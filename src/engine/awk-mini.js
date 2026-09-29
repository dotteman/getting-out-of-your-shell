// awk-mini.js — a small subset of awk: enough for the one-liners this book teaches.
// Supports: -F sep (escapes decoded, " " = default whitespace split, multi-char = ERE),
// BEGIN/END blocks, /regex/ and expression patterns, pattern-only rules (implicit
// print), print/printf with full %[-0+ ][width][.prec]conv formatting, field vars
// $0..$NF (assignable, rebuilding $0 with OFS), NR/NF, the special vars FS/OFS/ORS/
// OFMT/CONVFMT/SUBSEP, user variables, += -= *= /= %= ^=, associative arrays with
// for(k in arr), `next`, string concatenation by juxtaposition, comparisons,
// arithmetic incl. ^, && || !, the ?: ternary, ~ and !~ matching, and the builtins
// length substr index split sub gsub match sprintf toupper tolower int sqrt exp log
// sin cos atan2 rand srand.
// Not supported: C-style `for (i=0;i<n;i++)`, `while`, `do`, user-defined functions,
// getline, and print/printf redirection (`>` in print is always a comparison here).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AwkMini = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class AwkError extends Error {}

  // ---------------- rule parsing ----------------
  function parseProgram(prog) {
    const rules = [];
    let i = 0; const n = prog.length;
    const skipWs = () => { while (i < n && /\s/.test(prog[i])) i++; };
    while (true) {
      skipWs();
      if (i >= n) break;
      let kind = 'expr'; let pattern = null;
      if (prog.startsWith('BEGIN', i) && /[\s{]/.test(prog[i + 5] || ' ')) { kind = 'BEGIN'; i += 5; }
      else if (prog.startsWith('END', i) && /[\s{]/.test(prog[i + 3] || ' ')) { kind = 'END'; i += 3; }
      skipWs();
      if (kind === 'expr' && prog[i] !== '{' && prog[i] !== undefined) {
        // Scan the whole pattern up to this rule's '{' (or the end of the rule),
        // skipping over strings and /regex/ literals so `/a/ || /b/ {…}` works.
        let j = i, buf = '', depth = 0, inStr = false;
        while (j < n) {
          const ch = prog[j];
          if (inStr) { buf += ch; if (ch === '\\') { buf += prog[j + 1] === undefined ? '' : prog[j + 1]; j += 2; continue; } if (ch === '"') inStr = false; j++; continue; }
          if (ch === '"') { inStr = true; buf += ch; j++; continue; }
          if (ch === '{' && depth === 0) break;
          if (ch === '\n' && depth === 0 && buf.trim() && !/[&|,]$/.test(buf.trim())) break;
          if (ch === '/' && /(^|[~(,!&|=<>?:+\-*/%])\s*$/.test(buf)) {
            buf += ch; j++;
            while (j < n) {
              if (prog[j] === '\\') { buf += prog[j] + (prog[j + 1] === undefined ? '' : prog[j + 1]); j += 2; continue; }
              buf += prog[j];
              if (prog[j] === '/') { j++; break; }
              j++;
            }
            continue;
          }
          if (ch === '(') depth++;
          if (ch === ')') depth--;
          buf += ch; j++;
        }
        const trimmed = buf.trim();
        if (trimmed) {
          const lone = trimmed.match(/^\/((?:[^\/\\]|\\.)*)\/$/);
          pattern = lone ? { type: 'regex', src: lone[1] } : { type: 'expr', src: trimmed };
        }
        i = j;
      }
      skipWs();
      let action = null;
      if (prog[i] === '{') {
        let depth = 0, j = i, buf = '', inStr = false, strCh = '';
        while (j < n) {
          const c = prog[j];
          if (inStr) { buf += c; if (c === '\\') { buf += prog[j + 1]; j += 2; continue; } if (c === strCh) inStr = false; j++; continue; }
          if (c === '"' || c === "'") { inStr = true; strCh = c; buf += c; j++; continue; }
          if (c === '{') { depth++; if (depth === 1) { j++; continue; } }
          if (c === '}') { depth--; j++; if (depth === 0) break; buf += c; continue; }
          buf += c; j++;
        }
        action = buf; i = j;
      }
      rules.push({ kind, pattern, action });
    }
    return rules;
  }

  // ---------------- expression tokenizer ----------------
  // Positions where a '/' can only be the start of a regex literal, never division.
  const REGEX_PRECEDERS = ['~', '!~', '(', ',', '&&', '||', '!', '==', '!=', '<', '<=', '>', '>=', '?', ':', '='];
  function regexAllowed(toks) {
    if (!toks.length) return true;
    const last = toks[toks.length - 1];
    return last.t === 'op' && REGEX_PRECEDERS.includes(last.v);
  }

  function lex(src) {
    const toks = []; let i = 0; const n = src.length;
    while (i < n) {
      const c = src[i];
      if (/\s/.test(c)) {
        // record that whitespace occurred (relevant for implicit concatenation)
        if (toks.length) toks[toks.length - 1].wsAfter = true;
        i++; continue;
      }
      if (c === '"') {
        let j = i + 1, buf = '';
        while (j < n && src[j] !== '"') { if (src[j] === '\\') { buf += ({ n: '\n', t: '\t', '"': '"', '\\': '\\' }[src[j + 1]] || src[j + 1]); j += 2; continue; } buf += src[j]; j++; }
        toks.push({ t: 'str', v: buf }); i = j + 1; continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
        let j = i, buf = '';
        while (j < n && /[0-9.]/.test(src[j])) { buf += src[j]; j++; }
        // exponent: 1e6, 2.5E-3
        if ((src[j] === 'e' || src[j] === 'E') && /[0-9]/.test(src[j + 1] === '+' || src[j + 1] === '-' ? src[j + 2] || '' : src[j + 1] || '')) {
          buf += src[j]; j++;
          if (src[j] === '+' || src[j] === '-') { buf += src[j]; j++; }
          while (j < n && /[0-9]/.test(src[j])) { buf += src[j]; j++; }
        }
        toks.push({ t: 'num', v: parseFloat(buf) }); i = j; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        let j = i, buf = '';
        while (j < n && /[A-Za-z0-9_]/.test(src[j])) { buf += src[j]; j++; }
        toks.push({ t: 'name', v: buf }); i = j; continue;
      }
      // A '/' starts a regex literal only where an operand is expected — otherwise
      // it is division. Anything else would break `s/n` in `printf "%.2f", s/n`.
      if (c === '/' && regexAllowed(toks)) {
        let j = i + 1, buf = '', closed = false;
        while (j < n) {
          if (src[j] === '\\') { buf += src[j] + (src[j + 1] === undefined ? '' : src[j + 1]); j += 2; continue; }
          if (src[j] === '/') { closed = true; j++; break; }
          buf += src[j]; j++;
        }
        if (closed) { toks.push({ t: 'regex', v: buf }); i = j; continue; }
      }
      const two = src.slice(i, i + 2);
      if (['==', '!=', '>=', '<=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '^=', '!~'].includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
      if ('+-*/%^()[],!<>=$?:~'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
      throw new AwkError(`awk: syntax error at char '${c}'`);
    }
    return toks;
  }

  // Only these names are treated as function calls; every other `name (` stays a
  // plain variable, so nothing that parsed before starts parsing differently.
  const BUILTIN_FUNCS = new Set([
    'length', 'substr', 'index', 'split', 'sub', 'gsub', 'match', 'sprintf',
    'toupper', 'tolower', 'int', 'sqrt', 'exp', 'log', 'sin', 'cos', 'atan2',
    'rand', 'srand',
  ]);

  // ---------------- expression parser (Pratt-ish, recursive descent) ----------------
  function parseExpr(toks) {
    let p = 0;
    function peek() { return toks[p]; }
    function next() { return toks[p++]; }
    function expectOp(v) { const t = next(); if (!t || t.v !== v) throw new AwkError(`awk: expected '${v}'`); }

    function parseAssignment() {
      const left = parseTernary();
      const t = peek();
      if (t && t.t === 'op' && (t.v === '=' || t.v === '+=' || t.v === '-=' || t.v === '*=' || t.v === '/=' || t.v === '%=' || t.v === '^=')) {
        next();
        const right = parseAssignment();
        return { type: 'assign', op: t.v, target: left, value: right };
      }
      return left;
    }
    function parseTernary() {
      const cond = parseOr();
      if (peek() && peek().t === 'op' && peek().v === '?') {
        next();
        const a = parseTernary();
        expectOp(':');
        const b = parseTernary();
        return { type: 'cond', cond, then: a, else: b };
      }
      return cond;
    }
    function parseOr() {
      let left = parseAnd();
      while (peek() && peek().t === 'op' && peek().v === '||') { next(); left = { type: 'or', left, right: parseAnd() }; }
      return left;
    }
    function parseAnd() {
      let left = parseCmp();
      while (peek() && peek().t === 'op' && peek().v === '&&') { next(); left = { type: 'and', left, right: parseCmp() }; }
      return left;
    }
    function parseCmp() {
      let left = parseMatch();
      const cmpOps = ['==', '!=', '<', '<=', '>', '>='];
      if (peek() && peek().t === 'op' && cmpOps.includes(peek().v)) {
        const op = next().v;
        const right = parseMatch();
        return { type: 'cmp', op, left, right };
      }
      return left;
    }
    function parseMatch() {
      let left = parseConcat();
      while (peek() && peek().t === 'op' && (peek().v === '~' || peek().v === '!~')) {
        const op = next().v;
        left = { type: 'match', neg: op === '!~', left, right: parseConcat() };
      }
      return left;
    }
    function startsPrimary(t) {
      if (!t) return false;
      if (t.t === 'num' || t.t === 'str') return true;
      if (t.t === 'name') return true;
      if (t.t === 'op' && (t.v === '$' || t.v === '(' || t.v === '!' || t.v === '-' || t.v === '+')) return true;
      return false;
    }
    function parseConcat() {
      let left = parseAdd();
      while (startsPrimary(peek()) && !(peek().t === 'op' && (peek().v === '(' ))) {
        // avoid swallowing a following '(' that isn't real (rare); good enough for our programs
        left = { type: 'concat', left, right: parseAdd() };
      }
      return left;
    }
    function parseAdd() {
      let left = parseMul();
      while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
        const op = next().v; left = { type: 'bin', op, left, right: parseMul() };
      }
      return left;
    }
    function parseMul() {
      let left = parseUnary();
      while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/' || peek().v === '%')) {
        const op = next().v; left = { type: 'bin', op, left, right: parseUnary() };
      }
      return left;
    }
    function parseUnary() {
      if (peek() && peek().t === 'op' && peek().v === '!') { next(); return { type: 'not', value: parseUnary() }; }
      if (peek() && peek().t === 'op' && peek().v === '-') { next(); return { type: 'neg', value: parseUnary() }; }
      if (peek() && peek().t === 'op' && peek().v === '+') { next(); return parseUnary(); }
      return parsePow();
    }
    function parsePow() {
      const base = parsePostfix();
      if (peek() && peek().t === 'op' && peek().v === '^') { next(); return { type: 'bin', op: '^', left: base, right: parseUnary() }; }
      return base;
    }
    function parsePostfix() {
      let node = parsePrimary();
      if (peek() && peek().t === 'op' && (peek().v === '++' || peek().v === '--')) {
        const op = next().v; node = { type: 'postfix', op, target: node };
      }
      return node;
    }
    function parsePrimary() {
      const t = next();
      if (!t) throw new AwkError('awk: unexpected end of expression');
      if (t.t === 'num') return { type: 'num', v: t.v };
      if (t.t === 'str') return { type: 'str', v: t.v };
      if (t.t === 'regex') return { type: 'regex', src: t.v };
      if (t.t === 'op' && t.v === '(') { const e = parseAssignment(); expectOp(')'); return e; }
      if (t.t === 'op' && t.v === '$') {
        const inner = parsePrimary();
        return { type: 'field', index: inner };
      }
      if (t.t === 'name') {
        if (BUILTIN_FUNCS.has(t.v) && peek() && peek().t === 'op' && peek().v === '(') {
          next();
          const args = [];
          if (!(peek() && peek().t === 'op' && peek().v === ')')) {
            args.push(parseAssignment());
            while (peek() && peek().t === 'op' && peek().v === ',') { next(); args.push(parseAssignment()); }
          }
          expectOp(')');
          return { type: 'call', name: t.v, args };
        }
        if (peek() && peek().t === 'op' && peek().v === '[') {
          next();
          const idx = parseAssignment();
          expectOp(']');
          return { type: 'index', name: t.v, index: idx };
        }
        return { type: 'var', name: t.v };
      }
      throw new AwkError(`awk: unexpected token '${t.v}'`);
    }
    const expr = parseAssignment();
    return { expr, rest: p };
  }

  function parseExprFull(toks) {
    const { expr, rest } = parseExpr(toks);
    if (rest !== toks.length) throw new AwkError('awk: trailing tokens in expression');
    return expr;
  }

  // ---------------- statement parsing ----------------
  // We split the action body into top-level statements by ';' and newlines,
  // but 'for (...)' and 'if (...)' headers may themselves contain semicolons
  // inside their parens — handle those as special statement forms up front.
  function splitStatements(body) {
    const stmts = []; let depthParen = 0, depthBrace = 0; let buf = '';
    let inStr = false, strCh = '';
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (inStr) { buf += c; if (c === '\\') { buf += body[i + 1]; i++; continue; } if (c === strCh) inStr = false; continue; }
      if (c === '"' || c === "'") { inStr = true; strCh = c; buf += c; continue; }
      if (c === '(') depthParen++;
      if (c === ')') depthParen--;
      if (c === '{') depthBrace++;
      if (c === '}') depthBrace--;
      if ((c === ';' || c === '\n') && depthParen === 0 && depthBrace === 0) {
        // `if (c) x; else y` — the ';' before `else` binds the two halves together,
        // so don't cut the statement here.
        if (/^\s*else\b/.test(body.slice(i + 1))) { buf += ' '; continue; }
        if (buf.trim()) stmts.push(buf.trim());
        buf = ''; continue;
      }
      buf += c;
    }
    if (buf.trim()) stmts.push(buf.trim());
    return stmts;
  }

  // A keyword only counts when it is a whole word — otherwise identifiers like
  // `formatted`, `printed`, `iffy`, `nextHop` get parsed as for/print/if/next.
  function startsKeyword(text, kw) {
    if (!text.startsWith(kw)) return false;
    const after = text[kw.length];
    return after === undefined || !/[A-Za-z0-9_]/.test(after);
  }

  function parseStatement(text) {
    text = text.trim();
    if (startsKeyword(text, 'for')) {
      const m = text.match(/^for\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*(.*)$/s);
      if (m) return { type: 'forin', varName: m[1], arrName: m[2], body: m[3] };
      throw new AwkError('awk: unsupported for-loop form');
    }
    if (startsKeyword(text, 'if')) {
      const m = text.match(/^if\s*\((.*?)\)\s*(.*)$/s);
      if (m) {
        // find matching close paren for the condition (handle nested parens)
        const rest = text.slice(2).trim();
        if (rest[0] !== '(') throw new AwkError('awk: expected ( after if');
        let depth = 0, j = 0;
        for (; j < rest.length; j++) { if (rest[j] === '(') depth++; if (rest[j] === ')') { depth--; if (depth === 0) break; } }
        const cond = rest.slice(1, j);
        let after = rest.slice(j + 1).trim();
        let thenPart = after, elsePart = null;
        const elseIdx = findTopLevelElse(after);
        if (elseIdx !== -1) { thenPart = after.slice(0, elseIdx).trim(); elsePart = after.slice(elseIdx + 4).trim(); }
        return { type: 'if', cond, then: thenPart, else: elsePart };
      }
    }
    if (text === 'next' || startsKeyword(text, 'next')) return { type: 'next' };
    if (startsKeyword(text, 'printf')) {
      const rest = text.slice(6).trim();
      return { type: 'printf', argsSrc: rest };
    }
    if (startsKeyword(text, 'print')) {
      const rest = text.slice(5).trim();
      return { type: 'print', argsSrc: rest };
    }
    return { type: 'expr', src: text };
  }
  function isWordAt(s, i, w) {
    if (s.slice(i, i + w.length) !== w) return false;
    if (i > 0 && /[A-Za-z0-9_]/.test(s[i - 1])) return false;
    const after = s[i + w.length];
    return after === undefined || !/[A-Za-z0-9_]/.test(after);
  }
  // Find the `else` belonging to *this* if — an unbraced nested `if` claims the
  // next `else` first (`if (a) if (b) X; else Y; else Z`).
  function findTopLevelElse(s) {
    let depth = 0, inStr = false, strCh = '', pendingIf = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (c === '\\') { i++; continue; } if (c === strCh) inStr = false; continue; }
      if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
      if (c === '{') { depth++; continue; }
      if (c === '}') { depth--; continue; }
      if (depth !== 0) continue;
      if (isWordAt(s, i, 'if')) { pendingIf++; i += 1; continue; }
      if (isWordAt(s, i, 'else')) {
        if (pendingIf === 0) return i;
        pendingIf--; i += 3; continue;
      }
    }
    return -1;
  }

  function splitArgsSrc(src) {
    // split a comma-separated arg list at top level (respecting strings/parens)
    const parts = []; let depth = 0, buf = '', inStr = false, strCh = '';
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (inStr) { buf += c; if (c === '\\') { buf += src[i + 1]; i++; continue; } if (c === strCh) inStr = false; continue; }
      if (c === '"' || c === "'") { inStr = true; strCh = c; buf += c; continue; }
      if (c === '(' || c === '[') depth++;
      if (c === ')' || c === ']') depth--;
      if (c === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
      buf += c;
    }
    if (buf.trim() !== '') parts.push(buf);
    return parts.map((s) => s.trim()).filter((s) => s.length);
  }

  // ---------------- runtime ----------------
  function toNum(v) {
    if (typeof v === 'number') return v;
    if (v === undefined || v === null || v === '') return 0;
    const f = parseFloat(v);
    return isNaN(f) ? 0 : f;
  }
  function looksNumeric(s) { return typeof s === 'string' && /^-?\d+(\.\d+)?$/.test(s.trim()); }
  // awk renders integral values exactly and everything else through OFMT/CONVFMT
  // (default "%.6g") — so `print 1/3` is 0.333333, not 0.3333333333333333.
  function toStrFmt(v, fmt) {
    if (v === undefined || v === null) return '';
    if (typeof v === 'number') {
      if (Number.isInteger(v)) return String(v);
      if (Number.isNaN(v)) return 'nan';
      if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
      return sprintf(fmt || '%.6g', [v]);
    }
    return String(v);
  }
  function toStr(v, fmt) { return toStrFmt(v, fmt); }

  // Compiled-regex cache — awk regexes are EREs, which JS accepts as-is here.
  const reCache = Object.create(null);
  function getRe(src, flags) {
    const key = (flags || '') + ' ' + src;
    if (reCache[key]) { reCache[key].lastIndex = 0; return reCache[key]; }
    let re;
    try { re = new RegExp(src, flags || ''); }
    catch (e) { throw new AwkError(`awk: invalid regular expression: /${src}/`); }
    reCache[key] = re;
    return re;
  }
  function truthy(v) {
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v !== '';
    return !!v;
  }

  // %[flags][width][.precision]conv  — flags: '-' left align, '0' zero pad,
  // '+' force sign, ' ' space for sign. Width/precision may be '*' (taken from args).
  function sprintf(fmt, args) {
    let out = ''; let ai = 0;
    for (let i = 0; i < fmt.length; i++) {
      if (fmt[i] !== '%') { out += fmt[i]; continue; }
      if (i + 1 >= fmt.length) { out += '%'; continue; }
      let j = i + 1;
      // flags
      let left = false, zero = false, plus = false, space = false;
      while (j < fmt.length && '-0+ #'.indexOf(fmt[j]) !== -1) {
        if (fmt[j] === '-') left = true;
        else if (fmt[j] === '0') zero = true;
        else if (fmt[j] === '+') plus = true;
        else if (fmt[j] === ' ') space = true;
        j++;
      }
      // width
      let width = null;
      if (fmt[j] === '*') { width = Math.trunc(toNum(args[ai++])); j++; }
      else { let w = ''; while (j < fmt.length && fmt[j] >= '0' && fmt[j] <= '9') { w += fmt[j]; j++; } if (w) width = parseInt(w, 10); }
      if (width !== null && width < 0) { left = true; width = -width; }
      // precision
      let prec = null;
      if (fmt[j] === '.') {
        j++;
        if (fmt[j] === '*') { prec = Math.trunc(toNum(args[ai++])); j++; }
        else { let p = ''; while (j < fmt.length && fmt[j] >= '0' && fmt[j] <= '9') { p += fmt[j]; j++; } prec = p ? parseInt(p, 10) : 0; }
      }
      const conv = fmt[j];
      if (conv === undefined) { out += fmt.slice(i); break; }
      if (conv === '%') { out += '%'; i = j; continue; }

      const arg = args[ai++];
      let body;
      let numeric = false;
      switch (conv) {
        case 'd': case 'i': {
          let v = Math.trunc(toNum(arg));
          numeric = true;
          const neg = v < 0 || Object.is(v, -0);
          body = String(Math.abs(v));
          if (prec !== null && body.length < prec) body = '0'.repeat(prec - body.length) + body;
          body = (neg ? '-' : plus ? '+' : space ? ' ' : '') + body;
          break;
        }
        case 'f': case 'F': {
          const v = toNum(arg);
          numeric = true;
          const neg = v < 0 || Object.is(v, -0);
          body = Math.abs(v).toFixed(prec === null ? 6 : prec);
          body = (neg ? '-' : plus ? '+' : space ? ' ' : '') + body;
          break;
        }
        case 'e': case 'E': {
          const v = toNum(arg);
          numeric = true;
          const neg = v < 0;
          body = Math.abs(v).toExponential(prec === null ? 6 : prec);
          // C uses at least two exponent digits
          body = body.replace(/e([+-])(\d)$/, 'e$10$2');
          if (conv === 'E') body = body.toUpperCase();
          body = (neg ? '-' : plus ? '+' : space ? ' ' : '') + body;
          break;
        }
        case 'g': case 'G': {
          const v = toNum(arg);
          numeric = true;
          const p = prec === null ? 6 : (prec === 0 ? 1 : prec);
          body = String(parseFloat(v.toPrecision(p)));
          if (conv === 'G') body = body.toUpperCase();
          if (v >= 0 && (plus || space)) body = (plus ? '+' : ' ') + body;
          break;
        }
        case 'x': case 'X': case 'o': {
          let v = Math.trunc(toNum(arg));
          numeric = true;
          const base = conv === 'o' ? 8 : 16;
          body = Math.abs(v).toString(base);
          if (conv === 'X') body = body.toUpperCase();
          if (prec !== null && body.length < prec) body = '0'.repeat(prec - body.length) + body;
          if (v < 0) body = '-' + body;
          break;
        }
        case 'c': {
          if (typeof arg === 'number') body = String.fromCharCode(Math.trunc(arg));
          else { const s = toStr(arg); body = s.length ? s[0] : ''; }
          break;
        }
        case 's': {
          body = toStr(arg);
          if (prec !== null) body = body.slice(0, prec);
          break;
        }
        default:
          // Unknown conversion: emit it verbatim and don't consume the argument.
          ai--;
          out += fmt.slice(i, j + 1);
          i = j;
          continue;
      }

      const isFloatConv = conv === 'f' || conv === 'F' || conv === 'e' || conv === 'E' || conv === 'g' || conv === 'G';
      if (width !== null && body.length < width) {
        if (left) body = body.padEnd(width);
        // '0' padding is ignored for integer conversions that also carry a precision
        else if (zero && numeric && (prec === null || isFloatConv)) {
          const sign = /^[-+ ]/.test(body) ? body[0] : '';
          const rest = sign ? body.slice(1) : body;
          body = sign + rest.padStart(width - sign.length, '0');
        } else body = body.padStart(width);
      }
      out += body;
      i = j;
    }
    return out;
  }

  // Decode the C-style escapes awk applies to a -F argument / an FS assignment.
  const ESCAPES = { t: '\t', n: '\n', r: '\r', f: '\f', v: '\v', b: '\b', a: '\x07', '\\': '\\', '/': '/', '"': '"' };
  function decodeEscapes(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && i + 1 < s.length) {
        const nx = s[i + 1];
        if (Object.prototype.hasOwnProperty.call(ESCAPES, nx)) { out += ESCAPES[nx]; i++; continue; }
        out += s[i]; continue; // leave regex escapes such as \. \s alone
      }
      out += s[i];
    }
    return out;
  }

  // Turn an FS value into a splitter. " " (the default) means "strip and split on
  // runs of whitespace"; a single character splits literally; anything longer is an ERE.
  function compileFS(fs) {
    if (fs === undefined || fs === null) return { kind: 'ws' };
    if (fs instanceof RegExp) return { kind: 're', re: fs };
    let s = decodeEscapes(String(fs));
    if (s === ' ') return { kind: 'ws' };
    if (s === '') return { kind: 'chars' };
    if (s.length === 1) {
      if (s === '\t') return { kind: 'lit', sep: '\t' };
      return { kind: 'lit', sep: s };
    }
    try { return { kind: 're', re: new RegExp(s) }; }
    catch (e) { throw new AwkError(`awk: invalid field separator: ${s}`); }
  }

  function splitRecord(line, fs) {
    if (line === '') return [];
    if (fs.kind === 'ws') { const t = line.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, ''); return t === '' ? [] : t.split(/[ \t\n]+/); }
    if (fs.kind === 'chars') return line.split('');
    if (fs.kind === 'lit') return line.split(fs.sep);
    return line.split(fs.re);
  }

  function run(program, input, opts) {
    opts = opts || {};
    // Mutable special variables. FS starts from -F (or the default " ").
    const specials = {
      FS: opts.FS === undefined || opts.FS === null || opts.FS instanceof RegExp ? ' ' : String(opts.FS),
      OFS: ' ', ORS: '\n', OFMT: '%.6g', CONVFMT: '%.6g', SUBSEP: '\x1c', RS: '\n', FILENAME: '',
    };
    let fsSplit = compileFS(specials.FS);
    // Inside a program, number -> string conversions go through CONVFMT
    // (print/printf use OFMT and the format string instead).
    const toStr = (v) => toStrFmt(v, specials.CONVFMT);
    const lines = input.length ? input.replace(/\n$/, '').split('\n') : [];
    const rules = parseProgram(program).map((r) => ({
      kind: r.kind,
      pattern: r.pattern && r.pattern.type === 'expr' ? { type: 'expr', node: parseExprFull(lex(r.pattern.src)) } : r.pattern,
      stmts: r.action !== null ? splitStatements(r.action).map(parseStatement) : [{ type: 'print', argsSrc: '' }],
    }));

    const vars = Object.create(null);
    const arrays = Object.create(null);
    let out = '';
    let NR = 0, NF = 0, fields = [''];
    let stopped = false;

    function getArr(name) { if (!arrays[name]) arrays[name] = Object.create(null); return arrays[name]; }

    function evalExpr(node) {
      switch (node.type) {
        case 'num': return node.v;
        case 'str': return node.v;
        case 'var': {
          if (node.name === 'NR' || node.name === 'FNR') return NR;
          if (node.name === 'NF') return NF;
          if (Object.prototype.hasOwnProperty.call(specials, node.name)) return specials[node.name];
          if (Object.prototype.hasOwnProperty.call(vars, node.name)) return vars[node.name];
          return '';
        }
        case 'field': {
          const idx = Math.trunc(toNum(evalExpr(node.index)));
          if (idx === 0) return fields[0];
          return fields[idx] !== undefined ? fields[idx] : '';
        }
        case 'index': {
          const arr = getArr(node.name);
          const key = toStr(evalExpr(node.index));
          return Object.prototype.hasOwnProperty.call(arr, key) ? arr[key] : '';
        }
        case 'call': return callBuiltin(node);
        case 'regex': return getRe(node.src).test(fields[0]) ? 1 : 0;
        case 'match': {
          const s = toStr(evalExpr(node.left));
          const re = node.right.type === 'regex' ? getRe(node.right.src) : getRe(toStr(evalExpr(node.right)));
          const hit = re.test(s);
          return (node.neg ? !hit : hit) ? 1 : 0;
        }
        case 'cond': return truthy(evalExpr(node.cond)) ? evalExpr(node.then) : evalExpr(node.else);
        case 'concat': return toStr(evalExpr(node.left)) + toStr(evalExpr(node.right));
        case 'bin': {
          const a = toNum(evalExpr(node.left)), b = toNum(evalExpr(node.right));
          switch (node.op) { case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; case '%': return a % b; case '^': return Math.pow(a, b); }
          break;
        }
        case 'cmp': {
          let a = evalExpr(node.left), b = evalExpr(node.right);
          let av, bv;
          const aNumeric = typeof a === 'number' || looksNumeric(a);
          const bNumeric = typeof b === 'number' || looksNumeric(b);
          if (aNumeric && bNumeric) { av = toNum(a); bv = toNum(b); } else { av = toStr(a); bv = toStr(b); }
          switch (node.op) {
            case '==': return av === bv ? 1 : 0; case '!=': return av !== bv ? 1 : 0;
            case '<': return av < bv ? 1 : 0; case '<=': return av <= bv ? 1 : 0;
            case '>': return av > bv ? 1 : 0; case '>=': return av >= bv ? 1 : 0;
          }
          break;
        }
        case 'and': return (truthy(evalExpr(node.left)) && truthy(evalExpr(node.right))) ? 1 : 0;
        case 'or': return (truthy(evalExpr(node.left)) || truthy(evalExpr(node.right))) ? 1 : 0;
        case 'not': return truthy(evalExpr(node.value)) ? 0 : 1;
        case 'neg': return -toNum(evalExpr(node.value));
        case 'assign': return doAssign(node);
        case 'postfix': {
          const cur = toNum(readLValue(node.target));
          const next = node.op === '++' ? cur + 1 : cur - 1;
          writeLValue(node.target, next);
          return cur;
        }
        default: throw new AwkError(`awk: cannot evaluate node ${node.type}`);
      }
    }

    // Regex-valued argument: a /re/ literal is used as-is, anything else is stringified.
    function reArg(node) {
      return node.type === 'regex' ? node.src : toStr(evalExpr(node));
    }

    function callBuiltin(node) {
      const a = node.args;
      switch (node.name) {
        case 'length': {
          if (!a.length) return toStr(fields[0]).length;
          if (a[0].type === 'var' && arrays[a[0].name]) return Object.keys(arrays[a[0].name]).length;
          return toStr(evalExpr(a[0])).length;
        }
        case 'substr': {
          const s = toStr(evalExpr(a[0]));
          const m = Math.trunc(toNum(evalExpr(a[1])));
          // mawk's rule: the start clamps to 1, and a start left of the string
          // lengthens the result by the overhang rather than trimming it.
          const start = m < 1 ? 1 : m;
          if (a.length < 3) return s.slice(start - 1);
          const len = Math.trunc(toNum(evalExpr(a[2]))) + (m < 0 ? -m : 0);
          if (len <= 0) return '';
          return s.substr(start - 1, len);
        }
        case 'index': {
          const s = toStr(evalExpr(a[0])), t = toStr(evalExpr(a[1]));
          return s.indexOf(t) + 1;
        }
        case 'toupper': return toStr(evalExpr(a[0])).toUpperCase();
        case 'tolower': return toStr(evalExpr(a[0])).toLowerCase();
        case 'split': {
          const s = toStr(evalExpr(a[0]));
          if (!a[1] || a[1].type !== 'var') throw new AwkError('awk: split: second argument must be an array');
          const arr = getArr(a[1].name);
          for (const k of Object.keys(arr)) delete arr[k];
          const fs = a.length > 2 ? compileFS(reArg(a[2])) : fsSplit;
          const parts = splitRecord(s, fs);
          parts.forEach((p, idx) => { arr[String(idx + 1)] = p; });
          return parts.length;
        }
        case 'match': {
          const s = toStr(evalExpr(a[0]));
          const m = getRe(reArg(a[1])).exec(s);
          vars.RSTART = m ? m.index + 1 : 0;
          vars.RLENGTH = m ? m[0].length : -1;
          return vars.RSTART;
        }
        case 'sub': case 'gsub': {
          const re = getRe(reArg(a[0]), node.name === 'gsub' ? 'g' : '');
          const repl = toStr(evalExpr(a[1]));
          const target = a.length > 2 ? a[2] : { type: 'field', index: { type: 'num', v: 0 } };
          const before = toStr(readLValue(target));
          let count = 0;
          const after = before.replace(re, (m0) => {
            count++;
            // awk replacement: '&' is the match, '\&' a literal ampersand.
            let o = '';
            for (let k = 0; k < repl.length; k++) {
              if (repl[k] === '\\' && repl[k + 1] === '&') { o += '&'; k++; continue; }
              if (repl[k] === '\\' && repl[k + 1] === '\\') { o += '\\'; k++; continue; }
              if (repl[k] === '&') { o += m0; continue; }
              o += repl[k];
            }
            return o;
          });
          if (count) writeLValue(target, after);
          return count;
        }
        case 'sprintf': {
          const fmt = toStr(evalExpr(a[0]));
          return sprintf(fmt, a.slice(1).map((x) => evalExpr(x)));
        }
        case 'int': { const v = toNum(evalExpr(a[0])); return Math.trunc(v); }
        case 'sqrt': return Math.sqrt(toNum(evalExpr(a[0])));
        case 'exp': return Math.exp(toNum(evalExpr(a[0])));
        case 'log': return Math.log(toNum(evalExpr(a[0])));
        case 'sin': return Math.sin(toNum(evalExpr(a[0])));
        case 'cos': return Math.cos(toNum(evalExpr(a[0])));
        case 'atan2': return Math.atan2(toNum(evalExpr(a[0])), toNum(evalExpr(a[1])));
        case 'rand': return Math.random();
        case 'srand': return 0;
        default: throw new AwkError(`awk: unknown function ${node.name}`);
      }
    }

    function rebuildRecord() {
      for (let k = 1; k <= NF; k++) if (fields[k] === undefined) fields[k] = '';
      fields[0] = fields.slice(1, NF + 1).join(specials.OFS);
    }
    function readLValue(node) { return evalExpr(node); }
    function writeLValue(node, value) {
      if (node.type === 'var') {
        if (node.name === 'NF') { NF = Math.trunc(toNum(value)); fields.length = NF + 1; rebuildRecord(); return; }
        if (node.name === 'NR' || node.name === 'FNR') { NR = Math.trunc(toNum(value)); return; }
        if (Object.prototype.hasOwnProperty.call(specials, node.name)) {
          specials[node.name] = toStr(value);
          if (node.name === 'FS') fsSplit = compileFS(specials.FS);
          return;
        }
        vars[node.name] = value; return;
      }
      if (node.type === 'field') {
        const idx = Math.trunc(toNum(evalExpr(node.index)));
        if (idx === 0) { setFields(toStr(value)); return; }
        fields[idx] = toStr(value);
        if (idx > NF) NF = idx;
        rebuildRecord();
        return;
      }
      if (node.type === 'index') {
        const arr = getArr(node.name); arr[toStr(evalExpr(node.index))] = value; return;
      }
      throw new AwkError('awk: invalid assignment target');
    }
    function doAssign(node) {
      let value;
      if (node.op === '=') value = evalExpr(node.value);
      else {
        const cur = toNum(readLValue(node.target));
        const rhs = toNum(evalExpr(node.value));
        value = node.op === '+=' ? cur + rhs : node.op === '-=' ? cur - rhs
          : node.op === '*=' ? cur * rhs : node.op === '%=' ? cur % rhs
          : node.op === '^=' ? Math.pow(cur, rhs) : cur / rhs;
      }
      writeLValue(node.target, value);
      return value;
    }

    function execStmts(stmts) {
      for (const s of stmts) {
        if (stopped) return;
        execStmt(s);
      }
    }
    function execStmt(s) {
      switch (s.type) {
        case 'expr': execExprStatement(s.src); return;
        case 'print': {
          const argsSrc = s.argsSrc;
          let text;
          if (!argsSrc) text = fields[0];
          else {
            const parts = splitArgsSrc(argsSrc).map((a) => toStrFmt(evalExpr(parseExprFull(lex(a))), specials.OFMT));
            text = parts.join(specials.OFS);
          }
          out += text + specials.ORS;
          return;
        }
        case 'printf': {
          const parts = splitArgsSrc(s.argsSrc);
          if (!parts.length) return;
          const fmtNode = parseExprFull(lex(parts[0]));
          const fmt = toStr(evalExpr(fmtNode));
          const args = parts.slice(1).map((a) => evalExpr(parseExprFull(lex(a))));
          out += sprintf(fmt, args);
          return;
        }
        case 'forin': {
          const arr = getArr(s.arrName);
          const bodyStmts = splitStatements(stripBraces(s.body)).map(parseStatement);
          for (const k of Object.keys(arr)) {
            vars[s.varName] = k;
            execStmts(bodyStmts);
            if (stopped) return;
          }
          return;
        }
        case 'if': {
          const condVal = truthy(evalExpr(parseExprFull(lex(s.cond))));
          if (condVal) execStmts(splitStatements(stripBraces(s.then)).map(parseStatement));
          else if (s.else) execStmts(splitStatements(stripBraces(s.else)).map(parseStatement));
          return;
        }
        case 'next': stopped = 'next'; return;
        default: throw new AwkError(`awk: cannot execute statement ${s.type}`);
      }
    }
    function execExprStatement(src) { evalExpr(parseExprFull(lex(src))); }
    function stripBraces(s) { s = s.trim(); if (s.startsWith('{') && s.endsWith('}')) return s.slice(1, -1); return s; }

    // Re-split $0 into fields without advancing NR (used by setRecord and by `$0 = ...`).
    function setFields(line) {
      fields = [line, ...splitRecord(line, fsSplit)];
      NF = fields.length - 1;
    }
    function setRecord(line) { NR++; setFields(line); }

    for (const r of rules) if (r.kind === 'BEGIN') execStmts(r.stmts);

    for (const line of lines) {
      setRecord(line);
      stopped = false; // one reset per record, before any rule runs
      for (const r of rules) {
        if (r.kind === 'BEGIN' || r.kind === 'END') continue;
        let matched;
        if (!r.pattern) matched = true;
        else if (r.pattern.type === 'regex') matched = getRe(r.pattern.src).test(fields[0]);
        else matched = truthy(evalExpr(r.pattern.node));
        if (matched) execStmts(r.stmts);
        if (stopped) break; // `next` skips the remaining rules for this record
      }
    }
    stopped = false; // `next` on the last record must not swallow END
    for (const r of rules) if (r.kind === 'END') execStmts(r.stmts);

    return out;
  }

  return { run, AwkError };
});
