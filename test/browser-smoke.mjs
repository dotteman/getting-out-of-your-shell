// browser-smoke.mjs — load both built editions in headless Chromium and check
// that the interactive widgets actually work end to end.
//
//   npx playwright install chromium   (once)
//   node test/browser-smoke.mjs
// Set CHROMIUM_PATH to use an already-installed Chromium instead.
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = (f) => 'file://' + path.join(ROOT, 'docs', f);

let fails = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`ok   ${label}`);
  else { fails++; console.log(`FAIL ${label}${detail ? ' — ' + detail : ''}`); }
};

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  // ---------------------------------------------------------------- interactive
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url('index.html'));
  await page.waitForTimeout(300);

  const counts = await page.evaluate(() => ({
    terminals: document.querySelectorAll('.shell-term-wrap').length,
    chmod: document.querySelectorAll('.chmod-result').length,
    quote: document.querySelectorAll('.quote-cols').length,
    runner: document.querySelectorAll('.scriptrun-area').length,
  }));
  check('12 live terminals mount', counts.terminals === 12, JSON.stringify(counts));
  check('chmod calculator, quoting sandbox and script runner mount', counts.chmod === 1 && counts.quote === 1 && counts.runner === 1, JSON.stringify(counts));

  // A real command, typed into the first terminal, runs against the seeded lab.
  const input = page.locator('.live-term').first().locator('.shell-term-input');
  await input.click();
  await input.type(`awk -F, 'NR>1 {s+=$5} END {printf "%.2f\\n", s}' data/sales_2026.csv`);
  await input.press('Enter');
  const termText = await page.locator('.live-term').first().locator('.shell-term-body').innerText();
  check('typed command produces the answer-key value 31505.00', termText.includes('31505.00'), termText.slice(-200));

  // The shared sandbox: a file made in chapter 1 is visible from chapter 8's terminal.
  await input.type('touch smoke-marker.txt');
  await input.press('Enter');
  const seenElsewhere = await page.evaluate(() => {
    const t = window.__shellTerminals[7];
    return t.session.run('ls smoke-marker.txt').chunks.map((c) => c.text).join('');
  });
  check('terminals share one sandbox', seenElsewhere.includes('smoke-marker.txt'), seenElsewhere);

  // Reset restores the seeded starting point everywhere.
  await page.locator('.shell-term-reset').first().click();
  await page.waitForTimeout(100);
  const prompts = await page.evaluate(() => [...document.querySelectorAll('.shell-term-inputrow .shell-term-prompt')].map((p) => p.textContent));
  check('reset returns every terminal to ~/shell-lab', prompts.length === 12 && prompts.every((p) => p.includes('~/shell-lab')), prompts.join(' | '));

  // The chmod calculator renders a filename as text, never as markup.
  await page.locator('.chmod-filename').fill('<img src=x onerror=window.__xss=1>');
  await page.waitForTimeout(50);
  const xss = await page.evaluate(() => ({ fired: !!window.__xss, imgs: document.querySelectorAll('.chmod-result img').length }));
  check('chmod filename cannot inject HTML', !xss.fired && xss.imgs === 0, JSON.stringify(xss));

  // Appendix B shows the real script, not the build placeholder.
  const appendixB = await page.evaluate(() => document.getElementById('appendix-b').parentElement.innerText);
  check('Appendix B shows the setup script', appendixB.includes('Sandbox ready at') && !appendixB.includes('__SETUP_SCRIPT__'));

  check('no page or console errors (interactive)', errors.length === 0, errors.join(' | '));
  await page.close();

  // ---------------------------------------------------------------------- print
  const print = await browser.newPage();
  const printErrors = [];
  print.on('pageerror', (e) => printErrors.push(e.message));
  await print.goto(url('print.html'));
  await print.waitForTimeout(200);
  const printInfo = await print.evaluate(() => ({
    toc: document.querySelectorAll('#toc a').length,
    cover: document.querySelectorAll('.book-cover img').length,
    terminals: document.querySelectorAll('.shell-term-wrap').length,
  }));
  check('print edition builds its table of contents and cover', printInfo.toc > 50 && printInfo.cover === 1, JSON.stringify(printInfo));
  check('print edition has no live terminals', printInfo.terminals === 0);
  check('no page errors (print)', printErrors.length === 0, printErrors.join(' | '));
} finally {
  await browser.close();
}

console.log(`\n===== browser smoke: ${fails} failed =====`);
process.exitCode = fails ? 1 : 0;
