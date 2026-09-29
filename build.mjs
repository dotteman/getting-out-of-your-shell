// build.mjs — builds both editions of "Getting Out of Your Shell" from source.
//
//   node build.mjs           write docs/index.html (interactive) and docs/print.html
//   node build.mjs --check   rebuild in memory; exit 1 if docs/ is out of date (used in CI)
//
// Both editions are made from the same chapter files in book/parts/, so the
// text can no longer drift apart. The interactive edition adds live terminal
// widgets at fixed anchors and inlines the shell engine from src/.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { findBlocks } from './book/tools/run-lines.mjs';
import { classifyBlock } from './book/tools/classify.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Fill {{NAME}} placeholders in one pass over the template, so inserted values
// (which contain arbitrary JS/CSS/HTML) are never themselves scanned for
// placeholders or `$&`-style replacement patterns.
function fill(template, values) {
  const seen = new Set();
  const outText = template.replace(/\{\{([A-Z_]+)\}\}/g, (m, name) => {
    if (!(name in values)) throw new Error(`no value for placeholder ${m}`);
    seen.add(name);
    return values[name];
  });
  for (const name of Object.keys(values)) if (!seen.has(name)) throw new Error(`placeholder {{${name}}} missing from template`);
  return outText;
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------- shared parts
const part = (name) => read(`book/parts/${name}.html`);
const front = part('00-front');
const chapterSources = Array.from({ length: 12 }, (_, i) => part(String(i + 1).padStart(2, '0')));
const appendixA = part('13-appendix-a');
// Appendix B prints the real setup script, so the book and lab/setup.sh can't disagree.
const appendixB = part('14-appendix-b').split('__SETUP_SCRIPT__').join(escapeHtml(read('lab/setup.sh')));

const cover = read('book/template/cover.html')
  .split('{{COVER_BASE64}}')
  .join(fs.readFileSync(path.join(ROOT, 'book/assets/cover.jpg')).toString('base64'));
const bookCss = read('book/template/book.css');
const bookJs = read('book/template/book.js').replace(/\n$/, '');

// --------------------------------------------------------------- print edition
function buildPrint() {
  // The print edition separates parts with a blank line; the interactive edition
  // (below) with a single newline. Both are kept as-is so rebuilds stay byte-stable.
  const content = '\n\n' + [front, ...chapterSources, appendixA, appendixB].join('\n\n') + '\n';
  return fill(read('book/template/print.html'), { CSS: bookCss, COVER: cover, CONTENT: content, BOOK_JS: bookJs });
}

// --------------------------------------------------------- interactive edition
function insertBefore(html, anchor, insertion) {
  const idx = html.indexOf(anchor);
  if (idx === -1) throw new Error('anchor not found: ' + anchor);
  return html.slice(0, idx) + insertion + '\n' + html.slice(idx);
}

// Tags every `$` example line that runs cleanly in the sandbox with a ▶ Run
// button, by putting data-run='[{"l":line,"c":command}]' on its <code> element.
// run-buttons.js (which runs after the syntax highlighter) turns those into
// buttons. Blocks with no runnable line are left untouched.
function tagRunnable(html) {
  let out = html;
  for (const block of findBlocks(html).reverse()) {
    const runnable = classifyBlock(block).filter((c) => c.runnable).map((c) => ({ l: c.line, c: c.cmd }));
    if (!runnable.length) continue;
    const attr = `data-run="${escapeHtml(JSON.stringify(runnable)).replace(/"/g, '&quot;')}"`;
    const tagged = out.slice(block.start, block.end).replace('<pre><code', () => `<pre><code ${attr}`);
    out = out.slice(0, block.start) + tagged + out.slice(block.end);
  }
  return out;
}

function liveTerminalWidget(introText, seedCommands) {
  const attrs = [`data-shell-term="1"`];
  if (introText) attrs.push(`data-intro="${introText.replace(/"/g, '&quot;')}"`);
  if (seedCommands && seedCommands.length) attrs.push(`data-seed="${seedCommands.join('|').replace(/"/g, '&quot;')}"`);
  return `<div class="live-term" ${attrs.join(' ')}></div>`;
}

// One terminal per chapter, placed just before its Questions, with a hint line.
const TERMINAL_INTROS = {
  1: 'Try it here — this sandbox follows you through the whole book. Start with: pwd, whoami, ls',
  2: 'cd around, ls -ltr the logs, try a glob or a brace expansion.',
  3: 'cp, mv, mkdir -p, ln -s — the filesystem here is a real (simulated) one, so mistakes are free.',
  4: 'head, tail, wc, diff -u — try the commands from this chapter on the files in data/ and logs/.',
  5: 'Build a pipeline: try the cut | sort | uniq -c | sort -rn example from this chapter.',
  6: 'find and grep -r across data/, logs/, and conf/.',
  7: 'awk, sed, and grep -E — try the examples from this chapter against data/sales_2026.csv.',
  8: 'chmod things in here, then ls -l to see the result — use the calculator above to plan the octal first.',
  9: 'sleep 300 &, then jobs, pgrep, kill %1 — background jobs finish quickly here so you are not stuck waiting.',
  10: 'export a variable, then bash -c to see what a child process does and does not inherit.',
  11: 'Try a for loop or an if/test one-liner here, or use the script runner above for something longer.',
  12: 'tar -czf, then tar -tzf to list it back — rsync --dry-run is also live here.',
};

const SCRIPT_RUNNER_STARTER = 'for f in data/*.csv; do\n  lines=$(wc -l < "$f")\n  echo "$f: $lines lines"\ndone';

const APPENDIX_B_NOTE =
  `<div class="intro-box"><h4>You don't need to run this in this edition</h4><p>Every live sandbox on this page is already seeded with exactly the data this script produces — it runs in your browser, not on a real machine. This script is here so you can build the <em>same</em> sandbox on a real Linux box or WSL if you want to practice outside the browser too.</p></div>\n`;

const MODULES = [
  'src/engine/engine.js',
  'src/engine/awk-mini.js',
  'src/engine/sed-mini.js',
  'src/engine/builtins.js',
  'src/widgets/terminal-widget.js',
  'src/widgets/bonus-widgets.js',
  'src/widgets/run-buttons.js',
];

function buildInteractive() {
  const chapters = chapterSources.map((source, i) => {
    const n = i + 1;
    let html = tagRunnable(source);
    const qAnchor = `<h3 id="q${n}">`;
    if (n === 8) html = insertBefore(html, '<div class="box lab">', '<div data-chmod-calc="1"></div>');
    if (n === 10) html = insertBefore(html, '<h3 id="expansion-order">', '<div data-quote-box="1"></div>');
    if (n === 11) {
      html = insertBefore(html, qAnchor, `<div data-script-runner="1" data-starter="${encodeURIComponent(SCRIPT_RUNNER_STARTER)}"></div>`);
    }
    // Chapter 1's terminal moves the shared session into the lab; reset replays it.
    const seed = n === 1 ? ['cd shell-lab'] : null;
    return insertBefore(html, qAnchor, liveTerminalWidget(TERMINAL_INTROS[n], seed));
  });

  const content = [
    read('book/template/interactive-intro.html'),
    tagRunnable(front),
    chapters.join('\n'),
    appendixA,
    appendixB.replace('<h2 id="appendix-b">', APPENDIX_B_NOTE + '<h2 id="appendix-b">'),
  ].join('\n');

  const css = bookCss + read('book/template/interactive.css') +
    read('src/widgets/terminal-widget.css') + read('src/widgets/bonus-widgets.css') +
    read('src/widgets/run-buttons.css');
  const modules = MODULES.map((p) => `<script>\n${read(p)}\n</script>`).join('\n');

  return fill(read('book/template/interactive.html'), { CSS: css, COVER: cover, CONTENT: content, BOOK_JS: bookJs, MODULES: modules });
}

// ------------------------------------------------------------------------ main
const outputs = {
  'docs/index.html': buildInteractive(),
  'docs/print.html': buildPrint(),
};

if (process.argv.includes('--check')) {
  let stale = false;
  for (const [file, html] of Object.entries(outputs)) {
    const current = fs.existsSync(path.join(ROOT, file)) ? read(file) : null;
    if (current !== html) { console.error(`${file} is out of date — run: node build.mjs`); stale = true; }
    else console.log(`${file} is up to date`);
  }
  process.exit(stale ? 1 : 0);
}

fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
for (const [file, html] of Object.entries(outputs)) {
  fs.writeFileSync(path.join(ROOT, file), html);
  console.log(`wrote ${file} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB)`);
}
