// Hits the DEPLOYED Function URL and CloudFront URL. Real network, real Lambda, real DynamoDB, real Bedrock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync(new URL('../../.aws-out/urls.env', import.meta.url), 'utf8').trim().split('\n').map((l) => l.split('=')));
const FN = env.FUNCTION_URL.replace(/\/$/, ''), CF = env.CLOUDFRONT_URL.replace(/\/$/, '');
const sid = () => 'dep-' + Math.random().toString(36).slice(2, 12);
const get = async (base, path, s) => { const r = await fetch(base + path, { headers: s ? { 'x-session': s } : {} }); return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }; };
const post = async (base, path, s, body, extra = {}) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-session': s, ...extra }, body: JSON.stringify(body ?? {}) }); return { status: r.status, body: await r.json().catch(() => null) }; };

test('Function URL /api/health responds', async () => { const r = await get(FN, '/api/health'); console.log('  ', FN, r.status, JSON.stringify(r.body)); assert.equal(r.status, 200); assert.equal(r.body.store, 'dynamodb'); });
test('CloudFront serves the single-page app HTML', async () => { const r = await fetch(CF + '/'); const t = await r.text(); console.log('  ', CF, r.status, r.headers.get('content-type'), t.length, 'bytes'); assert.equal(r.status, 200); assert.match(t, /<div id="root"|<title>/); });
test('CloudFront routes /api/* to the Lambda (same origin, X-Session forwarded)', async () => { const r = await get(CF, '/api/health'); assert.equal(r.status, 200); const s = sid(); const st = await get(CF, '/api/state', s); assert.equal(st.status, 200); assert.equal(st.body.disputes.length, 6); });
test('PayPal sandbox status through the deployed Lambda: oauth ok, seller scopes present', async () => {
  const r = await get(CF, '/api/paypal/status'); console.log('  ', JSON.stringify(r.body));
  assert.equal(r.body.oauth, 'ok'); assert.ok(r.body.dispute_scopes.includes('disputes/update-seller'));
});
test('missing or malformed session header is rejected', async () => { assert.equal((await get(FN, '/api/state')).status, 400); assert.equal((await get(FN, '/api/state', 'bad one')).status, 400); });
test('two visitors do not see each other\'s changes (DynamoDB isolation)', async () => {
  const a = sid(), b = sid();
  await get(CF, '/api/state', a); await get(CF, '/api/state', b);
  await post(CF, '/api/disputes/FX-D-48219/accept', a);
  const sa = await get(CF, '/api/state', a), sb = await get(CF, '/api/state', b);
  assert.equal(sa.body.disputes.find((d) => d.id === 'FX-D-48219').state, 'ACCEPTED');
  assert.equal(sb.body.disputes.find((d) => d.id === 'FX-D-48219').state, 'ESCALATED');
});
test('state persists across requests (a reload finds the same board)', async () => {
  const s = sid(); await get(CF, '/api/state', s);
  await post(CF, '/api/demo/clock', s, { advance_ms: 3600e3 });
  const r = await get(CF, '/api/state', s); assert.equal(r.body.clock_offset_ms, 3600e3);
});
test('guard replay through the deployed stack: 4-day jump, guard on, nothing missed', async () => {
  const s = sid(); await get(CF, '/api/state', s);
  const r = await post(CF, '/api/demo/clock', s, { advance_ms: 4 * 86400e3 });
  console.log('  acted:', JSON.stringify(r.body.acted.map((a) => `${a.id} ${a.action}`)));
  const st = await get(CF, '/api/state', s); assert.equal(st.body.kpis.missed_with_agent, 0);
});
test('guard OFF through the deployed stack: the same jump loses disputes by default', async () => {
  const s = sid(); await get(CF, '/api/state', s);
  await post(CF, '/api/demo/clock', s, { advance_ms: 4 * 86400e3, guard: 'off' });
  await post(CF, '/api/guard/sweep', s);
  const st = await get(CF, '/api/state', s); console.log('  missed with guard off:', st.body.kpis.missed_with_agent); assert.ok(st.body.kpis.missed_with_agent >= 1);
});
test('FORGED PayPal webhook is rejected with 401 by the deployed Lambda (verified by PayPal)', async () => {
  const r = await post(CF, '/api/webhooks/paypal', sid(), { id: 'WH-FORGED', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { dispute_id: 'PP-D-FORGED' } },
    { 'paypal-transmission-id': 'x1', 'paypal-transmission-sig': Buffer.from('forged').toString('base64'), 'paypal-transmission-time': new Date().toISOString(), 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-x', 'paypal-auth-algo': 'SHA256withRSA' });
  console.log('  ', r.status, JSON.stringify(r.body)); assert.equal(r.status, 401);
});
test('unsigned webhook without the demo flag is rejected', async () => { assert.equal((await post(CF, '/api/webhooks/paypal', sid(), { event_type: 'CUSTOMER.DISPUTE.CREATED' })).status, 401); });
test('REAL AGENT, deployed: webhook returns 202 at once, then the Bedrock tool-using agent finishes the dispute', async () => {
  const s = sid(); await get(CF, '/api/state', s);
  const t0 = Date.now();
  const r = await post(CF, '/api/webhooks/paypal', s, { event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { demo_template: 'inr-signed' } }, { 'x-demo-event': '1' });
  const ack = Date.now() - t0;
  console.log('  ack in', ack, 'ms:', r.status, JSON.stringify(r.body));
  assert.equal(r.status, 202); assert.ok(ack < 5000);
  let d;
  for (let i = 0; i < 70; i++) {
    await new Promise((x) => setTimeout(x, 3000));
    d = (await get(CF, '/api/state', s)).body.disputes.find((x) => x.id === r.body.dispute_id);
    if (d.state !== 'NEW') break;
  }
  console.log('  finished after', Math.round((Date.now() - t0) / 1000), 's: state', d.state, 'score', d.analysis?.score, 'turns', d.analysis?.agent?.turns, 'decided_by', d.analysis?.route?.decided_by);
  console.log('  filing:', d.filing?.mode, d.filing?.request?.path, 'request_id', d.filing?.request_id);
  assert.equal(d.state, 'FILED'); assert.equal(d.analysis.draft.generator, 'bedrock'); assert.ok(d.analysis.agent.turns >= 3);
  // replay
  const again = await post(CF, `/api/disputes/${d.id}/file`, s);
  assert.equal(again.body.idempotent_replay, true);
});
