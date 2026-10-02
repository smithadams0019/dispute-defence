// Invokes the real handler in-process against a MemoryStore, with Bedrock DISABLED (rule/template path)
// except where a test says otherwise. Proves routing, session isolation, the pipeline, filing, the guard.
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.STORE = 'memory';
const { handler, __setStore } = await import('../src/handler.js');
const { MemoryStore } = await import('../src/store.js');
const svc = await import('../src/service.js');

const ev = (method, path, { sid = 'sess-test-0001', body, headers = {} } = {}) => ({
  requestContext: { http: { method, path } }, headers: { ...(sid ? { 'x-session': sid } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, isBase64Encoded: false,
});
const call = async (...a) => { const r = await handler(ev(...a)); return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, headers: r.headers }; };

const store = new MemoryStore(); __setStore(store);
process.env.DISABLE_LLM = '1'; // local suite never calls Bedrock

test('health + CORS preflight', async () => {
  const r = await call('GET', '/api/health', { sid: null });
  assert.equal(r.status, 200); assert.equal(r.body.ok, true);
  const o = await handler(ev('OPTIONS', '/api/state'));
  assert.equal(o.statusCode, 204); assert.equal(o.headers['access-control-allow-origin'], '*');
});

test('session header is required and validated', async () => {
  assert.equal((await call('GET', '/api/state', { sid: null })).status, 400);
  assert.equal((await call('GET', '/api/state', { sid: 'short' })).status, 400);
  assert.equal((await call('GET', '/api/state', { sid: 'has spaces and !!' })).status, 400);
});

test('unknown route is 404, bad JSON is 400', async () => {
  assert.equal((await call('GET', '/api/nope')).status, 404);
  const r = await handler({ requestContext: { http: { method: 'POST', path: '/api/guard/sweep' } }, headers: { 'x-session': 'sess-test-0001' }, body: '{oops' });
  assert.equal(r.statusCode, 400);
});

const byId = (st, id) => st.disputes.find((d) => d.id === id);

test('first load seeds 6 fixtures in the expected states with live deadlines', async () => {
  const r = await call('GET', '/api/state');
  assert.equal(r.status, 200);
  const st = r.body;
  assert.equal(st.disputes.length, 6);
  assert.equal(st.tz, 'America/Chicago');
  assert.equal(byId(st, 'FX-D-48201').state, 'FILED');
  assert.equal(byId(st, 'FX-D-48207').state, 'FILED');
  assert.equal(byId(st, 'FX-D-48213').state, 'ESCALATED');
  assert.equal(byId(st, 'FX-D-48219').state, 'ESCALATED');
  assert.equal(byId(st, 'FX-D-48224').state, 'FILED');
  assert.equal(byId(st, 'FX-D-48155').state, 'MISSED');
  assert.equal(st.kpis.most_urgent_id, 'FX-D-48213');
  assert.equal(st.kpis.needs_human, 2);
  assert.equal(st.kpis.lost_to_default_amount, '77.00');
  assert.equal(st.kpis.missed_with_agent, 0);
  // closest open deadline is ~3h40m away
  const d = byId(st, 'FX-D-48213').deadline;
  assert.ok(d.remaining_ms > 3.5 * 3600e3 && d.remaining_ms < 3.8 * 3600e3, `remaining ${d.remaining_ms}`);
  assert.equal(d.band, 'critical');
});

test('every fixture is labelled FIXTURE and every filing is a dry run, never "sent"', async () => {
  const st = (await call('GET', '/api/state')).body;
  for (const d of st.disputes) assert.equal(d.source, 'FIXTURE');
  for (const d of st.disputes.filter((x) => x.filing)) {
    assert.equal(d.filing.mode, 'FIXTURE_DRY_RUN'); assert.equal(d.filing.sent, false);
    assert.match(d.provenance.filing, /not sent/);
    assert.equal(d.filing.request.path, `/v1/customer/disputes/${d.id}/provide-evidence`);
    assert.equal(d.filing.request.content_type, 'multipart/form-data');
  }
});

test('strong evidence filed itself; weak evidence waited for a person; defence never invents', async () => {
  const st = (await call('GET', '/api/state')).body;
  assert.ok(byId(st, 'FX-D-48201').analysis.score >= 70);
  assert.ok(byId(st, 'FX-D-48213').analysis.score < 45);
  assert.equal(byId(st, 'FX-D-48213').analysis.route.action, 'human_review');
  // the porch case has contradicting items and the draft must not assert them
  const porch = byId(st, 'FX-D-48213').analysis;
  assert.ok(porch.items.some((i) => i.quality === 'contradicts'));
  assert.ok(porch.draft.weaknesses.length > 0);
});

test('guard: replayed across a clock jump, the guard files the porch case at its hand-over point, inside the window', async () => {
  let st = (await call('GET', '/api/state')).body;
  const p = byId(st, 'FX-D-48213');
  assert.equal(p.state, 'ESCALATED');
  assert.equal(p.deadline.hand_over_applies, true);
  const handOverIn = p.deadline.hand_over_remaining_ms;
  assert.ok(handOverIn > 1.5 * 3600e3 && handOverIn < 2.0 * 3600e3, `human window ${handOverIn}`);
  const adv = await call('POST', '/api/demo/clock', { body: { advance_ms: (2 * 60 + 50) * 60000 } });
  assert.equal(adv.status, 200);
  const act = adv.body.acted.find((a) => a.id === 'FX-D-48213');
  assert.equal(act?.action, 'file_best_effort', JSON.stringify(adv.body));
  st = (await call('GET', '/api/state')).body;
  const after = byId(st, 'FX-D-48213');
  assert.equal(after.state, 'FILED');
  assert.equal(after.filing.best_effort, true);
  assert.equal(after.filing.by, 'guard');
  assert.ok(after.filing.margin_ms > 3600e3 - 1, 'filed with at least the 1h floor to spare');
  assert.ok(after.filing.margin_ms < 2.1 * 3600e3, 'but only after the human window had run out');
});

test('guard OFF: jump past the deadline, switch the guard on, and the dispute is lost by default and counted', async () => {
  const sid = 'guardoff-visitor-09';
  await call('GET', '/api/state', { sid });
  const adv = await call('POST', '/api/demo/clock', { sid, body: { advance_ms: 4 * 86400e3, guard: 'off' } });
  assert.equal(adv.status, 200); assert.deepEqual(adv.body.acted, []);
  let st = (await call('GET', '/api/state', { sid })).body;
  assert.equal(byId(st, 'FX-D-48219').deadline.expired, true);
  assert.equal(byId(st, 'FX-D-48219').state, 'ESCALATED', 'nothing happened while the guard was off');
  const sw = await call('POST', '/api/guard/sweep', { sid });
  assert.ok(sw.body.acted.some((a) => a.id === 'FX-D-48219' && a.action === 'mark_missed'));
  st = (await call('GET', '/api/state', { sid })).body;
  assert.equal(byId(st, 'FX-D-48219').state, 'MISSED');
  assert.equal(byId(st, 'FX-D-48219').outcome.default, true);
  assert.equal(st.kpis.missed_with_agent, 2);
  assert.equal(st.kpis.lost_to_default_count, 3);
});

test('guard ON: the same 4-day jump loses nothing, everything unfiled is filed before it lapses', async () => {
  const sid = 'guardon-visitor-10';
  await call('GET', '/api/state', { sid });
  const adv = await call('POST', '/api/demo/clock', { sid, body: { advance_ms: 4 * 86400e3 } });
  const filed = adv.body.acted.filter((a) => a.action === 'file_best_effort').map((a) => a.id).sort();
  assert.deepEqual(filed, ['FX-D-48213', 'FX-D-48219']);
  const st = (await call('GET', '/api/state', { sid })).body;
  assert.equal(st.kpis.missed_with_agent, 0);
  for (const id of filed) assert.ok(byId(st, id).filing.margin_ms > 0);
});

test('session isolation: another visitor gets a fresh, untouched board', async () => {
  const st = (await call('GET', '/api/state', { sid: 'other-visitor-02' })).body;
  assert.equal(byId(st, 'FX-D-48213').state, 'ESCALATED');
  assert.equal(st.clock_offset_ms, 0);
});

test('human path: accept is a person-only action and closes the dispute in the buyer favour', async () => {
  const sid = 'accept-visitor-03';
  await call('GET', '/api/state', { sid });
  const r = await call('POST', '/api/disputes/FX-D-48219/accept', { sid });
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'ACCEPTED');
  assert.equal(r.body.outcome.code, 'RESOLVED_BUYER_FAVOUR');
  const again = await call('POST', '/api/disputes/FX-D-48219/accept', { sid });
  assert.equal(again.status, 409);
});

