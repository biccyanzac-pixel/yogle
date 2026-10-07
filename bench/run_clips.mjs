// Run one model over many sequential clips in a single page (tracking mode, as in the game).
import { chromium } from 'playwright-core'; import fs from 'node:fs'; import { start } from './server.mjs';
const [clipsFile, model, outFile] = process.argv.slice(2);
const clips = JSON.parse(fs.readFileSync(clipsFile, 'utf8'));
const srv = await start();
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage();
await page.goto('http://localhost:8765/web/'); await page.waitForFunction(() => window.benchReady);
const out = {};
for (const c of clips) {
  const frames = JSON.parse(fs.readFileSync(`${c.dir}/index.json`, 'utf8')).map((n) => `/${c.dir}/${n}`);
  const r = await page.evaluate((a) => window.runBench(a), { model, mode: 'fps', frames, warmup: 0 });
  out[c.dir] = r.results.map((x) => (x ? x.native33.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, Math.round(p[3] * 1000) / 1000]) : null));
  process.stdout.write('.');
}
fs.writeFileSync(outFile, JSON.stringify(out));
console.log('\ndone', Object.keys(out).length);
await browser.close(); srv.close();
