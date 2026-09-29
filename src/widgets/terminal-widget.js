// terminal-widget.js — a small, dependency-free interactive terminal UI backed
// by ShellEngine (engine.js + builtins.js). All widgets on a page share ONE
// underlying shell session by default (same filesystem, cwd, variables), so
// the sandbox feels continuous as the reader scrolls through the book — just
// like the print book's single running lab. A "reset sandbox" button on any
// widget resets the shared session for every widget on the page.
(function () {
  'use strict';

  function getSharedSession() {
    if (!window.__labSession) window.__labSession = window.ShellEngine.createSession();
    return window.__labSession;
  }

  window.__shellTerminals = window.__shellTerminals || [];

  // Rendering limits. Without these a single `seq 1 1000000` builds a million
  // <p> nodes and freezes the tab for a minute.
  const MAX_LINES_PER_COMMAND = 2000; // rendered lines for one command's output
  const MAX_SCROLLBACK_LINES = 5000;  // total lines kept in one terminal

  function resetSandbox() {
    const fresh = window.ShellEngine.createSession();
    window.__labSession = fresh;
    // Reset every terminal first (chapter 1 replays `cd shell-lab` here), then
    // refresh all prompts once, so the result does not depend on mount order.
    for (const t of window.__shellTerminals) {
      try { t.onSandboxReset(); } catch (e) { /* one bad widget must not block the rest */ }
    }
    refreshAllPrompts(fresh);
  }
  window.__resetShellSandbox = resetSandbox;

  // Every terminal sharing the default session shows the same cwd/prompt —
  // called after any widget runs a command so the others catch up too.
  function refreshAllPrompts(session) {
    for (const t of window.__shellTerminals) if (t.session === session) t.refreshPrompt();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Backslash-escape the characters that would otherwise split or re-expand a
  // completed word, so `cat my file.txt` becomes the runnable `cat my\ file.txt`.
  // Only the text spliced into the input is escaped; the candidate list below
  // still shows bare filenames.
  function shellEscape(s) {
    return String(s).replace(/([ '"$`\\])/g, '\\$1');
  }

  function promptHtml(session) {
    const path = session.promptCwd();
    return '<span class="shell-term-prompt-user">dave@web-01</span>' +
      '<span class="shell-term-prompt-sym">:</span>' +
      '<span class="shell-term-prompt-path">' + escapeHtml(path) + '</span>' +
      '<span class="shell-term-prompt-sym">$ </span>';
  }

  class ShellTerminal {
    constructor(container, opts) {
      opts = opts || {};
      this.container = container;
      this.session = opts.session || getSharedSession();
      this.histIdx = null; // null = not currently browsing history
      this.savedDraft = '';      // line stashed while browsing history with up/down
      this.savedSearchLine = ''; // line stashed while in Ctrl+R search mode
      this.searchMode = false;
      this.searchQuery = '';
      this.searchIdx = -1;
      // Kept so "reset sandbox" can restore the exact starting state this
      // widget was mounted with (chapter 1 seeds `cd shell-lab`).
      this.seedCommands = (opts.seedCommands || []).slice();
      this.render();
      window.__shellTerminals.push(this);
      if (opts.intro) this.printSystem(opts.intro);
      this.runSeeds();
    }

    runSeeds() {
      for (const line of this.seedCommands) this.runVisible(line, { silent: true });
    }

    onSandboxReset() {
      this.session = getSharedSession();
      this.body.innerHTML = '';
      this.inputRow = null;
      this.promptEl = null;
      this.input = null;
      this.histIdx = null;
      this.savedDraft = '';
      this.savedSearchLine = '';
      this.searchMode = false;
      this.searchQuery = '';
      this.searchIdx = -1;
      this.printSystem('— sandbox reset —');
      this.runSeeds();
      this.newInputLine();
    }

    render() {
      const wrap = document.createElement('div');
      wrap.className = 'shell-term-wrap';
      wrap.innerHTML =
        '<div class="shell-term-titlebar">' +
          '<span class="shell-term-dot r"></span><span class="shell-term-dot y"></span><span class="shell-term-dot g"></span>' +
          '<span class="shell-term-title">dave@web-01 — shell-lab</span>' +
          '<button type="button" class="shell-term-reset">reset sandbox</button>' +
        '</div>' +
        '<div class="shell-term-body" tabindex="-1"></div>';
      this.container.appendChild(wrap);
      this.body = wrap.querySelector('.shell-term-body');
      wrap.querySelector('.shell-term-reset').addEventListener('click', () => resetSandbox());
      this.body.addEventListener('click', () => { if (this.input) this.input.focus(); });
      this.newInputLine();
    }

    appendLine(el) {
      if (this.inputRow && this.inputRow.parentNode === this.body) this.body.insertBefore(el, this.inputRow);
      else this.body.appendChild(el);
    }

    printSystem(text) {
      const p = document.createElement('p');
      p.className = 'shell-term-line shell-term-hint';
      p.textContent = text;
      this.appendLine(p);
    }

    // Render one command's output. Capped and batched: at most
    // MAX_LINES_PER_COMMAND <p> nodes go in, built into a DocumentFragment and
    // inserted in a single DOM operation, with a note about what was dropped.
    printOutput(res) {
      const frag = document.createDocumentFragment();
      let rendered = 0;
      let dropped = 0;
      for (const chunk of (res && res.chunks) || []) {
        const text = chunk.text;
        if (!text) continue;
        const cls = 'shell-term-line ' + (chunk.stream === 'err' ? 'shell-term-err' : 'shell-term-out');
        const len = text.length;
        let pos = 0;
        // Walk the chunk without materialising a million-element array.
        while (pos < len) {
          const nl = text.indexOf('\n', pos);
          const end = nl === -1 ? len : nl;
          if (rendered < MAX_LINES_PER_COMMAND) {
            const p = document.createElement('p');
            p.className = cls;
            p.textContent = text.slice(pos, end);
            frag.appendChild(p);
            rendered++;
          } else {
            dropped++;
          }
          if (nl === -1) break;
          pos = end + 1;
        }
      }
      if (dropped) {
        const note = document.createElement('p');
        note.className = 'shell-term-line shell-term-trunc';
        note.textContent = '… output truncated (' + dropped + ' more line' + (dropped === 1 ? '' : 's') + ')';
        frag.appendChild(note);
      }
      if (frag.childNodes.length) this.appendLine(frag);
      this.trimScrollback();
    }

    // Keep one terminal's scrollback bounded across a long session.
    trimScrollback() {
      const lines = this.body.querySelectorAll('.shell-term-line');
      const excess = lines.length - MAX_SCROLLBACK_LINES;
      for (let i = 0; i < excess; i++) lines[i].remove();
    }

    // Run a command as if the user typed it (used for scripted intro commands
    // and for programmatic "try this" buttons elsewhere on the page).
    runVisible(line, opts) {
      opts = opts || {};
      if (!opts.silent) {
        const echoRow = document.createElement('p');
        echoRow.className = 'shell-term-line shell-term-echo';
        echoRow.innerHTML = promptHtml(this.session) + escapeHtml(line);
        this.body.insertBefore(echoRow, this.inputRow);
      }
      let res;
      try { res = this.session.run(line); }
      catch (e) { res = { chunks: [{ stream: 'err', text: 'bash: internal error: ' + e.message + '\n' }] }; }
      this.printOutput(res);
      refreshAllPrompts(this.session);
      this.scrollToBottom();
      return res;
    }

    newInputLine() {
      const row = document.createElement('div');
      row.className = 'shell-term-inputrow';
      const prompt = document.createElement('span');
      prompt.className = 'shell-term-prompt';
      prompt.innerHTML = promptHtml(this.session);
      const input = document.createElement('input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.autocapitalize = 'off';
      input.spellcheck = false;
      input.className = 'shell-term-input';
      row.appendChild(prompt);
      row.appendChild(input);
      this.body.appendChild(row);
      this.inputRow = row;
      this.promptEl = prompt;
      this.input = input;
      input.addEventListener('keydown', (ev) => this.onKeyDown(ev));
      this.scrollToBottom();
    }

    refreshPrompt() {
      if (this.promptEl) this.promptEl.innerHTML = promptHtml(this.session);
    }

    scrollToBottom() { this.body.scrollTop = this.body.scrollHeight; }

    exitSearch(accept) {
      this.searchMode = false;
      // Restores the line that was being typed when Ctrl+R started — kept
      // separate from savedDraft, which belongs to up/down history browsing.
      if (!accept) this.input.value = this.savedSearchLine;
      this.searchQuery = '';
      const label = this.inputRow.querySelector('.shell-term-search');
      if (label) label.remove();
      this.promptEl.style.display = '';
    }

    updateSearchLabel() {
      let label = this.inputRow.querySelector('.shell-term-search');
      if (!label) {
        label = document.createElement('span');
        label.className = 'shell-term-prompt shell-term-search';
        this.inputRow.insertBefore(label, this.input);
      }
      const hist = this.session.state.history;
      let match = '';
      if (this.searchQuery) {
        for (let i = hist.length - 1; i >= 0; i--) {
          if (hist[i].includes(this.searchQuery)) { match = hist[i]; this.searchIdx = i; break; }
        }
      }
      label.textContent = "(reverse-i-search)`" + this.searchQuery + "': ";
      // Like bash: the line stays put until an actual match replaces it. With
      // an empty query (or a failing one) we leave what is already there.
      if (this.searchQuery && match) this.input.value = match;
    }

    onKeyDown(ev) {
      // Ctrl+R — reverse history search
      if (ev.ctrlKey && ev.key === 'r') {
        ev.preventDefault();
        if (!this.searchMode) { this.searchMode = true; this.savedSearchLine = this.input.value; this.searchQuery = ''; this.promptEl.style.display = 'none'; }
        this.updateSearchLabel();
        return;
      }
      if (this.searchMode) {
        // Ctrl+C / Ctrl+G abort the search and restore the original line.
        if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'c' || ev.key === 'g')) { ev.preventDefault(); this.exitSearch(false); return; }
        if (ev.key === 'Enter') { ev.preventDefault(); this.exitSearch(true); this.runCurrent(); return; }
        if (ev.key === 'Escape') { ev.preventDefault(); this.exitSearch(false); return; }
        if (ev.key === 'Backspace') { ev.preventDefault(); this.searchQuery = this.searchQuery.slice(0, -1); this.updateSearchLabel(); return; }
        // Printable characters only — a Ctrl/Alt/Cmd chord is not search text.
        if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
          ev.preventDefault(); this.searchQuery += ev.key; this.updateSearchLabel(); return;
        }
        return;
      }
      // Ctrl+C — cancel current line
      if (ev.ctrlKey && ev.key === 'c') {
        ev.preventDefault();
        const echoRow = document.createElement('p');
        echoRow.className = 'shell-term-line shell-term-echo';
        echoRow.innerHTML = promptHtml(this.session) + escapeHtml(this.input.value) + '<span class="shell-term-hint">^C</span>';
        this.body.insertBefore(echoRow, this.inputRow);
        this.input.value = '';
        this.histIdx = null;
        this.scrollToBottom();
        return;
      }
      // Ctrl+L — clear screen
      if (ev.ctrlKey && ev.key === 'l') {
        ev.preventDefault();
        [...this.body.querySelectorAll('.shell-term-line, .shell-term-candidates')].forEach((el) => el.remove());
        return;
      }
      if (ev.key === 'Enter') { ev.preventDefault(); this.runCurrent(); return; }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); this.historyStep(-1); return; }
      if (ev.key === 'ArrowDown') { ev.preventDefault(); this.historyStep(1); return; }
      if (ev.key === 'Tab') { ev.preventDefault(); this.tabComplete(); return; }
    }

    historyStep(dir) {
      const hist = this.session.state.history;
      if (!hist.length) return;
      if (this.histIdx === null) { this.savedDraft = this.input.value; this.histIdx = hist.length; }
      this.histIdx += dir;
      if (this.histIdx >= hist.length) { this.histIdx = hist.length; this.input.value = this.savedDraft; return; }
      if (this.histIdx < 0) this.histIdx = 0;
      this.input.value = hist[this.histIdx];
      this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    }

    tabComplete() {
      const val = this.input.value;
      const candidates = this.session.completionCandidates(val);
      const old = this.body.querySelector('.shell-term-candidates');
      if (old) old.remove();
      if (candidates.length === 1) {
        const m = val.match(/(\S*)$/);
        const frag = m ? m[1] : '';
        const done = candidates[0].endsWith('/');
        this.input.value = val.slice(0, val.length - frag.length) + shellEscape(candidates[0]) + (done ? '' : ' ');
      } else if (candidates.length > 1) {
        // common-prefix completion, then list the rest like a real shell
        let prefix = candidates[0];
        for (const c of candidates) { while (!c.startsWith(prefix)) prefix = prefix.slice(0, -1); }
        const m = val.match(/(\S*)$/);
        const frag = m ? m[1] : '';
        if (prefix.length > frag.length) this.input.value = val.slice(0, val.length - frag.length) + shellEscape(prefix);
        const row = document.createElement('p');
        row.className = 'shell-term-line shell-term-candidates';
        row.textContent = candidates.join('  ');
        this.body.insertBefore(row, this.inputRow);
        this.scrollToBottom();
      }
    }

    runCurrent() {
      const line = this.input.value;
      this.histIdx = null;
      const echoRow = document.createElement('p');
      echoRow.className = 'shell-term-line shell-term-echo';
      echoRow.innerHTML = promptHtml(this.session) + escapeHtml(line);
      this.body.insertBefore(echoRow, this.inputRow);
      this.inputRow.remove();
      if (line.trim()) {
        let res;
        try { res = this.session.run(line); }
        catch (e) { res = { chunks: [{ stream: 'err', text: 'bash: internal error: ' + e.message + '\n' }] }; }
        this.printOutput(res);
      }
      refreshAllPrompts(this.session);
      this.newInputLine();
      this.input.focus();
    }
  }

  window.ShellTerminal = ShellTerminal;

  // Auto-mount: any element with data-shell-term="1" becomes a terminal.
  // Optional data-intro="..." text and data-seed="cmd1|cmd2" pre-run commands.
  function autoMount() {
    document.querySelectorAll('[data-shell-term]:not([data-shell-mounted])').forEach((el) => {
      el.setAttribute('data-shell-mounted', '1');
      const opts = {};
      if (el.dataset.intro) opts.intro = el.dataset.intro;
      if (el.dataset.seed) opts.seedCommands = el.dataset.seed.split('|');
      new ShellTerminal(el, opts);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount);
  else autoMount();
  window.__mountShellTerminals = autoMount;
})();