test('human path: filing from ESCALATED with edited notes, then simulated adjudication is labelled simulated', async () => {
  const sid = 'file-visitor-04';
  await call('GET', '/api/state', { sid });
  const f = await call('POST', '/api/disputes/FX-D-48213/file', { sid, body: { notes: 'Edited by owner: FedEx 774609881246 shows a porch delivery with a photo on file.' } });
  assert.equal(f.status, 200); assert.equal(f.body.state, 'FILED'); assert.equal(f.body.filing.by, 'human');
  assert.match(f.body.filing.request.input.evidences[0].notes, /Edited by owner/);
  const a = await call('POST', '/api/disputes/FX-D-48213/adjudicate', { sid });
  assert.equal(a.status, 200); assert.equal(a.body.outcome.simulated, true);
  assert.equal(a.body.outcome.code, 'RESOLVED_BUYER_FAVOUR', 'a 30/100 case loses even when filed, and the UI says so');
  assert.equal((await call('POST', '/api/disputes/FX-D-48201/adjudicate', { sid })).body.outcome.code, 'RESOLVED_SELLER_FAVOUR');
});

test('cannot file after the deadline', async () => {
  const sid = 'late-visitor-05';
  await call('GET', '/api/state', { sid });
  await call('POST', '/api/demo/clock', { sid, body: { advance_ms: 5 * 3600e3, guard: 'off' } });
  const r = await call('POST', '/api/disputes/FX-D-48213/file', { sid });
  assert.equal(r.status, 409); assert.match(r.body.error, /closed/);
});

