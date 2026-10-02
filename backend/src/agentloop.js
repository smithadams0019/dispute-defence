// The tool-using agent. Bedrock Converse drives a bounded loop; the model decides which records to pull,
// whether the evidence is enough, and whether to FILE or hand the dispute to a person. The server enforces
// the rules the model cannot be trusted with: schema validation, grounded facts, and a floor on weak filings.
import { converseTurn, MODEL } from './bedrock.js';
import { gather, score, reasonLabel, CHECKLISTS } from './gather.js';
import { strengthBand, FILE_AT } from './policy.js';
import { validateEvidences } from './paypal.js';
import { MERCHANT } from './fixtures.js';
import { addTrace, checkFacts, buildEvidencePayload, setHandOver, addHistory, templateNotes } from './agent.js';

export const MAX_TURNS = 9;
const THEORIES = ['never_arrived', 'arrived_damaged', 'not_matching_listing', 'unrecognised_charge', 'refund_missing', 'double_charged', 'changed_mind', 'other'];
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });

export const TOOLS = [
  { name: 'classify_dispute', description: 'Record your reading of what the buyer is actually complaining about, compared with the reason code they picked. Call this first.', input: obj({ claim_theory: { type: 'string', enum: THEORIES }, consistent_with_filed_reason: { type: 'boolean' }, buyer_core_complaint: str('one sentence, max 200 chars'), defence_strategy: str('one sentence, max 240 chars') }, ['claim_theory', 'consistent_with_filed_reason', 'buyer_core_complaint', 'defence_strategy']) },
  { name: 'get_dispute', description: 'Fetch the PayPal dispute record: reason code, amount, stage, response deadline, the buyer\'s own messages.', input: obj() },
  { name: 'get_requirements', description: 'What evidence this dispute reason actually requires, with weights. Use it to decide which records are worth pulling.', input: obj() },
  { name: 'get_order', description: 'Fetch the merchant\'s order record for the disputed transaction.', input: obj() },
  { name: 'get_transaction', description: 'Fetch the PayPal transaction: buyer, amount, and the buyer\'s PayPal-confirmed shipping address.', input: obj() },
  { name: 'get_delivery_evidence', description: 'Pull carrier tracking and the delivery scan history. Also cross-checks delivery location against the buyer\'s confirmed address and shipped weight against the listing.', input: obj() },
  { name: 'get_communications', description: 'Fetch the email thread between the seller and this buyer for this order.', input: obj() },
  { name: 'get_policies_and_listing', description: 'Fetch the store\'s return and shipping policies, the product listing text, and whether the buyer attached photos.', input: obj() },
  { name: 'get_payment_records', description: 'Fetch the refund ledger, return shipments, and any other orders from the same buyer around the same time.', input: obj() },
  { name: 'get_risk_signals', description: 'Fetch fraud and customer-history signals: address and card checks, prior orders, device history.', input: obj() },
  { name: 'assess_evidence', description: 'Score the evidence you have gathered SO FAR against the checklist for this reason. Returns score 0-100, band (strong/moderate/weak), and which checklist items are still unchecked or contradicted.', input: obj() },
  { name: 'submit_draft', description: 'Submit the seller\'s response. Every dollar amount, date, tracking number and ID in it is checked against the evidence you fetched; invented figures are rejected.', input: obj({ response_notes: str('under 1700 characters, plain, factual, first person plural'), cited_evidence_ids: { type: 'array', items: { type: 'string' } }, weaknesses: { type: 'array', items: { type: 'string' }, description: 'honest gaps or contradictions you chose not to assert around' } }, ['response_notes', 'cited_evidence_ids', 'weaknesses']) },
  { name: 'file_response', description: `File the submitted draft with PayPal. Refused if evidence strength is below ${FILE_AT}. Ends your run.`, input: obj() },
  { name: 'escalate_to_human', description: 'Stop and hand the dispute to the seller. Use it when the evidence is too weak to win, when the seller is clearly at fault (for example a real double charge), or when you cannot responsibly decide. Ends your run.', input: obj({ reason: str('why a person should decide, one or two sentences'), recommend: { type: 'string', enum: ['file', 'accept'], description: '"accept" if the seller should refund; "file" if a weak defence is still worth a shot' } }, ['reason', 'recommend']) },
];

