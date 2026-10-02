// Application logic: sessions, seeding, views, webhook intake, guard sweep. No HTTP in here.
import crypto from 'node:crypto';
import { MERCHANT, buildFixtures, incomingTemplates } from './fixtures.js';
import { loadRealCase } from './real-case.js';
import { createRecord } from './records.js';
import { gather } from './gather.js';
import { buildEvidencePayload, templateNotes } from './agent.js';
import { analyse, analyseDeterministic, fileResponse, acceptClaim, simulateAdjudication, addTrace, addHistory, setHandOver } from './agent.js';
import { assess, humanDeadline, parseInstant, HOUR, DAY, formatLocal } from './deadline.js';
import { guardAction, TERMINAL } from './policy.js';
import ENUMS from './generated/paypal-enums.json' with { type: 'json' };

const iso = (ms) => new Date(ms).toISOString();
export const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_DISPUTES_PER_SESSION = 25;
const RESEED_AFTER_MS = 72 * HOUR;

export const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

export function makeDeps(store, { useLlm = true, realNow = Date.now() } = {}) {
  const deps = { useLlm: useLlm && process.env.DISABLE_LLM !== '1', schemaVersion: ENUMS.schema_version, store, budget: () => store.takeBudget(dayKey(realNow)) };
  // Deployed: the 30-90 s agent run happens in a second, asynchronous invocation so no HTTP request waits on it.
  if (process.env.AWS_LAMBDA_FUNCTION_NAME && process.env.STORE !== 'memory') {
    deps.invokeAsync = async (payload) => {
      const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
      await new LambdaClient({ region: process.env.AWS_REGION }).send(new InvokeCommand({ FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(payload)) }));
    };
  }
  return deps;
}

/** Run (or queue) the agent for a dispute that is in state NEW. */
export async function dispatchAnalysis(store, sid, id, realNow, deps) {
  if (deps.invokeAsync) { await deps.invokeAsync({ job: 'analyse', sid, id }); return { queued: true }; }
  await runAnalysisJob(store, sid, id, realNow, deps); return { queued: false };
}

export async function runAnalysisJob(store, sid, id, realNow, deps) {
  const meta = await store.getMeta(sid); if (!meta) return { skipped: 'no session' };
  const now = simNow(meta, realNow);
  const rec = await store.get(sid, id);
  if (!rec || rec.state !== 'NEW') return { skipped: rec ? `state ${rec.state}` : 'missing' };
  const v = rec.version ?? 0;
  rec.analysis = null; rec.trace = [];
  await analyse(rec, now, deps); rec.analysis.origin = rec.analysis.origin ?? 'live';
  if (rec.state === 'ANALYSED') await fileResponse(rec, Date.now() + (meta.clock_offset_ms || 0), { actor: 'agent' }, deps);
  await store.put(sid, rec, { expect: v });
  return { state: rec.state };
}

// ------------------------------------------------------------ seed cache (real Bedrock output, reused per narrative day)
function cacheKey(fixtureKey, rec) {
  const h = crypto.createHash('sha256').update(JSON.stringify({ k: fixtureKey, c: rec.t0, p: 'v5' })).digest('hex').slice(0, 16);
  return `${fixtureKey}#${h}`;
}

async function analyseWithCache(store, rec, now, deps) {
  const key = cacheKey(rec.fixture_key, rec);
  const hit = await store.getCache?.(key);
  if (hit) {
    rec.analysis = { ...hit.analysis, at: iso(now), origin: 'seed_cache', cached_from: hit.generated_at };
    let t = now;
    rec.trace = hit.trace.map((e) => { t += Math.max(200, e.ms ?? 0); return { ...e, t: iso(t) }; });
    rec.trace.unshift({ t: iso(now), step: 'cache', label: 'Reused this morning\'s Bedrock run', detail: `Pipeline output generated ${hit.generated_at} by ${hit.analysis.draft.model ?? 'rules'}; reused so the first page load is instant.`, kind: 'rule' });
    rec.state = hit.state;
    if (rec.state === 'ESCALATED') setHandOver(rec, now);
    addHistory(rec, now, 'agent', hit.state === 'ANALYSED' ? 'analysed' : 'escalated', hit.history_detail);
    return rec;
  }
  if (!deps.warm) {
    // No cached Bedrock run for today yet: answer instantly from the deterministic pipeline and say so.
    await analyseDeterministic(rec, now, { ...deps, useLlm: false });
    rec.analysis.origin = 'template_fallback';
    return rec;
  }
  await analyse(rec, now, deps);
  rec.analysis.origin = 'live';
  await store.putCache?.(key, { generated_at: iso(now), analysis: rec.analysis, trace: rec.trace.map(({ t, ...rest }) => rest), state: rec.state, history_detail: rec.history.at(-1).detail });
  return rec;
}

