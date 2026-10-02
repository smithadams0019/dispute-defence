import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

let client;
export const MODEL = () => process.env.BEDROCK_MODEL || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

/** One structured-JSON call. Returns {json, text, usage, ms}. Throws on transport or parse failure. */
export async function converseJson({ system, user, maxTokens = 1200 }) {
  client ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1', maxAttempts: 6, retryMode: 'adaptive' });
  const t = Date.now();
  const out = await send(new ConverseCommand({
    modelId: MODEL(),
    system: [{ text: system }],
    messages: [{ role: 'user', content: [{ text: user }] }],
    inferenceConfig: { maxTokens, temperature: 0.2 },
  }));
  const text = out.output?.message?.content?.map((c) => c.text ?? '').join('') ?? '';
  return { json: extractJson(text), text, usage: out.usage, ms: Date.now() - t, model: MODEL() };
}

/** Retry throttling with backoff on top of the SDK's own retries. */
async function send(cmd) {
  let wait = 1500;
  for (let i = 0; ; i++) {
    try { return await client.send(cmd); }
    catch (e) {
      const throttled = e.name === 'ThrottlingException' || /too many requests/i.test(e.message);
      if (!throttled || i >= 3) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait *= 2;
    }
  }
}

export function extractJson(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('model returned no JSON object');
  return JSON.parse(text.slice(a, b + 1));
}

/** One tool-use turn on the Converse API. Returns the assistant message, stop reason and usage. */
export async function converseTurn({ system, messages, tools, maxTokens = 1800 }) {
  client ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1', maxAttempts: 6, retryMode: 'adaptive' });
  const t = Date.now();
  const out = await send(new ConverseCommand({
    modelId: MODEL(),
    system: [{ text: system }],
    messages,
    toolConfig: { tools: tools.map((x) => ({ toolSpec: { name: x.name, description: x.description, inputSchema: { json: x.input } } })) },
    inferenceConfig: { maxTokens, temperature: 0.1 },
  }));
  return { message: out.output.message, stopReason: out.stopReason, usage: out.usage, ms: Date.now() - t, model: MODEL() };
}
