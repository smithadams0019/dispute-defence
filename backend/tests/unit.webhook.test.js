import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { crc32, verifyLocal, verifyViaApi, signedString, certUrlAllowed } from '../src/webhook.js';
import { __resetTokenCache } from '../src/paypal.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const WEBHOOK_ID = '5GP028458E2496506';
const body = JSON.stringify({ id: 'WH-1', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { dispute_id: 'PP-D-1', dispute_amount: { value: '10.00' } } });

function signed(rawBody, over = {}) {
  const h = { 'paypal-transmission-id': 'tid-1', 'paypal-transmission-time': new Date().toISOString(), 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1', 'paypal-auth-algo': 'SHA256withRSA', ...over };
  const sig = crypto.createSign('RSA-SHA256').update(signedString(h, rawBody, WEBHOOK_ID)).sign(privateKey, 'base64');
  return { ...h, 'paypal-transmission-sig': sig };
}
const getKey = async () => publicKey;

test('crc32 matches the standard check value', () => { assert.equal(crc32('123456789'), 0xcbf43926); });

test('a correctly signed payload verifies locally', async () => {
  const r = await verifyLocal({ headers: signed(body), rawBody: body, webhookId: WEBHOOK_ID, getKey });
  assert.deepEqual(r, { ok: true, via: 'local' });
});

test('REJECTED: tampered body (amount changed after signing)', async () => {
  const headers = signed(body);
  const tampered = body.replace('10.00', '1000.00');
  const r = await verifyLocal({ headers, rawBody: tampered, webhookId: WEBHOOK_ID, getKey });
  assert.equal(r.ok, false); assert.match(r.reason, /does not match/);
});

test('REJECTED: signature made for another webhook id', async () => {
  const r = await verifyLocal({ headers: signed(body), rawBody: body, webhookId: 'SOMEONE-ELSES-ID', getKey });
  assert.equal(r.ok, false);
});

test('REJECTED: signature from a different key', async () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const r = await verifyLocal({ headers: signed(body), rawBody: body, webhookId: WEBHOOK_ID, getKey: async () => other.publicKey });
  assert.equal(r.ok, false);
});

test('REJECTED: cert url on a non-PayPal host or plain http (certificate substitution)', async () => {
  for (const u of ['https://evil.example.com/cert', 'http://api.paypal.com/cert', 'https://paypal.com.evil.io/cert', 'not a url']) {
    const r = await verifyLocal({ headers: signed(body, { 'paypal-cert-url': u }), rawBody: body, webhookId: WEBHOOK_ID, getKey });
    assert.equal(r.ok, false, u); assert.match(r.reason, /cert url/);
  }
  assert.equal(certUrlAllowed('https://api.paypal.com/v1/notifications/certs/X'), true);
  assert.equal(certUrlAllowed('https://api.sandbox.paypal.com/x'), true);
});

test('REJECTED: replayed old transmission (outside the one-hour window)', async () => {
  const old = new Date(Date.now() - 3 * 3600e3).toISOString();
  const r = await verifyLocal({ headers: signed(body, { 'paypal-transmission-time': old }), rawBody: body, webhookId: WEBHOOK_ID, getKey });
  assert.equal(r.ok, false); assert.match(r.reason, /replay/);
});

test('REJECTED: missing headers, unsupported SHA1 algo, unknown webhook id', async () => {
  assert.match((await verifyLocal({ headers: {}, rawBody: body, webhookId: WEBHOOK_ID, getKey })).reason, /missing headers/);
  assert.match((await verifyLocal({ headers: signed(body, { 'paypal-auth-algo': 'SHA1withRSA' }), rawBody: body, webhookId: WEBHOOK_ID, getKey })).reason, /unsupported/);
  assert.match((await verifyLocal({ headers: signed(body), rawBody: body, webhookId: '', getKey })).reason, /not configured/);
});

test('verifyViaApi posts the documented body and maps SUCCESS / FAILURE', async () => {
  __resetTokenCache();
  const seen = [];
  const mk = (status) => async (url, init) => {
    seen.push({ url, init });
    if (url.endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 't', scope: '', expires_in: 3000 }), { status: 200 });
    return new Response(JSON.stringify({ verification_status: status }), { status: 200 });
  };
  const env = { PAYPAL_CLIENT_ID: 'a', PAYPAL_SECRET: 'b', PAYPAL_API: 'https://api-m.sandbox.paypal.com' };
  const h = signed(body);
  const ok = await verifyViaApi({ headers: h, rawBody: body, webhookId: WEBHOOK_ID, env, fetchImpl: mk('SUCCESS') });
  assert.equal(ok.ok, true);
  const call = seen.find((s) => s.url.endsWith('/verify-webhook-signature'));
  const sent = JSON.parse(call.init.body);
  assert.equal(sent.webhook_id, WEBHOOK_ID); assert.equal(sent.transmission_id, 'tid-1'); assert.equal(sent.webhook_event.id, 'WH-1');
  __resetTokenCache();
  const bad = await verifyViaApi({ headers: h, rawBody: body, webhookId: WEBHOOK_ID, env, fetchImpl: mk('FAILURE') });
  assert.equal(bad.ok, false); assert.match(bad.reason, /FAILURE/);
});