// ------------------------------------------------------------ session + seeding
export async function seedSession(store, sid, realNow, deps) {
  const fixtures = buildFixtures(realNow);
  await store.clear(sid);
  const meta = { sid, seeded_at: realNow, clock_offset_ms: 0, tz: MERCHANT.tz, created: realNow };
  await store.putMeta(sid, meta);
  const recs = fixtures.map((fx) => createRecord(fx, realNow));
  await Promise.all(recs.map(async (rec, i) => {
    const fx = fixtures[i];
    const sd = fx.seed;
    if (sd.state === 'MISSED') {
      await analyse(rec, realNow + (fx.dispute.opened_h + 1) * HOUR, { ...deps, useLlm: false });
      rec.retrospective = true;
      rec.state = 'MISSED';
      const closed = realNow + sd.closed_h * HOUR;
      rec.outcome = { code: 'RESOLVED_BUYER_FAVOUR', simulated: false, default: true, decided_at: iso(closed), note: 'Closed in the buyer\'s favour by default. No response was filed before the window closed.' };
      rec.history.push({ t: iso(closed), actor: 'paypal', event: 'closed_default', detail: 'Response window closed with no seller response. Buyer refunded.' });
      rec.pre_agent = true;
      return;
    }
    const analysedAt = realNow + (sd.filed_h ?? sd.analysed_h) * HOUR - (sd.state === 'FILED' ? 25_000 : 0);
    await analyseWithCache(store, rec, analysedAt, deps);
    if (sd.state === 'FILED') {
      if (rec.state !== 'ANALYSED') throw new Error(`fixture ${fx.key} expected to auto-file but routed ${rec.state}`);
      await fileResponse(rec, realNow + sd.filed_h * HOUR, { actor: 'agent' });
    } else if (sd.state === 'ESCALATED' && rec.state !== 'ESCALATED') {
      throw new Error(`fixture ${fx.key} expected to escalate but routed ${rec.state}`);
    }
  }));
  for (const rec of recs) await store.put(sid, rec);
  // The sandbox's one real dispute, fetched live. Absent if PayPal cannot be
  // reached, in which case the session is fixtures only, as it was before.
  const real = await loadRealCase(deps?.env, deps?.fetchImpl);
  if (real) await store.put(sid, real);
  return meta;
}

export async function ensureSession(store, sid, realNow, deps) {
  let meta = await store.getMeta(sid);
  if (!meta || realNow - meta.seeded_at > RESEED_AFTER_MS) meta = await seedSession(store, sid, realNow, deps);
  return meta;
}

export const simNow = (meta, realNow) => realNow + (meta.clock_offset_ms || 0);

