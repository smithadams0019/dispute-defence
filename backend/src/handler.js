// Lambda entry point. Function URL (payload v2) and EventBridge (scheduled guard).
import { MemoryStore, DynamoStore } from './store.js';
import * as svc from './service.js';
import * as pp from './paypal.js';
import * as wh from './webhook.js';
import ENUMS from './generated/paypal-enums.json' with { type: 'json' };

let store;
const getStore = () => (store ??= process.env.STORE === 'memory' ? new MemoryStore() : new DynamoStore());
export const __setStore = (s) => { store = s; };
let verifier = null;
export const __setVerifier = (v) => { verifier = v; };

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,x-session',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-max-age': '600',
};
const json = (status, body) => ({ statusCode: status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS }, body: JSON.stringify(body) });

let statusCache = null;
async function paypalStatus(env) {
  if (statusCache && Date.now() - statusCache.at < 60_000) return statusCache.v;
  const v = { api: pp.cfg(env).api, mode: /sandbox/.test(pp.cfg(env).api) ? 'sandbox' : 'LIVE' };
  try {
    const t = await pp.getToken(env);
    v.oauth = 'ok';
    v.dispute_scopes = t.scopes.filter((s) => s.includes('/disputes/')).map((s) => s.split('/services/')[1]);
    const list = await pp.listDisputes({ env }, { page_size: '20' });
    v.list_status = 'HTTP 200';
    v.sandbox_disputes = list.items?.length ?? 0;
  } catch (e) { v.oauth = v.oauth ?? 'failed'; v.error = String(e.message).slice(0, 200); }
  v.schema = { version: ENUMS.schema_version, operations: ENUMS.operations.length, source: ENUMS.fetched_from };
  statusCache = { at: Date.now(), v };
  return v;
}

// Lambda passes (event, context, callback): never take env from the third parameter.
export const handler = (event, ctx) => handle(event, ctx, process.env);

export async function handle(event, _ctx, env) {
  const st = getStore();
  const realNow = Date.now();
  // Scheduled guard
  if (event?.source === 'aws.events' || event?.['detail-type'] === 'Scheduled Event') {
    const deps = svc.makeDeps(st, { realNow });
    const r = await svc.sweepAll(st, realNow, deps);
    console.log(JSON.stringify({ guard_sweep: r }));
    return r;
  }
  if (event?.job === 'analyse') {
    const r = await svc.runAnalysisJob(st, event.sid, event.id, realNow, svc.makeDeps(st, { realNow }));
    console.log(JSON.stringify({ analysis_job: { id: event.id, ...r } }));
    return r;
  }
  const http = event?.requestContext?.http;
  if (!http) return json(400, { error: 'unsupported event' });
  const method = http.method, path = http.path.replace(/\/+$/, '') || '/';
  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body); }
    catch { return json(400, { error: 'body must be JSON' }); }
  }
  const sid = headers['x-session'];
  const needSid = () => { if (!sid || !svc.SESSION_RE.test(sid)) { const e = new Error('X-Session header required (8-64 chars of A-Z a-z 0-9 _ -)'); e.status = 400; throw e; } return sid; };
  const deps = () => svc.makeDeps(st, { realNow });

  try {
    if (method === 'GET' && path === '/api/health') return json(200, { ok: true, service: 'dispute-defence', now: new Date(realNow).toISOString(), model: process.env.BEDROCK_MODEL ?? null, store: process.env.STORE ?? 'dynamodb' });
    if (method === 'GET' && path === '/api/paypal/status') return json(200, await paypalStatus(env));
    if (method === 'GET' && path === '/api/state') return json(200, await svc.getState(st, needSid(), realNow, deps()));
    if (method === 'POST' && path === '/api/demo/reset') { const s = needSid(); await svc.seedSession(st, s, realNow, deps()); return json(200, await svc.getState(st, s, realNow, deps())); }
    if (method === 'POST' && path === '/api/demo/clock') return json(200, await svc.actClock(st, needSid(), body, realNow, deps()));
    if (method === 'POST' && path === '/api/guard/sweep') return json(200, await svc.actSweep(st, needSid(), realNow, deps()));
    if (method === 'POST' && path === '/api/webhooks/paypal') {
      if (headers['paypal-transmission-sig'] || headers['paypal-transmission-id']) {
        const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : (event.body ?? '');
        const v = await (verifier ?? wh.verifyViaApi)({ headers, rawBody: raw, webhookId: env.PAYPAL_WEBHOOK_ID, env });
        if (!v.ok) { console.warn(JSON.stringify({ webhook_rejected: v.reason })); return json(401, { error: `webhook rejected: ${v.reason}` }); }
        const r = await svc.ingestLiveEvent(st, body, realNow);
        return json(r.status, r.body);
      }
      if (headers['x-demo-event'] !== '1') return json(401, { error: 'unsigned events are only accepted from the demo UI (x-demo-event: 1)' });
      const r = await svc.ingestWebhook(st, needSid(), body, realNow, deps());
      return json(r.status, r.body);
    }
    const m = path.match(/^\/api\/disputes\/([A-Za-z0-9-]+)\/(analyse|file|accept|adjudicate|surrender)$/);
    if (m) {
      const [, id, op] = m, s = needSid();
      if (op === 'surrender' && method === 'GET') return json(200, await svc.surrenderPreview(st, s, id, realNow, deps()));
      if (method !== 'POST') return json(405, { error: 'POST required' });
      if (op === 'analyse') return json(200, await svc.actAnalyse(st, s, id, realNow, deps()));
      if (op === 'file') return json(200, await svc.actFile(st, s, id, body, realNow, deps()));
      if (op === 'accept') return json(200, await svc.actAccept(st, s, id, realNow, deps()));
      if (op === 'adjudicate') return json(200, await svc.actAdjudicate(st, s, id, realNow, deps()));
    }
    return json(404, { error: `no route for ${method} ${path}` });
  } catch (e) {
    const status = e.status ?? 500;
    if (status >= 500) console.error('handler error', e);
    return json(status, { error: status >= 500 ? 'internal error' : e.message, ...(status >= 500 && process.env.DEBUG_ERRORS ? { detail: e.message } : {}) });
  }
}