const KIND_TOOL = {
  get_order: ['order'], get_delivery_evidence: ['delivery_scan', 'signature', 'exception', 'address', 'sku_match'], get_communications: ['buyer_comms'],
  get_policies_and_listing: ['policy', 'listing', 'buyer_photos'], get_payment_records: ['refund', 'return_receipt', 'distinct_orders', 'shipment_count'], get_risk_signals: ['risk'],
};

const SYSTEM = `You are the dispute-defence agent for an online merchant. A PayPal dispute has arrived and you have a hard response deadline. Your job: investigate with the tools, decide whether the merchant can honestly defend it, then either file a grounded response or hand it to the owner.
Process: classify_dispute first; get_dispute and get_requirements; pull only the records the reason requires (you may call several tools in one turn); assess_evidence; submit_draft; then file_response OR escalate_to_human.
Rules:
- Use ONLY facts the tools returned. Never invent dates, names, amounts, tracking numbers or quotes. No phone numbers, URLs, or advice addressed to the buyer or PayPal.
- Evidence flagged "contradicts" or "none" must not be asserted around: leave it out of the response and list it under weaknesses.
- Do not file a hopeless defence. If assess_evidence returns band "weak", or the seller is plainly at fault, call escalate_to_human with an honest reason and the right recommendation. That is a correct outcome, not a failure.
- Plain, civil, factual tone. You have at most ${MAX_TURNS} turns. Finish with exactly one of file_response or escalate_to_human.`;