// ------------------------------------------------------------ views
export function viewOf(rec, now, tz) {
  const dl = assess(now, rec.due_at, { tz, openedAt: rec.opened_at });
  const hd = rec.hand_over_at ? { at_ms: parseInstant(rec.hand_over_at), buffer_ms: rec.hand_over_buffer_ms } : humanDeadline(rec.opened_at, rec.due_at);
  const closed = TERMINAL.has(rec.state);
  const a = rec.analysis;
  return {
    id: rec.id, source: rec.source, reason: rec.paypal.reason, reason_label: rec.reason_label,
    amount: rec.paypal.dispute_amount, buyer: rec.buyer, item: rec.item, stage: rec.paypal.dispute_life_cycle_stage,
    buyer_claim: rec.buyer_claim, buyer_photos: rec.buyer_photos,
    opened_at: rec.opened_at, due_at: rec.due_at, state: rec.state,
    deadline: {
      ...dl, closed,
      hand_over_at: iso(hd.at_ms), hand_over_local: formatLocal(hd.at_ms, tz), hand_over_remaining_ms: hd.at_ms - now, hand_over_buffer_ms: hd.buffer_ms,
      hand_over_applies: rec.state === 'ESCALATED',
    },
    analysis: a ? {
      at: a.at, origin: a.origin, cached_from: a.cached_from ?? null, score: a.score, band: a.band, claim_theory: a.classification.claim_theory,
      buyer_core_complaint: a.classification.buyer_core_complaint, defence_strategy: a.classification.defence_strategy, consistent_with_filed_reason: a.classification.consistent_with_filed_reason,
      items: a.items, checklist: a.checklist, draft: a.draft, evidence_payload: a.evidence_payload, route: a.route, agent: a.agent ?? null,
    } : null,
    filing: rec.filing, filing_error: rec.filing_error ?? null, outcome: rec.outcome, accept_request: rec.accept_request ?? null,
    trace: rec.trace, history: rec.history,
    pre_agent: !!rec.pre_agent, retrospective: !!rec.retrospective, missed_note: rec.missed_note,
    provenance: {
      dispute: rec.source === 'SANDBOX' ? 'live PayPal sandbox dispute' : 'seeded fixture (not a PayPal object)',
      analysis: a ? (a.draft.generator === 'bedrock' ? (a.origin === 'seed_cache' ? 'Bedrock output cached from an earlier real run' : 'Bedrock, live in this session') : `${a.draft.generator} (no model call)`) : null,
      filing: rec.filing ? (rec.filing.sent ? 'sent to PayPal sandbox' : 'request built and schema-validated; not sent (fixture)') : null,
      outcome: rec.outcome ? (rec.outcome.simulated ? 'SIMULATED adjudication' : rec.outcome.default ? 'seeded history' : 'real') : null,
    },
  };
}

export function kpis(views) {
  const open = views.filter((v) => !TERMINAL.has(v.state));
  const sum = (arr) => arr.reduce((s, v) => s + Number(v.amount.value), 0);
  const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2);
  const won = views.filter((v) => v.outcome?.code === 'RESOLVED_SELLER_FAVOUR');
  const lostDefault = views.filter((v) => v.outcome?.default);
  const filed = views.filter((v) => v.filing);
  const missedWithAgent = views.filter((v) => v.state === 'MISSED' && !v.pre_agent);
  const urgent = open.slice().sort((a, b) => a.deadline.remaining_ms - b.deadline.remaining_ms)[0];
  return {
    open: open.length, needs_human: views.filter((v) => v.state === 'ESCALATED').length, filed: filed.length, queued: views.filter((v) => v.state === 'ANALYSED').length,
    at_stake_open: fmt(sum(open)), defended_amount: fmt(sum(filed)), won_amount: fmt(sum(won)),
    lost_to_default_amount: fmt(sum(lostDefault)), lost_to_default_count: lostDefault.length,
    missed_with_agent: missedWithAgent.length, most_urgent_id: urgent?.id ?? null,
  };
}

export async function getState(store, sid, realNow, deps) {
  const meta = await ensureSession(store, sid, realNow, deps);
  const now = simNow(meta, realNow);
  const recs = await store.list(sid);
  const views = recs.map((r) => viewOf(r, now, meta.tz));
  views.sort((a, b) => (TERMINAL.has(a.state) - TERMINAL.has(b.state)) || a.deadline.remaining_ms - b.deadline.remaining_ms);
  return {
    server_now: iso(realNow), sim_now: iso(now), clock_offset_ms: meta.clock_offset_ms || 0, tz: meta.tz, merchant: { name: MERCHANT.name, tz: MERCHANT.tz },
    kpis: kpis(views), disputes: views,
    schema: { version: ENUMS.schema_version, operations: ENUMS.operations.length },
  };
}

// ------------------------------------------------------------ webhook intake
export const WEBHOOK_EVENTS = ['CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED'];

