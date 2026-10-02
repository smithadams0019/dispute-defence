// Runs the REAL Bedrock tool-using agent on one seeded fixture and writes the full result to docs/agent-runs/.
import fs from 'node:fs';
for (const l of fs.readFileSync(new URL('../../../../.env', import.meta.url), 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2]; }
const { buildFixtures } = await import('../src/fixtures.js');
const { createRecord } = await import('../src/records.js');
const { analyse } = await import('../src/agent.js');
const key = process.argv[2];
const t0 = Date.now();
const fx = buildFixtures(t0).find((f) => f.key === key);
if (!fx) throw new Error('unknown fixture ' + key);
const rec = createRecord(fx, t0);
const started = Date.now();
await analyse(rec, t0, { useLlm: true, budget: async () => true });
const out = { fixture: key, wall_ms: Date.now() - started, state: rec.state, score: rec.analysis.score, band: rec.analysis.band, route: rec.analysis.route, agent: rec.analysis.agent ?? null, draft: rec.analysis.draft, trace: rec.trace };
fs.writeFileSync(new URL(`../../docs/agent-runs/${key}.json`, import.meta.url), JSON.stringify(out, null, 1));
console.log(`${key}: ${rec.state} score=${rec.analysis.score}(${rec.analysis.band}) route=${rec.analysis.route.action} by=${rec.analysis.route.decided_by ?? 'rules'} turns=${rec.analysis.agent?.turns ?? '-'} wall=${out.wall_ms}ms`);
console.log('reason:', rec.analysis.route.why);
for (const t of rec.trace.filter((x) => x.step === 'agent' || x.step === 'route')) console.log(' ', t.kind, t.label.slice(0, 160), '|', (t.detail || '').slice(0, 160));
