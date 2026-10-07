// Renders the link-preview image (1200x630) shown when the site is shared on X, Telegram,
// Discord, Slack... Run after changing the brand: node scripts/make-og-image.mjs [chrome path]
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';
import { BRAND } from '../../frontend/src/brand.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '../../frontend/public');
const [first, second] = BRAND.endsWith('Terminal') ? [BRAND.slice(0, -8), 'Terminal'] : [BRAND, ''];

// A stylised order book ladder: asks above, bids below, deepest levels widest.
const asks = [0.34, 0.52, 0.41, 0.66, 0.83];
const bids = [0.38, 0.47, 0.71, 0.58, 0.9];
const ladder = (sizes, color) => sizes.map(w => `<div class="lvl"><div class="bar" style="width:${w * 100}%;background:${color}"></div></div>`).join('');

const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;600;700;800&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1200px; height: 630px; font-family: Inter, sans-serif; color: #e6e9ee;
    background: radial-gradient(900px 500px at 85% 20%, rgba(76,141,255,.18), transparent 60%), #0b0e11;
    display: flex; padding: 72px; gap: 64px; }
  .left { flex: 1; display: flex; flex-direction: column; }
  .brand { font-size: 64px; font-weight: 800; letter-spacing: -0.03em; }
  .brand span { color: #4c8dff; }
  h1 { margin-top: 28px; font-size: 52px; line-height: 1.08; font-weight: 700; letter-spacing: -0.02em; }
  ul { margin-top: 28px; padding: 0; list-style: none; font-size: 26px; color: #aab3c0; display: grid; gap: 12px; }
  li::before { content: '✓'; color: #2ebd85; font-weight: 800; margin-right: 14px; }
  .chips { margin-top: auto; display: flex; gap: 12px; }
  .chip { padding: 8px 16px; border: 1px solid #2e3641; border-radius: 999px; font-size: 20px; color: #aab3c0; font-weight: 600; }
  .book { width: 330px; align-self: center; background: #12161c; border: 1px solid #232a33; border-radius: 16px; padding: 22px; }
  .lvl { height: 30px; margin: 6px 0; display: flex; justify-content: flex-end; }
  .bar { height: 100%; border-radius: 4px; opacity: .85; }
  .mid { margin: 16px 0; font-size: 34px; font-weight: 700; color: #2ebd85; text-align: center; }
</style></head><body>
  <div class="left">
    <div class="brand">${first}<span>${second}</span></div>
    <h1>Trade Solana tokens on order books. Zero trading fees.</h1>
    <ul>
      <li>Limit orders pay out to your wallet</li>
      <li>Market orders at the best price on Solana</li>
    </ul>
    <div class="chips"><span class="chip">Manifest</span><span class="chip">Archer</span><span class="chip">Jupiter routing</span></div>
  </div>
  <div class="book">${ladder(asks, '#f6465d')}<div class="mid">120.95</div>${ladder(bids, '#2ebd85')}</div>
</body></html>`;

const browser = await puppeteer.launch({ executablePath: process.argv[2] || '/usr/bin/google-chrome', headless: 'new', args: ['--no-first-run'] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630 });
await page.setContent(html, { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);
// og.png is what the pages point at; og-image.png replaces the old app's image at its old URL,
// which link-preview caches may still reference.
for (const name of ['og.png', 'og-image.png']) await page.screenshot({ path: path.join(out, name), type: 'png' });
await browser.close();
console.log(`Wrote ${out}/og.png (${BRAND})`);