export async function ingestWebhook(store, sid, event, realNow, deps) {
  const meta = await ensureSession(store, sid, realNow, deps);
  const now = simNow(meta, realNow);
  if (!WEBHOOK_EVENTS.includes(event.event_type)) return { status: 202, body: { ignored: true, reason: `event_type ${event.event_type} not handled` } };
  const existing = await store.list(sid);
  if (event.event_type === 'CUSTOMER.DISPUTE.CREATED') {
    if (existing.length >= MAX_DISPUTES_PER_SESSION) return { status: 429, body: { error: `session limit of ${MAX_DISPUTES_PER_SESSION} disputes reached; reset the demo` } };
    const key = event.resource?.demo_template;
    const n = existing.filter((r) => r.fixture_key.startsWith('inr-signed-duvet') || r.fixture_key.startsWith('unauth-espresso')).length;
    const tmpl = incomingTemplates(realNow, n * 7 + Math.floor(realNow / 1000) % 7)[key];
    if (!tmpl) return { status: 400, body: { error: `unknown demo_template "${key}"; use one of ${Object.keys(incomingTemplates(realNow)).join(', ')}` } };
    const rec = createRecord(tmpl, now);
    rec.webhook = { event_id: event.id ?? `WH-${crypto.randomUUID().slice(0, 8)}`, event_type: event.event_type, received_at: iso(now), signature: 'unverified demo event (fixture only)' };
    addHistory(rec, now, 'paypal', 'webhook', `${event.event_type} received`);
    addTrace(rec, now, 'receive', `Dispute ${rec.id} received`, 'Queued for the agent. The board updates when the run finishes.', { kind: 'rule' });
    await store.put(sid, rec);
    const q = await dispatchAnalysis(store, sid, rec.id, realNow, deps);
    const after = q.queued ? rec : await store.get(sid, rec.id);
    return { status: q.queued ? 202 : 200, body: { dispute_id: rec.id, state: after.state, queued: q.queued } };
  }
  const res = event.resource ?? {};
  const rec = res.dispute_id ? existing.find((r) => r.id === res.dispute_id) : null;
  if (!rec) return { status: 404, body: { error: `no dispute ${res.dispute_id ?? '(missing resource.dispute_id)'} in this session` } };
  rec.__v = rec.version ?? 0;
  if (event.event_type === 'CUSTOMER.DISPUTE.RESOLVED') {
    if (TERMINAL.has(rec.state) && rec.state !== 'FILED') return { status: 200, body: { dispute_id: rec.id, state: rec.state, ignored: 'already closed' } };
    rec.state = 'RESOLVED';
    rec.outcome = { code: res.dispute_outcome?.outcome_code ?? 'RESOLVED_BUYER_FAVOUR', simulated: true, decided_at: iso(now), note: 'Resolved by PayPal event (fixture).' };
    addHistory(rec, now, 'paypal', 'resolved', rec.outcome.code);
  } else {
    await applyUpdate(rec, res, now, deps);
  }
  await save(store, sid, rec);
  return { status: 200, body: { dispute_id: rec.id, state: rec.state, stale_draft_refreshed: !!rec.refreshed_at } };
}

/** CUSTOMER.DISPUTE.UPDATED: a new due date and/or a new buyer message arrived after we may have drafted. */
export async function applyUpdate(rec, res, now, deps) {
  if (TERMINAL.has(rec.state) && rec.state !== 'FILED') { addHistory(rec, now, 'paypal', 'update_ignored', `update arrived after the dispute reached ${rec.state}`); return rec; }
  let changed = false;
  if (res.seller_response_due_date) {
    const due = parseInstant(res.seller_response_due_date);
    rec.due_at = iso(due); rec.paypal.seller_response_due_date = rec.due_at;
    addHistory(rec, now, 'paypal', 'deadline_changed', `Response due date is now ${rec.due_at}.`);
    if (rec.state === 'ESCALATED') setHandOver(rec, now);
    changed = true;
  }
  if (res.message) {
    rec.paypal.messages.push({ posted_by: 'BUYER', time_posted: iso(now), content: String(res.message).slice(0, 2000) });
    rec.buyer_claim = `${rec.buyer_claim}\n[Later message] ${String(res.message).slice(0, 2000)}`;
    addHistory(rec, now, 'paypal', 'buyer_message', String(res.message).slice(0, 200));
    if (rec.analysis && rec.state !== 'FILED') {
      addTrace(rec, now, 'update', 'Buyer added a message after the draft', 'The draft is stale; the agent is running again with the new message.', { kind: 'rule' });
      const prior = rec.analysis.score;
      rec.trace = rec.trace ?? [];
      rec.analysis = null; rec.state = 'NEW';
      await analyse(rec, now, deps); rec.analysis.origin = 'live';
      rec.refreshed_at = iso(now);
      addHistory(rec, now, 'agent', 'draft_refreshed', `Re-analysed after the update (score ${prior} -> ${rec.analysis.score}).`);
      if (rec.state === 'ANALYSED') await fileResponse(rec, now + 1000, { actor: 'agent' }, deps);
    } else if (rec.state === 'FILED') {
      addTrace(rec, now, 'update', 'Buyer message arrived after filing', 'The response is already with PayPal; nothing to refile. Flagged for the owner.', { kind: 'rule' });
    }
    changed = true;
  }
  if (!changed) addHistory(rec, now, 'paypal', 'updated', 'No deadline or message change.');
  return rec;
}

