// run-buttons.js — the ▶ Run button on `$` examples in the interactive edition.
//
// build.mjs marks every example line that runs cleanly in the sandbox with
//   <code data-run='[{"l":<line index>,"c":"<command>"}, …]'>
// This script (which must load after book.js has syntax-highlighted the blocks
// and after terminal-widget.js) adds a button to the end of each such line.
// Clicking it opens a terminal directly under the code block — the same shared
// sandbox as every other terminal on the page — and runs that line in it.
(function () {
  'use strict';

  var MOUNT_HINT = 'This terminal shares the sandbox with every other one on the page. Type more here, or press ✕ to close it.';

  function closeTerminal(term, holder) {
    var list = window.__shellTerminals || [];
    var i = list.indexOf(term);
    if (i > -1) list.splice(i, 1);
    if (holder.parentNode) holder.parentNode.removeChild(holder);
  }

  // The terminal for a block: created on the first click, reused after that.
  function terminalFor(pre) {
    var next = pre.nextElementSibling;
    if (next && next.classList.contains('run-term')) return next.__term;
    var holder = document.createElement('div');
    holder.className = 'run-term';
    pre.parentNode.insertBefore(holder, pre.nextSibling);
    var term = new window.ShellTerminal(holder, { intro: MOUNT_HINT });
    holder.__term = term;
    var bar = holder.querySelector('.shell-term-titlebar');
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'shell-term-reset run-term-close';
    x.setAttribute('aria-label', 'Close this terminal');
    x.textContent = '✕';
    x.addEventListener('click', function () { closeTerminal(term, holder); });
    if (bar) bar.appendChild(x);
    return term;
  }

  function attach(code) {
    var entries;
    try { entries = JSON.parse(code.getAttribute('data-run')); } catch (e) { return; }
    if (!entries || !entries.length) return;
    var pre = code.parentNode;
    // Highlighted spans never cross a newline, so innerHTML splits back into
    // the same lines the build saw.
    var lines = code.innerHTML.split('\n');
    var byLine = {};
    entries.forEach(function (e) { if (e.l < lines.length) byLine[e.l] = e.c; });
    code.innerHTML = lines.map(function (html, i) {
      if (!(i in byLine)) return html;
      return html + '<button type="button" class="run-btn" data-line="' + i + '" aria-label="Run this command in a terminal"></button>';
    }).join('\n');
    pre.classList.add('has-run');
    code.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('.run-btn') : null;
      if (!btn || !code.contains(btn)) return;
      var term = terminalFor(pre);
      term.runVisible(byLine[btn.getAttribute('data-line')]);
      var wrap = term.container.querySelector('.shell-term-wrap');
      if (wrap && wrap.scrollIntoView) wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  function init() {
    if (!window.ShellTerminal) return;
    document.querySelectorAll('pre > code[data-run]').forEach(attach);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
