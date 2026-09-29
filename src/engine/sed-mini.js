// sed-mini.js — a small subset of sed.
// Addresses: N, $, /re/, N,M, N,$, /re/,/re/, each with an optional '!' negation.
// Commands: s/// (flags g, i/I, p, and an Nth-occurrence number), p, d, q, =,
// i\text, a\text, c\text, and { … } blocks. Flags: -n, -E/-r.
// Patterns are BREs by default (\( \) \{ \} \+ \? \| are the metacharacters) or
// EREs under -E, and POSIX [[:class:]] names work in both.
// Not supported: the hold space (h/H/g/G/x), n/N, b/t/labels, y///, and -z.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SedMini = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  class SedError extends Error {}

  // ---------------- pattern normalization ----------------

  // POSIX bracket classes -> JS character-class fragments.
  const POSIX_CLASSES = {
    alpha: 'A-Za-z',
    digit: '0-9',
    alnum: 'A-Za-z0-9',
    space: ' \\t\\n\\r\\f\\v',
    blank: ' \\t',
    upper: 'A-Z',
    lower: 'a-z',
    punct: '!-\\/:-@\\[-\\x60{-~',
    xdigit: '0-9A-Fa-f',
    cntrl: '\\x00-\\x1f\\x7f',
    print: '\\x20-\\x7e',
    graph: '\\x21-\\x7e',
    word: 'A-Za-z0-9_',
  };

  // In a BRE, these are *quantifiers/groups when escaped* and literals when bare —
  // exactly the opposite of JS (and ERE). Swap the escaping as we copy.
  const BRE_ESCAPED_TO_META = { '(': '(', ')': ')', '{': '{', '}': '}', '+': '+', '?': '?', '|': '|' };
  const BRE_BARE_TO_LITERAL = { '(': '\\(', ')': '\\)', '{': '\\{', '}': '\\}', '+': '\\+', '?': '\\?', '|': '\\|' };

  // Copy a bracket expression starting at pat[i] === '['. Returns null when unterminated.
  function scanBracket(pat, i) {
    const n = pat.length;
    let j = i + 1;
    let out = '[';
    if (pat[j] === '^') { out += '^'; j++; }
    if (pat[j] === ']') { out += '\\]'; j++; }
    while (j < n) {
      const c = pat[j];
      if (c === '[' && pat[j + 1] === ':') {
        const end = pat.indexOf(':]', j + 2);
        if (end !== -1) {
          const name = pat.slice(j + 2, end);
          if (Object.prototype.hasOwnProperty.call(POSIX_CLASSES, name)) {
            out += POSIX_CLASSES[name]; j = end + 2; continue;
          }
        }
        out += '\\['; j++; continue;
      }
      if (c === ']') { out += ']'; return { text: out, next: j + 1 }; }
      if (c === '\\') {
        const nx = pat[j + 1];
        if (nx !== undefined && 'ntrfv\\]^-'.indexOf(nx) !== -1) { out += '\\' + nx; j += 2; continue; }
        out += '\\\\'; j++; continue; // a bare backslash is literal inside POSIX brackets
      }
      if (c === '^') { out += '\\^'; j++; continue; }
      out += c; j++;
    }
    return null;
  }

  // Normalize a sed pattern (BRE by default, ERE when extended) to JS regex source.
  function normalizePattern(pat, extended) {
    let out = '';
    let i = 0;
    const n = pat.length;
    while (i < n) {
      const c = pat[i];
      if (c === '\\') {
        const nx = pat[i + 1];
        if (nx === undefined) { out += '\\\\'; i++; continue; }
        if (!extended && Object.prototype.hasOwnProperty.call(BRE_ESCAPED_TO_META, nx)) {
          out += BRE_ESCAPED_TO_META[nx]; i += 2; continue;
        }
        out += c + nx; i += 2; continue;
      }
      if (c === '[') {
        const b = scanBracket(pat, i);
        if (b) { out += b.text; i = b.next; continue; }
        out += '\\['; i++; continue; // unmatched '[' is a literal
      }
      if (!extended && Object.prototype.hasOwnProperty.call(BRE_BARE_TO_LITERAL, c)) {
        out += BRE_BARE_TO_LITERAL[c]; i++; continue;
      }
      out += c; i++;
    }
    return out;
  }

  function makeRegExp(src, flags) {
    try { return new RegExp(src, flags || ''); }
    catch (e) { throw new SedError(`sed: invalid regular expression: ${src}`); }
  }

  // sed replacement text -> JS String.replace replacement.
  // One left-to-right pass: '&' -> '$&', '\&' -> literal '&', '\N' -> '$N', '$' -> '$$'.
  function normalizeReplacement(repl) {
    let out = '';
    for (let i = 0; i < repl.length; i++) {
      const c = repl[i];
      if (c === '\\') {
        const nx = repl[i + 1];
        if (nx === undefined) { out += '\\'; break; }
        i++;
        if (nx >= '0' && nx <= '9') { out += '$' + nx; continue; }
        if (nx === '&') { out += '&'; continue; }
        if (nx === 'n') { out += '\n'; continue; }
        if (nx === 't') { out += '\t'; continue; }
        if (nx === 'r') { out += '\r'; continue; }
        if (nx === '\\') { out += '\\'; continue; }
        out += nx; continue;
      }
      if (c === '&') { out += '$&'; continue; }
      if (c === '$') { out += '$$'; continue; }
      out += c;
    }
    return out;
  }

  // ---------------- script splitting ----------------

  function isDelim(c) {
    return c !== undefined && !/[A-Za-z0-9\\\n;\s]/.test(c);
  }

  // Split a script into commands on top-level ';' / newline, skipping over
  // /address/ regexes and s<d>pat<d>repl<d> fields (honoring '\' escapes).
  function splitTopLevel(script, sep) {
    const parts = [];
    let buf = '';
    let i = 0;
    let depth = 0; // nesting inside { … } blocks
    const n = script.length;
    while (i < n) {
      const c = script[i];
      if (c === '\\') { buf += c + (script[i + 1] === undefined ? '' : script[i + 1]); i += 2; continue; }
      if (c === '{') { depth++; buf += c; i++; continue; }
      if (c === '}') { depth--; buf += c; i++; continue; }
      if ((c === sep || c === '\n') && depth <= 0) { parts.push(buf); buf = ''; i++; continue; }
      if (c === '/') {
        // address regex — consume through the closing unescaped '/'
        buf += c; i++;
        while (i < n) {
          if (script[i] === '\\') { buf += script[i] + (script[i + 1] === undefined ? '' : script[i + 1]); i += 2; continue; }
          buf += script[i];
          if (script[i] === '/') { i++; break; }
          i++;
        }
        continue;
      }
      if ((c === 's' || c === 'y') && isDelim(script[i + 1])) {
        const delim = script[i + 1];
        buf += c + delim; i += 2;
        let fieldsLeft = 2; // pattern and replacement
        while (i < n && fieldsLeft > 0) {
          if (script[i] === '\\') { buf += script[i] + (script[i + 1] === undefined ? '' : script[i + 1]); i += 2; continue; }
          buf += script[i];
          if (script[i] === delim) fieldsLeft--;
          i++;
        }
        continue;
      }
      if ((c === 'i' || c === 'a' || c === 'c') && (script[i + 1] === '\\' || script[i + 1] === ' ')) {
        // text command: everything up to the next top-level separator is literal text
        buf += c; i++;
        while (i < n && script[i] !== sep && script[i] !== '\n') {
          if (script[i] === '\\') { buf += script[i] + (script[i + 1] === undefined ? '' : script[i + 1]); i += 2; continue; }
          buf += script[i]; i++;
        }
        continue;
      }
      buf += c; i++;
    }
    parts.push(buf);
    return parts;
  }

  // ---------------- s/// parsing ----------------

  const REGEX_META = '\\^$.|?*+()[]{}/';

  function parseSub(sub, extended) {
    if (sub[0] !== 's') throw new SedError(`sed: unknown command: ${sub[0]}`);
    const delim = sub[1];
    if (delim === undefined || !isDelim(delim)) throw new SedError(`sed: unterminated 's' command`);
    const patHex = REGEX_META.indexOf(delim) !== -1
      ? '\\x' + delim.charCodeAt(0).toString(16).padStart(2, '0')
      : delim;
    let i = 2;
    const fields = [];
    let cur = '';
    let escapedDelimAs = patHex; // first field is the pattern
    while (i < sub.length && fields.length < 2) {
      const c = sub[i];
      if (c === '\\') {
        const nx = sub[i + 1];
        if (nx === undefined) { cur += '\\'; i++; continue; }
        if (nx === delim) { cur += escapedDelimAs; i += 2; continue; }
        cur += c + nx; i += 2; continue;
      }
      if (c === delim) { fields.push(cur); cur = ''; i++; escapedDelimAs = delim; continue; }
      cur += c; i++;
    }
    if (fields.length < 2) throw new SedError(`sed: unterminated 's' command`);
    const flags = sub.slice(i);
    if (/[^gipIm0-9\s]/.test(flags)) throw new SedError(`sed: unknown option to 's'`);
    const global = flags.indexOf('g') !== -1;
    const ci = flags.indexOf('i') !== -1 || flags.indexOf('I') !== -1;
    const nthMatch = flags.match(/[0-9]+/);
    return {
      pattern: normalizePattern(fields[0], extended),
      replacement: normalizeReplacement(fields[1]),
      global,
      ci,
      nth: nthMatch ? parseInt(nthMatch[0], 10) : 1,
      print: flags.indexOf('p') !== -1,
    };
  }

  // Expand a normalized ($-form) replacement against a match result.
  function expandRepl(repl, m) {
    let out = '';
    for (let i = 0; i < repl.length; i++) {
      const c = repl[i];
      if (c === '$') {
        const nx = repl[i + 1];
        if (nx === '$') { out += '$'; i++; continue; }
        if (nx === '&') { out += m[0]; i++; continue; }
        if (nx >= '0' && nx <= '9') {
          const g = nx.charCodeAt(0) - 48;
          out += g === 0 ? m[0] : (m[g] === undefined ? '' : m[g]);
          i++; continue;
        }
      }
      out += c;
    }
    return out;
  }

  // Apply an s/// to one line. Honors g, the Nth-occurrence flag, and both together.
  function applySub(line, sub) {
    const re = makeRegExp(sub.pattern, 'g' + (sub.ci ? 'i' : ''));
    const nth = sub.nth > 0 ? sub.nth : 1;
    let out = '', last = 0, count = 0, changed = false, m;
    while ((m = re.exec(line)) !== null) {
      count++;
      if (sub.global ? count >= nth : count === nth) {
        out += line.slice(last, m.index) + expandRepl(sub.replacement, m);
        last = m.index + m[0].length;
        changed = true;
        if (!sub.global) break;
      }
      if (m[0] === '') { re.lastIndex++; if (re.lastIndex > line.length) break; }
    }
    if (!changed) return { line, changed: false };
    return { line: out + line.slice(last), changed: true };
  }

  // ---------------- address parsing ----------------

  // Parse a single address at pos i. Returns { addr, next } or null.
  function parseOneAddr(text, i, extended) {
    const c = text[i];
    if (c === '$') return { addr: { type: 'last' }, next: i + 1 };
    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < text.length && text[j] >= '0' && text[j] <= '9') j++;
      return { addr: { type: 'line', n: parseInt(text.slice(i, j), 10) }, next: j };
    }
    if (c === '/' || c === '\\') {
      let delim = '/';
      let j = i + 1;
      if (c === '\\') { delim = text[i + 1]; j = i + 2; }
      let src = '';
      let closed = false;
      while (j < text.length) {
        if (text[j] === '\\') {
          if (text[j + 1] === delim) { src += delim; j += 2; continue; }
          src += text[j] + (text[j + 1] === undefined ? '' : text[j + 1]); j += 2; continue;
        }
        if (text[j] === delim) { closed = true; j++; break; }
        src += text[j]; j++;
      }
      if (!closed) throw new SedError(`sed: unterminated address regex`);
      let flags = '';
      if (text[j] === 'I') { flags = 'i'; j++; }
      return { addr: { type: 're', re: makeRegExp(normalizePattern(src, extended), flags) }, next: j };
    }
    return null;
  }

  function parseAddress(text, extended) {
    const first = parseOneAddr(text, 0, extended);
    if (!first) return { addr: null, next: 0 };
    let i = first.next;
    if (text[i] === ',') {
      const second = parseOneAddr(text, i + 1, extended);
      if (!second) throw new SedError(`sed: expected address after ','`);
      return { addr: { type: 'range', from: first.addr, to: second.addr, active: false }, next: second.next };
    }
    return { addr: first.addr, next: i };
  }

  function addrMatchesOne(a, ctx) {
    if (a.type === 'last') return ctx.isLast;
    if (a.type === 'line') return ctx.lineNo === a.n;
    if (a.type === 're') { a.re.lastIndex = 0; return a.re.test(ctx.line); }
    return false;
  }

  // Match an address (including ranges, whose state lives on the address object).
  function matchAddr(addr, ctx) {
    if (!addr) return true;
    if (addr.type !== 'range') return addrMatchesOne(addr, ctx);
    if (!addr.active) {
      if (!addrMatchesOne(addr.from, ctx)) return false;
      addr.active = true;
      // A numeric end address at or before the start line closes the range at once.
      if (addr.to.type === 'line' && addr.to.n <= ctx.lineNo) addr.active = false;
      return true;
    }
    if (addr.to.type === 'line') { if (ctx.lineNo >= addr.to.n) addr.active = false; }
    else if (addr.to.type === 'last') { if (ctx.isLast) addr.active = false; }
    else if (addr.to.type === 're') { if (addrMatchesOne(addr.to, ctx)) addr.active = false; }
    return true;
  }

  // ---------------- command parsing ----------------

  function parseCommand(raw, extended) {
    const text = raw.trim();
    if (!text || text[0] === '#') return null;
    const { addr, next } = parseAddress(text, extended);
    let i = next;
    let neg = false;
    while (text[i] === ' ' || text[i] === '\t') i++;
    while (text[i] === '!') { neg = !neg; i++; while (text[i] === ' ' || text[i] === '\t') i++; }
    const cmd = text[i];
    if (cmd === undefined) throw new SedError(`sed: missing command: ${text}`);
    const rest = text.slice(i + 1);

    if (cmd === '{') {
      const close = text.lastIndexOf('}');
      if (close === -1) throw new SedError(`sed: unmatched '{'`);
      const inner = text.slice(i + 1, close);
      return { addr, neg, cmd: 'block', cmds: splitTopLevel(inner, ';').map((s) => parseCommand(s, extended)).filter(Boolean) };
    }
    if (cmd === 's') return { addr, neg, cmd: 's', sub: parseSub(text.slice(i), extended) };
    if (cmd === 'p' || cmd === 'd' || cmd === 'q' || cmd === '=') {
      if (rest.trim() && rest.trim() !== ';') throw new SedError(`sed: extra characters after command: ${text}`);
      return { addr, neg, cmd };
    }
    if (cmd === 'i' || cmd === 'a' || cmd === 'c') {
      let body = rest;
      if (body[0] === '\\') body = body.slice(1);
      else body = body.replace(/^\s+/, '');
      body = body.replace(/\\n/g, '\n');
      return { addr, neg, cmd, text: body };
    }
    throw new SedError(`sed: unsupported command: ${text}`);
  }

  // ---------------- main ----------------

  function run(scriptStr, text, opts) {
    opts = opts || {};
    const extended = !!opts.extended;
    const suppress = !!opts.suppress;
    const hadTrailingNL = text.endsWith('\n') || text.length === 0;
    let lines = text.split('\n');
    if (hadTrailingNL && lines.length && lines[lines.length - 1] === '') lines.pop();

    const cmds = splitTopLevel(scriptStr, ';')
      .map((s) => parseCommand(s, extended))
      .filter(Boolean);
    const outLines = [];

    // Run a command list against one line. `st` carries the per-line flags so a
    // `d`/`q` inside a { … } block stops the outer list too.
    function runCmds(list, ctx, st) {
      for (const c of list) {
        if (st.deleted || st.quit) return;
        let hit = matchAddr(c.addr, ctx);
        if (c.neg) hit = !hit;
        if (!hit) continue;

        if (c.cmd === 'block') { runCmds(c.cmds, ctx, st); continue; }
        if (c.cmd === 's') {
          const r = applySub(ctx.line, c.sub);
          ctx.line = r.line;
          if (c.sub.print && r.changed) outLines.push(ctx.line);
          continue;
        }
        if (c.cmd === 'd') { st.deleted = true; continue; }
        if (c.cmd === 'p') { outLines.push(ctx.line); continue; }
        if (c.cmd === '=') { outLines.push(String(ctx.lineNo)); continue; }
        if (c.cmd === 'i') { outLines.push(c.text); continue; }
        if (c.cmd === 'a') { st.appended.push(c.text); continue; }
        if (c.cmd === 'c') { st.deleted = true; outLines.push(c.text); continue; }
        if (c.cmd === 'q') { st.quit = true; return; }
      }
    }

    for (let ln = 0; ln < lines.length; ln++) {
      const ctx = { lineNo: ln + 1, isLast: ln === lines.length - 1, line: lines[ln] };
      const st = { deleted: false, quit: false, appended: [] };

      runCmds(cmds, ctx, st);

      if (!st.deleted && !suppress) outLines.push(ctx.line);
      for (const a of st.appended) outLines.push(a);
      if (st.quit) break;
    }

    if (!outLines.length) return '';
    return outLines.join('\n') + (hadTrailingNL ? '\n' : '');
  }

  return { run, SedError, normalizePattern, normalizeReplacement, splitTopLevel };
});