/** A verified, real PayPal event. Sandbox disputes have no merchant records here, so a person always decides. */
export async function ingestLiveEvent(store, event, realNow) {
  if (!WEBHOOK_EVENTS.includes(event.event_type)) return { status: 200, body: { ignored: true, event_type: event.event_type } };
  await store.putInbox?.({ id: event.id, event_type: event.event_type, received_at: iso(realNow), dispute_id: event.resource?.dispute_id ?? null, resource: event.resource ?? null });
  return { status: 200, body: { accepted: true, event_id: event.id, note: 'Verified and stored for the owner. No merchant records are connected to live sandbox disputes, so nothing is filed automatically.' } };
}

// ------------------------------------------------------------ actions
async function load(store, sid, id) {
  const rec = await store.get(sid, id);
  if (!rec) { const e = new Error(`dispute ${id} not found`); e.status = 404; throw e; }
  rec.__v = rec.version ?? 0;
  return rec;
}
/** Optimistic write: fails with 409 if another request changed the dispute since it was loaded. */
const save = (store, sid, rec) => { const v = rec.__v; delete rec.__v; return store.put(sid, rec, { expect: v }); };
const bad = (msg, status = 409) => { const e = new Error(msg); e.status = status; return e; };

export async function actAnalyse(store, sid, id, realNow, deps) {
  const meta = await ensureSession(store, sid, realNow, deps); const now = simNow(meta, realNow);
  const rec = await load(store, sid, id);
  if (TERMINAL.has(rec.state)) throw bad(`dispute is ${rec.state}; nothing to analyse`);
  if (rec.state === 'NEW') return { ...viewOf(rec, now, meta.tz), queued: true };
  rec.state = 'NEW'; rec.analysis = null; rec.trace = [];
  addTrace(rec, now, 'receive', `Re-run requested for ${rec.id}`, 'Queued for the agent. The board updates when the run finishes.', { kind: 'rule' });
  await save(store, sid, rec);
  const q = await dispatchAnalysis(store, sid, id, realNow, deps);
  const fresh = q.queued ? rec : await store.get(sid, id);
  return { ...viewOf(fresh, now, meta.tz), queued: q.queued };
}

export async function actFile(store, sid, id, body, realNow, deps) {
  const meta = await ensureSession(store, sid, realNow, deps); const now = simNow(meta, realNow);
  const rec = await load(store, sid, id);
  if (rec.state === 'FILED') {            // idempotent replay: same answer, nothing re-sent
    addTrace(rec, now, 'file', 'Replay suppressed', `A second file request arrived for ${rec.id}; the first filing stands (PayPal-Request-Id ${rec.filing?.request_id}).`, { kind: 'rule' });
    rec.filing.replays = (rec.filing.replays ?? 0) + 1;
    await save(store, sid, rec);
    return { ...viewOf(rec, now, meta.tz), idempotent_replay: true };
  }
  if (!['ESCALATED', 'ANALYSED'].includes(rec.state)) throw bad(`cannot file from state ${rec.state}`);
  if (now >= parseInstant(rec.due_at)) throw bad('the response window has closed');
  await fileResponse(rec, now, { actor: 'human', notesOverride: body?.notes }, deps);
  await save(store, sid, rec); return viewOf(rec, now, meta.tz);
}

export async function actAccept(store, sid, id, realNow, deps) {
  const meta = await ensureSession(store, sid, realNow, deps); const now = simNow(meta, realNow);
  const rec = await load(store, sid, id);
  if (TERMINAL.has(rec.state)) throw bad(`cannot accept from state ${rec.state}`);
  acceptClaim(rec, now, 'human');
  await save(store, sid, rec); return viewOf(rec, now, meta.tz);
}

export async function actAdjudicate(store, sid, id, realNow, deps) {
  const meta = await ensureSession(store, sid, realNow, deps); const now = simNow(meta, realNow);
  const rec = await load(store, sid, id);
  if (rec.state !== 'FILED') throw bad(`only filed disputes can be adjudicated (state ${rec.state})`);
  simulateAdjudication(rec, now);
  await save(store, sid, rec); return viewOf(rec, now, meta.tz);
}

