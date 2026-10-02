// The dispute-defence pipeline: classify -> gather -> score -> draft -> validate -> route -> file.
// Every step appends to a trace that the UI shows, so nothing the agent did is hidden.
import { converseJson, MODEL } from './bedrock.js';
import { gather, score, reasonLabel, CHECKLISTS } from './gather.js';
import { strengthBand, routeByStrength } from './policy.js';
import { validateEvidences, buildProvideEvidenceRequest, provideEvidence, requestIdFor } from './paypal.js';
import { MERCHANT } from './fixtures.js';
import { humanDeadline } from './deadline.js';

const THEORIES = ['never_arrived', 'arrived_damaged', 'not_matching_listing', 'unrecognised_charge', 'refund_missing', 'double_charged', 'changed_mind', 'other'];
const iso = (ms) => new Date(ms).toISOString();

export function addTrace(rec, now, step, label, detail, extra = {}) {
  (rec.trace ??= []).push({ t: iso(now), step, label, detail, ...extra });
}
/** Fix the hand-over point once, at the moment a dispute reaches a person. */
export function setHandOver(rec, now) {
  const hd = humanDeadline(rec.opened_at, rec.due_at, now);
  rec.hand_over_at = iso(hd.at_ms); rec.hand_over_buffer_ms = hd.buffer_ms;
}
export function addHistory(rec, now, actor, event, detail) {
  (rec.history ??= []).push({ t: iso(now), actor, event, detail });
}

// ---------------------------------------------------------------- classify
const CLASSIFY_SYSTEM = `You triage payment disputes for a small online merchant. You are given what the buyer said and the reason code the buyer chose. Return ONLY a JSON object, no prose.
Fields:
- "claim_theory": one of ${JSON.stringify(THEORIES)}
- "consistent_with_filed_reason": boolean, does the buyer's own wording match the reason code they chose
- "buyer_core_complaint": one sentence, max 200 chars, in your own words
- "defence_strategy": one sentence, max 240 chars, what kind of evidence would actually answer this complaint
- "evidence_to_prioritise": array of up to 4 short strings`;

function ruleClassify(rec) {
  const map = { MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'never_arrived', MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'not_matching_listing', UNAUTHORISED: 'unrecognised_charge', CREDIT_NOT_PROCESSED: 'refund_missing', DUPLICATE_TRANSACTION: 'double_charged' };
  return { claim_theory: map[rec.paypal.reason] ?? 'other', consistent_with_filed_reason: true, buyer_core_complaint: rec.buyer_claim.slice(0, 200), defence_strategy: 'Rule-based fallback: answer the reason code with the matching checklist evidence.', evidence_to_prioritise: [] };
}

export async function classify(rec, now, deps) {
  const t = Date.now();
  if (!deps.useLlm || !(await deps.budget())) {
    const c = ruleClassify(rec);
    addTrace(rec, now, 'classify', 'Classified by rules', deps.useLlm ? 'Bedrock daily budget reached; rule-based fallback used.' : 'LLM disabled for this run.', { kind: 'rule', ms: Date.now() - t });
    return { ...c, generator: 'rules' };
  }
  try {
    const r = await converseJson({ system: CLASSIFY_SYSTEM, maxTokens: 500,
      user: JSON.stringify({ reason_code: rec.paypal.reason, amount: rec.paypal.dispute_amount, buyer_statement: rec.buyer_claim }) });
    const j = r.json;
    if (!THEORIES.includes(j.claim_theory)) j.claim_theory = 'other';
    addTrace(rec, now, 'classify', `Classified: ${j.claim_theory}`, `${j.buyer_core_complaint} Strategy: ${j.defence_strategy}`, { kind: 'llm', model: r.model, ms: r.ms, tokens: r.usage });
    return { ...j, generator: 'bedrock', model: r.model };
  } catch (e) {
    const c = ruleClassify(rec);
    addTrace(rec, now, 'classify', 'Classified by rules (Bedrock failed)', String(e.message).slice(0, 200), { kind: 'rule', ms: Date.now() - t });
    return { ...c, generator: 'rules' };
  }
}

