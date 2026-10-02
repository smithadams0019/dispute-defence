const BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
let mem = null;

function uuid() {
  try { if (crypto.randomUUID) return crypto.randomUUID(); } catch { /* fall through */ }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

export function session() {
  try {
    let s = localStorage.getItem('dd-session');
    if (!s) { s = uuid(); localStorage.setItem('dd-session', s); }
    return s;
  } catch {
    if (!mem) mem = uuid();
    return mem;
  }
}

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function call(method, path, body, extra = {}, timeoutMs = 60000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Session': session(), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new ApiError('The server took too long to answer.', 0);
    throw new ApiError('Could not reach the server.', 0);
  }
  clearTimeout(timer);
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    let msg = data && (data.error || data.message);
    if (msg && typeof msg !== 'string') msg = JSON.stringify(msg);
    if (!msg) msg = res.status === 502 || res.status === 504 ? 'The gateway timed out.' : `The server answered with status ${res.status}.`;
    throw new ApiError(msg, res.status);
  }
  return data;
}

export const api = {
  state: () => call('GET', '/api/state'),
  paypalStatus: () => call('GET', '/api/paypal/status'),
  sweep: () => call('POST', '/api/guard/sweep', {}),
  clock: (body) => call('POST', '/api/demo/clock', body),
  reset: () => call('POST', '/api/demo/reset', {}),
  webhook: (template) =>
    call('POST', '/api/webhooks/paypal',
      { event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { demo_template: template } },
      { 'x-demo-event': '1' }, 150000),
  act: (id, verb, body) => call('POST', `/api/disputes/${encodeURIComponent(id)}/${verb}`, body || {}, {}, 90000),
  surrender: (id) => call('GET', `/api/disputes/${encodeURIComponent(id)}/surrender`),
};