/** What PayPal's own MCP-style agent would have done: accept_claim, nothing else. Pure preview; mutates nothing. */
export async function surrenderPreview(store, sid, id, realNow, deps) {
  const meta = await ensureSession(store, sid, realNow, deps);
  const rec = await load(store, sid, id);
  return {
    dispute_id: rec.id,
    tool: 'accept_dispute_claim',
    rest_equivalent: { method: 'POST', path: `/v1/customer/disputes/${rec.id}/accept-claim`, body: { note: 'Accepted via agent tool', accept_claim_type: 'REFUND' } },
    outcome: { code: 'RESOLVED_BUYER_FAVOUR', amount_refunded: rec.paypal.dispute_amount, merchandise_returned: false, simulated: true },
    note: 'This is a preview. Nothing was executed. The MCP tool list is as stated in the project brief; the MCP server itself was not inspected.',
    evidence_that_was_available: rec.analysis ? { score: rec.analysis.score, band: rec.analysis.band } : null,
  };
}

const TICK = 5 * 60_000; // the scheduled guard runs every 5 minutes
const nextTick = (ms) => Math.ceil(ms / TICK) * TICK;

/** Run the guard at every 5-minute tick where something would have become due, between two instants. */
async function runGuardBetween(store, sid, from, to, deps) {
  const acted = [];
  let t = from;
  for (let i = 0; i < 300; i++) {
    const recs = (await store.list(sid)).filter((r) => !TERMINAL.has(r.state));
    const cands = [];
    for (const r of recs) {
      const due = parseInstant(r.due_at);
      cands.push(due);
      if (r.state === 'ESCALATED') {
        cands.push(r.hand_over_at ? parseInstant(r.hand_over_at) : humanDeadline(r.opened_at, r.due_at).at_ms);
        if (!r.nudged) cands.push(due - 24 * HOUR);
      }
    }
    const next = cands.map(nextTick).filter((c) => c > t && c <= to).sort((a, b) => a - b)[0];
    if (next == null) break;
    t = next;
    acted.push(...(await sweepSession(store, sid, t, deps, { recs })).map((a) => ({ ...a, at: iso(t) })));
  }
  return acted;
}

/**
 * Move this visitor's demo clock forward. With the guard ON (default) the 5-minute guard is replayed across
 * the jump, so it acts at the instants it really would have. With guard "off" nothing runs, which is what
 * a human-only workflow looks like when nobody opens the inbox.
 */
export async function actClock(store, sid, body, realNow, deps) {
  const meta = await ensureSession(store, sid, realNow, deps);
  let acted = [];
  if (body?.reset) meta.clock_offset_ms = 0;
  else {
    const add = Number(body?.advance_ms);
    if (!Number.isFinite(add) || add < 0 || add > 14 * DAY) throw bad('advance_ms must be between 0 and 14 days', 400);
    const from = simNow(meta, realNow);
    const capped = Math.min(14 * DAY - (meta.clock_offset_ms || 0), add);
    if (body?.guard !== 'off' && capped > 0) acted = await runGuardBetween(store, sid, from, from + capped, deps);
    meta.clock_offset_ms = (meta.clock_offset_ms || 0) + capped;
  }
  await store.putMeta(sid, meta);
  return { clock_offset_ms: meta.clock_offset_ms, sim_now: iso(simNow(meta, realNow)), guard: body?.guard === 'off' ? 'off' : 'on', acted };
}

