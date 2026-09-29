// bonus-widgets.js — chmod calculator, quoting sandbox, and the Chapter 11
// script runner. Auto-mounts on elements with data-chmod-calc / data-quote-box
// / data-script-runner. The script runner uses the shared shell session (looked
// up per run, so "reset sandbox" is honoured) and so stays in sync with the
// nearby terminals; the quoting sandbox deliberately does not — it re-runs on
// every keystroke, so it gets a private throwaway session.
(function () {
  'use strict';

  // Always look the shared session up at call time: "reset sandbox" swaps
  // window.__labSession for a brand new one, and anything holding a reference
  // from mount time would keep writing to the orphaned filesystem forever.
  function getSession() {
    if (!window.__labSession) window.__labSession = window.ShellEngine.createSession();
    return window.__labSession;
  }

  // NOTE: `html` is innerHTML — pass only static, author-written markup here.
  // Anything derived from reader input must be set with textContent instead
  // (see the chmod result below).
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function span(cls, text) {
    const e = document.createElement('span');
    if (cls) e.className = cls;
    e.textContent = text;
    return e;
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn(); }, ms);
    };
  }

  // ---------------- chmod calculator ----------------
  function mountChmodCalc(container) {
    const box = el('div', 'widget-box');
    box.appendChild(el('div', 'widget-box-title', 'Try it: chmod permissions calculator'));
    const body = el('div', 'widget-box-body');
    box.appendChild(body);

    const cols = el('div', 'chmod-cols');
    const who = ['owner', 'group', 'other'];
    const boxes = {}; // who -> {r,w,x: <input>}
    who.forEach((w) => {
      const col = el('div', 'chmod-col');
      col.appendChild(el('h4', null, w));
      boxes[w] = {};
      ['r', 'w', 'x'].forEach((perm) => {
        const label = el('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.who = w; cb.dataset.perm = perm;
        if ((w === 'owner' && (perm === 'r' || perm === 'w')) || (w !== 'owner' && perm === 'r')) cb.checked = true;
        label.appendChild(cb);
        label.appendChild(document.createTextNode(' ' + perm));
        col.appendChild(label);
        boxes[w][perm] = cb;
      });
      cols.appendChild(col);
    });
    body.appendChild(cols);

    const fnameRow = el('div', 'chmod-fname-row', 'file: ');
    const fname = document.createElement('input');
    fname.type = 'text'; fname.value = 'myfile.txt'; fname.className = 'chmod-filename';
    fnameRow.appendChild(fname);
    body.appendChild(fnameRow);

    const result = el('div', 'chmod-result');
    body.appendChild(result);

    function bits(w) { return (boxes[w].r.checked ? 4 : 0) + (boxes[w].w.checked ? 2 : 0) + (boxes[w].x.checked ? 1 : 0); }
    function symFor(n) { return (n & 4 ? 'r' : '-') + (n & 2 ? 'w' : '-') + (n & 1 ? 'x' : '-'); }

    function update() {
      const o = bits('owner'), g = bits('group'), ot = bits('other');
      const octal = '' + o + g + ot;
      const sym = symFor(o) + symFor(g) + symFor(ot);
      const cmdSym = 'u=' + (o & 4 ? 'r' : '') + (o & 2 ? 'w' : '') + (o & 1 ? 'x' : '') +
        ',g=' + (g & 4 ? 'r' : '') + (g & 2 ? 'w' : '') + (g & 1 ? 'x' : '') +
        ',o=' + (ot & 4 ? 'r' : '') + (ot & 2 ? 'w' : '') + (ot & 1 ? 'x' : '');
      // Built with textContent, never innerHTML: the filename is reader input.
      const file = fname.value || 'file';
      result.textContent = '';
      result.appendChild(span('octal', octal));
      result.appendChild(span('sym', '-' + sym));
      result.appendChild(span('cmd', 'chmod ' + octal + ' ' + file));
      result.title = 'equivalent: chmod ' + cmdSym + ' ' + file;
    }
    Object.values(boxes).forEach((g) => Object.values(g).forEach((cb) => cb.addEventListener('change', update)));
    fname.addEventListener('input', update);
    update();
    container.appendChild(box);
  }

  // ---------------- quoting sandbox ----------------
  function mountQuoteBox(container) {
    // This box re-runs a command on every keystroke, so it gets its own
    // private throwaway session — never the shared one. Otherwise typing
    // `$(rm -rf data)` here would destroy the reader's practice data in every
    // terminal on the page. It only ever runs `echo`, so a private filesystem
    // costs nothing.
    const session = window.ShellEngine.createSession();
    const box = el('div', 'widget-box');
    box.appendChild(el('div', 'widget-box-title', "Try it: single quotes vs. double quotes"));
    const body = el('div', 'widget-box-body');
    box.appendChild(body);

    const hint = el('div', 'widget-hint', 'Type something with a <code>$VARIABLE</code> or <code>$(command)</code> in it and watch how each quoting style handles it:');
    body.appendChild(hint);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'quote-input';
    input.value = 'Hello $USER, it is $(date +%A)';
    body.appendChild(input);

    const cols = el('div', 'quote-cols');
    const singleCol = el('div', 'quote-col');
    singleCol.appendChild(el('h4', null, "Single quotes — everything is literal"));
    const singleCmd = el('div', 'cmdline');
    const singleOut = document.createElement('pre');
    singleCol.appendChild(singleCmd); singleCol.appendChild(singleOut);

    const doubleCol = el('div', 'quote-col');
    doubleCol.appendChild(el('h4', null, 'Double quotes — $vars and $(...) still expand'));
    const doubleCmd = el('div', 'cmdline');
    const doubleOut = document.createElement('pre');
    doubleCol.appendChild(doubleCmd); doubleCol.appendChild(doubleOut);

    cols.appendChild(singleCol); cols.appendChild(doubleCol);
    body.appendChild(cols);

    function runQuoted(content, quoteChar) {
      let escaped;
      if (quoteChar === "'") {
        // Close the quote, emit a literal ', reopen — the only escape single
        // quotes have.
        escaped = content.replace(/'/g, "'\\''");
      } else {
        // Inside double quotes only a bare " or ` needs escaping. $ is left
        // alone on purpose — expansion is the whole point of this column — and
        // the reader's own backslashes are passed through untouched, so
        // someone who types \$USER is shown (and runs) exactly \$USER.
        let outq = '';
        for (let i = 0; i < content.length; i++) {
          const c = content[i];
          if (c === '\\') {
            if (i + 1 < content.length) { outq += c + content[i + 1]; i++; }
            else outq += '\\\\'; // dangling backslash would eat the closing quote
          } else if (c === '"' || c === '`') {
            outq += '\\' + c;
          } else {
            outq += c;
          }
        }
        escaped = outq;
      }
      const cmd = 'echo ' + quoteChar + escaped + quoteChar;
      let res;
      try { res = session.run(cmd); } catch (e) { return { cmd, out: 'error: ' + e.message }; }
      const out = res.chunks.map((c) => c.text).join('');
      return { cmd, out };
    }
    function update() {
      const content = input.value;
      const s = runQuoted(content, "'");
      singleCmd.textContent = '$ ' + s.cmd;
      singleOut.textContent = s.out || ' ';
      const d = runQuoted(content, '"');
      doubleCmd.textContent = '$ ' + d.cmd;
      doubleOut.textContent = d.out || ' ';
    }
    // Debounced: without this every keystroke runs a command substitution.
    input.addEventListener('input', debounce(update, 150));
    update();
    container.appendChild(box);
  }

  // ---------------- Chapter 11 script runner ----------------
  function mountScriptRunner(container, opts) {
    opts = opts || {};
    const box = el('div', 'widget-box');
    box.appendChild(el('div', 'widget-box-title', 'Try it: run a small script'));
    const body = el('div', 'widget-box-body');
    box.appendChild(body);

    const textarea = document.createElement('textarea');
    textarea.className = 'scriptrun-area';
    textarea.spellcheck = false;
    textarea.value = opts.starter || 'for f in data/*.csv; do\n  echo "found: $f"\ndone';
    body.appendChild(textarea);

    const btnRow = el('div', 'scriptrun-buttons');
    const runBtn = el('button', 'scriptrun-run', 'Run ▶');
    runBtn.type = 'button';
    const clearBtn = el('button', 'scriptrun-clear', 'Clear output');
    clearBtn.type = 'button';
    btnRow.appendChild(runBtn); btnRow.appendChild(clearBtn);
    body.appendChild(btnRow);

    const out = el('pre', 'scriptrun-out', '');
    body.appendChild(out);

    function run() {
      out.textContent = '';
      // Looked up per run, so "reset sandbox" is picked up instead of writing
      // to the filesystem of the session that existed at mount time.
      const session = getSession();
      let res;
      try { res = session.run(textarea.value); }
      catch (e) { res = { chunks: [{ stream: 'err', text: 'bash: internal error: ' + e.message + '\n' }] }; }
      // Same reasoning as the terminal's line cap: a runaway loop should not
      // drop megabytes of text into the page.
      const MAX_CHARS = 200000;
      let used = 0;
      let clipped = false;
      for (const chunk of res.chunks) {
        const text = chunk.text || '';
        if (used >= MAX_CHARS) { clipped = clipped || text.length > 0; continue; }
        const piece = text.length > MAX_CHARS - used ? (clipped = true, text.slice(0, MAX_CHARS - used)) : text;
        used += piece.length;
        out.appendChild(span(chunk.stream === 'err' ? 'err' : null, piece));
      }
      if (clipped) out.appendChild(span('trunc', '\n… output truncated\n'));
      if (!res.chunks.length) out.textContent = '(no output)';
    }
    runBtn.addEventListener('click', run);
    clearBtn.addEventListener('click', () => { out.textContent = ''; });
    container.appendChild(box);
  }

  window.mountChmodCalc = mountChmodCalc;
  window.mountQuoteBox = mountQuoteBox;
  window.mountScriptRunner = mountScriptRunner;

  function autoMount() {
    document.querySelectorAll('[data-chmod-calc]:not([data-mounted])').forEach((e) => { e.setAttribute('data-mounted', '1'); mountChmodCalc(e); });
    document.querySelectorAll('[data-quote-box]:not([data-mounted])').forEach((e) => { e.setAttribute('data-mounted', '1'); mountQuoteBox(e); });
    document.querySelectorAll('[data-script-runner]:not([data-mounted])').forEach((e) => {
      e.setAttribute('data-mounted', '1');
      mountScriptRunner(e, { starter: e.dataset.starter ? decodeURIComponent(e.dataset.starter) : undefined });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount);
  else autoMount();
  window.__mountBonusWidgets = autoMount;
})();
