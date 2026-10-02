// Stands up PayPal's own MCP server (stdio, real sandbox token), enumerates its tools, and shows what its
// dispute tools can and cannot do. Every line printed here is real output. Run: node probe.mjs
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
for (const l of fs.readFileSync(new URL('../../../.env', import.meta.url), 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2]; }
const api = process.env.PAYPAL_API;
const tok = await (await fetch(`${api}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })).json();

const transport = new StdioClientTransport({ command: 'node', args: ['node_modules/@paypal/mcp/dist/index.js', '--tools=all', '--paypal-environment=SANDBOX', `--access-token=${tok.access_token}`], stderr: 'pipe' });
const client = new Client({ name: 'dispute-defence-probe', version: '1.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();
console.log(`MCP server connected. tools/list returned ${tools.length} tools via the CLI (--tools=all).`);
const disp = tools.filter((t) => /dispute/i.test(t.name));
console.log(`\nDispute tools (${disp.length}):`);
for (const t of disp) console.log(`  - ${t.name}: ${t.description?.split('\n')[0]}\n    input: ${JSON.stringify(t.inputSchema.properties ? Object.keys(t.inputSchema.properties) : [])}  required: ${JSON.stringify(t.inputSchema.required ?? [])}`);
const writes = disp.filter((t) => !/^(list|get)_/.test(t.name));
console.log(`\nOf those, WRITE tools: ${writes.map((w) => w.name).join(', ') || 'none'}`);
console.log('Any tool anywhere mentioning evidence/appeal/escalate/offer:', tools.filter((t) => /evidence|appeal|escalate|offer/i.test(t.name)).map((t) => t.name));
const out = async (name, args) => { try { const r = await client.callTool({ name, arguments: args }); return JSON.stringify(r.content?.map((c) => c.text)).slice(0, 400) + (r.isError ? ' [isError]' : ''); } catch (e) { return 'THROWN ' + e.message.slice(0, 300); } };
console.log('\n--- one live read through the MCP server (list first; no calls on ids that are not ours)');
const listName = disp.find((t) => /^list_/.test(t.name))?.name;
if (listName) console.log(listName, '->', await out(listName, {}));
console.log('get_dispute / accept_dispute_claim were NOT called: the sandbox account has no disputes, and accept_dispute_claim refunds the buyer.');
console.log('\nAll tool names:', tools.map((t) => t.name).join(', '));
await client.close();
