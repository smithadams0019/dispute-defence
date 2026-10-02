import test from 'node:test';
import assert from 'node:assert/strict';
import { requestIdFor, provideEvidence, __resetTokenCache } from '../src/paypal.js';
import { fileResponse } from '../src/agent.js';
import { createRecord } from '../src/records.js';
import { buildFixtures } from '../src/fixtures.js';
import { analyseDeterministic } from '../src/agent.js';

const payload = { evidences: [{ evidence_type: 'PROOF_OF_FULFILLMENT', evidence_info: { tracking_info: [{ carrier_name: 'FEDEX', tracking_number: '774612308811' }] }, notes: 'Delivered' }] };

test('request id is deterministic per (operation, dispute, body) and changes with any of them', () => {
  const a = requestIdFor('provide-evidence', 'PP-D-1', payload);
  assert.equal(a, requestIdFor('provide-evidence', 'PP-D-1', structuredClone(payload)));
  assert.notEqual(a, requestIdFor('provide-evidence', 'PP-D-2', payload));
  assert.notEqual(a, requestIdFor('accept-claim', 'PP-D-1', payload));
  assert.notEqual(a, requestIdFor('provide-evidence', 'PP-D-1', { evidences: [{ ...payload.evidences[0], notes: 'x' }] }));
  assert.ok(a.length <= 108, 'PayPal-Request-Id limit');
});

test('every mutating PayPal call carries PayPal-Request-Id; reads do not', async () => {
  __resetTokenCache();
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, method: init.method, headers: init.headers });
    if (url.endsWith('/token')) return new Response(JSON.stringify({ access_token: 't', scope: '', expires_in: 3000 }));
    return new Response(JSON.stringify({ links: [] }), { status: 200, headers: { 'paypal-debug-id': 'dbg' } });
  };
  const env = { PAYPAL_CLIENT_ID: 'a', PAYPAL_SECRET: 'b', PAYPAL_API: 'https://api-m.sandbox.paypal.com' };
  await provideEvidence('PP-D-1', payload, { env, fetchImpl });
  const post = seen.find((s) => s.method === 'POST' && s.url.includes('provide-evidence'));
  assert.equal(post.headers['PayPal-Request-Id'], requestIdFor('provide-evidence', 'PP-D-1', payload));
});

test('a replayed filing does not send a second request to PayPal', async () => {
  const t0 = Date.now();
  const fx = buildFixtures(t0)[0];
  const rec = createRecord(fx, t0, { source: 'SANDBOX' });          // SANDBOX source => the real send path
  await analyseDeterministic(rec, t0, { useLlm: false, budget: async () => true });
  let sends = 0; const ids = [];
  const deps = { provideEvidence: async (id, p, o) => { sends++; ids.push(o.requestId); return { status: 200, body: { ok: 1 }, debug_id: 'd' }; } };
  await fileResponse(rec, t0, { actor: 'agent' }, deps);
  assert.equal(rec.state, 'FILED'); assert.equal(rec.filing.mode, 'LIVE_SANDBOX'); assert.equal(sends, 1);
  rec.state = 'ESCALATED';                                            // simulate a retry path that re-enters filing
  await fileResponse(rec, t0 + 5000, { actor: 'guard', bestEffort: true }, deps);
  await fileResponse(rec, t0 + 9000, { actor: 'human' }, deps);
  assert.equal(sends, 1, 'PayPal was called exactly once');
  assert.equal(rec.filing.replays, 2);
  assert.equal(ids[0], rec.filing.request_id);
});

test('a PayPal rejection leaves the dispute ESCALATED and never claims it was filed', async () => {
  const t0 = Date.now();
  const rec = createRecord(buildFixtures(t0)[0], t0, { source: 'SANDBOX' });
  await analyseDeterministic(rec, t0, { useLlm: false, budget: async () => true });
  const e = Object.assign(new Error('PayPal POST -> HTTP 422 UNPROCESSABLE_ENTITY'), { body: { name: 'UNPROCESSABLE_ENTITY' } });
  await fileResponse(rec, t0, { actor: 'agent' }, { provideEvidence: async () => { throw e; } });
  assert.equal(rec.state, 'ESCALATED'); assert.equal(rec.filing, null); assert.ok(rec.filing_error);
});
