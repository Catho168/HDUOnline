// styleframe 截图：把 index.html 的三张 1920x1080 关键帧各截一张
import puppeteer from 'puppeteer';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const browser = await puppeteer.launch({
  headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--no-sandbox', '--force-device-scale-factor=1'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(here, 'styleframe', 'index.html')).href, { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);
await new Promise((r) => setTimeout(r, 600));
for (const id of ['A', 'B', 'C']) {
  const el = await page.$(`#${id}`);
  await el.screenshot({ path: join(here, 'styleframe', `${id}.png`) });
  console.log('shot', id);
}
await browser.close();
