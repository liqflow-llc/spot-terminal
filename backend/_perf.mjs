import os from 'os';
import path from 'path';
import puppeteer from 'puppeteer-core';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const url = process.argv[2] || 'https://spotterminal.com/';
// Page-load timings (layout shifts, LCP) on desktop and phone: node backend/_perf.mjs [url]
// CHROME_PATH: your Chrome or Chromium binary.
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: 'new', userDataDir: path.join(os.tmpdir(), `chrome-perf-${Date.now()}`), args: ['--no-first-run'] });
for (const [label, vp] of [['desktop', { width: 1600, height: 920 }], ['phone', { width: 412, height: 880, deviceScaleFactor: 2, isMobile: true, hasTouch: true }]]) {
  const page = await browser.newPage();
  await page.setViewport(vp);
  await page.evaluateOnNewDocument(() => {
    window.__shifts = []; window.__lcp = 0;
    new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__shifts.push({ v: e.value, t: Math.round(e.startTime), src: (e.sources || []).map(s => (s.node?.className || s.node?.nodeName || '?').toString().split(' ')[0]).slice(0, 3) }); }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver(l => { const e = l.getEntries().at(-1); if (e) window.__lcp = Math.round(e.startTime); }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ob-row', { timeout: 30000 }).catch(() => {});
  const bookAt = Date.now() - t0;
  await page.waitForFunction(() => document.querySelector('.tv-container iframe'), { timeout: 30000 }).catch(() => {});
  await sleep(4000);
  const r = await page.evaluate(() => ({ cls: window.__shifts.reduce((a, s) => a + s.v, 0).toFixed(3), shifts: window.__shifts.filter(s => s.v > 0.005), lcp: window.__lcp, fcp: Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0), res: performance.getEntriesByType('resource').filter(e => e.transferSize > 50000).map(e => new URL(e.name).pathname.split('/').slice(-2).join('/') + ' ' + Math.round(e.transferSize / 1024) + 'KB@' + Math.round(e.responseEnd)) }));
  console.log(label, 'FCP', r.fcp, 'LCP', r.lcp, 'book rows at ~' + bookAt + 'ms', 'CLS', r.cls);
  console.log('  shifts:', JSON.stringify(r.shifts));
  console.log('  big downloads:', r.res.join(', '));
  await page.close();
}
await browser.close();
