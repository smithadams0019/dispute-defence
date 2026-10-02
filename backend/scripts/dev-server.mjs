// Local HTTP wrapper around the Lambda handler. Usage: STORE=memory node scripts/dev-server.mjs
import http from 'node:http';
import fs from 'node:fs';
const envFile = new URL('../../../../.env', import.meta.url);
if (fs.existsSync(envFile)) for (const l of fs.readFileSync(envFile, 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }
const { handler } = await import('../src/handler.js');
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const url = new URL(req.url, 'http://x');
  const r = await handler({ requestContext: { http: { method: req.method, path: url.pathname } }, headers: req.headers, body: chunks.length ? Buffer.concat(chunks).toString() : undefined });
  res.writeHead(r.statusCode, r.headers); res.end(r.body);
}).listen(Number(process.env.PORT||8791), () => console.log('dispute-defence dev server on :'+(process.env.PORT||8791)+' store=' + (process.env.STORE || 'dynamodb') + ' llm=' + (process.env.DISABLE_LLM === '1' ? 'off' : 'on')));
