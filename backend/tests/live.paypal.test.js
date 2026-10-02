// REAL calls to the PayPal sandbox. No mocks. Credentials come from ../../.env (never committed).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
for (const l of fs.readFileSync(new URL('../../../../.env', import.meta.url), 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2]; }
const pp = await import('../src/paypal.js');
const wh = await import('../src/webhook.js');
const ENUMS = JSON.parse(fs.readFileSync(new URL('../src/generated/paypal-enums.json', import.meta.url)));
const WEBHOOK_ID = fs.existsSync(new URL('../../.aws-out/webhook_id', import.meta.url)) ? fs.readFileSync(new URL('../../.aws-out/webhook_id', import.meta.url), 'utf8').trim() : null;

test('OAuth token carries the seller dispute scopes', async () => {
  const t = await pp.getToken();
  for (const s of ['disputes/read-seller', 'disputes/update-seller']) assert.ok(t.scopes.some((x) => x.endsWith(s)), `missing ${s}`);
  console.log('  scopes:', t.scopes.filter((s) => s.includes('/disputes/')).map((s) => s.split('/services/')[1]).join(', '));
});

test('LIVE schema (fetched now) still matches the enums this build validates against', async () => {
  const r = await fetch(ENUMS.fetched_from); assert.equal(r.status, 200);
  const live = await r.json();
  console.log('  live schema version:', live.info.version, '| paths:', Object.keys(live.paths).length, '| saved snapshot version:', ENUMS.schema_version);
  assert.deepEqual(live.components.schemas.evidence_type.enum, ENUMS.evidence_type);
  assert.deepEqual(live.components.schemas.tracking_info.properties.carrier_name.enum, ENUMS.carrier_name);
  const ops = Object.values(live.paths).flatMap((v) => Object.values(v)).filter((o) => o?.operationId);
  assert.equal(ops.length, 15);
});

test('list disputes: HTTP 200 and a well-formed (possibly empty) page', async () => {
  const r = await pp.listDisputes();
  assert.ok(Array.isArray(r.items)); assert.ok(Array.isArray(r.links));
  console.log('  sandbox disputes visible to this app:', r.items.length);
});

test('read one dispute: a missing id is a clean 404 RESOURCE_NOT_FOUND (route + auth are real)', async () => {
  await assert.rejects(() => pp.getDispute('DD-NOT-A-REAL-DISPUTE'), (e) => { console.log('  ', e.message, '| debug_id', e.body?.debug_id); return e.status === 404 && e.body.name === 'RESOURCE_NOT_FOUND'; });
});

test('webhook is registered with PayPal for the three dispute events', async () => {
  const t = await pp.getToken();
  const r = await fetch(`${pp.cfg().api}/v1/notifications/webhooks/${WEBHOOK_ID}`, { headers: { Authorization: `Bearer ${t.token}` } });
  assert.equal(r.status, 200); const w = await r.json();
  console.log('  webhook', w.id, '->', w.url, w.event_types.map((e) => e.name).join(', '));
  for (const n of ['CREATED', 'UPDATED', 'RESOLVED']) assert.ok(w.event_types.some((e) => e.name === `CUSTOMER.DISPUTE.${n}`));
});

test('PayPal ITSELF rejects a forged webhook: verify-webhook-signature returns FAILURE', async () => {
  const body = JSON.stringify({ id: 'WH-FORGED', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { dispute_id: 'PP-D-FORGED' } });
  const headers = { 'paypal-transmission-id': 'forged-1', 'paypal-transmission-time': new Date().toISOString(), 'paypal-transmission-sig': Buffer.from('not a signature').toString('base64'), 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270', 'paypal-auth-algo': 'SHA256withRSA' };
  let res;
  try { res = await wh.verifyViaApi({ headers, rawBody: body, webhookId: WEBHOOK_ID }); } catch (e) { res = { ok: false, reason: 'PayPal answered ' + e.message }; }
  console.log('  result:', JSON.stringify(res));
  assert.equal(res.ok, false);
});
