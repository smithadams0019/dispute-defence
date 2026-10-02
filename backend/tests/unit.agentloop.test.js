// The tool-using agent, driven by a scripted fake model so the behaviour is deterministic.
// This tests OUR rules around the model (refusals, grounding, turn cap), not the model's intelligence;
// the real-model runs are in TEST-RESULTS.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop, MAX_TURNS } from '../src/agentloop.js';
import { createRecord } from '../src/records.js';
import { buildFixtures } from '../src/fixtures.js';

const fixture = (key) => buildFixtures(Date.now()).find((f) => f.key === key);
const use = (name, input = {}, n = 1) => ({ toolUse: { toolUseId: `${name}-${Math.random()}`, name, input } });
const turn = (...blocks) => ({ message: { role: 'assistant', content: blocks }, stopReason: 'tool_use', usage: {}, ms: 1, model: 'fake' });
const script = (turns) => { let i = 0; const seen = []; return { fn: async ({ messages }) => { seen.push(messages.at(-1)); return turns[i++] ?? turn({ text: 'done' }); }, seen, calls: () => i }; };
const deps = (s) => ({ useLlm: true, budget: async () => true, converseTurn: s.fn });
const results = (s) => s.seen.flatMap((m) => (m.content ?? []).filter((c) => c.toolResult).map((c) => c.toolResult));

test('weak case: the agent gathers, assesses, sees "weak" and escalates instead of filing', async () => {
  const t = Date.now(); const rec = createRecord(fixture('inr-porch-skillet'), t);
  const s = script([
    turn(use('get_dispute'), use('get_requirements')),
    turn(use('get_delivery_evidence'), use('get_communications')),
    turn(use('assess_evidence')),
    turn(use('escalate_to_human', { reason: 'Delivery went to a different street number and the carrier logged an exception.', recommend: 'file' })),
  ]);
  await runAgentLoop(rec, t, deps(s));
  assert.equal(rec.state, 'ESCALATED');
  assert.equal(rec.analysis.route.decided_by, 'agent');
  assert.match(rec.analysis.route.why, /different street number/);
  assert.ok(rec.analysis.score < 45);
  assert.ok(rec.hand_over_at, 'hand-over point fixed at escalation');
  assert.equal(rec.analysis.agent.turns, 4);
  // it never drafted, but a person (or the guard) still gets an honest, editable draft and a valid request
  assert.equal(rec.analysis.draft.generator, 'template');
  assert.ok(rec.analysis.evidence_payload?.evidences?.length >= 2);
  assert.ok(rec.analysis.draft.notes.length > 50);
});

test('server policy refuses a hopeless filing even if the model insists, then the model escalates', async () => {
  const t = Date.now(); const rec = createRecord(fixture('inr-porch-skillet'), t);
  const s = script([
    turn(use('get_delivery_evidence')),
    turn(use('submit_draft', { response_notes: 'FedEx delivered the parcel.', cited_evidence_ids: ['E1'], weaknesses: [] })),
    turn(use('file_response')),
    turn(use('escalate_to_human', { reason: 'Policy refused filing.', recommend: 'accept' })),
  ]);
  await runAgentLoop(rec, t, deps(s));
  const refusal = results(s).find((r) => /filing floor/.test(JSON.stringify(r.content)));
  assert.ok(refusal, 'file_response was refused'); assert.equal(refusal.status, 'error');
  assert.equal(rec.state, 'ESCALATED');
});

test('strong case: gathers, drafts, files; only what it fetched is cited and scored', async () => {
  const t = Date.now(); const rec = createRecord(fixture('inr-signed-walnut'), t);
  const s = script([
    turn(use('get_requirements'), use('get_order'), use('get_delivery_evidence')),
    turn(use('assess_evidence')),
    turn(use('submit_draft', { response_notes: 'Order HH-20417 shipped via FedEx tracking 774612308811 and was signed for.', cited_evidence_ids: ['E1', 'E2', 'E3'], weaknesses: [] })),
    turn(use('file_response')),
  ]);
  await runAgentLoop(rec, t, deps(s));
  assert.equal(rec.state, 'ANALYSED');
  assert.equal(rec.analysis.route.action, 'auto_file');
  assert.deepEqual(rec.analysis.agent.fetched.sort(), ['address', 'delivery_scan', 'exception', 'order', 'signature', 'sku_match'].sort());
  // it never asked for comms, so the buyer_comms line is honestly unchecked and the score reflects it
  assert.ok(!rec.analysis.items.some((i) => i.kind === 'buyer_comms'));
  assert.equal(rec.analysis.evidence_payload.evidences[0].evidence_type, 'MERCHANT_RESPONSE');
});

test('grounding: a draft with an invented amount or tracking number is rejected, and the corrected one is accepted', async () => {
  const t = Date.now(); const rec = createRecord(fixture('inr-signed-walnut'), t);
  const s = script([
    turn(use('get_delivery_evidence')),
    turn(use('submit_draft', { response_notes: 'Shipped with tracking 999999999999 for $500.00. Call 1-800-463-3339.', cited_evidence_ids: ['E1'], weaknesses: [] })),
    turn(use('submit_draft', { response_notes: 'Shipped with tracking 774612308811.', cited_evidence_ids: ['E1', 'E99'], weaknesses: [] })),
    turn(use('submit_draft', { response_notes: 'Shipped with tracking 774612308811.', cited_evidence_ids: ['E1'], weaknesses: [] })),
    turn(use('file_response')),
  ]);
  await runAgentLoop(rec, t, deps(s));
  const rs = results(s);
  const rej1 = rs.find((r) => /do not appear in the evidence/.test(JSON.stringify(r.content)));
  assert.ok(rej1); assert.match(JSON.stringify(rej1.content), /999999999999/); assert.match(JSON.stringify(rej1.content), /\$500\.00/); assert.match(JSON.stringify(rej1.content), /463-3339/);
  assert.ok(rs.find((r) => /you have not fetched: E99/.test(JSON.stringify(r.content))));
  assert.equal(rec.state, 'ANALYSED');
});

test('turn cap: a model that never decides is cut off at MAX_TURNS and the loop reports no decision', async () => {
  const t = Date.now(); const rec = createRecord(fixture('inr-signed-walnut'), t);
  const s = script(Array.from({ length: 30 }, () => turn(use('get_order'))));
  const out = await runAgentLoop(rec, t, deps(s));
  assert.equal(out, null);
  assert.equal(s.calls(), MAX_TURNS);
});

test('duplicate charge: the agent recommends accept and the dispute waits for a person (refunds are never autonomous)', async () => {
  const t = Date.now(); const rec = createRecord(fixture('dup-planter'), t);
  const s = script([
    turn(use('get_payment_records'), use('get_delivery_evidence')),
    turn(use('assess_evidence')),
    turn(use('escalate_to_human', { reason: 'Order HH-20403 is an identical retry order that never shipped; the buyer was charged twice.', recommend: 'accept' })),
  ]);
  await runAgentLoop(rec, t, deps(s));
  assert.equal(rec.state, 'ESCALATED'); assert.equal(rec.analysis.draft.recommended_action, 'accept');
  assert.equal(rec.analysis.score, 0);
});

test('budget exhausted mid-run: returns null so the caller falls back to the deterministic pipeline', async () => {
  const t = Date.now(); const rec = createRecord(fixture('inr-signed-walnut'), t);
  const out = await runAgentLoop(rec, t, { useLlm: true, budget: async () => false, converseTurn: async () => { throw new Error('should not be called'); } });
  assert.equal(out, null);
});