// ---------------------------------------------------------------- draft
const DRAFT_SYSTEM = `You write the seller's response to a PayPal dispute, on behalf of the seller. Return ONLY a JSON object, no prose.
Hard rules:
1. Use ONLY facts present in the evidence items you are given. Never invent dates, names, amounts, tracking numbers or quotes.
2. Cite specifics: tracking numbers, carrier, delivery dates, order and refund IDs, dollar amounts, short exact quotes from the buyer's own messages when they help.
3. If an item is marked quality "contradicts" or "none", do NOT assert the opposite. Leave it out of the response and list it under "weaknesses".
4. Plain, civil, factual tone. First person plural ("we"). No threats, no legal language, no emotion.
5. response_notes must be under 1700 characters.
6. "cited_evidence_ids" must list the ids (like "E3") of the items you relied on. Only ids you were given.
7. Do not include phone numbers, web addresses, or advice addressed to the buyer or to PayPal. State what the records show; do not tell anyone what to go and do.
8. "recommended_action" is "accept" ONLY if the evidence shows the seller is clearly at fault (for example a real double charge); otherwise "file".
Fields: "response_notes" (string), "cited_evidence_ids" (array), "weaknesses" (array of short strings), "recommended_action" ("file"|"accept"), "recommendation_reason" (one sentence).`;

const FACT_TOKENS = [/\b(?:1[-. ])?\d{3}[-. ]\d{3}[-. ]\d{4}\b/g, /https?:\/\/\S+|\bwww\.\S+/g, /\$\s?\d[\d,]*(?:\.\d{1,2})?/g, /\b\d{4}-\d{2}-\d{2}\b/g, /\b[A-Z0-9]{10,}\b/g, /\b[A-Z]{2,4}-\d{3,}\b/g];

/** Every dollar amount, date, long id, order id in the draft must exist in the evidence corpus. */
export function checkFacts(text, corpus) {
  const hay = corpus.toLowerCase().replace(/\s+/g, '').replace(/,/g, '');
  const bad = [];
  for (const re of FACT_TOKENS) for (const m of text.match(re) ?? []) {
    const needle = m.toLowerCase().replace(/\s+/g, '').replace(/,/g, '');
    if (!hay.includes(needle) && !/^[a-z]+$/i.test(m)) bad.push(m);
  }
  return [...new Set(bad)];
}

export function templateNotes(rec, items) {
  const get = (k) => items.find((i) => i.kind === k && (i.quality === 'strong' || i.quality === 'partial'));
  const parts = [`We are responding to dispute ${rec.id} regarding order ${rec.merchant.order.id} ($${rec.paypal.dispute_amount.value}).`];
  for (const k of ['delivery_scan', 'signature', 'address', 'refund', 'return_receipt', 'listing', 'policy', 'risk']) {
    const it = get(k); if (it) parts.push(`${it.title}. ${it.detail}`);
  }
  return parts.join('\n\n').slice(0, 1900);
}

