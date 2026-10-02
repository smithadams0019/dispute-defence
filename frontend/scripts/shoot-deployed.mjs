import { chromium } from '/home/rogerkorantenng/dev/Hackathons/agentic-cinema/callsheet/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
const url = fs.readFileSync(new URL('../../.aws-out/urls.env', import.meta.url), 'utf8').match(/CLOUDFRONT_URL=(.*)/)[1];
const b = await chromium.launch({ args: ['--no-sandbox'] });
for (const [w, h] of [[360, 780], [768, 1024], [1280, 900], [1920, 1080]]) {
  for (const scheme of ['light', 'dark']) {
    const p = await b.newPage({ viewport: { width: w, height: h }, colorScheme: scheme });
    await p.goto(url, { waitUntil: 'networkidle' }); await p.waitForTimeout(1500);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    await p.screenshot({ path: new URL(`../../docs/screens-deployed/home-${w}-${scheme}.png`, import.meta.url).pathname });
    console.log(w, scheme, 'horizontal overflow:', overflow);
    await p.close();
  }
}
await b.close();
