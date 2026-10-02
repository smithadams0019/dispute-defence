// Direct PayPal Disputes REST client (NOT the MCP server). Sandbox or live is decided by PAYPAL_API.
import crypto from 'node:crypto';
import ENUMS from './generated/paypal-enums.json' with { type: 'json' };

const CARRIERS = new Set(ENUMS.carrier_name);
const EVIDENCE_TYPES = new Set(ENUMS.evidence_type);

export class PayPalError extends Error {
  constructor(status, body, where) {
    super(`PayPal ${where} -> HTTP ${status} ${body?.name ?? ''} ${body?.message ?? ''}`.trim());
    this.status = status; this.body = body; this.where = where;
  }
}

let tokenCache = null;

export function cfg(env = process.env) {
  return {
    api: env.PAYPAL_API || 'https://api-m.sandbox.paypal.com',
    id: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_SECRET,
  };
}

export const __resetTokenCache = () => { tokenCache = null; };

export async function getToken(env = process.env, fetchImpl = fetch) {
  const c = cfg(env);
  if (!c.id || !c.secret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_SECRET not configured');
  if (tokenCache && tokenCache.key === c.id + c.api && tokenCache.exp > Date.now() + 60_000) return tokenCache;
  const r = await fetchImpl(`${c.api}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${c.id}:${c.secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new PayPalError(r.status, body, 'oauth2/token');
  tokenCache = { key: c.id + c.api, token: body.access_token, scopes: String(body.scope || '').split(' '), exp: Date.now() + body.expires_in * 1000 };
  return tokenCache;
}

async function call(method, path, { env = process.env, fetchImpl = fetch, json, form, query, requestId } = {}) {
  const c = cfg(env);
  const t = await getToken(env, fetchImpl);
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const headers = { Authorization: `Bearer ${t.token}` };
  if (requestId && method !== 'GET') headers['PayPal-Request-Id'] = requestId;
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form; // FormData sets its own boundary header
  const r = await fetchImpl(`${c.api}${path}${qs}`, { method, headers, body });
  const text = await r.text();
  let parsed; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!r.ok) throw new PayPalError(r.status, parsed, `${method} ${path}`);
  return { status: r.status, body: parsed, debug_id: r.headers.get('paypal-debug-id') };
}

/** Deterministic PayPal-Request-Id: the same operation on the same dispute with the same body always yields the same id. */
export function requestIdFor(op, disputeId, body) {
  return 'dd-' + crypto.createHash('sha256').update(JSON.stringify([op, disputeId, body])).digest('hex').slice(0, 48);
}

export const listDisputes = (opts = {}, query = { page_size: '20' }) => call('GET', '/v1/customer/disputes', { ...opts, query }).then((r) => r.body);
export const getDispute = (id, opts = {}) => call('GET', `/v1/customer/disputes/${encodeURIComponent(id)}`, opts).then((r) => r.body);

/**
 * Validate an evidences payload against enums taken from the LIVE schema.
 * Returns a list of problems (empty = valid).
 */
export function validateEvidences(payload) {
  const problems = [];
  const list = payload?.evidences;
  if (!Array.isArray(list) || list.length === 0) return ['evidences must be a non-empty array'];
  list.forEach((e, i) => {
    const at = `evidences[${i}]`;
    if (!EVIDENCE_TYPES.has(e.evidence_type)) problems.push(`${at}.evidence_type "${e.evidence_type}" is not in the live schema enum`);
    if (e.notes != null) {
      if (typeof e.notes !== 'string' || e.notes.length < 1) problems.push(`${at}.notes must be a non-empty string`);
      else if (e.notes.length > ENUMS.evidence_notes_max) problems.push(`${at}.notes is ${e.notes.length} chars; schema max is ${ENUMS.evidence_notes_max}`);
    }
    if (['PROOF_OF_FULFILLMENT', 'PROOF_OF_REFUND', 'PROOF_OF_RETURN'].includes(e.evidence_type) && !e.evidence_info) {
      problems.push(`${at}: evidence_info is expected for ${e.evidence_type} (schema description)`);
    }
    for (const [j, t] of (e.evidence_info?.tracking_info ?? []).entries()) {
      if (!t.tracking_number) problems.push(`${at}.evidence_info.tracking_info[${j}].tracking_number is required`);
      if (!CARRIERS.has(t.carrier_name)) problems.push(`${at}.evidence_info.tracking_info[${j}].carrier_name "${t.carrier_name}" is not in the live schema enum`);
    }
    for (const [j, rid] of (e.evidence_info?.refund_ids ?? []).entries()) {
      if (typeof rid !== 'string' || !rid) problems.push(`${at}.evidence_info.refund_ids[${j}] must be a non-empty string`);
    }
  });
  return problems;
}

/** Build the exact multipart request provide-evidence takes. `input` = JSON part. */
export function buildProvideEvidenceRequest(disputeId, payload) {
  const problems = validateEvidences(payload);
  if (problems.length) { const e = new Error('evidence payload failed schema validation: ' + problems.join('; ')); e.problems = problems; throw e; }
  return {
    method: 'POST',
    path: `/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`,
    scope: 'https://uri.paypal.com/services/disputes/update-seller',
    content_type: 'multipart/form-data',
    parts: { input: { content_type: 'application/json', json: payload } },
  };
}

export function toFormData(req) {
  const fd = new FormData();
  for (const [name, p] of Object.entries(req.parts)) fd.append(name, new Blob([JSON.stringify(p.json)], { type: p.content_type }), `${name}.json`);
  return fd;
}

export async function provideEvidence(disputeId, payload, opts = {}) {
  const req = buildProvideEvidenceRequest(disputeId, payload);
  return call('POST', req.path, { requestId: requestIdFor('provide-evidence', disputeId, payload), ...opts, form: toFormData(req) });
}

export function buildAcceptClaimRequest(disputeId, note) {
  return {
    method: 'POST', path: `/v1/customer/disputes/${encodeURIComponent(disputeId)}/accept-claim`,
    scope: 'https://uri.paypal.com/services/disputes/update-seller', content_type: 'application/json',
    json: { note: String(note || 'Seller accepts the claim.').slice(0, 2000), accept_claim_type: 'REFUND' },
    note: 'accept_claim_type REFUND is in the live schema enum; the schema documents only a multipart body for accept-claim, so the JSON field set here follows PayPal\'s integration guide and is unverified by the schema.',
  };
}
export const acceptClaim = (id, note, opts = {}) => { const r = buildAcceptClaimRequest(id, note); return call('POST', r.path, { requestId: requestIdFor('accept-claim', id, r.json), ...opts, json: r.json }); };