export async function draft(rec, now, deps, classification, items) {
  const t = Date.now();
  const corpus = JSON.stringify(items) + JSON.stringify(rec.paypal) + rec.buyer_claim + JSON.stringify(rec.merchant.order);
  const fallback = (why) => {
    const notes = templateNotes(rec, items);
    const cited = items.filter((i) => i.quality === 'strong' || i.quality === 'partial').map((i) => i.id);
    addTrace(rec, now, 'draft', 'Drafted from template', why, { kind: 'rule', ms: Date.now() - t });
    return { response_notes: notes, cited_evidence_ids: cited, weaknesses: items.filter((i) => ['none', 'contradicts'].includes(i.quality)).map((i) => i.title), recommended_action: 'file', recommendation_reason: 'Template draft; no recommendation to accept.', generator: 'template' };
  };
  if (!deps.useLlm) return fallback('LLM disabled for this run.');
  if (!(await deps.budget())) return fallback('Bedrock daily budget reached.');

  const payload = {
    dispute: { id: rec.id, reason: reasonLabel(rec.paypal.reason), amount: rec.paypal.dispute_amount, buyer_statement: rec.buyer_claim },
    classification: { claim_theory: classification.claim_theory, buyer_core_complaint: classification.buyer_core_complaint, defence_strategy: classification.defence_strategy },
    merchant: MERCHANT.name,
    evidence_items: items.map((i) => ({ id: i.id, kind: i.kind, quality: i.quality, title: i.title, detail: i.detail })),
  };
  let feedback = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await converseJson({ system: DRAFT_SYSTEM, maxTokens: 1500, user: JSON.stringify(payload) + feedback });
      const j = r.json;
      const ids = new Set(items.map((i) => i.id));
      const problems = [];
      if (typeof j.response_notes !== 'string' || !j.response_notes.trim()) problems.push('response_notes missing');
      else if (j.response_notes.length > 1800) problems.push(`response_notes is ${j.response_notes.length} chars; max 1800`);
      const unknown = (j.cited_evidence_ids ?? []).filter((x) => !ids.has(x));
      if (unknown.length) problems.push(`cited ids not in evidence: ${unknown.join(', ')}`);
      if (!j.cited_evidence_ids?.length) problems.push('no evidence ids cited');
      const ungrounded = j.response_notes ? checkFacts(j.response_notes, corpus) : [];
      if (ungrounded.length) problems.push(`these figures do not appear in the evidence: ${ungrounded.join(', ')}`);
      if (problems.length) {
        addTrace(rec, now, 'validate', `Draft attempt ${attempt} rejected`, problems.join(' | '), { kind: 'rule', ms: r.ms });
        feedback = `\n\nYour previous answer was rejected: ${problems.join('; ')}. Fix exactly these problems and return the JSON again.`;
        if (attempt === 2) return fallback('Both model drafts failed validation; using the template.');
        continue;
      }
      j.recommended_action = j.recommended_action === 'accept' ? 'accept' : 'file';
      addTrace(rec, now, 'draft', `Drafted response (${j.response_notes.length} chars, cites ${j.cited_evidence_ids.join(', ')})`,
        `Every dollar figure, date and ID in the draft was checked against the evidence${attempt > 1 ? ' (second attempt)' : ''}.`, { kind: 'llm', model: r.model, ms: r.ms, tokens: r.usage });
      return { ...j, generator: 'bedrock', model: r.model };
    } catch (e) {
      addTrace(rec, now, 'draft', `Draft attempt ${attempt} failed`, String(e.message).slice(0, 200), { kind: 'rule', ms: Date.now() - t });
      if (attempt === 2) return fallback('Bedrock call failed twice.');
    }
  }
}

// ---------------------------------------------------------------- evidence request
const MAX_NOTE = 1900;
export function buildEvidencePayload(items, d) {
  const byType = new Map();
  for (const id of d.cited_evidence_ids) {
    const it = items.find((i) => i.id === id);
    if (!it || it.kind === 'buyer_photos' || it.quality === 'none' || it.quality === 'contradicts') continue;
    const g = byType.get(it.evidence_type) ?? { evidence_type: it.evidence_type, notes: [], evidence_info: undefined };
    g.notes.push(`${it.title}: ${it.detail}`);
    if (it.evidence_info) {
      g.evidence_info ??= {};
      for (const [k, v] of Object.entries(it.evidence_info)) g.evidence_info[k] = [...(g.evidence_info[k] ?? []), ...v];
    }
    byType.set(it.evidence_type, g);
  }
  const evidences = [{ evidence_type: 'MERCHANT_RESPONSE', notes: d.response_notes.slice(0, MAX_NOTE) }];
  for (const g of byType.values()) {
    if (g.evidence_type === 'MERCHANT_RESPONSE') continue;
    const e = { evidence_type: g.evidence_type, notes: g.notes.join('\n').slice(0, MAX_NOTE) };
    if (g.evidence_info) e.evidence_info = g.evidence_info;
    evidences.push(e);
  }
  return { evidences };
}

// ---------------------------------------------------------------- the pipeline
/**
 * Analyse a dispute: classify, gather, score, draft, validate, route.
 * Mutates and returns `rec`. Does NOT file; see fileResponse.
 */
