// Archive replay + leaderboard submit, end to end: site on :8080, worker on :8797 (wrangler dev --local).
import { chromium } from '../bench/node_modules/playwright-core/index.mjs';
import { serve } from '../tools/serve.mjs';
import path from 'node:path'; import fs from 'node:fs';
const [cam, dayIndexFromTop = '0', name = 'E2E Tester'] = process.argv.slice(2);
const srv = await serve(8080);
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${path.resolve(cam)}`, '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8080/?api=http://127.0.0.1:8797');
await page.waitForSelector('#today-title:not(:empty)');
await page.waitForTimeout(1500);
fs.mkdirSync('bench/results/e2e', { recursive: true });
await page.screenshot({ path: 'bench/results/e2e/lb-home.png', fullPage: true });
const homeBoard = await page.$eval('#today-board-panel', (e) => e.innerText);
await page.click('#btn-archive');
await page.waitForSelector('#archive-list button');
const days = await page.$$eval('#archive-list button', (bs) => bs.map((b) => b.innerText.replace(/\n/g, ' | ')));
await page.locator('#archive-list button').nth(Number(dayIndexFromTop)).click();
await page.waitForFunction(() => !document.getElementById('archive-board-msg').textContent.includes('Loading'));
await page.screenshot({ path: 'bench/results/e2e/lb-archive-day.png', fullPage: true });
await page.click('#btn-archive-play');
await page.click('#btn-agree');
const t0 = Date.now();
while (Date.now() - t0 < 150000) {
  if (await page.$eval('#screen-result', (e) => !e.hidden)) break;
  await page.waitForTimeout(500);
}
const result = await page.$eval('#screen-result', (e) => e.innerText.slice(0, 400));
await page.fill('#player-name', name);
await page.click('#btn-submit');
await page.waitForFunction(() => !document.getElementById('result-board-wrap').hidden && document.getElementById('result-board').children.length > 0, null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(800);
const board = await page.$eval('#result-board-wrap', (e) => e.innerText);
const msg = await page.$eval('#share-msg', (e) => e.textContent) + ' / ' + await page.$eval('#submit-msg', (e) => e.textContent);
await page.screenshot({ path: 'bench/results/e2e/lb-result.png', fullPage: true });
console.log(JSON.stringify({ homeBoard, days, result, msg, board, errors }, null, 1));
await browser.close(); srv.close();
