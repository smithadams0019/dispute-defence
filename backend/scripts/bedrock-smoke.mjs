process.env.STORE = 'memory';
const fs = await import('node:fs');
for (const l of fs.readFileSync(new URL('../../../../.env', import.meta.url), 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2]; }
const { MemoryStore } = await import('../src/store.js');
const svc = await import('../src/service.js');
const store = new MemoryStore();
const t = Date.now();
const deps = svc.makeDeps(store);
const out = await svc.ingestWebhook(store, 'smoke-session-1', { event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { demo_template: process.argv[2] || 'inr-signed' } }, Date.now(), deps).catch(e => ({ err: e }));
console.log(out.err ? out.err : JSON.stringify(out), 'ms', Date.now() - t);
const rec = (await store.list('smoke-session-1')).find(r => r.id.startsWith('FX-D-483'));
console.log(JSON.stringify({ state: rec.state, score: rec.analysis.score, gen: rec.analysis.draft.generator, cited: rec.analysis.draft.cited, weaknesses: rec.analysis.draft.weaknesses }, null, 1));
console.log('NOTES:\n' + rec.analysis.draft.notes);
console.log(rec.trace.map(x => `${x.kind} ${x.step} ${x.label} | ${x.detail?.slice(0,300)}`).join('\n'));