export async function analyse(rec, now, deps) {
  if (deps.useLlm) {
    try {
      const { runAgentLoop } = await import('./agentloop.js');
      addTrace(rec, now, 'receive', `Dispute ${rec.id} received`, `${reasonLabel(rec.paypal.reason)}, $${rec.paypal.dispute_amount.value}, response due ${rec.due_at}`, { kind: 'rule' });
      const done = await runAgentLoop(rec, now, deps);
      if (done) return done;
    } catch (e) {
      addTrace(rec, now, 'agent', 'Agent loop failed', String(e.message).slice(0, 240) + ' Falling back to the deterministic pipeline.', { kind: 'rule' });
    }
    rec.trace = (rec.trace ?? []).filter((t) => t.step !== 'receive' || true);
  }
  return analyseDeterministic(rec, now, deps);
}

export async function analyseDeterministic(rec, now, deps) {
  addTrace(rec, now, 'receive', `Dispute ${rec.id} received`, `${reasonLabel(rec.paypal.reason)}, $${rec.paypal.dispute_amount.value}, response due ${rec.due_at}`, { kind: 'rule' });
  const classification = await classify(rec, now, deps);
  const { items, tool } = gather({ dispute: { amount: rec.paypal.dispute_amount.value, buyer_photos: rec.buyer_photos, opened_h: rec.opened_h }, txn: rec.txn, merchant: rec.merchant, _t0: rec.t0, _policy: MERCHANT.policies });
  for (const c of tool) addTrace(rec, now, 'gather', `${c.tool}(${Object.values(c.args).join(', ')})`, c.result, { kind: 'tool' });
  const sc = score(rec.paypal.reason, items);
  const band = strengthBand(sc.score);
  addTrace(rec, now, 'score', `Evidence strength ${sc.score}/100 (${band})`, sc.known_reason ? sc.checklist.map((c) => `${c.label}: ${c.quality}`).join('; ') : `No checklist for reason ${rec.paypal.reason}; a person must handle it.`, { kind: 'rule' });
  let d;
  if (!sc.known_reason) {
    d = { response_notes: '', cited_evidence_ids: [], weaknesses: ['Dispute reason has no checklist'], recommended_action: 'accept', recommendation_reason: 'Unsupported reason code.', generator: 'none' };
  } else d = await draft(rec, now, deps, classification, items);

  let payload = null, problems = [];
  if (d.response_notes) {
    payload = buildEvidencePayload(items, d);
    problems = validateEvidences(payload);
    addTrace(rec, now, 'validate', problems.length ? 'Evidence request FAILED schema validation' : `Evidence request valid against live PayPal schema ${deps.schemaVersion ?? ''}`.trim(), problems.length ? problems.join('; ') : `${payload.evidences.length} evidence block(s): ${payload.evidences.map((e) => e.evidence_type).join(', ')}`, { kind: 'rule' });
  }
  let route = sc.known_reason && !problems.length ? routeByStrength(sc.score, d.recommended_action) : { action: 'human_review', why: problems.length ? 'Evidence request failed validation.' : 'Unsupported dispute reason.' };
  addTrace(rec, now, 'route', route.action === 'auto_file' ? 'Route: file without waiting for a person' : 'Route: escalate to a person', route.why, { kind: 'rule' });

  rec.analysis = {
    at: iso(now), classification, items, checklist: sc.checklist, score: sc.score, band,
    draft: { notes: d.response_notes, cited: d.cited_evidence_ids, weaknesses: d.weaknesses, recommended_action: d.recommended_action, recommendation_reason: d.recommendation_reason, generator: d.generator, model: d.model ?? null },
    evidence_payload: payload, route,
  };
  rec.state = route.action === 'auto_file' ? 'ANALYSED' : 'ESCALATED';
  if (rec.state === 'ESCALATED') setHandOver(rec, now);
  addHistory(rec, now, 'agent', route.action === 'auto_file' ? 'analysed' : 'escalated', `Score ${sc.score}/100 (${band}). ${route.why}`);
  return rec;
}

// ---------------------------------------------------------------- filing
/**
 * File the prepared response. FIXTURE disputes build and validate the exact request but DO NOT send it
 * (the dispute does not exist at PayPal). SANDBOX/LIVE disputes send it for real.
 */
