// Verifies the countdown and the automatic switch to the new pose at 00:00 UTC, using a fake clock.
import { chromium } from '../bench/node_modules/playwright-core/index.mjs';
import { serve } from '../tools/serve.mjs';
const srv = await serve(8081);
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.clock.install({ time: new Date('2026-10-07T23:59:55Z') });
await page.goto('http://localhost:8081/');
await page.waitForSelector('#today-title:not(:empty)');
await page.clock.runFor(1000);
const before = { day: await page.textContent('#daynum'), pose: await page.textContent('#today-title'), countdown: await page.textContent('#countdown') };
await page.clock.runFor(7000);
const after = { day: await page.textContent('#daynum'), pose: await page.textContent('#today-title'), countdown: await page.textContent('#countdown') };
await page.screenshot({ path: 'bench/results/e2e/countdown.png' });
console.log(JSON.stringify({ before, after, errors }, null, 1));
await browser.close(); srv.close();