test('webhook: unsigned events rejected without the demo flag; CREATED with a template runs the whole pipeline and files', async () => {
  const sid = 'hook-visitor-06';
  await call('GET', '/api/state', { sid });
  const noFlag = await call('POST', '/api/webhooks/paypal', { sid, body: { event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { demo_template: 'inr-signed' } } });
  assert.equal(noFlag.status, 401);
  const ok = await call('POST', '/api/webhooks/paypal', { sid, headers: { 'x-demo-event': '1' }, body: { event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { demo_template: 'inr-signed' } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.state, 'FILED');
  const st = (await call('GET', '/api/state', { sid })).body;
  assert.equal(st.disputes.length, 7);
  const bad = await call('POST', '/api/webhooks/paypal', { sid, headers: { 'x-demo-event': '1' }, body: { event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { demo_template: 'nope' } } });
  assert.equal(bad.status, 400);
  const ign = await call('POST', '/api/webhooks/paypal', { sid, headers: { 'x-demo-event': '1' }, body: { event_type: 'PAYMENT.SALE.COMPLETED' } });
  assert.equal(ign.status, 202);
});

test('surrender preview mutates nothing and names the single write the MCP agent has', async () => {
  const sid = 'surr-visitor-07';
  const before = (await call('GET', '/api/state', { sid })).body;
  const r = await call('GET', '/api/disputes/FX-D-48201/surrender', { sid });
  assert.equal(r.status, 200);
  assert.equal(r.body.tool, 'accept_dispute_claim');
  assert.equal(r.body.rest_equivalent.path, '/v1/customer/disputes/FX-D-48201/accept-claim');
  const after = (await call('GET', '/api/state', { sid })).body;
  assert.deepEqual(after.disputes.map((d) => d.state), before.disputes.map((d) => d.state));
});

test('clock endpoint rejects absurd input; reset restores seed', async () => {
  const sid = 'clock-visitor-08';
  await call('GET', '/api/state', { sid });
  assert.equal((await call('POST', '/api/demo/clock', { sid, body: { advance_ms: -5 } })).status, 400);
  assert.equal((await call('POST', '/api/demo/clock', { sid, body: { advance_ms: 99 * 86400e3 } })).status, 400);
  await call('POST', '/api/demo/clock', { sid, body: { advance_ms: 3600e3 } });
  const r = await call('POST', '/api/demo/reset', { sid });
  assert.equal(r.body.clock_offset_ms, 0);
});

test('scheduled EventBridge invocation sweeps open disputes across sessions', async () => {
  const out = await handler({ source: 'aws.events', 'detail-type': 'Scheduled Event' });
  assert.ok(typeof out.scanned === 'number');
  assert.ok(Array.isArray(out.acted));
});

test('DISPUTE.UPDATED with a new due date moves the deadline and recomputes the hand-over point', async () => {
  const sid = 'upd-visitor-11';
  const before = byId((await call('GET', '/api/state', { sid })).body, 'FX-D-48219');
  const newDue = new Date(Date.parse(before.due_at) + 2 * 86400e3).toISOString();
  const r = await call('POST', '/api/webhooks/paypal', { sid, headers: { 'x-demo-event': '1' }, body: { event_type: 'CUSTOMER.DISPUTE.UPDATED', resource: { dispute_id: 'FX-D-48219', seller_response_due_date: newDue } } });
  assert.equal(r.status, 200);
  const after = byId((await call('GET', '/api/state', { sid })).body, 'FX-D-48219');
  assert.equal(after.due_at, newDue);
  assert.ok(after.deadline.remaining_ms > before.deadline.remaining_ms + 1.9 * 86400e3);
  assert.ok(Date.parse(after.deadline.hand_over_at) > Date.parse(before.deadline.hand_over_at));
});

test('dispute UPDATED after a draft exists: the stale draft is rebuilt with the new buyer message', async () => {
  const sid = 'upd-visitor-12';
  const before = byId((await call('GET', '/api/state', { sid })).body, 'FX-D-48219');
  const r = await call('POST', '/api/webhooks/paypal', { sid, headers: { 'x-demo-event': '1' }, body: { event_type: 'CUSTOMER.DISPUTE.UPDATED', resource: { dispute_id: 'FX-D-48219', message: 'Update: the second charge has now been refunded by my bank.' } } });
  assert.equal(r.status, 200); assert.equal(r.body.stale_draft_refreshed, true);
  const after = byId((await call('GET', '/api/state', { sid })).body, 'FX-D-48219');
  assert.ok(after.history.some((h) => h.event === 'buyer_message'));
  assert.ok(after.history.some((h) => h.event === 'draft_refreshed'));
  assert.ok(after.trace.some((t) => t.step === 'update'));
  assert.notEqual(after.analysis.at, before.analysis.at);
});

test('dispute UPDATED after it was already filed: nothing is refiled, the owner is told', async () => {
  const sid = 'upd-visitor-13';
  await call('GET', '/api/state', { sid });
  const r = await call('POST', '/api/webhooks/paypal', { sid, headers: { 'x-demo-event': '1' }, body: { event_type: 'CUSTOMER.DISPUTE.UPDATED', resource: { dispute_id: 'FX-D-48201', message: 'Still nothing here.' } } });
  assert.equal(r.status, 200);
  const d = byId((await call('GET', '/api/state', { sid })).body, 'FX-D-48201');
  assert.equal(d.state, 'FILED'); assert.equal(d.filing.replays ?? 0, 0);
  assert.ok(d.trace.some((t) => /after filing/.test(t.label)));
});

test('dispute UPDATED after it was missed is ignored with a history note', async () => {
  const sid = 'upd-visitor-14';
  await call('GET', '/api/state', { sid });
  const r = await call('POST', '/api/webhooks/paypal', { sid, headers: { 'x-demo-event': '1' }, body: { event_type: 'CUSTOMER.DISPUTE.UPDATED', resource: { dispute_id: 'FX-D-48155', seller_response_due_date: new Date(Date.now() + 5 * 86400e3).toISOString() } } });
  assert.equal(r.status, 200);
  const d = byId((await call('GET', '/api/state', { sid })).body, 'FX-D-48155');
  assert.equal(d.state, 'MISSED');
  assert.ok(d.history.some((h) => h.event === 'update_ignored'));
});

test('replayed file request over HTTP: second call is an idempotent no-op', async () => {
  const sid = 'idem-visitor-15';
  await call('GET', '/api/state', { sid });
  const a = await call('POST', '/api/disputes/FX-D-48213/file', { sid });
  const b = await call('POST', '/api/disputes/FX-D-48213/file', { sid });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(b.body.idempotent_replay, true);
  assert.equal(b.body.filing.request_id, a.body.filing.request_id);
  assert.equal(b.body.filing.at, a.body.filing.at, 'the original filing stands');
});

test('webhook with PayPal signature headers is verified before anything else; a failed verification is a 401 and stores nothing', async () => {
  const { __setVerifier } = await import('../src/handler.js');
  const sid = 'sig-visitor-16';
  const hdr = { 'paypal-transmission-id': 't', 'paypal-transmission-sig': 'bad', 'paypal-transmission-time': new Date().toISOString(), 'paypal-cert-url': 'https://api.sandbox.paypal.com/c', 'paypal-auth-algo': 'SHA256withRSA' };
  __setVerifier(async () => ({ ok: false, reason: 'PayPal verification_status FAILURE' }));
  const r = await call('POST', '/api/webhooks/paypal', { sid, headers: hdr, body: { id: 'WH-X', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { dispute_id: 'PP-D-1' } } });
  assert.equal(r.status, 401); assert.match(r.body.error, /rejected/);
  assert.equal((await store.listInbox()).length, 0);
  __setVerifier(async () => ({ ok: true, via: 'paypal-api' }));
  const ok = await call('POST', '/api/webhooks/paypal', { sid, headers: hdr, body: { id: 'WH-Y', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { dispute_id: 'PP-D-2' } } });
  assert.equal(ok.status, 200); assert.equal((await store.listInbox()).length, 1);
  __setVerifier(null);
});

test('optimistic locking: a stale writer gets 409 instead of silently overwriting', async () => {
  const { MemoryStore } = await import('../src/store.js');
  const s = new MemoryStore();
  await s.put('s', { id: 'd', state: 'NEW' });
  const a = await s.get('s', 'd'), b = await s.get('s', 'd');
  await s.put('s', a, { expect: a.version });
  await assert.rejects(() => s.put('s', b, { expect: b.version }), /changed underneath/);
});

test('queued path (as deployed): webhook returns 202 with the dispute in NEW; the async job then completes it; the sweeper leaves a fresh NEW alone', async () => {
  const svc2 = await import('../src/service.js');
  const sid = 'queue-visitor-17';
  const jobs = [];
  const deps = { ...svc2.makeDeps(store), invokeAsync: async (p) => { jobs.push(p); } };
  await svc2.ensureSession(store, sid, Date.now(), deps);
  const r = await svc2.ingestWebhook(store, sid, { event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { demo_template: 'unauthorised' } }, Date.now(), deps);
  assert.equal(r.status, 202); assert.equal(r.body.queued, true); assert.equal(r.body.state, 'NEW');
  assert.equal(jobs.length, 1); assert.equal(jobs[0].job, 'analyse');
  const sweep = await svc2.actSweep(store, sid, Date.now(), deps);
  assert.ok(!sweep.acted.some((a) => a.id === jobs[0].id), 'sweeper does not race a run that is still in flight');
  const done = await svc2.runAnalysisJob(store, sid, jobs[0].id, Date.now(), svc2.makeDeps(store));
  assert.equal(done.state, 'FILED');
  assert.deepEqual(await svc2.runAnalysisJob(store, sid, jobs[0].id, Date.now(), svc2.makeDeps(store)), { skipped: 'state FILED' }, 'a duplicate job is a no-op');
});

test('handler routes the {job:"analyse"} self-invocation', async () => {
  const r = await handler({ job: 'analyse', sid: 'no-such-session', id: 'PP-D-0' });
  assert.deepEqual(r, { skipped: 'no session' });
});

test('guard files best-effort even when the agent escalated without ever drafting, and never calls a model to do it', async () => {
  const sid = 'nodraft-visitor-18';
  const svc3 = await import('../src/service.js');
  await call('GET', '/api/state', { sid });
  const rec = await store.get(sid, 'FX-D-48213');
  rec.analysis.evidence_payload = null; rec.analysis.draft.notes = ''; rec.analysis.draft.cited = [];
  await store.put(sid, rec);
  const deps = { ...svc3.makeDeps(store), useLlm: true, converseTurn: async () => { throw new Error('guard must not call a model'); }, budget: async () => { throw new Error('guard must not spend model budget'); } };
  const meta = await store.getMeta(sid);
  const out = await svc3.sweepSession(store, sid, Date.parse(rec.due_at) - 30 * 60000, deps);
  assert.equal(out.find((a) => a.id === 'FX-D-48213').action, 'file_best_effort');
  const after = await store.get(sid, 'FX-D-48213');
  assert.equal(after.state, 'FILED'); assert.equal(after.filing.best_effort, true);
  assert.equal(after.analysis.draft.generator, 'template');
});