export async function fileResponse(rec, now, { actor, bestEffort = false, notesOverride } = {}, deps = {}) {
  if (!rec.analysis?.evidence_payload) throw new Error('nothing to file: no evidence package');
  const payload = structuredClone(rec.analysis.evidence_payload);
  if (notesOverride) { payload.evidences[0].notes = notesOverride.slice(0, MAX_NOTE); rec.analysis.draft.notes = payload.evidences[0].notes; rec.analysis.evidence_payload = payload; }
  const req = buildProvideEvidenceRequest(rec.id, payload);
  const requestId = requestIdFor('provide-evidence', rec.id, payload);
  if (rec.filing?.request_id === requestId) {
    addTrace(rec, now, 'file', 'Replay suppressed', `PayPal-Request-Id ${requestId} was already used for this dispute; nothing was sent again.`, { kind: 'rule' });
    addHistory(rec, now, actor, 'replay_suppressed', requestId);
    rec.filing.replays = (rec.filing.replays ?? 0) + 1;
    return rec;
  }
  const filing = { request_id: requestId, at: iso(now), by: actor, best_effort: bestEffort, request: { method: req.method, path: req.path, scope: req.scope, content_type: req.content_type, input: payload }, margin_ms: Date.parse(rec.due_at) - now };
  if (rec.source === 'SANDBOX') {
    try {
      const r = await (deps.provideEvidence ?? provideEvidence)(rec.id, payload, { requestId });
      Object.assign(filing, { mode: 'LIVE_SANDBOX', sent: true, http_status: r.status, response: r.body, debug_id: r.debug_id });
    } catch (e) {
      addTrace(rec, now, 'file', 'PayPal rejected the filing', e.message, { kind: 'tool' });
      addHistory(rec, now, actor, 'file_failed', e.message);
      rec.state = 'ESCALATED'; rec.filing_error = { at: iso(now), message: e.message, body: e.body ?? null };
      return rec;
    }
  } else {
    Object.assign(filing, { mode: 'FIXTURE_DRY_RUN', sent: false, note: 'Fixture dispute: the request was built and validated against the live schema, then NOT sent, because this dispute does not exist at PayPal.' });
  }
  rec.filing = filing; rec.state = 'FILED'; delete rec.filing_error;
  addTrace(rec, now, 'file', filing.sent ? `Filed to PayPal (HTTP ${filing.http_status})` : 'Filed (fixture dry run: request built, not sent)',
    `${req.method} ${req.path} with ${payload.evidences.length} evidence block(s), ${Math.round(filing.margin_ms / 60000)} minutes before the deadline.${bestEffort ? ' Best-effort filing by the deadline guard.' : ''}`, { kind: 'tool' });
  addHistory(rec, now, actor, bestEffort ? 'filed_best_effort' : 'filed', `${filing.mode}; ${Math.round(filing.margin_ms / 3600000 * 10) / 10} h before deadline`);
  return rec;
}

// ---------------------------------------------------------------- accept (human only)
export function acceptClaim(rec, now, actor) {
  rec.state = 'ACCEPTED';
  rec.outcome = { code: 'RESOLVED_BUYER_FAVOUR', simulated: rec.source !== 'SANDBOX', decided_at: iso(now), note: 'Seller accepted the claim; buyer refunded in full.' };
  rec.accept_request = { method: 'POST', path: `/v1/customer/disputes/${rec.id}/accept-claim`, sent: rec.source === 'SANDBOX' ? 'see history' : false };
  addTrace(rec, now, 'accept', 'Claim accepted by a person', 'The only write PayPal\'s own MCP agent has. Here it needs a human.', { kind: 'tool' });
  addHistory(rec, now, actor, 'accepted', 'Seller accepted the claim; refund issued.');
  return rec;
}

/** SIMULATED adjudication. Labelled as such everywhere it appears. */
export function simulateAdjudication(rec, now) {
  const filed = rec.state === 'FILED';
  const s = rec.analysis?.score ?? 0;
  const win = filed && s >= 55;
  rec.state = 'RESOLVED';
  rec.outcome = { code: win ? 'RESOLVED_SELLER_FAVOUR' : 'RESOLVED_BUYER_FAVOUR', simulated: true, decided_at: iso(now),
    note: win ? `Simulated: evidence score ${s} clears the 55 threshold, so the seller wins.` : `Simulated: evidence score ${s} is below 55, so the buyer wins. A filed response still beats a default.` };
  addHistory(rec, now, 'simulator', 'resolved', rec.outcome.note);
  return rec;
}

export { CHECKLISTS, MODEL };
