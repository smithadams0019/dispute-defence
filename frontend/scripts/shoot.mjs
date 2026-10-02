// usage: node scripts/shoot.mjs round1   (needs vite on :5199 and the API on :8791)
import { chromium } from '/home/rogerkorantenng/dev/Hackathons/agentic-cinema/callsheet/node_modules/playwright-core/index.mjs';
import { mkdirSync } from 'node:fs';
const round = process.argv[2] || 'round1';
const out = new URL(`../shots/${round}/`, import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const APP = 'http://localhost:5199/', API = 'http://localhost:8791';
const post = (s, p, b) => fetch(API + p, { method: 'POST', headers: { 'X-Session': s, 'content-type': 'application/json', 'x-demo-event': '1' }, body: JSON.stringify(b || {}) }).then((r) => r.json());
const sessions = {};
async function ids(s) { const j = await fetch(API + '/api/state', { headers: { 'X-Session': s } }).then((r) => r.json()); const open = j.disputes.filter((d) => ['ESCALATED', 'ANALYSED'].includes(d.state)).sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at)); return open.map((d) => d.id); }
let A, B;
async function mk(name, setup) {
  const s = 'shot' + name + Date.now();
  await post(s, '/api/demo/reset'); await setup?.(s); sessions[name] = s;
}
await mk('critical'); [A, B] = await ids(sessions.critical);
await mk('soon', (s) => post(s, `/api/disputes/${A}/file`, { notes: 'Filed for the screenshot.' }));
await mk('urgent', async (s) => { await post(s, `/api/disputes/${A}/file`, { notes: 'x' }); await post(s, '/api/demo/clock', { advance_ms: 50 * 3600e3, guard: 'off' }); });
await mk('breached', (s) => post(s, '/api/demo/clock', { advance_ms: 5 * 3600e3, guard: 'off' }));
await mk('ok', async (s) => { await post(s, `/api/disputes/${A}/file`, { notes: 'x' }); await post(s, `/api/disputes/${B}/file`, { notes: 'x' }); await post(s, '/api/webhooks/paypal', { event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { demo_template: 'unauthorised' } }); });

const b = await chromium.launch({ args: ['--no-sandbox'] });
const WIDTHS = [[360, 740], [768, 1000], [1280, 800], [1920, 1000]];
async function page(w, h, theme, sess) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: theme });
  await ctx.addInitScript(([s, t]) => { localStorage.setItem('dd-session', s); localStorage.setItem('dd-theme', t); }, [sess, theme]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('PAGEERR', e.message));
  return p;
}
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
for (const theme of ['dark', 'light']) {
  for (const [w, h] of WIDTHS) {
    const tag = `${w}-${theme}`;
    const p = await page(w, h, theme, sessions.critical);
    await p.goto(APP); await p.waitForTimeout(1200);
    await p.screenshot({ path: `${out}home-${tag}.png`, fullPage: true });
    console.log(tag, 'home overflow', await overflow(p));
    await p.goto(APP + '#/disputes'); await p.waitForTimeout(500);
    await p.screenshot({ path: `${out}disputes-${tag}.png`, fullPage: true });
    await p.goto(APP + '#/evidence'); await p.waitForTimeout(400);
    await p.screenshot({ path: `${out}evidence-${tag}.png`, fullPage: true });
    console.log(tag, 'evidence overflow', await overflow(p));
    await p.goto(APP + '#/compare'); await p.waitForTimeout(900);
    await p.screenshot({ path: `${out}compare-${tag}.png`, fullPage: true });
    console.log(tag, 'compare overflow', await overflow(p));
    await p.goto(APP + `#/home?d=${A}`); await p.waitForTimeout(900);
    await p.screenshot({ path: `${out}detail-${tag}.png` });
    await p.evaluate(() => document.querySelector('.drawer').scrollTo(0, 700));
    await p.screenshot({ path: `${out}detail-scrolled-${tag}.png` });
    await p.evaluate(() => document.querySelector('.drawer').scrollTo(0, 0));
    await p.click('text=File response'); await p.waitForTimeout(300);
    await p.screenshot({ path: `${out}confirm-${tag}.png` });
    await p.context().close();
  }
  for (const st of ['critical', 'soon', 'urgent', 'breached', 'ok']) {
    for (const [w, h] of [[360, 740], [1280, 800]]) {
      const p = await page(w, h, theme, sessions[st]);
      await p.goto(APP); await p.waitForTimeout(1100);
      await p.evaluate(() => document.querySelector('.attn')?.scrollIntoView());
      await p.waitForTimeout(150);
      await p.screenshot({ path: `${out}state-${st}-${w}-${theme}.png` });
      await p.context().close();
    }
  }
}
await b.close();