export async function runAgentLoop(rec, now, deps) {
  const gatherAll = (() => { let c; return () => (c ??= gather({ dispute: { amount: rec.paypal.dispute_amount.value, buyer_photos: rec.buyer_photos, opened_h: rec.opened_h }, txn: rec.txn, merchant: rec.merchant, _t0: rec.t0, _policy: MERCHANT.policies })); })();
  const revealed = [];            // evidence items the agent has actually pulled, renumbered E1..En
  const state = { classification: null, draft: null, decision: null, assessed: null, calls: 0 };
  let corpus = () => JSON.stringify(revealed) + JSON.stringify(rec.paypal) + rec.buyer_claim + JSON.stringify(rec.merchant.order);

  const reveal = (tool) => {
    const { items, tool: calls } = gatherAll();
    const out = [];
    for (const it of items.filter((i) => KIND_TOOL[tool].includes(i.kind))) {
      if (revealed.find((r) => r._src === it.id)) continue;
      const copy = { ...it, _src: it.id, id: `E${revealed.length + 1}` };
      revealed.push(copy); out.push(copy);
    }
    return { items: out.map(({ _src, ...x }) => x), tool_calls: calls.length };
  };
  const pub = () => revealed.map(({ _src, ...x }) => x);

  const handlers = {
    classify_dispute: (a) => { state.classification = { ...a, generator: 'bedrock', model: MODEL() }; return { ok: true }; },
    get_dispute: () => ({ dispute_id: rec.id, reason: rec.paypal.reason, reason_label: reasonLabel(rec.paypal.reason), amount: rec.paypal.dispute_amount, stage: rec.paypal.dispute_life_cycle_stage, seller_response_due_date: rec.due_at, messages: rec.paypal.messages.map((m) => ({ posted_by: m.posted_by, content: m.content })), buyer_attached_photos: rec.buyer_photos ?? 0 }),
    get_requirements: () => ({ reason: rec.paypal.reason, checklist: (CHECKLISTS[rec.paypal.reason] ?? []).map(([kind, label, weight]) => ({ kind, label, weight })), note: CHECKLISTS[rec.paypal.reason] ? undefined : 'No checklist exists for this reason; escalate.' }),
    get_transaction: () => ({ paypal_transaction_id: rec.txn.id, buyer_name: rec.txn.buyer.name, amount: rec.paypal.dispute_amount, buyer_paypal_confirmed_address: `${rec.txn.confirmed_address.line1}, ${rec.txn.confirmed_address.city}, ${rec.txn.confirmed_address.state} ${rec.txn.confirmed_address.zip}` }),
    assess_evidence: () => {
      const sc = score(rec.paypal.reason, revealed);
      state.assessed = { score: sc.score, band: strengthBand(sc.score) };
      const needed = CHECKLISTS[rec.paypal.reason] ?? [];
      return { score: sc.score, band: state.assessed.band, file_floor: FILE_AT, checklist: sc.checklist.map((c) => ({ kind: c.kind, label: c.label, weight: c.weight, status: revealed.some((i) => i.kind === c.kind) ? c.quality : 'NOT YET CHECKED' })), unchecked: needed.filter(([k]) => !revealed.some((i) => i.kind === k)).map(([k]) => k) };
    },
    submit_draft: (a) => {
      const problems = [];
      if (typeof a.response_notes !== 'string' || !a.response_notes.trim()) problems.push('response_notes missing');
      else if (a.response_notes.length > 1800) problems.push(`response_notes is ${a.response_notes.length} chars; max 1800`);
      const ids = new Set(revealed.map((i) => i.id));
      const unknown = (a.cited_evidence_ids ?? []).filter((x) => !ids.has(x));
      if (unknown.length) problems.push(`cited ids you have not fetched: ${unknown.join(', ')}`);
      if (!a.cited_evidence_ids?.length) problems.push('cite at least one evidence id');
      const bad = a.response_notes ? checkFacts(a.response_notes, corpus()) : [];
      if (bad.length) problems.push(`these figures/IDs/phone numbers/URLs do not appear in the evidence: ${bad.join(', ')}`);
      if (problems.length) return { ok: false, problems };
      state.draft = { notes: a.response_notes, cited: a.cited_evidence_ids, weaknesses: a.weaknesses ?? [] };
      return { ok: true, note: 'Draft accepted. Now call file_response or escalate_to_human.' };
    },
    file_response: () => {
      if (!state.draft) return { ok: false, error: 'submit_draft first' };
      const sc = score(rec.paypal.reason, revealed);
      if (sc.score < FILE_AT) return { ok: false, error: `Refused by policy: evidence strength ${sc.score} is below the ${FILE_AT} filing floor. Call escalate_to_human.` };
      const payload = buildEvidencePayload(pub(), { cited_evidence_ids: state.draft.cited, response_notes: state.draft.notes });
      const problems = validateEvidences(payload);
      if (problems.length) return { ok: false, error: 'PayPal schema validation failed: ' + problems.join('; ') };
      state.decision = { action: 'auto_file', why: `The agent decided to file; evidence score ${sc.score}/100.`, payload };
      return { ok: true, status: 'accepted for filing' };
    },
    escalate_to_human: (a) => { state.decision = { action: 'human_review', why: a.reason, recommend: a.recommend }; return { ok: true, status: 'handed to the owner' }; },
  };
  for (const t of Object.keys(KIND_TOOL)) handlers[t] = () => reveal(t);

  const messages = [{ role: 'user', content: [{ text: `New dispute ${rec.id} ($${rec.paypal.dispute_amount.value}). Reason code: ${reasonLabel(rec.paypal.reason)}. Seller response due ${rec.due_at}. Investigate and decide.` }] }];
  let turns = 0;
  while (turns < MAX_TURNS && !state.decision) {
    if (!(await deps.budget())) { addTrace(rec, now, 'agent', 'Bedrock daily budget reached', 'Falling back to the deterministic pipeline.', { kind: 'rule' }); return null; }
    turns++;
    const r = await (deps.converseTurn ?? converseTurn)({ system: SYSTEM, messages, tools: TOOLS });
    messages.push(r.message);
    const uses = (r.message.content ?? []).filter((c) => c.toolUse);
    const said = (r.message.content ?? []).filter((c) => c.text).map((c) => c.text).join(' ').trim();
    if (said) addTrace(rec, now, 'agent', `Turn ${turns}: ${said.slice(0, 220)}`, '', { kind: 'llm', model: r.model, ms: r.ms, tokens: r.usage });
    if (!uses.length) {
      messages.push({ role: 'user', content: [{ text: 'Continue with the tools. You must finish with file_response or escalate_to_human.' }] });
      continue;
    }
    const results = [];
    for (const u of uses) {
      state.calls++;
      let out;
      try { out = handlers[u.toolUse.name] ? handlers[u.toolUse.name](u.toolUse.input ?? {}) : { ok: false, error: `unknown tool ${u.toolUse.name}` }; }
      catch (e) { out = { ok: false, error: String(e.message) }; }
      const brief = u.toolUse.name === 'submit_draft' ? (out.ok ? 'draft accepted' : 'REJECTED: ' + out.problems.join(' | ')) : u.toolUse.name === 'file_response' ? (out.ok ? 'filing approved' : out.error) : u.toolUse.name === 'escalate_to_human' ? `escalating (${u.toolUse.input?.recommend}): ${u.toolUse.input?.reason}` : u.toolUse.name === 'assess_evidence' ? `score ${out.score} (${out.band})` : u.toolUse.name === 'classify_dispute' ? `${u.toolUse.input?.claim_theory}` : `${(out.items ?? []).length || 'ok'} item(s)`;
      addTrace(rec, now, 'agent', `${u.toolUse.name}(${Object.keys(u.toolUse.input ?? {}).length ? '…' : ''})`, brief, { kind: 'tool', model: r.model, ms: r.ms, turn: turns });
      results.push({ toolResult: { toolUseId: u.toolUse.toolUseId, content: [{ json: out }], status: out?.ok === false || out?.error ? 'error' : 'success' } });
    }
    messages.push({ role: 'user', content: results });
  }
  if (!state.decision) {
    addTrace(rec, now, 'agent', `No decision after ${turns} turns`, 'Falling back to the deterministic pipeline.', { kind: 'rule' });
    return null;
  }
  // assemble the same analysis shape the rest of the system uses
  const items = pub();
  const sc = score(rec.paypal.reason, items);
  const classification = state.classification ?? { claim_theory: 'other', consistent_with_filed_reason: true, buyer_core_complaint: rec.buyer_claim.slice(0, 200), defence_strategy: '', generator: 'bedrock' };
  let dr = state.draft;
  let draftGenerator = 'bedrock';
  if (!dr) {
    // The agent handed over without drafting. A person (or the guard at the hand-over point) still needs something
    // honest to file, so build it from the strongest evidence it fetched and say plainly that no model wrote it.
    const usable = items.filter((i) => i.quality === 'strong' || i.quality === 'partial');
    if (usable.length) {
      dr = { notes: templateNotes({ ...rec, merchant: rec.merchant, paypal: rec.paypal }, items), cited: usable.map((i) => i.id), weaknesses: items.filter((i) => ['none', 'contradicts'].includes(i.quality)).map((i) => i.title) };
      draftGenerator = 'template';
    }
  }
  const payload = state.decision.payload ?? (dr ? buildEvidencePayload(items, { cited_evidence_ids: dr.cited, response_notes: dr.notes }) : null);
  rec.analysis = {
    at: new Date(now).toISOString(), classification, items, checklist: sc.checklist, score: sc.score, band: strengthBand(sc.score),
    draft: { notes: dr?.notes ?? '', cited: dr?.cited ?? [], weaknesses: dr?.weaknesses ?? [], recommended_action: state.decision.action === 'auto_file' ? 'file' : (state.decision.recommend ?? 'file'), recommendation_reason: state.decision.why, generator: draftGenerator, model: draftGenerator === 'bedrock' ? MODEL() : null },
    evidence_payload: payload, route: { action: state.decision.action, why: state.decision.why, decided_by: 'agent' },
    agent: { turns, tool_calls: state.calls, max_turns: MAX_TURNS, fetched: [...new Set(revealed.map((i) => i.kind))] },
  };
  rec.state = state.decision.action === 'auto_file' ? 'ANALYSED' : 'ESCALATED';
  if (rec.state === 'ESCALATED') setHandOver(rec, now);
  addTrace(rec, now, 'route', state.decision.action === 'auto_file' ? 'Agent chose to file' : 'Agent chose to escalate', state.decision.why, { kind: 'llm' });
  addHistory(rec, now, 'agent', rec.state === 'ANALYSED' ? 'analysed' : 'escalated', `Score ${sc.score}/100 (${rec.analysis.band}) after ${turns} turn(s), ${state.calls} tool call(s). ${state.decision.why}`);
  return rec;
}
