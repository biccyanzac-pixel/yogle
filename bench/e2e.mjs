// End-to-end: play the real site in Chrome with a video file as the camera.
// node bench/e2e.mjs <fakecam.mjpeg> <pose-id> <label>
import { chromium } from '../bench/node_modules/playwright-core/index.mjs';
import { serve } from '../tools/serve.mjs';
import fs from 'node:fs'; import path from 'node:path';
const [cam, poseId, label = poseId] = process.argv.slice(2);
const srv = await serve(8090);
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${path.resolve(cam)}`, '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 420, height: 860 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:8090/?debug&pose=${poseId}`);
await page.waitForSelector('#today-title:not(:empty)');
fs.mkdirSync('bench/results/e2e', { recursive: true });
await page.screenshot({ path: `bench/results/e2e/${label}-home.png`, fullPage: true });
await page.click('#btn-practice');
await page.click('#btn-agree');
const statuses = new Set();
const t0 = Date.now(); let shot = false;
while (Date.now() - t0 < (Number(process.env.E2E_SECONDS) || 170) * 1000) {
  const st = await page.evaluate(() => ({ status: document.getElementById('status').textContent, result: !document.getElementById('screen-result').hidden, perf: document.getElementById('perf').textContent, hold: document.getElementById('hold-val').textContent, match: document.getElementById('match-val').textContent }));
  statuses.add(st.status.replace(/\d+s$/, 'Ns'));
  if (!shot && Date.now() - t0 > 25000) { await page.screenshot({ path: `bench/results/e2e/${label}-play.png` }); shot = true; }
  if (st.result) break;
  await page.waitForTimeout(500);
}
const out = await page.evaluate(() => ({ score: document.getElementById('result-score').textContent, detail: document.getElementById('result-detail').textContent, grid: document.getElementById('result-grid').textContent, perf: document.getElementById('perf').textContent }));
await page.screenshot({ path: `bench/results/e2e/${label}-result.png`, fullPage: true });
console.log(JSON.stringify({ label, pose: poseId, ...out, statuses: [...statuses], seconds: Math.round((Date.now() - t0) / 1000) }, null, 1));
console.log(logs.filter((l) => /error|warn/i.test(l)).slice(0, 10).join('\n'));
await browser.close(); srv.close();