// ------------------------------------------------------------ the guard
/** Apply guardAction to every open dispute in one session. Returns what it did. */
export async function sweepSession(store, sid, now, deps, { recs } = {}) {
  const list = recs ?? await store.list(sid);
  const acted = [];
  for (const rec of list) {
    const g = guardAction(now, rec);
    if (g.action === 'none') continue;
    try {
      if (g.action === 'mark_missed') {
        rec.state = 'MISSED';
        rec.outcome = { code: 'RESOLVED_BUYER_FAVOUR', simulated: rec.source !== 'SANDBOX', default: true, decided_at: iso(now), note: 'The response window closed with nothing filed.' };
        addTrace(rec, now, 'guard', 'Deadline passed with nothing filed', g.reason, { kind: 'rule' });
        addHistory(rec, now, 'guard', 'missed', g.reason);
      } else if (g.action === 'run_agent') {
        if (now - Date.parse(rec.trace?.[0]?.t ?? rec.opened_at) < 3 * 60_000) continue;   // an async run is probably still in flight
        await analyse(rec, now, deps); rec.analysis.origin = 'live';
        if (rec.state === 'ANALYSED') await fileResponse(rec, now + 1000, { actor: 'agent' }, deps);
      } else if (g.action === 'file') {
        await fileResponse(rec, now, { actor: 'agent' }, deps);
      } else if (g.action === 'file_best_effort') {
        if (!rec.analysis?.evidence_payload) {
          // The guard never waits on a model: build the response from whatever evidence is on hand.
          const { items } = gather({ dispute: { amount: rec.paypal.dispute_amount.value, buyer_photos: rec.buyer_photos, opened_h: rec.opened_h }, txn: rec.txn, merchant: rec.merchant, _t0: rec.t0, _policy: MERCHANT.policies });
          const usable = items.filter((i) => i.quality === 'strong' || i.quality === 'partial');
          const notes = templateNotes(rec, items);
          rec.analysis = { ...(rec.analysis ?? {}), at: iso(now), items, origin: 'guard_template', score: rec.analysis?.score ?? 0, band: rec.analysis?.band ?? 'weak', checklist: rec.analysis?.checklist ?? [],
            classification: rec.analysis?.classification ?? { claim_theory: 'other', consistent_with_filed_reason: true, buyer_core_complaint: rec.buyer_claim.slice(0, 200), defence_strategy: '' },
            draft: { notes, cited: usable.map((i) => i.id), weaknesses: items.filter((i) => ['none', 'contradicts'].includes(i.quality)).map((i) => i.title), recommended_action: 'file', recommendation_reason: 'Built by the guard from the evidence on hand.', generator: 'template', model: null },
            route: rec.analysis?.route ?? { action: 'human_review', why: 'guard' } };
          rec.analysis.evidence_payload = buildEvidencePayload(items, { cited_evidence_ids: usable.map((i) => i.id), response_notes: notes });
        }
        if (rec.analysis?.evidence_payload) {
          addTrace(rec, now, 'guard', 'Hand-over point reached; filing the best honest response', g.reason, { kind: 'rule' });
          await fileResponse(rec, now, { actor: 'guard', bestEffort: true }, deps);
        }
      } else if (g.action === 'nudge_human') {
        rec.nudged = true;
        addTrace(rec, now, 'guard', 'Nudged the owner', g.reason, { kind: 'rule' });
        addHistory(rec, now, 'guard', 'nudged', g.reason);
      }
      acted.push({ id: rec.id, action: g.action, reason: g.reason, state: rec.state });
      await store.put(sid, rec);
    } catch (e) {
      acted.push({ id: rec.id, action: g.action, error: e.message });
    }
  }
  return acted;
}

export async function actSweep(store, sid, realNow, deps) {
  const meta = await ensureSession(store, sid, realNow, deps);
  const now = simNow(meta, realNow);
  const acted = await sweepSession(store, sid, now, deps);
  return { sim_now: iso(now), acted };
}

/** Scheduled entry point: sweeps every open dispute in every session, in deadline order. */
export async function sweepAll(store, realNow, deps) {
  const open = await store.openDue();
  const acted = [];
  for (const { sid, rec } of open) {
    const g = guardAction(realNow, rec);
    if (g.action === 'none') continue;
    const fresh = await store.get(sid, rec.id);
    if (!fresh) continue;
    acted.push(...(await sweepSession(store, sid, realNow, deps, { recs: [fresh] })));
  }
  let warmed = [];
  if (deps.useLlm) { try { warmed = await warmSeedCache(store, realNow, deps); } catch (e) { console.error('warm failed', e.message); } }
  return { at: iso(realNow), scanned: open.length, acted, warmed };
}

/** Pre-compute today's and tomorrow's seed analyses with the real agent, one fixture at a time. Run by the scheduled guard. */
export async function warmSeedCache(store, realNow, baseDeps) {
  const done = [];
  for (const anchor of [realNow, (Math.floor(realNow / DAY) + 1) * DAY + HOUR]) {
    for (const fx of buildFixtures(anchor)) {
      if (fx.seed.state === 'MISSED') continue;
      const rec = createRecord(fx, anchor);
      const key = cacheKey(rec.fixture_key, rec);
      if (await store.getCache(key)) continue;
      if (!(await baseDeps.budget())) return done;
      await analyseWithCache(store, rec, anchor, { ...baseDeps, warm: true });
      done.push(key);
    }
  }
  return done;
}
