// Drives installed Chrome through the benchmark page. Usage: node run.mjs <framesDir> <mode> <out.json> [modelFilterRegex] [--throttle N] [--headed]
import { chromium } from 'playwright-core'; import fs from 'node:fs'; import { start } from './server.mjs';
const [framesDir, mode, outFile, filter = '.*'] = process.argv.slice(2);
const throttle = Number((process.argv.find((a) => a.startsWith('--throttle=')) || '=1').split('=')[1]);
const headed = process.argv.includes('--headed');
const srv = await start();
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: !headed,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const names = JSON.parse(fs.readFileSync(`${framesDir}/index.json`, 'utf8'));
const frames = names.map((n) => `/${framesDir}/${n}`);
const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { runs: {} };
let page = await browser.newPage(); await page.goto('http://localhost:8765/web/'); await page.waitForFunction(() => window.benchReady);
out.env = await page.evaluate(() => window.envInfo()); out.throttle = throttle;
console.log(JSON.stringify(out.env));
const models = (await page.evaluate(() => window.listModels())).filter((m) => new RegExp(filter).test(m));
await page.close();
for (const model of models) {
  const ctx = await browser.newContext(); page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 200)); });
  if (throttle > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle }); }
  try {
    await page.goto('http://localhost:8765/web/'); await page.waitForFunction(() => window.benchReady);
    const r = await page.evaluate((a) => window.runBench(a), { model, mode, frames });
    const t = [...r.times].sort((a, b) => a - b), mean = t.reduce((a, b) => a + b, 0) / t.length;
    r.summary = { init: Math.round(r.tInit), first: Math.round(r.tFirst), median: +t[t.length >> 1].toFixed(1), p90: +t[Math.floor(t.length * 0.9)].toFixed(1), fps: +(1000 / mean).toFixed(1), detected: r.results.filter(Boolean).length + '/' + r.results.length };
    console.log(model.padEnd(34), JSON.stringify(r.summary));
    out.runs[model] = r;
  } catch (e) { console.log(model.padEnd(34), 'FAILED', String(e).slice(0, 300)); out.runs[model] = { error: String(e) }; }
  await ctx.close();
  fs.writeFileSync(outFile, JSON.stringify(out));
}
await browser.close(); srv.close();
