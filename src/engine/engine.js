// engine.js — a small, honest simulation of a bash-like shell.
// Runs identically in Node (for testing) and in the browser (as window.ShellEngine).
// Scope: a teaching subset of bash. Not a real shell. Where it fakes something
// (network commands, `top`, `ps` of the host machine) it says so in the output.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShellEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------
  class ShellSyntaxError extends Error {}
  class ShellRuntimeError extends Error {} // message becomes stderr, exit 1

  // ---------------------------------------------------------------------
  // Virtual filesystem
  // ---------------------------------------------------------------------
  function mkNode(type, opts) {
    opts = opts || {};
    const node = {
      type, // 'dir' | 'file' | 'link'
      mode: opts.mode !== undefined ? opts.mode : (type === 'dir' ? 0o755 : 0o644),
      owner: opts.owner || 'dave',
      group: opts.group || 'staff',
      mtime: opts.mtime || 0,
    };
    if (type === 'dir') node.children = new Map();
    if (type === 'file') {
      node.content = opts.content !== undefined ? opts.content : '';
      if (opts.binaryLabel) node.binaryLabel = opts.binaryLabel; // e.g. "gzip compressed data"
      if (opts.archive) node.archive = opts.archive; // {tree: <serialized node>} for tar
    }
    if (type === 'link') node.target = opts.target || '';
    return node;
  }

  function splitPath(p) {
    return p.split('/').filter(Boolean);
  }

  // Resolve a path string (possibly relative, possibly with ~ . ..) against cwd
  // into an absolute segment array. Does NOT touch the filesystem.
  function resolvePathSegs(pathStr, cwdSegs, home) {
    let segs;
    if (pathStr.startsWith('~')) {
      const rest = pathStr.slice(1);
      segs = splitPath(home).concat(splitPath(rest));
    } else if (pathStr.startsWith('/')) {
      segs = splitPath(pathStr);
    } else {
      segs = cwdSegs.concat(splitPath(pathStr));
    }
    const out = [];
    for (const s of segs) {
      if (s === '.' || s === '') continue;
      if (s === '..') { if (out.length) out.pop(); continue; }
      out.push(s);
    }
    return out;
  }

  class VFS {
    constructor() {
      this.root = mkNode('dir', { owner: 'root', group: 'root', mode: 0o755 });
    }

    // Walk from root along segs, checking execute (traverse) permission on every
    // directory strictly along the way (not the final node). Resolves one level
    // of symlink for intermediate components. Returns {node, parent, name, error}
    getParentAndName(segs) {
      const name = segs[segs.length - 1];
      const parentSegs = segs.slice(0, -1);
      const parentRes = this._walk(parentSegs, { user: null }); // permission-free internal walk
      let parent = parentRes.node;
      // The parent may itself be a symlink to a directory (`ln -s d1 d2` then
      // `touch d2/f`) — dereference it, or callers get `undefined.children`.
      if (parent && parent.type === 'link') parent = this._followLink(parent, parentSegs.slice(0, -1), {});
      return { parent, name };
    }

    _walk(segs, opts) {
      opts = opts || {};
      let node = this.root;
      let pathSoFar = []; // path to `node`
      for (let i = 0; i < segs.length; i++) {
        if (node.type === 'link') {
          const containingSegs = pathSoFar.slice(0, -1);
          node = this._followLink(node, containingSegs, opts);
        }
        if (!node || node.type !== 'dir') return { node: null, error: 'ENOTDIR' };
        if (opts.user && !hasPerm(node, opts.user, 'x')) return { node: null, error: 'EPERM' };
        const child = node.children.get(segs[i]);
        if (!child) return { node: null, error: 'ENOENT' };
        node = child;
        pathSoFar = segs.slice(0, i + 1);
      }
      return { node, error: null };
    }

    // containingSegs = the absolute path of the directory that HOLDS this link
    // (needed so relative link targets like "logs/app.log" resolve from there,
    // not from the filesystem root).
    // Follows a symlink to a non-link node, chasing link→link→file chains and
    // giving up (rather than hanging) on a cycle.
    _followLink(node, containingSegs, opts, depth) {
      let cur = node;
      let base = containingSegs || [];
      for (let hops = depth || 0; hops < 16; hops++) {
        const segs = cur.target.startsWith('/') ? splitPath(cur.target) : normalizeJoin(base, splitPath(cur.target));
        const res = this._walk(segs, opts);
        if (!res.node) return null;
        if (res.node.type !== 'link') return res.node;
        cur = res.node;
        base = segs.slice(0, -1);
      }
      return null; // too many levels of symbolic links
    }

    // Public resolve: returns {node, error} where error is a human string or null.
    // followLink controls whether a trailing symlink is dereferenced.
    resolve(segs, user, followLink) {
      if (followLink === undefined) followLink = true;
      let node = this.root;
      let pathSoFar = [];
      for (let i = 0; i < segs.length; i++) {
        if (node.type === 'link') {
          const containingSegs = pathSoFar.slice(0, -1);
          node = this._followLink(node, containingSegs, { user });
          if (!node) return { node: null, error: 'broken symlink' };
        }
        if (node.type !== 'dir') return { node: null, error: 'not a directory' };
        if (user && !hasPerm(node, user, 'x')) return { node: null, error: 'permission denied' };
        const child = node.children.get(segs[i]);
        if (!child) return { node: null, error: 'no such file or directory' };
        node = child;
        pathSoFar = segs.slice(0, i + 1);
      }
      if (followLink && node.type === 'link') {
        const containingSegs = pathSoFar.slice(0, -1);
        const target = this._followLink(node, containingSegs, { user });
        if (!target) return { node: null, error: 'broken symlink' };
        return { node: target, error: null, viaLink: node };
      }
      return { node, error: null };
    }

    mkdirp(segs, user, mode) {
      let node = this.root;
      let pathSoFar = [];
      for (const s of segs) {
        if (node.type === 'link') {
          const containingSegs = pathSoFar.slice(0, -1);
          node = this._followLink(node, containingSegs, { user });
        }
        if (user && !hasPerm(node, user, 'x')) throw new ShellRuntimeError(`cannot create directory '${pathSoFar.concat(s).join('/')}': Permission denied`);
        let child = node.children.get(s);
        if (!child) {
          if (user && !hasPerm(node, user, 'w')) throw new ShellRuntimeError(`cannot create directory '${pathSoFar.concat(s).join('/')}': Permission denied`);
          child = mkNode('dir', { mode: mode !== undefined ? mode : 0o755, owner: user ? user.name : 'dave', group: user ? user.primaryGroup : 'staff' });
          node.children.set(s, child);
        } else if (child.type !== 'dir') {
          throw new ShellRuntimeError(`cannot create directory '${pathSoFar.concat(s).join('/')}': Not a directory`);
        }
        node = child;
        pathSoFar = pathSoFar.concat(s);
      }
      return node;
    }
  }

  function normalizeJoin(baseSegs, relSegs) {
    const out = baseSegs.slice();
    for (const s of relSegs) {
      if (s === '.' || s === '') continue;
      if (s === '..') { if (out.length) out.pop(); continue; }
      out.push(s);
    }
    return out;
  }

  function hasPerm(node, user, need) {
    if (!node) return false;
    if (user && user.sudo) return true;
    const bit = need === 'r' ? 4 : need === 'w' ? 2 : 1;
    let perm;
    if (!user) perm = 7;
    else if (node.owner === user.name) perm = (node.mode >> 6) & 7;
    else if (user.groups && user.groups.includes(node.group)) perm = (node.mode >> 3) & 7;
    else perm = node.mode & 7;
    return (perm & bit) === bit;
  }

  function modeToString(node) {
    const t = node.type === 'dir' ? 'd' : node.type === 'link' ? 'l' : '-';
    const bits = node.mode;
    const chars = ['r', 'w', 'x'];
    let s = t;
    for (let shift = 6; shift >= 0; shift -= 3) {
      const v = (bits >> shift) & 7;
      s += (v & 4 ? 'r' : '-') + (v & 2 ? 'w' : '-') + (v & 1 ? 'x' : '-');
    }
    return s;
  }

  function octalFromMode(mode) { return (mode & 0o777).toString(8).padStart(3, '0'); }

  // ---------------------------------------------------------------------
  // Glob & brace expansion
  // ---------------------------------------------------------------------
  function expandBraces(text) {
    const m = text.match(/\{([^{}]+)\}/);
    if (!m) return [text];
    const inner = m[1];
    const pre = text.slice(0, m.index);
    const post = text.slice(m.index + m[0].length);
    let parts;
    const rangeMatch = inner.match(/^(-?\d+)\.\.(-?\d+)$/);
    const letterRangeMatch = inner.match(/^([a-zA-Z])\.\.([a-zA-Z])$/);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10), b = parseInt(rangeMatch[2], 10);
      parts = [];
      if (a <= b) for (let v = a; v <= b; v++) parts.push(String(v));
      else for (let v = a; v >= b; v--) parts.push(String(v));
    } else if (letterRangeMatch && !inner.includes(',')) {
      const a = letterRangeMatch[1].charCodeAt(0), b = letterRangeMatch[2].charCodeAt(0);
      parts = [];
      if (a <= b) for (let v = a; v <= b; v++) parts.push(String.fromCharCode(v));
      else for (let v = a; v >= b; v--) parts.push(String.fromCharCode(v));
    } else if (inner.includes(',')) {
      parts = inner.split(',');
    } else {
      return [text]; // not a real brace expression, leave literal
    }
    const results = [];
    for (const p of parts) results.push(...expandBraces(pre + p + post));
    return results;
  }

  function globToRegex(glob) {
    let re = '^';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*') re += '.*';
      else if (c === '?') re += '.';
      else if (c === '[') {
        let j = i + 1, neg = false, set = '';
        if (glob[j] === '^' || glob[j] === '!') { neg = true; j++; }
        while (j < glob.length && glob[j] !== ']') { set += glob[j]; j++; }
        re += '[' + (neg ? '^' : '') + set.replace(/\\/g, '\\\\') + ']';
        i = j;
      } else {
        re += c.replace(/[.+^${}()|\\]/g, '\\$&');
      }
    }
    re += '$';
    return new RegExp(re);
  }

  function hasGlobChars(s) { return /[*?[]/.test(s); }

  // ---------------------------------------------------------------------
  // Tokenizer
  // ---------------------------------------------------------------------
  const OPS = ['2>&1', '>&2', '>&1', '2>>', '&>>', '&>', '2>', '>>', '||', '&&', '<<', '<', '>', '|', ';', '&'];

  // A bare (unquoted) $(...) or $((...)) must be consumed as one atomic run of
  // characters — its insides may contain spaces, redirects, and quotes that
  // must NOT be split into separate shell tokens here (they're re-parsed as
  // their own command when the substitution actually runs). line[i] is '$'
  // and line[i+1] is '(' when this is called. Returns the index just past
  // the matching close paren.
  function scanDollarParen(line, i) {
    let j = i + 2, depth = 1;
    while (j < line.length && depth > 0) {
      const c = line[j];
      if (c === '\\') { j += 2; continue; }
      if (c === "'") { const k = line.indexOf("'", j + 1); j = k === -1 ? line.length : k + 1; continue; }
      if (c === '"') {
        let k = j + 1;
        while (k < line.length && line[k] !== '"') { if (line[k] === '\\') k++; k++; }
        j = k + 1; continue;
      }
      if (c === '(') { depth++; j++; continue; }
      if (c === ')') { depth--; j++; continue; }
      j++;
    }
    return j;
  }

  // Span kinds:
  //   'b' bare      — expanded, then word-split and glob-expanded
  //   'd' double    — expanded, but never split or globbed
  //   's' literal   — never expanded (single quotes, and backslash-escaped chars)
  // A backslash-escaped character becomes its own 's' span, which is what makes
  // `echo \$HOME` print $HOME and `echo a\ b` stay one argument.
  function tokenize(line) {
    const tokens = [];
    let curSpans = null;
    let i = 0;
    // Inside [[ ... ]] bash treats < > && || as operators of the *test*, not as
    // redirections or list separators, so operator recognition is suspended and
    // they arrive as ordinary words for the `[[` builtin to interpret.
    let inTestBrackets = false;
    const flush = () => {
      if (!curSpans) return;
      const tok = { spans: curSpans };
      tokens.push(tok);
      if (curSpans.length === 1 && curSpans[0].kind === 'b') {
        if (curSpans[0].text === '[[') inTestBrackets = true;
        else if (curSpans[0].text === ']]') inTestBrackets = false;
      }
      curSpans = null;
    };
    const opAt = (pos) => (inTestBrackets ? undefined : OPS.find((o) => line.startsWith(o, pos)));
    while (i < line.length) {
      const ch = line[i];
      if (ch === '\n') { flush(); tokens.push({ op: ';' }); i++; continue; }
      if (/\s/.test(ch)) { flush(); i++; continue; }
      // `]]` closes the test and must always end the word, even when written
      // tight against what follows (`[[ -f x ]];` / `]]&&`), or the suspended
      // operator recognition would never be switched back on.
      if (inTestBrackets && line.startsWith(']]', i)) {
        flush();
        curSpans = [{ kind: 'b', text: ']]' }];
        flush(); // clears inTestBrackets
        i += 2; continue;
      }
      // `#` starts a comment only at a word boundary, so `echo a#b` and URLs
      // keep their hash but `chmod 644 f # note` and `#!/usr/bin/env bash` don't.
      if (ch === '#' && !curSpans) {
        const nl = line.indexOf('\n', i);
        if (nl === -1) break;
        i = nl; continue; // leave the newline for the separator logic above
      }
      if (!curSpans) {
        const op = opAt(i);
        if (op) { tokens.push({ op }); i += op.length; continue; }
      }
      if (ch === "'") {
        const j = line.indexOf("'", i + 1);
        if (j === -1) throw new ShellSyntaxError('unterminated single quote');
        curSpans = curSpans || [];
        curSpans.push({ kind: 's', text: line.slice(i + 1, j) });
        i = j + 1; continue;
      }
      if (ch === '"') {
        let j = i + 1, buf = '';
        curSpans = curSpans || [];
        while (j < line.length && line[j] !== '"') {
          if (line[j] === '\\' && j + 1 < line.length && '"\\$`'.includes(line[j + 1])) {
            // The escape must survive expansion, so break the run and emit the
            // escaped character as a literal span of its own.
            if (buf) { curSpans.push({ kind: 'd', text: buf }); buf = ''; }
            curSpans.push({ kind: 's', text: line[j + 1] });
            j += 2; continue;
          }
          // A $(...) inside double quotes is taken whole — its own quotes are
          // not the end of this string: "$(basename "$(pwd)")".
          if (line[j] === '$' && line[j + 1] === '(') {
            const end = scanDollarParen(line, j);
            buf += line.slice(j, end);
            j = end; continue;
          }
          buf += line[j]; j++;
        }
        if (j >= line.length) throw new ShellSyntaxError('unterminated double quote');
        // Always push, even when empty: "" is a real (empty) argument.
        curSpans.push({ kind: 'd', text: buf });
        i = j + 1; continue;
      }
      {
        let j = i;
        let buf = '';
        const spans = [];
        const pushBuf = () => { if (buf) { spans.push({ kind: 'b', text: buf }); buf = ''; } };
        while (j < line.length) {
          if (line[j] === '\\') {
            if (j + 1 >= line.length) { j++; break; }        // trailing \ — drop it
            if (line[j + 1] === '\n') { j += 2; continue; }  // line continuation
            pushBuf();
            spans.push({ kind: 's', text: line[j + 1] });
            j += 2; continue;
          }
          // A bare $(...) / $((...)) is consumed whole, whitespace/operators
          // and all — it's re-tokenized later when the substitution runs.
          if (line[j] === '$' && line[j + 1] === '(') {
            const end = scanDollarParen(line, j);
            buf += line.slice(j, end);
            j = end;
            continue;
          }
          if (/\s/.test(line[j]) || line[j] === "'" || line[j] === '"') break;
          // An operator can start right after a word with no whitespace
          // (e.g. "PROJECT=shell-lab;" or "2>file") — stop the bare word there,
          // just like real bash's metacharacter-based tokenizing.
          if (opAt(j)) break;
          buf += line[j]; j++;
        }
        pushBuf();
        if (!spans.length) {
          // We're sitting on an operator with no word collected yet — but the
          // op-check above (for !curSpans) only fires at the very start of a
          // token, so this only happens when curSpans already has content
          // (mid-word) and we hit an operator immediately. Let the outer loop
          // pick it up as an operator on the next pass.
          flush();
          const op = opAt(j);
          if (!op) { i = j + 1; continue; } // defensive: never spin in place
          tokens.push({ op }); i = j + op.length; continue;
        }
        curSpans = curSpans || [];
        for (const s of spans) curSpans.push(s);
        i = j;
      }
    }
    flush();
    return tokens;
  }

  // ---------------------------------------------------------------------
  // Parser: tokens -> list of {connector, background, pipeline:[segment,...]}
  // segment = {argvWords:[token,...], redirects:[{type,targetWord|null}]}
  // ---------------------------------------------------------------------
  function splitTop(tokens, ops) {
    const groups = [];
    let cur = [];
    let connector = null;
    for (const t of tokens) {
      if (t.op && ops.includes(t.op)) {
        groups.push({ connector, tokens: cur });
        connector = t.op;
        cur = [];
      } else cur.push(t);
    }
    groups.push({ connector, tokens: cur });
    return groups;
  }

  function parseLine(line) {
    const tokens = tokenize(line);
    const compounds = splitTop(tokens, [';', '&&', '||']);
    const commands = [];
    for (const c of compounds) {
      let toks = c.tokens;
      let background = false;
      if (toks.length && toks[toks.length - 1].op === '&') { background = true; toks = toks.slice(0, -1); }
      const pipeGroups = splitTop(toks, ['|']).map((g) => g.tokens);
      const pipeline = pipeGroups.map(parseSegment);
      commands.push({ connector: c.connector, background, pipeline });
    }
    return commands;
  }

  function parseSegment(tokens) {
    const argvWords = [];
    const redirects = [];
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.op) {
        // Duplication operators take no filename operand.
        if (t.op === '2>&1' || t.op === '>&2' || t.op === '>&1') { redirects.push({ type: t.op }); continue; }
        const target = tokens[k + 1];
        if (!target || target.op) throw new ShellSyntaxError(`syntax error near unexpected token, expected filename after '${t.op}'`);
        redirects.push({ type: t.op, targetWord: target });
        k++;
        continue;
      }
      argvWords.push(t);
    }
    return { argvWords, redirects };
  }

  // ---------------------------------------------------------------------
  // Statement-level parser: for / if / while / until on top of the
  // pipeline parser above. Newlines are tokenized as ';' (see tokenize()),
  // so a multi-line script and a semicolon-joined one-liner parse the same.
  // ---------------------------------------------------------------------
  const KEYWORDS = ['for', 'if', 'while', 'until'];
  const TERM_OPS = [';', '&&', '||', '&'];

  function isWordTok(t, w) { return t && !t.op && t.spans && t.spans.length === 1 && t.spans[0].kind === 'b' && t.spans[0].text === w; }
  function isStopWordTok(t, words) { return t && !t.op && t.spans && t.spans.length === 1 && t.spans[0].kind === 'b' && words.indexOf(t.spans[0].text) !== -1; }

  function mkCursor(tokens) { return { toks: tokens, i: 0 }; }
  function atEnd(c) { return c.i >= c.toks.length; }
  function peek(c) { return c.toks[c.i]; }
  function skipLeadingSeps(c) { while (!atEnd(c) && peek(c).op === ';') c.i++; }
  function expectWord(c, w) {
    if (!isWordTok(peek(c), w)) throw new ShellSyntaxError(`syntax error: expected '${w}'`);
    c.i++;
  }
  function isCompoundStart(c) {
    const t = peek(c);
    return !!t && !t.op && t.spans && t.spans.length === 1 && t.spans[0].kind === 'b' && KEYWORDS.indexOf(t.spans[0].text) !== -1;
  }

  // Parses one pipeline: `[!] stage [| stage]...`, where a stage is either a
  // simple command or a whole compound (`cat f | while read -r l; do ...; done`).
  // Stops at a top-level terminator (';','&&','||','&') or at a reserved stop
  // word in COMMAND POSITION (start of a stage), never mid-argument — so
  // `echo done` and `grep -r if .` stay ordinary commands.
  function parsePipeline(c, stopWords) {
    let negate = false;
    if (isWordTok(peek(c), '!')) { negate = true; c.i++; }
    const stages = [];
    while (true) {
      if (isCompoundStart(c)) {
        const node = parseCompound(c);
        // A redirect written after `done`/`fi` applies to the whole compound:
        // `while read -r l; do ...; done < names.txt`.
        node.redirects = collectRedirects(c);
        stages.push({ kind: 'compound', node });
      } else {
        const collected = [];
        while (!atEnd(c)) {
          const t = peek(c);
          if (t.op === '|') break;
          if (t.op && TERM_OPS.indexOf(t.op) !== -1) break;
          if (!collected.length && !t.op && stopWords && isStopWordTok(t, stopWords)) break;
          collected.push(t);
          c.i++;
        }
        stages.push({ kind: 'simple', seg: parseSegment(collected) });
      }
      if (!atEnd(c) && peek(c).op === '|') { c.i++; continue; }
      break;
    }
    return { stages, negate };
  }

  function collectRedirects(c) {
    const redirects = [];
    while (!atEnd(c)) {
      const t = peek(c);
      if (!t.op || TERM_OPS.indexOf(t.op) !== -1 || t.op === '|') break;
      c.i++;
      if (t.op === '2>&1' || t.op === '>&2' || t.op === '>&1') { redirects.push({ type: t.op }); continue; }
      const target = c.toks[c.i];
      if (!target || target.op) throw new ShellSyntaxError(`syntax error near unexpected token, expected filename after '${t.op}'`);
      redirects.push({ type: t.op, targetWord: target });
      c.i++;
    }
    return redirects;
  }

  // Parses a sequence of ;/&&/||-joined pipelines until end-of-input or a
  // reserved stop word in command position.
  function parseList(c, stopWords) {
    const entries = [];
    let connector = null;
    skipLeadingSeps(c);
    while (true) {
      if (atEnd(c)) break;
      if (stopWords && currentIsStopWord(c, stopWords)) break;
      const { stages, negate } = parsePipeline(c, stopWords);
      const entry = { connector, background: false, kind: 'pipeline', stages, negate };
      let backgrounded = false;
      if (!atEnd(c) && peek(c).op === '&') { entry.background = true; backgrounded = true; c.i++; }
      entries.push(entry);
      connector = null;
      // "&" is itself a statement separator (like ";"), not just a suffix —
      // "sleep 2 & jobs" backgrounds sleep, then runs jobs right away.
      if (backgrounded) { skipLeadingSeps(c); continue; }
      if (atEnd(c)) break;
      const t = peek(c);
      if (t.op === ';') { c.i++; connector = null; skipLeadingSeps(c); continue; }
      if (t.op === '&&') { c.i++; connector = '&&'; continue; }
      if (t.op === '||') { c.i++; connector = '||'; continue; }
      break;
    }
    return entries;
  }
  function currentIsStopWord(c, stopWords) { return isStopWordTok(peek(c), stopWords); }

  function parseCompound(c) {
    if (isWordTok(peek(c), 'for')) return parseFor(c);
    if (isWordTok(peek(c), 'if')) return parseIf(c);
    if (isWordTok(peek(c), 'while')) return parseWhileUntil(c, false);
    if (isWordTok(peek(c), 'until')) return parseWhileUntil(c, true);
    throw new ShellSyntaxError('syntax error: unexpected keyword');
  }

  function parseFor(c) {
    expectWord(c, 'for');
    const varTok = peek(c);
    if (!varTok || varTok.op) throw new ShellSyntaxError("syntax error: expected name after 'for'");
    const varName = varTok.spans.map((s) => s.text).join('');
    c.i++;
    let itemsTokens = [];
    if (isWordTok(peek(c), 'in')) {
      c.i++;
      while (!atEnd(c) && peek(c).op !== ';' && !isWordTok(peek(c), 'do')) { itemsTokens.push(peek(c)); c.i++; }
    }
    if (!atEnd(c) && peek(c).op === ';') c.i++;
    skipLeadingSeps(c);
    expectWord(c, 'do');
    const body = parseList(c, ['done']);
    expectWord(c, 'done');
    return { type: 'for', varName, itemsTokens, body };
  }

  function parseIf(c) {
    expectWord(c, 'if');
    const branches = [];
    let condEntries = parseList(c, ['then']);
    expectWord(c, 'then');
    let body = parseList(c, ['elif', 'else', 'fi']);
    branches.push({ condEntries, body });
    while (isWordTok(peek(c), 'elif')) {
      c.i++;
      const ce = parseList(c, ['then']);
      expectWord(c, 'then');
      const b = parseList(c, ['elif', 'else', 'fi']);
      branches.push({ condEntries: ce, body: b });
    }
    let elseBody = null;
    if (isWordTok(peek(c), 'else')) { c.i++; elseBody = parseList(c, ['fi']); }
    expectWord(c, 'fi');
    return { type: 'if', branches, elseBody };
  }

  function parseWhileUntil(c, negate) {
    expectWord(c, negate ? 'until' : 'while');
    const condEntries = parseList(c, ['do']);
    expectWord(c, 'do');
    const body = parseList(c, ['done']);
    expectWord(c, 'done');
    return { type: negate ? 'until' : 'while', condEntries, body };
  }

  function parseProgram(text) {
    const tokens = tokenize(text);
    const c = mkCursor(tokens);
    const entries = parseList(c, null);
    if (!atEnd(c)) throw new ShellSyntaxError('unexpected token');
    return entries;
  }

  // ---------------------------------------------------------------------
  // Expansion
  // ---------------------------------------------------------------------
  function isAllBare(spans) { return spans.every((s) => s.kind === 'b'); }

  // Replaces $(...) with the command's output. Uses the same quote-aware scan
  // as the tokenizer, so `$(basename "$(pwd)")` and `$(echo "a)b")` find the
  // right closing paren instead of the first one inside a string.
  function replaceCmdSub(text, run) {
    let out = '';
    let i = 0;
    while (i < text.length) {
      if (text[i] === '$' && text[i + 1] === '(') {
        const end = scanDollarParen(text, i); // index just past the matching ')'
        const inner = text.slice(i + 2, end - 1);
        out += run(inner).replace(/\n+$/, '');
        i = end;
      } else {
        out += text[i]; i++;
      }
    }
    return out;
  }

  // $(( expr )) arithmetic expansion — reuses the same paren-depth scan as
  // command substitution, then strips one layer of parens from the capture.
  function replaceArith(text, evalFn) {
    let out = '';
    let i = 0;
    while (i < text.length) {
      if (text[i] === '$' && text[i + 1] === '(' && text[i + 2] === '(') {
        const end = scanDollarParen(text, i); // index just past the matching ')'
        let inner = text.slice(i + 2, end - 1);
        if (inner.startsWith('(') && inner.endsWith(')')) inner = inner.slice(1, -1);
        out += String(evalFn(inner));
        i = end;
      } else { out += text[i]; i++; }
    }
    return out;
  }

  // Expands a glob component by component, so wildcards work anywhere in the
  // path (`l*/a*.log`, `du -sh */`), not only in the last segment. A trailing
  // slash restricts matches to directories and is preserved in the output.
  function globPattern(pattern, cwdSegs, fs, home, user) {
    const wantDirs = pattern.endsWith('/');
    const body = wantDirs ? pattern.slice(0, -1) : pattern;
    const absolute = body.startsWith('/');
    const tilde = body.startsWith('~');
    const parts = (tilde ? home + body.slice(1) : body).split('/').filter((p) => p !== '');
    if (!parts.length) return [];

    // Each candidate carries the segment path used to look it up and the text
    // to print (which keeps the caller's relative/absolute framing).
    const baseSegs = absolute || tilde ? [] : cwdSegs;
    let candidates = [{ segs: baseSegs, text: absolute || tilde ? '' : '' }];
    const isAbsOut = absolute || tilde;

    for (let idx = 0; idx < parts.length; idx++) {
      const part = parts[idx];
      const isLast = idx === parts.length - 1;
      const next = [];
      for (const cand of candidates) {
        if (!hasGlobChars(part)) {
          // Literal component: only keep walking, don't verify until the end
          // (an unmatched literal simply yields no results at the final step).
          const segs = part === '..' ? cand.segs.slice(0, -1) : part === '.' ? cand.segs : cand.segs.concat(part);
          next.push({ segs, text: cand.text + part + '/' });
          continue;
        }
        const res = fs.resolve(cand.segs, user);
        if (!res.node || res.node.type !== 'dir') continue;
        const re = globToRegex(part);
        const names = [...res.node.children.keys()].filter((n) => {
          if (n.startsWith('.') && !part.startsWith('.')) return false;
          return re.test(n);
        }).sort();
        for (const n of names) {
          const child = res.node.children.get(n);
          // Intermediate components must be directories to descend into.
          if (!isLast && child.type !== 'dir' && child.type !== 'link') continue;
          next.push({ segs: cand.segs.concat(n), text: cand.text + n + '/' });
        }
      }
      candidates = next;
      if (!candidates.length) return [];
    }

    const out = [];
    for (const cand of candidates) {
      const res = fs.resolve(cand.segs, user);
      if (!res.node) continue;
      if (wantDirs && res.node.type !== 'dir') continue;
      const rel = cand.text.slice(0, -1); // drop the trailing '/' we appended
      out.push((isAbsOut ? '/' : '') + rel + (wantDirs ? '/' : ''));
    }
    return out.sort();
  }

  // ---------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------
  function createSession(opts) {
    opts = opts || {};
    const DAY = 86400000, HOUR = 3600000, MIN = 60000;
    const fs = new VFS();
    const user = { name: 'dave', primaryGroup: 'staff', groups: ['dave', 'staff', 'sudo', 'docker'], sudo: false };
    const startedReal = (opts.now || Date.now)();
    const state = {
      fs, user,
      cwdSegs: splitPath('/home/dave'),
      home: '/home/dave',
      vars: {}, exported: new Set(),
      aliases: {},
      history: [],
      lastExit: 0,
      jobs: [], // {id, cmd, status:'Running'|'Done'|'Stopped', pid, kind:'sleep', endsAt, timer}
      pidCounter: 1000,
      nowFn: opts.now || Date.now,
      clockStart: startedReal,
      simEpoch: opts.simEpoch !== undefined ? opts.simEpoch : Date.UTC(2026, 7, 14, 16, 20, 0), // 2026-08-14 09:20 PDT
      output: [], // collected by run() per call
      commandsList: null, // filled below
      procs: [], // background/system fake processes for ps
      umask: 0o022,
    };
    state.vars.HOME = state.home;
    state.vars.USER = 'dave';
    state.vars.SHELL = '/bin/bash';
    state.vars.BASH_VERSION = '5.2.21(1)-release';
    state.vars.PWD = state.home;
    state.vars.EDITOR = 'vim';
    state.vars.PATH = '/home/dave/bin:/usr/local/bin:/usr/bin:/bin';
    ['HOME', 'USER', 'SHELL', 'PWD', 'EDITOR', 'PATH'].forEach((k) => state.exported.add(k));

    seed(state);
    seedProcs(state);

    function now() { return state.simEpoch + (state.nowFn() - state.clockStart); }
    state.simNow = now;

    // -------------------- variable resolution --------------------
    function getVar(name, ctx) {
      if (ctx && ctx.locals && Object.prototype.hasOwnProperty.call(ctx.locals, name)) return ctx.locals[name];
      if (Object.prototype.hasOwnProperty.call(state.vars, name)) return state.vars[name];
      return undefined;
    }
    function setVar(name, value, ctx, exportIt) {
      if (ctx && ctx.locals && Object.prototype.hasOwnProperty.call(ctx.locals, name)) { ctx.locals[name] = value; return; }
      state.vars[name] = value;
      if (exportIt) state.exported.add(name);
    }

    function resolveSimpleVar(name, ctx) {
      if (name === '?') return String(state.lastExit);
      if (name === '$') return String(1234);
      if (name === '0') return (ctx && ctx.scriptName) || 'bash';
      if (name === '#') return String((ctx && ctx.positional || []).length);
      if (name === '@' || name === '*') return (ctx && ctx.positional || []).join(' ');
      if (/^[0-9]$/.test(name)) return ((ctx && ctx.positional) || [])[parseInt(name, 10) - 1] || '';
      if (name === '!') { const j = state.jobs[state.jobs.length - 1]; return j ? String(j.pid) : ''; }
      const v = getVar(name, ctx);
      return v === undefined ? '' : v;
    }

    function globToRe(pat) { return globToRegex(pat); }

    function resolveBraceExpr(inner, ctx) {
      let m;
      if ((m = inner.match(/^([A-Za-z_][A-Za-z0-9_]*):-(.*)$/))) {
        const v = getVar(m[1], ctx);
        return (v === undefined || v === '') ? expandVarsAndCmdSub(m[2], ctx) : v;
      }
      if ((m = inner.match(/^([A-Za-z_][A-Za-z0-9_]*):\?(.*)$/))) {
        const v = getVar(m[1], ctx);
        if (v === undefined || v === '') {
          const msg = expandVarsAndCmdSub(m[2], ctx) || 'parameter null or not set';
          throw new ShellRuntimeError(`bash: ${m[1]}: ${msg}`);
        }
        return v;
      }
      if ((m = inner.match(/^([A-Za-z_][A-Za-z0-9_]*):=(.*)$/))) {
        let v = getVar(m[1], ctx);
        if (v === undefined || v === '') { v = expandVarsAndCmdSub(m[2], ctx); setVar(m[1], v, ctx, false); }
        return v;
      }
      if ((m = inner.match(/^#([A-Za-z_][A-Za-z0-9_]*)$/))) {
        const v = resolveSimpleVar(m[1], ctx) || '';
        return String(v.length);
      }
      if ((m = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)%%(.*)$/))) {
        const v = getVar(m[1], ctx) || ''; return stripSuffix(v, m[2], true);
      }
      if ((m = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)%(.*)$/))) {
        const v = getVar(m[1], ctx) || ''; return stripSuffix(v, m[2], false);
      }
      if ((m = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)##(.*)$/))) {
        const v = getVar(m[1], ctx) || ''; return stripPrefix(v, m[2], true);
      }
      if ((m = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)#(.*)$/))) {
        const v = getVar(m[1], ctx) || ''; return stripPrefix(v, m[2], false);
      }
      if ((m = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\/\/([^/]*)\/(.*)$/))) {
        const v = getVar(m[1], ctx) || '';
        return v.split(m[2]).join(m[3]);
      }
      if ((m = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\/([^/]*)\/(.*)$/))) {
        const v = getVar(m[1], ctx) || '';
        const idx = v.indexOf(m[2]);
        if (idx === -1) return v;
        return v.slice(0, idx) + m[3] + v.slice(idx + m[2].length);
      }
      if ((m = inner.match(/^[A-Za-z_][A-Za-z0-9_]*$/))) return resolveSimpleVar(inner, ctx);
      return '';
    }

    function stripSuffix(value, pattern, greedy) {
      const re = globToRe(pattern).source.replace(/^\^/, '').replace(/\$$/, '');
      const full = new RegExp((greedy ? '(' + re + ')$' : '(' + re + ')$'));
      // shortest vs longest match: try progressively
      if (!greedy) {
        for (let i = 0; i <= value.length; i++) {
          const suf = value.slice(value.length - i);
          if (new RegExp('^' + re + '$').test(suf)) return value.slice(0, value.length - i);
        }
        return value;
      } else {
        for (let i = value.length; i >= 0; i--) {
          const suf = value.slice(value.length - i);
          if (new RegExp('^' + re + '$').test(suf)) return value.slice(0, value.length - i);
        }
        return value;
      }
    }
    function stripPrefix(value, pattern, greedy) {
      const re = globToRe(pattern).source.replace(/^\^/, '').replace(/\$$/, '');
      if (!greedy) {
        for (let i = 0; i <= value.length; i++) {
          const pre = value.slice(0, i);
          if (new RegExp('^' + re + '$').test(pre)) return value.slice(i);
        }
        return value;
      } else {
        for (let i = value.length; i >= 0; i--) {
          const pre = value.slice(0, i);
          if (new RegExp('^' + re + '$').test(pre)) return value.slice(i);
        }
        return value;
      }
    }

    // -------------------- minimal arithmetic evaluator for $((...)) --------------------
    function evalArith(expr, ctx) {
      const s = expr;
      let pos = 0;
      function skipWs() { while (s[pos] === ' ' || s[pos] === '\t') pos++; }
      function parseExpr() { return parseCompare(); }
      function parseCompare() {
        let left = parseAdd();
        skipWs();
        while (true) {
          let op = null;
          if (s.startsWith('==', pos)) op = '==';
          else if (s.startsWith('!=', pos)) op = '!=';
          else if (s.startsWith('<=', pos)) op = '<=';
          else if (s.startsWith('>=', pos)) op = '>=';
          else if (s[pos] === '<') op = '<';
          else if (s[pos] === '>') op = '>';
          if (!op) break;
          pos += op.length;
          const right = parseAdd();
          if (op === '==') left = left === right ? 1 : 0;
          else if (op === '!=') left = left !== right ? 1 : 0;
          else if (op === '<=') left = left <= right ? 1 : 0;
          else if (op === '>=') left = left >= right ? 1 : 0;
          else if (op === '<') left = left < right ? 1 : 0;
          else left = left > right ? 1 : 0;
          skipWs();
        }
        return left;
      }
      function parseAdd() {
        let left = parseMul();
        skipWs();
        while (s[pos] === '+' || s[pos] === '-') {
          const op = s[pos]; pos++;
          const right = parseMul();
          left = op === '+' ? left + right : left - right;
          skipWs();
        }
        return left;
      }
      function parseMul() {
        let left = parseUnary();
        skipWs();
        while (s[pos] === '*' || s[pos] === '/' || s[pos] === '%') {
          const op = s[pos]; pos++;
          const right = parseUnary();
          if (op === '*') left *= right;
          else if (op === '/') left = right === 0 ? 0 : Math.trunc(left / right);
          else left = right === 0 ? 0 : (left % right);
          skipWs();
        }
        return left;
      }
      function parseUnary() {
        skipWs();
        if (s[pos] === '-') { pos++; return -parseUnary(); }
        if (s[pos] === '+') { pos++; return parseUnary(); }
        if (s[pos] === '!') { pos++; return parseUnary() === 0 ? 1 : 0; }
        return parsePrimary();
      }
      function parsePrimary() {
        skipWs();
        if (s[pos] === '(') { pos++; const v = parseExpr(); skipWs(); if (s[pos] === ')') pos++; return v; }
        const m = /^[0-9]+(\.[0-9]+)?/.exec(s.slice(pos));
        if (m) { pos += m[0].length; return parseFloat(m[0]); }
        const idm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(pos));
        if (idm) { pos += idm[0].length; const v = getVar(idm[0], ctx); return v === undefined ? 0 : (parseFloat(v) || 0); }
        pos++; return 0; // skip unrecognized char to avoid an infinite loop
      }
      return Math.trunc(parseExpr());
    }

    function expandVarsAndCmdSub(text, ctx) {
      text = replaceArith(text, (inner) => evalArith(inner, ctx));
      text = replaceCmdSub(text, (inner) => runCapture(inner, ctx));
      text = text.replace(/\$\{([^{}]*)\}/g, (m, inner) => resolveBraceExpr(inner, ctx));
      text = text.replace(/\$([A-Za-z_][A-Za-z0-9_]*|[0-9#@?$!*])/g, (m, name) => resolveSimpleVar(name, ctx));
      return text;
    }

    function expandWord(spans, ctx) {
      const allBare = isAllBare(spans);
      let expandedConcat = spans.map((s) => (s.kind === 's' ? s.text : expandVarsAndCmdSub(s.text, ctx))).join('');
      // Tilde expansion: only on an unquoted leading ~ (bash does not expand
      // "~" or '~'), so `echo ~` prints the home directory but `echo "~"` does not.
      if (allBare && (expandedConcat === '~' || expandedConcat.startsWith('~/'))) {
        expandedConcat = state.home + expandedConcat.slice(1);
      }
      if (allBare) {
        const pieces = expandedConcat.split(/\s+/).filter((p) => p.length > 0);
        const out = [];
        for (const piece of pieces) {
          if (hasGlobChars(piece)) {
            const matches = globPattern(piece, state.cwdSegs, fs, state.home, user);
            if (matches.length) out.push(...matches); else out.push(piece);
          } else out.push(piece);
        }
        return out;
      }
      return [expandedConcat];
    }

    function expandArgv(argvWordsTokens, ctx) {
      // brace-expand bare-only tokens first
      let flat = [];
      for (const tok of argvWordsTokens) {
        if (isAllBare(tok.spans) && tok.spans.length === 1 && /\{[^{}]*[,.][^{}]*\}/.test(tok.spans[0].text)) {
          const variants = expandBraces(tok.spans[0].text);
          for (const v of variants) flat.push({ spans: [{ kind: 'b', text: v }] });
        } else flat.push(tok);
      }
      const words = [];
      for (const tok of flat) words.push(...expandWord(tok.spans, ctx));
      return words;
    }

    // -------------------- run a full line, return stdout as string (for $()) --------------------
    function runCapture(line, ctx) {
      const buf = { out: '', err: '' };
      const sink = { write: (s) => { buf.out += s; }, writeErr: (s) => { buf.err += s; } };
      try { execLine(line, sink, ctx); } catch (e) { /* swallow for capture */ }
      return buf.out;
    }

    // -------------------- path/file helpers exposed to builtins --------------------
    function abs(pathStr) { return resolvePathSegs(pathStr, state.cwdSegs, state.home); }
    function prettyPath(segs) { return '/' + segs.join('/'); }
    function tildePath(segs) {
      const homeSegs = splitPath(state.home);
      if (segs.length >= homeSegs.length && homeSegs.every((s, i) => segs[i] === s)) {
        const rest = segs.slice(homeSegs.length);
        return rest.length ? '~/' + rest.join('/') : '~';
      }
      return prettyPath(segs);
    }

    // -------------------- execution --------------------
    function execLine(line, sink, ctx) {
      let entries;
      try { entries = parseProgram(line); }
      catch (e) { sink.writeErr('bash: syntax error: ' + e.message + '\n'); state.lastExit = 2; return; }
      execEntries(entries, sink, ctx);
    }

    function execEntries(entries, sink, ctx) {
      let runNext = true;
      for (const e of entries) {
        if (e.connector === '&&' && state.lastExit !== 0) { runNext = false; }
        else if (e.connector === '||' && state.lastExit === 0) { runNext = false; }
        else runNext = true;
        if (!runNext) continue;
        execEntry(e, sink, ctx);
      }
    }

    function execEntry(e, sink, ctx) {
      const stages = e.stages || [];
      // An entirely empty pipeline (a stray ';') is a no-op.
      if (stages.length === 1 && stages[0].kind === 'simple' &&
          !stages[0].seg.argvWords.length && !stages[0].seg.redirects.length) return;
      if (e.background) {
        const first = stages[0];
        const argv0 = first && first.kind === 'simple' ? expandArgv(first.seg.argvWords, ctx) : [];
        launchBackground(argv0, sink, ctx);
        return;
      }
      runPipeline(stages, sink, ctx);
      // `! cmd` inverts the pipeline's status, mapping any nonzero to 1.
      if (e.negate) state.lastExit = state.lastExit === 0 ? 1 : 0;
    }

    // Iteration guard shared by for/while/until so a runaway loop typed into a
    // browser widget can't lock the tab.
    const MAX_LOOP_ITERATIONS = 10000;

    function execCompoundNode(node, sink, ctx) {
      // A redirect on the compound itself (`done < file`) becomes the input
      // stream its body's `read` calls consume, one line per call.
      let bodyCtx = ctx;
      const inRedir = (node.redirects || []).find((r) => r.type === '<');
      if (inRedir) {
        const path = resolveRedirectTargetPath(inRedir.targetWord, ctx);
        const res = fs.resolve(abs(path), user);
        if (!res.node) throw new ShellRuntimeError(`bash: ${path}: No such file or directory`);
        bodyCtx = Object.create(ctx);
        bodyCtx.stdinStream = mkStdinStream(res.node.content || '');
      } else if (ctx && ctx.pipedStdin !== undefined) {
        bodyCtx = Object.create(ctx);
        bodyCtx.stdinStream = mkStdinStream(ctx.pipedStdin);
      }

      if (node.type === 'for') {
        const items = node.itemsTokens.length ? expandArgv(node.itemsTokens, bodyCtx) : [];
        state.lastExit = 0;
        let n = 0;
        for (const item of items) {
          if (++n > MAX_LOOP_ITERATIONS) { sink.writeErr(loopLimitMsg()); break; }
          setVar(node.varName, item, bodyCtx, false);
          execEntries(node.body, sink, bodyCtx);
        }
        return;
      }
      if (node.type === 'if') {
        for (const branch of node.branches) {
          execEntries(branch.condEntries, sink, bodyCtx);
          if (state.lastExit === 0) { execEntries(branch.body, sink, bodyCtx); return; }
        }
        if (node.elseBody) execEntries(node.elseBody, sink, bodyCtx);
        else state.lastExit = 0; // an if with no matching branch succeeds
        return;
      }
      if (node.type === 'while' || node.type === 'until') {
        let n = 0;
        let bodyExit = 0; // a loop's status is its last body run, 0 if it never ran
        while (true) {
          execEntries(node.condEntries, sink, bodyCtx);
          let truth = state.lastExit === 0;
          if (node.type === 'until') truth = !truth;
          if (!truth) break;
          if (++n > MAX_LOOP_ITERATIONS) { sink.writeErr(loopLimitMsg()); break; }
          execEntries(node.body, sink, bodyCtx);
          bodyExit = state.lastExit;
        }
        state.lastExit = bodyExit;
        return;
      }
    }
    function loopLimitMsg() {
      return `bash: loop stopped after ${MAX_LOOP_ITERATIONS} iterations (sandbox safety limit — a real shell would keep going)\n`;
    }

    // A rewindable line reader, so successive `read` calls in a loop body walk
    // through the redirected file instead of all seeing line 1.
    function mkStdinStream(text) {
      return {
        text, pos: 0,
        readLine() {
          if (this.pos >= this.text.length) return null;
          const nl = this.text.indexOf('\n', this.pos);
          const line = nl === -1 ? this.text.slice(this.pos) : this.text.slice(this.pos, nl);
          this.pos = nl === -1 ? this.text.length : nl + 1;
          return line;
        },
      };
    }

    function resolveRedirectTargetPath(word, ctx) {
      const strs = expandWord(word.spans, ctx);
      return strs.join(' ');
    }

    // Writes to /dev/null are discarded rather than accumulated, so the
    // `cmd >/dev/null 2>&1` idiom the book teaches behaves as readers expect.
    const NULL_SINK = { devNull: true };
    function openForWrite(pathStr, append, ctx) {
      if (pathStr === '/dev/null') return NULL_SINK;
      const segs = abs(pathStr);
      const { parent, name } = fs.getParentAndName(segs);
      if (!parent || parent.type !== 'dir') throw new ShellRuntimeError(`bash: ${pathStr}: No such file or directory`);
      if (!hasPerm(parent, user, 'w')) throw new ShellRuntimeError(`bash: ${pathStr}: Permission denied`);
      let node = parent.children.get(name);
      if (!node) { node = mkNode('file', { content: '', mode: 0o666 & ~state.umask, owner: user.name, group: user.primaryGroup }); parent.children.set(name, node); }
      if (node.type !== 'file') throw new ShellRuntimeError(`bash: ${pathStr}: Is a directory`);
      if (!append) node.content = '';
      node.mtime = now();
      return node;
    }

    const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

    // Runs one pipeline. Every stage is wrapped so that a ShellRuntimeError
    // raised anywhere — expansion, redirect setup, or the command itself —
    // becomes a normal "bash: ..." stderr line and a nonzero status, instead of
    // escaping run() and tearing down the browser widget.
    function runPipeline(stages, sink, ctx) {
      let stdin = '';
      for (let i = 0; i < stages.length; i++) {
        const isLast = i === stages.length - 1;
        try {
          stdin = runStage(stages[i], stdin, isLast, sink, ctx);
        } catch (e) {
          if (e instanceof ShellRuntimeError) {
            sink.writeErr(e.message.startsWith('bash:') ? e.message + '\n' : 'bash: ' + e.message + '\n');
            state.lastExit = 1;
            return;
          }
          throw e;
        }
      }
    }

    function runStage(stage, stdin, isLast, sink, ctx) {
      if (stage.kind === 'compound') {
        // A compound in a pipeline gets its own capturing sink so its output can
        // feed the next stage; stderr always goes straight through.
        let out = '';
        const inner = { write: (s) => { out += s; }, writeErr: (s) => sink.writeErr(s) };
        const childCtx = Object.create(ctx || {});
        if (stdin) childCtx.pipedStdin = stdin;
        execCompoundNode(stage.node, isLast ? sink : inner, childCtx);
        applyCompoundOutRedirects(stage.node, ctx);
        return isLast ? '' : out;
      }
      return runSimpleStage(stage.seg, stdin, isLast, sink, ctx);
    }

    // `done > out.txt` — output redirects on a compound. The `<` form is handled
    // in execCompoundNode (it becomes the body's read stream).
    function applyCompoundOutRedirects(node, ctx) {
      for (const r of (node.redirects || [])) {
        if (r.type === '>' || r.type === '>>') openForWrite(resolveRedirectTargetPath(r.targetWord, ctx), r.type === '>>', ctx);
      }
    }

    function runSimpleStage(seg, stdin, isLast, sink, ctx) {
      {
        // Detect one or more leading NAME=value assignment tokens. The name/=
        // is always a bare (unquoted) prefix, but the value part may include
        // quoted spans glued on, e.g. f="backup tar.gz" or f=$HOME/x.
        let assignIdx = 0;
        while (assignIdx < seg.argvWords.length) {
          const tok = seg.argvWords[assignIdx];
          if (tok.spans.length && tok.spans[0].kind === 'b' && ASSIGN_RE.test(tok.spans[0].text)) assignIdx++;
          else break;
        }
        const assignTokens = seg.argvWords.slice(0, assignIdx);
        const restTokens = seg.argvWords.slice(assignIdx);

        function applyAssign(tok) {
          const text = tok.spans.map((s) => (s.kind === 's' ? s.text : expandVarsAndCmdSub(s.text, ctx))).join('');
          const eq = text.indexOf('=');
          return { name: text.slice(0, eq), value: text.slice(eq + 1) };
        }

        if (assignTokens.length && restTokens.length === 0) {
          // Pure assignment statement(s): "FOO=bar" or "A=1 B=2" — persist and move on.
          for (const tok of assignTokens) { const a = applyAssign(tok); setVar(a.name, a.value, ctx, false); }
          state.lastExit = 0;
          return '';
        }

        let savedVars = null;
        if (assignTokens.length) {
          savedVars = assignTokens.map(applyAssign).map((a) => {
            const had = Object.prototype.hasOwnProperty.call(state.vars, a.name);
            const old = state.vars[a.name];
            state.vars[a.name] = a.value;
            return { name: a.name, had, old };
          });
        }
        const restoreAssigns = () => {
          if (!savedVars) return;
          for (const sv of savedVars) { if (sv.had) state.vars[sv.name] = sv.old; else delete state.vars[sv.name]; }
        };

        let argv, outTarget, errTarget;
        try {
          argv = expandArgv(restTokens, ctx);
          if (argv.length === 0 && seg.redirects.length === 0) return '';

          // Targets are resolved to descriptors first, so that `2>&1` copies
          // wherever stdout currently points instead of a half-built object.
          // 'pipe' = downstream stage or the terminal; 'stderr' = the error
          // stream; {file, append} = a file.
          outTarget = 'pipe';
          errTarget = 'stderr';
          let inFile = null;
          for (const r of seg.redirects) {
            if (r.type === '>' || r.type === '>>') outTarget = { file: resolveRedirectTargetPath(r.targetWord, ctx), append: r.type === '>>' };
            else if (r.type === '<') inFile = resolveRedirectTargetPath(r.targetWord, ctx);
            else if (r.type === '2>' || r.type === '2>>') errTarget = { file: resolveRedirectTargetPath(r.targetWord, ctx), append: r.type === '2>>' };
            else if (r.type === '&>' || r.type === '&>>') { outTarget = { file: resolveRedirectTargetPath(r.targetWord, ctx), append: r.type === '&>>' }; errTarget = outTarget; }
            else if (r.type === '2>&1') errTarget = outTarget;   // stderr follows stdout as it stands NOW
            else if (r.type === '>&2') outTarget = 'stderr';     // stdout to the error stream
            else if (r.type === '>&1') outTarget = 'pipe';
          }
          if (inFile) {
            const res = fs.resolve(abs(inFile), user);
            if (!res.node) throw new ShellRuntimeError(`bash: ${inFile}: No such file or directory`);
            if (res.node.type === 'dir') throw new ShellRuntimeError(`bash: ${inFile}: Is a directory`);
            stdin = res.node.content || '';
          }
        } catch (e) { restoreAssigns(); throw e; }

        let result;
        try {
          result = runBuiltin(argv[0], argv.slice(1), stdin, ctx);
        } finally {
          restoreAssigns();
        }
        state.lastExit = result.code;

        // Route each stream to wherever its descriptor ended up pointing.
        let piped = '';
        // Each distinct file is opened once per command, so `cmd > f 2>&1`
        // appends both streams instead of the second truncating the first.
        const opened = new Map();
        const emit = (target, text) => {
          if (!text) return;
          if (target === 'stderr') { sink.writeErr(text); return; }
          if (target === 'pipe') {
            if (isLast) sink.write(text); else piped += text;
            return;
          }
          let node = opened.get(target.file);
          if (!node) { node = openForWrite(target.file, target.append, ctx); opened.set(target.file, node); }
          if (!node.devNull) node.content += text;
        };
        emit(errTarget, result.stderr);
        emit(outTarget, result.stdout);

        if (result.exitShell) throw { __exit: true };
        return piped;
      }
    }

    // -------------------- background jobs (sleep-based) --------------------
    function launchBackground(argv, sink, ctx) {
      if (!argv.length) return;
      const cmdline = argv.join(' ');
      const pid = state.pidCounter++;
      const job = { id: state.jobs.length + 1, pid, cmd: cmdline, status: 'Running', startedAt: now() };
      if (argv[0] === 'sleep') {
        const secs = parseFloat(argv[1]) || 0;
        job.durationMs = secs * 1000;
        job.timerReal = setTimer(() => { job.status = 'Done'; }, Math.min(secs * 120, 6000));
      } else {
        job.durationMs = 0;
        job.timerReal = setTimer(() => { job.status = 'Done'; }, 400);
      }
      state.jobs.push(job);
      sink.write(`[${job.id}] ${pid}\n`);
    }
    function setTimer(fn, ms) {
      if (typeof setTimeout === 'function') return setTimeout(fn, ms);
      fn(); return null;
    }

    // -------------------- seed data (mirrors the book's setup.sh) --------------------
    function seed(state) {
      const home = fs.mkdirp(splitPath('/home/dave'), null, 0o755);
      home.owner = 'dave'; home.group = 'staff';
      fs.mkdirp(splitPath('/home/dave/Documents'), null, 0o755);
      fs.mkdirp(splitPath('/home/dave/Downloads'), null, 0o755);
      fs.mkdirp(splitPath('/home/dave/bin'), null, 0o755);

      const etc = fs.mkdirp(splitPath('/etc'), null, 0o755); etc.owner = 'root'; etc.group = 'root';
      putFile('/etc/hostname', 'web-01\n', { owner: 'root', group: 'root', mode: 0o644 });
      putFile('/etc/hosts', '127.0.0.1 localhost\n10.0.0.14 web-01\n', { owner: 'root', group: 'root', mode: 0o644 });

      const varlog = fs.mkdirp(splitPath('/var/log'), null, 0o755); varlog.owner = 'root'; varlog.group = 'root';
      putFile('/var/log/syslog', 'Aug 14 08:59:01 web-01 cron[812]: (root) CMD (run-parts /etc/cron.hourly)\nAug 14 09:00:00 web-01 systemd[1]: Starting daily apt cleanup...\n', { owner: 'root', group: 'root', mode: 0o644 });

      fs.mkdirp(splitPath('/tmp'), null, 0o777);
      fs.mkdirp(splitPath('/usr/bin'), null, 0o755);
      fs.mkdirp(splitPath('/bin'), null, 0o755);
      // /dev/null exists so `ls /dev/null` and `test -e` behave; writes to it
      // are discarded in openForWrite rather than accumulating.
      const dev = fs.mkdirp(splitPath('/dev'), null, 0o755); dev.owner = 'root'; dev.group = 'root';
      dev.children.set('null', mkNode('file', { mode: 0o666, owner: 'root', group: 'root', content: '' }));

      const lab = '/home/dave/shell-lab';
      ['data', 'logs', 'conf', 'scripts', 'tmp', 'archive'].forEach((d) => fs.mkdirp(splitPath(lab + '/' + d), null, 0o755));

      putFile(lab + '/data/sales_2026.csv', SALES_2026, { mtimeAgoMs: DAY * 3 });
      putFile(lab + '/data/sales_2025.csv', SALES_2025, { mtimeAgoMs: DAY * 220 });
      putFile(lab + '/data/inventory_2026.csv', 'sku,product,warehouse,qty\nW-100,widget,north,412\nG-200,gadget,south,98\nZ-300,gizmo,east,37\n', { mtimeAgoMs: DAY * 5 });
      putFile(lab + '/data/names.txt', 'ada lovelace\ngrace hopper\nken thompson\ndennis ritchie\nbarbara liskov\n', { mtimeAgoMs: DAY * 10 });
      fs.mkdirp(splitPath(lab + '/data/tmp'), null, 0o755);
      fs.mkdirp(splitPath(lab + '/data/reports'), null, 0o755);
      putFile(lab + '/data/scratch.tmp', '', { mtimeAgoMs: HOUR * 2 });
      putFile(lab + '/data/reports/old.tmp', '', { mtimeAgoMs: DAY * 40 });
      putFile(lab + '/data/bigfile.dat', 'x'.repeat(2048), { mtimeAgoMs: DAY * 1 });
      putFile(lab + '/data/mystery', 'this file is really a gzip archive, despite its name\n', { mtimeAgoMs: DAY * 2, binaryLabel: 'gzip compressed data, from Unix, original size modulo 2^32 53' });

      putFile(lab + '/logs/app.log', APP_LOG, { mtimeAgoMs: MIN * 20 });
      putFile(lab + '/logs/access.log', ACCESS_LOG, { mtimeAgoMs: MIN * 25 });
      putFile(lab + '/logs/empty.log', '', { mtimeAgoMs: DAY * 1 });

      putFile(lab + '/conf/nginx.conf', NGINX_CONF, { mtimeAgoMs: DAY * 9 });
      putFile(lab + '/conf/nginx.conf.new', NGINX_CONF_NEW, { mtimeAgoMs: HOUR * 3 });
      putFile(lab + '/conf/secrets.env', 'DB_PASSWORD=hunter2\nAPI_TOKEN=abc123def456\n', { mtimeAgoMs: DAY * 30, mode: 0o644 });

      putFile(lab + '/scripts/backup.sh', '#!/usr/bin/env bash\nset -euo pipefail\necho "pretending to back up $(pwd) at $(date +%F)"\n', { mtimeAgoMs: DAY * 6, mode: 0o644 });
      putFile(lab + '/scripts/slow.sh', '#!/usr/bin/env bash\nset -euo pipefail\nfor i in $(seq 1 30); do echo "tick $i"; sleep 1; done\n', { mtimeAgoMs: DAY * 6, mode: 0o644 });

      // command binaries, for `which`/PATH resolution
      const binDir = fs.mkdirp(splitPath('/usr/bin'), null, 0o755);
      for (const name of COMMANDS) binDir.children.set(name, mkNode('file', { mode: 0o755, owner: 'root', group: 'root', content: '' }));

      function putFile(pathStr, content, o) {
        o = o || {};
        const segs = splitPath(pathStr);
        const { parent, name } = fs.getParentAndName(segs);
        const node = mkNode('file', {
          content,
          mode: o.mode !== undefined ? o.mode : 0o644,
          owner: o.owner || 'dave',
          group: o.group || 'staff',
          mtime: state.simEpoch - (o.mtimeAgoMs || 0),
          binaryLabel: o.binaryLabel,
        });
        parent.children.set(name, node);
      }
    }

    function seedProcs(state) {
      state.procs = [
        { pid: 1, user: 'root', cmd: 'systemd', mem: 0.1, cpu: 0.0 },
        { pid: 812, user: 'root', cmd: 'cron', mem: 0.1, cpu: 0.0 },
        { pid: 934, user: 'root', cmd: 'sshd: /usr/sbin/sshd -D', mem: 0.3, cpu: 0.0 },
        { pid: 1207, user: 'dave', cmd: 'nginx: worker process', mem: 1.2, cpu: 0.1 },
        { pid: 1208, user: 'root', cmd: 'nginx: master process', mem: 0.5, cpu: 0.0 },
        { pid: 2044, user: 'dave', cmd: 'node app.js', mem: 4.8, cpu: 2.1 },
        { pid: 2101, user: 'dave', cmd: 'postgres: writer process', mem: 3.1, cpu: 0.4 },
      ];
    }

    // -------------------- builtin dispatch is defined in builtins.js and mixed in --------------------
    const builtinsCtx = {
      state, fs, user, now, abs, prettyPath, tildePath, ShellRuntimeError, hasPerm, modeToString, octalFromMode,
      globPattern, expandArgv, runCapture, execLine,
      runBuiltin: (name, args, stdin, c) => runBuiltin(name, args, stdin, c),
      launchBackground: (argv, sink, c) => launchBackground(argv, sink, c),
    };
    const builtins = createBuiltins(builtinsCtx);

    const HELP_IS_LITERAL = new Set(['echo', 'printf', 'test', '[', 'read', 'true', 'false', 'shift', 'exit', 'export', 'set', 'unset', 'alias', 'unalias', 'source', '.', 'sleep', 'seq', 'yes']);
    function runBuiltin(name, args, stdin, ctx) {
      if (name === undefined) return { stdout: '', stderr: '', code: 0 };
      // alias expansion (only first word, one level)
      if (state.aliases[name] && !(ctx && ctx.noAlias)) {
        const expansion = state.aliases[name];
        const combined = expansion + (args.length ? ' ' + args.map(shellQuoteIfNeeded).join(' ') : '');
        const toks = tokenize(combined);
        const seg = parseSegment(toks);
        const argv = expandArgv(seg.argvWords, ctx);
        name = argv[0]; args = argv.slice(1);
      }
      // A name containing '/' is a path to run, not a builtin — this is what
      // makes chapter 11's `./hello.sh` work.
      if (name.indexOf('/') !== -1) return runScriptFile(name, args, stdin, ctx);
      const fn = builtins[name];
      if (!fn) return { stdout: '', stderr: `bash: ${name}: command not found\n`, code: 127 };
      // `cmd --help` prints usage for real programs. Shell builtins that treat the
      // word literally (echo --help prints "--help") are left alone.
      if (args[0] === '--help' && state.helpFor && !HELP_IS_LITERAL.has(name)) return { stdout: state.helpFor(name), stderr: '', code: 0 };
      try {
        const r = fn(args, stdin, ctx || {}) || {};
        return { stdout: r.stdout || '', stderr: r.stderr || '', code: r.code === undefined ? 0 : r.code, exitShell: r.exitShell };
      } catch (e) {
        if (e instanceof ShellRuntimeError) return { stdout: '', stderr: e.message + '\n', code: 1 };
        return { stdout: '', stderr: `bash: ${name}: internal error: ${e.message}\n`, code: 1 };
      }
    }

    // Executes a script from the virtual filesystem in a child scope: $0, $1…
    // and $# are the script's own, and variables it sets are local to the run
    // (a real shell forks, so the parent's environment survives untouched).
    function runScriptFile(path, args, stdin, ctx) {
      const res = fs.resolve(abs(path), user);
      if (!res.node) return { stdout: '', stderr: `bash: ${path}: No such file or directory\n`, code: 127 };
      if (res.node.type === 'dir') return { stdout: '', stderr: `bash: ${path}: Is a directory\n`, code: 126 };
      if (!hasPerm(res.node, user, 'x')) return { stdout: '', stderr: `bash: ${path}: Permission denied\n`, code: 126 };
      return runScriptText(res.node.content || '', path, args, ctx);
    }

    function runScriptText(text, scriptName, args, ctx) {
      const savedVars = state.vars;
      state.vars = Object.assign(Object.create(null), state.vars);
      const childCtx = Object.create(ctx || {});
      childCtx.scriptName = scriptName;
      childCtx.positional = args.slice();
      let out = '', errOut = '';
      const sink = { write: (s) => { out += s; }, writeErr: (s) => { errOut += s; } };
      let exited = false;
      try {
        execLine(text, sink, childCtx);
      } catch (e) {
        if (e && e.__exit) exited = true;
        else if (e instanceof ShellRuntimeError) errOut += e.message + '\n';
        else throw e;
      } finally {
        state.vars = savedVars;
      }
      void exited;
      return { stdout: out, stderr: errOut, code: state.lastExit };
    }
    state.runScriptText = runScriptText;
    function shellQuoteIfNeeded(s) { return /\s/.test(s) ? `'${s}'` : s; }

    state.commandsList = Object.keys(builtins).sort();

    // -------------------- public API --------------------
    function run(line) {
      const out = [];
      const sink = {
        write: (s) => out.push({ stream: 'out', text: s }),
        writeErr: (s) => out.push({ stream: 'err', text: s }),
      };
      state.history.push(line);
      try {
        execLine(line, sink, {});
      } catch (e) {
        if (e && e.__exit) { /* `exit` — nothing more to run on this line */ }
        else if (e instanceof ShellRuntimeError) { sink.writeErr(e.message + '\n'); state.lastExit = 1; }
        else {
          // Last-resort net: a bug in the simulator must not take the page's
          // terminal down with it. Report it and keep the session usable.
          sink.writeErr(`bash: internal error: ${(e && e.message) || e}\n`);
          state.lastExit = 1;
        }
      }
      // `clear` writes a marker; keep only what comes after the last one and tell the
      // UI to wipe the screen first.
      const CLEAR = '\x1bCLEAR\x1b';
      let clear = false;
      for (let i = out.length - 1; i >= 0; i--) {
        const k = out[i].text.lastIndexOf(CLEAR);
        if (k === -1) continue;
        clear = true;
        out.splice(0, i);
        out[0] = { stream: out[0].stream, text: out[0].text.slice(k + CLEAR.length) };
        break;
      }
      const result = { chunks: out.filter((c) => c.text), exit: state.lastExit, cwd: prettyPath(state.cwdSegs), cwdTilde: tildePath(state.cwdSegs) };
      if (clear) result.clear = true;
      return result;
    }

    function promptCwd() { return tildePath(state.cwdSegs); }

    return {
      run,
      promptCwd,
      state,
      fs,
      user,
      completionCandidates: (partialLine) => completionCandidates(partialLine, state, fs, user, builtins),
    };
  }

  // ---------------------------------------------------------------------
  // Tab completion
  // ---------------------------------------------------------------------
  function completionCandidates(partialLine, state, fs, user, builtins) {
    const m = partialLine.match(/(\S*)$/);
    const frag = m ? m[1] : '';
    const isFirstWord = /^\s*\S*$/.test(partialLine);
    if (isFirstWord && !frag.includes('/')) {
      const names = new Set([...Object.keys(builtins), ...Object.keys(state.aliases)]);
      return [...names].filter((n) => n.startsWith(frag)).sort();
    }
    const lastSlash = frag.lastIndexOf('/');
    const prefix = lastSlash === -1 ? '' : frag.slice(0, lastSlash + 1);
    const partial = lastSlash === -1 ? frag : frag.slice(lastSlash + 1);
    const dirSegs = resolvePathSegs(prefix || '.', state.cwdSegs, state.home);
    const res = fs.resolve(dirSegs, user);
    if (!res.node || res.node.type !== 'dir') return [];
    return [...res.node.children.keys()].filter((n) => n.startsWith(partial)).sort().map((n) => prefix + n);
  }

  // ---------------------------------------------------------------------
  // Seed content (shared with the printable book's Appendix B / setup.sh)
  // ---------------------------------------------------------------------
  const SALES_2026 = `date,region,product,units,revenue
2026-01-04,north,widget,12,240.00
2026-01-11,south,widget,45,900.00
2026-01-18,north,gadget,7,455.00
2026-02-02,east,widget,63,1260.00
2026-02-14,west,gizmo,22,1980.00
2026-02-21,south,gadget,51,3315.00
2026-03-03,north,widget,8,160.00
2026-03-15,east,gizmo,74,6660.00
2026-03-28,west,widget,33,660.00
2026-04-05,south,gizmo,19,1710.00
2026-04-19,north,gadget,58,3770.00
2026-05-02,east,widget,91,1820.00
2026-05-17,west,gadget,27,1755.00
2026-06-01,south,widget,44,880.00
2026-06-20,north,gizmo,66,5940.00
`;
  const SALES_2025 = `date,region,product,units,revenue
2025-11-04,north,widget,10,200.00
2025-12-11,south,gadget,25,1625.00
`;
  const APP_LOG = `2026-08-13 09:00:01 INFO  app starting, version 2.4.1
2026-08-13 09:00:02 INFO  loading configuration from /etc/myapp/app.conf
2026-08-13 09:00:02 DEBUG cache size set to 256MB
2026-08-13 09:00:03 INFO  connected to database db-01:5432
2026-08-13 09:01:15 WARN  slow query took 2841ms
2026-08-13 09:02:44 INFO  request GET /health 200 3ms
2026-08-13 09:03:12 ERROR connection timeout to payments-api after 5000ms
2026-08-13 09:03:12 DEBUG retry 1 of 3
2026-08-13 09:03:18 ERROR connection timeout to payments-api after 5000ms
2026-08-13 09:03:18 DEBUG retry 2 of 3
2026-08-13 09:03:24 INFO  request POST /orders 201 118ms
2026-08-13 09:05:00 DEBUG cache hit ratio 0.91
2026-08-13 09:07:33 WARN  memory usage at 87%
2026-08-13 09:08:02 INFO  request GET /orders/4821 200 12ms
2026-08-13 09:09:41 ERROR unhandled exception in worker-3
2026-08-13 09:09:41 DEBUG stack trace suppressed
2026-08-13 09:10:00 INFO  worker-3 restarted
2026-08-13 09:12:07 WARN  disk usage at 78%
2026-08-13 09:14:22 INFO  request GET /health 200 2ms
2026-08-13 09:15:58 ERROR failed to write to /var/log/myapp: no space left
2026-08-13 09:16:00 INFO  shutting down gracefully
`;
  const ACCESS_LOG = `10.0.0.14 - - [13/Aug/2026:09:00:01] "GET /health HTTP/1.1" 200 12
10.0.0.14 - - [13/Aug/2026:09:00:11] "GET /orders HTTP/1.1" 200 4821
10.0.0.7 - - [13/Aug/2026:09:00:14] "POST /orders HTTP/1.1" 201 88
10.0.0.14 - - [13/Aug/2026:09:00:22] "GET /missing HTTP/1.1" 404 0
192.168.1.55 - - [13/Aug/2026:09:00:31] "GET / HTTP/1.1" 200 1043
10.0.0.7 - - [13/Aug/2026:09:00:44] "GET /orders/1 HTTP/1.1" 200 311
10.0.0.14 - - [13/Aug/2026:09:01:02] "GET /admin HTTP/1.1" 403 0
10.0.0.7 - - [13/Aug/2026:09:01:19] "GET /nope HTTP/1.1" 404 0
10.0.0.14 - - [13/Aug/2026:09:01:33] "GET /health HTTP/1.1" 200 12
192.168.1.55 - - [13/Aug/2026:09:02:04] "GET /static/app.js HTTP/1.1" 200 90211
`;
  const NGINX_CONF = `# main nginx configuration
user www-data;
worker_processes 2;

events {
    worker_connections 1024;
}

http {
    # timeouts
    keepalive_timeout 65;
    send_timeout 30;

    server {
        listen 80;
        server_name example.com;

        location / {
            proxy_pass http://localhost:8080;
            proxy_read_timeout 60;
        }
    }
}
`;
  const NGINX_CONF_NEW = `# main nginx configuration
user www-data;
worker_processes 4;

events {
    worker_connections 2048;
}

http {
    # timeouts
    keepalive_timeout 65;
    send_timeout 30;

    server {
        listen 443 ssl;
        server_name example.com;

        location / {
            proxy_pass http://localhost:8080;
            proxy_read_timeout 60;
        }
    }
}
`;

  const COMMANDS = ['ls','cd','pwd','cat','less','more','head','tail','grep','egrep','sed','awk','find',
    'cp','mv','rm','mkdir','rmdir','touch','ln','chmod','chown','chgrp','sudo','su','echo','printf',
    'sort','uniq','cut','tr','wc','tee','xargs','which','whereis','type','file','stat','du','df',
    'ps','top','htop','kill','killall','pkill','pgrep','jobs','fg','bg','nohup','sleep','wait',
    'export','alias','unalias','source','history','env','set','unset','read','test','man','apropos',
    'tar','gzip','gunzip','zip','unzip','curl','wget','ssh','scp','rsync','ping','ip','ifconfig',
    'systemctl','journalctl','crontab','date','whoami','id','uname','mount','umount','diff',
    'basename','dirname','realpath','readlink','seq','yes','true','false','exit','trap','shift',
    'getopts','declare','mapfile','printenv','watch','tree','column','jq','nl','split','shuf','tac',
    'groups','umask','clear','hostname','help','zcat','zgrep','lsof','ss','uptime','free'];

  // placeholder, replaced by builtins.js which defines createBuiltins and re-assigns module export
  var createBuiltins = function () { throw new Error('builtins.js not loaded'); };
  var __setCreateBuiltins = function (fn) { createBuiltins = fn; };

  return { __internal: { splitPath, resolvePathSegs, globToRegex, expandBraces, tokenize, parseLine, VFS, mkNode, hasPerm, modeToString, octalFromMode, ShellRuntimeError, ShellSyntaxError },
    createSession: function (opts) { return createSession(opts); },
    __setCreateBuiltins };
});
