// PayPal webhook authentication. Two independent verifiers:
//  * verifyViaApi  - POST /v1/notifications/verify-webhook-signature (PayPal's own check; the production path)
//  * verifyLocal   - recompute the CRC32 of the raw body, rebuild the signed string, check the RSA-SHA256
//                    signature against the certificate named in PAYPAL-CERT-URL (https, *.paypal.com only).
// Nothing unauthenticated reaches the dispute code.
import crypto from 'node:crypto';
import { getToken, cfg, PayPalError } from './paypal.js';

const H = ['paypal-transmission-id', 'paypal-transmission-time', 'paypal-transmission-sig', 'paypal-cert-url', 'paypal-auth-algo'];

export function lowerHeaders(h) { return Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v])); }

export function missingHeaders(headers) { return H.filter((k) => !headers[k]); }

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of Buffer.from(buf)) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function certUrlAllowed(u) {
  try { const x = new URL(u); return x.protocol === 'https:' && /(^|\.)paypal\.com$/.test(x.hostname); } catch { return false; }
}

export function signedString(headers, rawBody, webhookId) {
  return `${headers['paypal-transmission-id']}|${headers['paypal-transmission-time']}|${webhookId}|${crc32(rawBody)}`;
}

/** @param getKey async (certUrl) => KeyObject | PEM string  (injectable so tests need no network) */
export async function verifyLocal({ headers, rawBody, webhookId, getKey = fetchCertKey, now = Date.now(), maxSkewMs = 60 * 60_000 }) {
  const h = lowerHeaders(headers);
  const miss = missingHeaders(h);
  if (miss.length) return { ok: false, reason: `missing headers: ${miss.join(', ')}` };
  if (!webhookId) return { ok: false, reason: 'webhook id not configured' };
  if (!certUrlAllowed(h['paypal-cert-url'])) return { ok: false, reason: 'cert url is not https on paypal.com' };
  const t = Date.parse(h['paypal-transmission-time']);
  if (!Number.isFinite(t) || Math.abs(now - t) > maxSkewMs) return { ok: false, reason: 'transmission time is outside the allowed window (replay protection)' };
  const algo = { SHA256withRSA: 'RSA-SHA256', SHA1withRSA: 'RSA-SHA1' }[h['paypal-auth-algo']];
  if (!algo || algo === 'RSA-SHA1') return { ok: false, reason: `unsupported auth algo ${h['paypal-auth-algo']}` };
  let key;
  try { key = await getKey(h['paypal-cert-url']); } catch (e) { return { ok: false, reason: 'certificate could not be fetched: ' + e.message }; }
  const ok = crypto.createVerify(algo).update(signedString(h, rawBody, webhookId)).verify(key, Buffer.from(h['paypal-transmission-sig'], 'base64'));
  return ok ? { ok: true, via: 'local' } : { ok: false, reason: 'signature does not match the payload' };
}

export async function fetchCertKey(url) {
  const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status);
  const x = new crypto.X509Certificate(await r.text());
  if (new Date(x.validTo) < new Date()) throw new Error('certificate expired');
  return x.publicKey;
}

export async function verifyViaApi({ headers, rawBody, webhookId, env = process.env, fetchImpl = fetch }) {
  const h = lowerHeaders(headers);
  const miss = missingHeaders(h);
  if (miss.length) return { ok: false, reason: `missing headers: ${miss.join(', ')}` };
  if (!webhookId) return { ok: false, reason: 'webhook id not configured' };
  let event; try { event = JSON.parse(rawBody); } catch { return { ok: false, reason: 'body is not JSON' }; }
  const t = await getToken(env, fetchImpl);
  const r = await fetchImpl(`${cfg(env).api}/v1/notifications/verify-webhook-signature`, {
    method: 'POST', headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_algo: h['paypal-auth-algo'], cert_url: h['paypal-cert-url'], transmission_id: h['paypal-transmission-id'], transmission_sig: h['paypal-transmission-sig'], transmission_time: h['paypal-transmission-time'], webhook_id: webhookId, webhook_event: event }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new PayPalError(r.status, body, 'verify-webhook-signature');
  return body.verification_status === 'SUCCESS' ? { ok: true, via: 'paypal-api' } : { ok: false, reason: `PayPal verification_status ${body.verification_status}`, via: 'paypal-api' };
}
