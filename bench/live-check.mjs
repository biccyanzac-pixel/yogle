// Read-only check of the live site: home board + archive load from the real worker, no submissions.
import { chromium } from '../bench/node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('https://biccyanzac-pixel.github.io/yogle/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('today-board-msg').textContent.length > 0, null, { timeout: 15000 });
const home = { title: await page.textContent('#today-title'), day: await page.textContent('#daynum'), board: await page.innerText('#today-board-panel') };
await page.screenshot({ path: 'bench/results/e2e/live-home.png', fullPage: true });
await page.click('#btn-archive');
await page.waitForSelector('#archive-list button');
const archive = await page.$$eval('#archive-list button', (bs) => bs.map((b) => b.innerText.replace(/\n/g, ' | ')));
await page.locator('#archive-list button').first().click();
await page.waitForFunction(() => !/Loading/.test(document.getElementById('archive-late-msg').textContent));
const day = await page.innerText('#archive-day');
console.log(JSON.stringify({ home, archive, day: day.slice(0, 300), errors }, null, 1));
await browser.close();
