// builtins.js — the command set. Wires into engine.js via __setCreateBuiltins.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const Engine = require('./engine.js');
    const AwkMini = require('./awk-mini.js');
    const SedMini = require('./sed-mini.js');
    factory(Engine, AwkMini, SedMini);
  } else {
    factory(root.ShellEngine, root.AwkMini, root.SedMini);
  }
})(typeof self !== 'undefined' ? self : this, function (Engine, AwkMini, SedMini) {
  'use strict';

  Engine.__setCreateBuiltins(function createBuiltins(ctx) {
    const { state, fs, user, now, abs, prettyPath, tildePath, ShellRuntimeError, hasPerm, modeToString,
      octalFromMode, globPattern, expandArgv, runCapture, execLine, runBuiltin, launchBackground } = ctx;
    const { splitPath, mkNode } = Engine.__internal;

    // ---------------- small utilities ----------------
    function err(msg) { throw new ShellRuntimeError(msg); }
    function pad(n, w) { return String(n).padStart(w || 2, '0'); }
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    function dateFormat(ms, fmt) {
      const d = new Date(ms);
      if (!fmt) return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} PDT ${d.getUTCFullYear()}`;
      return fmt.replace(/%[YmdHMSFTZAaBb%e]/g, (tok) => {
        switch (tok) {
          case '%Y': return String(d.getUTCFullYear());
          case '%m': return pad(d.getUTCMonth() + 1);
          case '%d': return pad(d.getUTCDate());
          case '%e': return String(d.getUTCDate()).padStart(2, ' ');
          case '%H': return pad(d.getUTCHours());
          case '%M': return pad(d.getUTCMinutes());
          case '%S': return pad(d.getUTCSeconds());
          case '%F': return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
          case '%T': return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
          case '%Z': return 'PDT';
          case '%A': return DAYS_FULL[d.getUTCDay()];
          case '%a': return DAYS[d.getUTCDay()];
          case '%B': return MONTHS_FULL[d.getUTCMonth()];
          case '%b': return MONTHS[d.getUTCMonth()];
          case '%%': return '%';
          default: return tok;
        }
      });
    }
    function lsDate(ms) {
      const d = new Date(ms);
      return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    }
    // `ls -lh` prints bare byte counts below 1K (no unit suffix), matching
    // coreutils; `du -h` uses the same scale but always rounds up to a block.
    function humanSize(n) {
      if (n < 1024) return String(n);
      const units = ['K', 'M', 'G', 'T'];
      let v = n, u = -1;
      do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
      return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + units[u];
    }

    // Parses "-lah", "--long" and "--include=*.log" style flags.
    // `valued` is a string of short flags that consume a value, so that both
    // `-n 5` and `-n5` are understood and the value never leaks into `rest`
    // as a phantom filename (`touch -t 202601010000 f` must create ONE file).
    // Returns {flags:Set, rest:[...], vals:{flag: value}}.
    function parseFlags(args, valued) {
      const flags = new Set(); const rest = []; const vals = {};
      let noMoreFlags = false;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--') { noMoreFlags = true; continue; }
        if (!noMoreFlags && a.startsWith('--') && a.length > 2) {
          const eq = a.indexOf('=');
          if (eq !== -1) { const k = a.slice(2, eq); flags.add(k); vals[k] = a.slice(eq + 1); }
          else flags.add(a.slice(2));
          continue;
        }
        if (!noMoreFlags && a.startsWith('-') && a.length > 1 && a !== '-') {
          const body = a.slice(1);
          let consumed = false;
          for (let k = 0; k < body.length; k++) {
            const c = body[k];
            if (valued && valued.indexOf(c) !== -1) {
              const attached = body.slice(k + 1);
              flags.add(c);
              if (attached) vals[c] = attached;
              else if (i + 1 < args.length) vals[c] = args[++i];
              consumed = true;
              break;
            }
            flags.add(c);
          }
          void consumed;
          continue;
        }
        rest.push(a);
      }
      return { flags, rest, vals };
    }

    function nodeSize(node) {
      if (node.type === 'dir') return 4096;
      if (node.type === 'link') return node.target.length;
      return (node.content || '').length;
    }

    function resolveOrThrow(pathStr, followLink) {
      const segs = abs(pathStr);
      const res = fs.resolve(segs, user, followLink);
      if (!res.node) err(`${pathStr}: ${res.error === 'permission denied' ? 'Permission denied' : 'No such file or directory'}`);
      return { segs, node: res.node };
    }

    function walkAll(dirNode, dirPath, out, opts) {
      // recursive listing helper used by find / grep -r / du
      out.push({ path: dirPath, node: dirNode });
      if (dirNode.type !== 'dir') return;
      if (!hasPerm(dirNode, user, 'x')) return;
      for (const [name, child] of [...dirNode.children.entries()].sort()) {
        walkAll(child, dirPath === '.' ? name : dirPath + '/' + name, out, opts);
      }
    }

    // ---------------- navigation ----------------
    const builtins = {};

    builtins.pwd = () => ({ stdout: prettyPath(state.cwdSegs) + '\n' });

    builtins.cd = (args) => {
      let target = args[0];
      if (!target || target === '~') target = state.home;
      else if (target === '-') {
        if (!state.prevCwd) err('cd: OLDPWD not set');
        target = state.prevCwd;
      }
      const segs = abs(target);
      const res = fs.resolve(segs, user);
      if (!res.node) return { stderr: `bash: cd: ${target}: No such file or directory\n`, code: 1 };
      if (res.node.type !== 'dir') return { stderr: `bash: cd: ${target}: Not a directory\n`, code: 1 };
      if (!hasPerm(res.node, user, 'x')) return { stderr: `bash: cd: ${target}: Permission denied\n`, code: 1 };
      const prev = prettyPath(state.cwdSegs);
      state.prevCwd = prev;
      state.cwdSegs = segs;
      state.vars.OLDPWD = prev;
      state.vars.PWD = prettyPath(segs);
      return { stdout: args[0] === '-' ? prettyPath(segs) + '\n' : '' };
    };

    builtins.ls = (args) => {
      const { flags, rest } = parseFlags(args);
      const targets = rest.length ? rest : ['.'];
      const showAll = flags.has('a') || flags.has('all');
      const long = flags.has('l');
      const human = flags.has('h');
      const byTime = flags.has('t');
      const reverse = flags.has('r');
      const recursive = flags.has('R');
      const dirAsFile = flags.has('d');
      let out = '';
      let errOut = '';
      let code = 0;
      const groups = [];
      for (const t of targets) {
        const segs = abs(t);
        // `-l` shows a symlink's own line (with "-> target"); without it, a
        // symlink-to-directory is listed like a real directory, matching bash.
        const res = fs.resolve(segs, user, !long);
        if (!res.node) {
          // Real ls reports this on stderr and exits 2, which is what makes
          // `ls missing 2>/dev/null` and `if ls x; then` behave.
          errOut += `ls: cannot access '${t}': No such file or directory\n`;
          code = 2;
          continue;
        }
        groups.push({ label: t, segs, node: res.node });
      }
      const multi = groups.length > 1 || recursive;

      // nlink: files report 1; a directory reports 2 (itself + '.') plus one
      // for each subdirectory's '..' entry.
      function linkCount(node) {
        if (node.type !== 'dir') return 1;
        let n = 2;
        for (const child of node.children.values()) if (child.type === 'dir') n++;
        return n;
      }
      function sizeText(node) { return human ? humanSize(nodeSize(node)) : String(nodeSize(node)); }
      function longLine(name, child, width) {
        const linkPart = child.type === 'link' ? ` -> ${child.target}` : '';
        return `${modeToString(child)} ${linkCount(child)} ${child.owner} ${child.group} ` +
          `${sizeText(child).padStart(width)} ${lsDate(child.mtime)} ${name}${linkPart}\n`;
      }

      function renderDir(node, label, segs) {
        let entries = [...node.children.entries()];
        if (!showAll) entries = entries.filter(([n]) => !n.startsWith('.'));
        if (byTime) entries.sort((a, b) => b[1].mtime - a[1].mtime);
        else entries.sort((a, b) => a[0].localeCompare(b[0]));
        if (showAll) {
          // '.' and '..' are real entries in a listing, and -a is usually run
          // precisely to see them.
          const parentSegs = segs.slice(0, -1);
          const parentRes = fs.resolve(parentSegs, user);
          const dots = [['.', node]];
          if (parentRes.node) dots.push(['..', parentRes.node]);
          entries = dots.concat(entries);
        }
        if (reverse) entries.reverse();
        let s = multi ? `${label}:\n` : '';
        if (long) {
          // Size column is right-aligned to the widest size in THIS listing.
          const width = entries.reduce((w, [, c]) => Math.max(w, sizeText(c).length), 0);
          // `total` is in 1K blocks, like real ls.
          const blocks = entries.reduce((t, [, c]) => t + Math.ceil(nodeSize(c) / 1024) * 4, 0);
          s += `total ${blocks}\n`;
          for (const [name, child] of entries) s += longLine(name, child, width);
        } else {
          s += entries.map(([n]) => n).join('  ') + (entries.length ? '\n' : '');
        }
        if (recursive) {
          for (const [name, child] of entries) {
            if (child.type === 'dir') s += '\n' + renderDir(child, (label === '.' ? '' : label + '/') + name, segs.concat(name));
          }
        }
        return s;
      }

      const rendered = [];
      const isBlock = [];
      // Width for the plain-file lines, shared across all non-directory targets.
      const fileWidth = groups.filter((g) => !(g.node.type === 'dir' && !dirAsFile))
        .reduce((w, g) => Math.max(w, sizeText(g.node).length), 0);
      for (const g of groups) {
        if (g.node.type === 'dir' && !dirAsFile) { rendered.push(renderDir(g.node, g.label, g.segs)); isBlock.push(true); }
        else {
          if (long) rendered.push(longLine(g.label, g.node, fileWidth));
          else rendered.push(g.label + '\n');
          isBlock.push(false);
        }
      }
      // Plain file entries are listed back-to-back with no separator; a
      // directory's own labeled block gets a blank line before it (matching
      // real ls, which only inserts blank lines between multi-directory groups).
      for (let idx = 0; idx < rendered.length; idx++) {
        if (isBlock[idx] && out.length) out += '\n';
        out += rendered[idx];
      }
      return { stdout: out, stderr: errOut, code };
    };

    builtins.tree = (args) => {
      const { flags, rest } = parseFlags(args);
      let maxDepth = Infinity;
      // Accept both `-L 2` and `-L2`.
      for (let i = 0; i < args.length; i++) {
        const m = /^-L(\d*)$/.exec(args[i]);
        if (!m) continue;
        maxDepth = parseInt(m[1] || args[i + 1], 10) || Infinity;
      }
      const startPath = rest.find((a) => !a.match(/^\d+$/)) || '.';
      const { node } = resolveOrThrow(startPath);
      let count = { dirs: 0, files: 0 };
      function render(n, prefix, depth) {
        if (depth > maxDepth) return '';
        if (n.type !== 'dir') return ''; // a file operand has no children to walk
        let entries = [...n.children.entries()].filter(([name]) => !name.startsWith('.')).sort((a, b) => a[0].localeCompare(b[0]));
        let s = '';
        entries.forEach(([name, child], i) => {
          const last = i === entries.length - 1;
          s += prefix + (last ? '└── ' : '├── ') + name + '\n';
          if (child.type === 'dir') { count.dirs++; s += render(child, prefix + (last ? '    ' : '│   '), depth + 1); }
          else count.files++;
        });
        return s;
      }
      const body = render(node, '', 1);
      return { stdout: `${startPath}\n${body}\n${count.dirs} directories, ${count.files} files\n` };
    };

    // ---------------- creating / copying / destroying ----------------
    builtins.mkdir = (args) => {
      const { flags, rest } = parseFlags(args);
      if (!rest.length) err('mkdir: missing operand');
      let out = '';
      for (const p of rest) {
        const segs = abs(p);
        if (flags.has('p')) { fs.mkdirp(segs, user); continue; }
        const { parent, name } = fs.getParentAndName(segs);
        if (!parent) err(`mkdir: cannot create directory '${p}': No such file or directory`);
        if (parent.children.has(name)) err(`mkdir: cannot create directory '${p}': File exists`);
        if (!hasPerm(parent, user, 'w')) err(`mkdir: cannot create directory '${p}': Permission denied`);
        parent.children.set(name, mkNode('dir', { mode: 0o777 & ~state.umask, owner: user.name, group: user.primaryGroup, mtime: now() }));
      }
      return { stdout: out };
    };

    builtins.touch = (args) => {
      const { rest } = parseFlags(args);
      for (const p of rest) {
        const segs = abs(p);
        const res = fs.resolve(segs, user);
        if (res.node) { res.node.mtime = now(); continue; }
        const { parent, name } = fs.getParentAndName(segs);
        if (!parent) err(`touch: cannot touch '${p}': No such file or directory`);
        if (!hasPerm(parent, user, 'w')) err(`touch: cannot touch '${p}': Permission denied`);
        parent.children.set(name, mkNode('file', { mode: 0o666 & ~state.umask, owner: user.name, group: user.primaryGroup, mtime: now(), content: '' }));
      }
      return {};
    };

    function deepCopy(node, ownerStamp) {
      const copy = mkNode(node.type, {
        mode: node.mode, owner: ownerStamp ? user.name : node.owner, group: ownerStamp ? user.primaryGroup : node.group,
        mtime: ownerStamp ? now() : node.mtime, content: node.content, target: node.target, binaryLabel: node.binaryLabel, archive: node.archive,
      });
      if (node.type === 'dir') for (const [k, v] of node.children) copy.children.set(k, deepCopy(v, ownerStamp));
      return copy;
    }

    function copyInto(srcNode, destParent, destName, opts) {
      if (destParent.children.has(destName) && opts.noClobber) return false;
      destParent.children.set(destName, deepCopy(srcNode, !opts.archive));
      return true;
    }

    builtins.cp = (args) => {
      const { flags, rest } = parseFlags(args);
      if (rest.length < 2) err('cp: missing file operand');
      const dest = rest[rest.length - 1];
      const sources = rest.slice(0, -1);
      const destSegs = abs(dest);
      const destRes = fs.resolve(destSegs, user);
      const destIsDir = destRes.node && destRes.node.type === 'dir';
      if (sources.length > 1 && !destIsDir) err(`cp: target '${dest}': Not a directory`);
      for (const s of sources) {
        const { node: srcNode } = resolveOrThrow(s);
        if (srcNode.type === 'dir' && !flags.has('r') && !flags.has('R') && !flags.has('a')) err(`cp: -r not specified; omitting directory '${s}'`);
        let destParent, destName;
        if (destIsDir) { destParent = destRes.node; destName = s.split('/').filter(Boolean).pop(); }
        else { const pn = fs.getParentAndName(destSegs); destParent = pn.parent; destName = pn.name; }
        if (!destParent) err(`cp: cannot create '${dest}': No such file or directory`);
        copyInto(srcNode, destParent, destName, { noClobber: flags.has('n'), archive: flags.has('a') });
      }
      return {};
    };

    builtins.mv = (args) => {
      const { flags, rest } = parseFlags(args);
      if (rest.length < 2) err('mv: missing file operand');
      const dest = rest[rest.length - 1];
      const sources = rest.slice(0, -1);
      const destSegs = abs(dest);
      const destRes = fs.resolve(destSegs, user);
      const destIsDir = destRes.node && destRes.node.type === 'dir';
      if (sources.length > 1 && !destIsDir) err(`mv: target '${dest}': Not a directory`);
      for (const s of sources) {
        const srcSegs = abs(s);
        const srcPN = fs.getParentAndName(srcSegs);
        if (!srcPN.parent || !srcPN.parent.children.has(srcPN.name)) err(`mv: cannot stat '${s}': No such file or directory`);
        const srcNode = srcPN.parent.children.get(srcPN.name);
        let destParent, destName;
        if (destIsDir) { destParent = destRes.node; destName = s.split('/').filter(Boolean).pop(); }
        else { const pn = fs.getParentAndName(destSegs); destParent = pn.parent; destName = pn.name; }
        if (!destParent) err(`mv: cannot move to '${dest}': No such file or directory`);
        // Moving a file onto itself must be refused, not performed: the
        // set-then-delete below would otherwise delete the file outright.
        if (destParent === srcPN.parent && destName === srcPN.name) {
          err(`mv: '${s}' and '${destIsDir ? dest.replace(/\/$/, '') + '/' + destName : dest}' are the same file`);
        }
        if (flags.has('n') && destParent.children.has(destName)) continue;
        destParent.children.set(destName, srcNode);
        srcPN.parent.children.delete(srcPN.name);
      }
      return {};
    };

    builtins.rm = (args) => {
      const { flags, rest } = parseFlags(args);
      if (!rest.length) { if (flags.has('f')) return {}; err('rm: missing operand'); }
      for (const p of rest) {
        const segs = abs(p);
        const pn = fs.getParentAndName(segs);
        if (!pn.parent || !pn.parent.children.has(pn.name)) { if (!flags.has('f')) err(`rm: cannot remove '${p}': No such file or directory`); continue; }
        const node = pn.parent.children.get(pn.name);
        if (node.type === 'dir' && !flags.has('r') && !flags.has('R')) err(`rm: cannot remove '${p}': Is a directory`);
        if (!hasPerm(pn.parent, user, 'w')) { if (!flags.has('f')) err(`rm: cannot remove '${p}': Permission denied`); continue; }
        pn.parent.children.delete(pn.name);
      }
      return {};
    };

    builtins.rmdir = (args) => {
      for (const p of args) {
        const segs = abs(p);
        const pn = fs.getParentAndName(segs);
        if (!pn.parent || !pn.parent.children.has(pn.name)) err(`rmdir: failed to remove '${p}': No such file or directory`);
        const node = pn.parent.children.get(pn.name);
        if (node.type !== 'dir') err(`rmdir: failed to remove '${p}': Not a directory`);
        if (node.children.size) err(`rmdir: failed to remove '${p}': Directory not empty`);
        pn.parent.children.delete(pn.name);
      }
      return {};
    };

    builtins.ln = (args) => {
      const { flags, rest } = parseFlags(args);
      if (rest.length < 2) err('ln: missing file operand');
      const [target, linkName] = rest;
      const segs = abs(linkName);
      const pn = fs.getParentAndName(segs);
      if (!pn.parent) err(`ln: failed to create link '${linkName}': No such file or directory`);
      if (flags.has('s')) {
        // Symlinks always show as lrwxrwxrwx; the target's bits are what matter.
        pn.parent.children.set(pn.name, mkNode('link', { target, mode: 0o777, owner: user.name, group: user.primaryGroup, mtime: now() }));
      } else {
        const { node: srcNode } = resolveOrThrow(target);
        pn.parent.children.set(pn.name, srcNode); // hard link: same node object
      }
      return {};
    };

    // ---------------- reading files ----------------
    function readFileOrThrow(p) {
      const { node } = resolveOrThrow(p);
      if (node.type === 'dir') err(`${p}: Is a directory`);
      if (!hasPerm(node, user, 'r')) err(`${p}: Permission denied`);
      return node.content || '';
    }

    builtins.cat = (args, stdin) => {
      const { flags, rest } = parseFlags(args);
      let text;
      if (!rest.length) text = stdin || '';
      else text = rest.map(readFileOrThrow).join('');
      if (flags.has('n')) {
        const lines = text.split('\n');
        const hadTrail = text.endsWith('\n'); if (hadTrail) lines.pop();
        text = lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n') + (hadTrail ? '\n' : '');
      }
      return { stdout: text };
    };
    builtins.less = builtins.more = (args, stdin) => {
      const r = builtins.cat(args, stdin);
      return { stdout: r.stdout + (r.stdout.endsWith('\n') ? '' : '\n') + '(end of file — this sandbox shows the whole thing at once; real less would page it)\n' };
    };

    // Shared operand parsing for head/tail: handles `-n N`, `-nN`, `-N`, and
    // `-c N`/`-cN` for bytes, leaving only real filenames behind.
    function headTailArgs(args) {
      const shorthand = args.filter((a) => /^-\d+$/.test(a));
      const cleaned = args.filter((a) => !/^-\d+$/.test(a));
      const { flags, rest, vals } = parseFlags(cleaned, 'nc');
      let count = null, unit = 'lines', fromStart = false;
      if (vals.c !== undefined) { unit = 'bytes'; count = parseInt(vals.c, 10); }
      else if (vals.n !== undefined) {
        const raw = String(vals.n);
        fromStart = raw.startsWith('+');
        count = parseInt(raw.replace(/^\+/, ''), 10);
      } else if (shorthand.length) count = parseInt(shorthand[shorthand.length - 1].slice(1), 10);
      if (count === null || isNaN(count)) count = 10;
      return { flags, files: rest, count, unit, fromStart };
    }

    function headTailBodies(files, stdin) {
      return files.length ? files.map((f) => ({ name: f, text: readFileOrThrow(f) }))
                          : [{ name: null, text: stdin || '' }];
    }
    function splitKeepingTrail(text) {
      const lines = text.split('\n');
      if (text.endsWith('\n')) lines.pop();
      return lines;
    }

    builtins.head = (args, stdin) => {
      const { files, count, unit } = headTailArgs(args);
      const bodies = headTailBodies(files, stdin);
      const parts = bodies.map((b) => {
        const header = bodies.length > 1 ? `==> ${b.name} <==\n` : '';
        if (unit === 'bytes') return header + b.text.slice(0, count);
        const lines = splitKeepingTrail(b.text);
        const taken = lines.slice(0, count);
        return header + (taken.length ? taken.join('\n') + '\n' : '');
      });
      return { stdout: parts.join(bodies.length > 1 ? '\n' : '') };
    };

    builtins.tail = (args, stdin) => {
      const { flags, files, count, unit, fromStart } = headTailArgs(args);
      const follow = flags.has('f') || flags.has('F');
      const bodies = headTailBodies(files, stdin);
      const parts = bodies.map((b) => {
        const header = bodies.length > 1 ? `==> ${b.name} <==\n` : '';
        if (unit === 'bytes') return header + b.text.slice(-count);
        const lines = splitKeepingTrail(b.text);
        // `tail -n +N` starts AT line N instead of counting back from the end.
        const taken = fromStart ? lines.slice(Math.max(0, count - 1)) : lines.slice(Math.max(0, lines.length - count));
        return header + (taken.length ? taken.join('\n') + '\n' : '');
      });
      let out = parts.join(bodies.length > 1 ? '\n' : '');
      if (follow) out += `(sandbox note: -f can't watch for new writes here — this is a snapshot. Run tail again to refresh.)\n`;
      return { stdout: out };
    };

    builtins.wc = (args, stdin) => {
      const { flags, rest } = parseFlags(args);
      const want = flags.has('l') || flags.has('w') || flags.has('c') ? flags : new Set(['l', 'w', 'c']);
      const order = ['l', 'w', 'c'].filter((k) => want.has(k));
      function counts(text) {
        const lines = (text.match(/\n/g) || []).length + (text.length && !text.endsWith('\n') ? 1 : 0);
        const words = text.trim().length ? text.trim().split(/\s+/).length : 0;
        const bytes = text.length;
        return { lines, words, bytes };
      }
      function val(c, k) { return k === 'l' ? c.lines : k === 'w' ? c.words : c.bytes; }
      let rows, width;
      if (!rest.length) {
        const c = counts(stdin || '');
        rows = [{ c, name: null }];
        width = Math.max(...order.map((k) => String(val(c, k)).length));
      } else if (rest.length === 1) {
        const c = counts(readFileOrThrow(rest[0]));
        rows = [{ c, name: rest[0] }];
        width = Math.max(...order.map((k) => String(val(c, k)).length));
      } else {
        rows = rest.map((f) => ({ c: counts(readFileOrThrow(f)), name: f }));
        const total = { lines: 0, words: 0, bytes: 0 };
        for (const r of rows) { total.lines += r.c.lines; total.words += r.c.words; total.bytes += r.c.bytes; }
        rows.push({ c: total, name: 'total' });
        // GNU wc quirk: multi-file column width is based on the digit-count of
        // the combined byte size of the inputs, not the specific counts shown.
        width = String(total.bytes).length;
      }
      function fmt(r) {
        const fields = order.map((k) => String(val(r.c, k)).padStart(width));
        return fields.join(' ') + (r.name !== null ? ' ' + r.name : '') + '\n';
      }
      return { stdout: rows.map(fmt).join('') };
    };

    builtins.diff = (args) => {
      const { flags, rest } = parseFlags(args);
      if (rest.length < 2) err('diff: missing operand');
      const [a, b] = rest;
      const at = readFileOrThrow(a).replace(/\n$/, '').split('\n');
      const bt = readFileOrThrow(b).replace(/\n$/, '').split('\n');
      const ops = lcsDiff(at, bt);
      const changed = ops.some((o) => o.type !== '=');
      if (flags.has('u')) return { stdout: unifiedDiff(a, b, ops), code: changed ? 1 : 0 };
      return { stdout: normalDiff(ops), code: changed ? 1 : 0 };
    };

    // Classic diff output: adjacent -/+ runs collapse into one `NcM` change
    // hunk (with the `---` separator), not a delete followed by an add.
    function normalDiff(ops) {
      let out = '';
      let i = 0, j = 0, k = 0;
      const range = (start, end) => (start === end ? String(start) : `${start},${end}`);
      while (k < ops.length) {
        if (ops[k].type === '=') { i++; j++; k++; continue; }
        const dels = [], adds = [];
        const startA = i + 1, startB = j + 1;
        while (k < ops.length && ops[k].type === '-') { dels.push(ops[k].line); i++; k++; }
        while (k < ops.length && ops[k].type === '+') { adds.push(ops[k].line); j++; k++; }
        if (dels.length && adds.length) {
          out += `${range(startA, i)}c${range(startB, j)}\n`;
          out += dels.map((l) => '< ' + l).join('\n') + '\n---\n' + adds.map((l) => '> ' + l).join('\n') + '\n';
        } else if (dels.length) {
          out += `${range(startA, i)}d${j}\n` + dels.map((l) => '< ' + l).join('\n') + '\n';
        } else {
          out += `${i}a${range(startB, j)}\n` + adds.map((l) => '> ' + l).join('\n') + '\n';
        }
      }
      return out;
    }
    function lcsDiff(a, b) {
      const n = a.length, m = b.length;
      const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      const ops = []; let i = 0, j = 0;
      while (i < n && j < m) {
        if (a[i] === b[j]) { ops.push({ type: '=', line: a[i] }); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: '-', line: a[i] }); i++; }
        else { ops.push({ type: '+', line: b[j] }); j++; }
      }
      while (i < n) { ops.push({ type: '-', line: a[i] }); i++; }
      while (j < m) { ops.push({ type: '+', line: b[j] }); j++; }
      return ops;
    }
    // Unified diff with GNU's 3 lines of context. Changes closer than 2*CTX
    // apart share a hunk; further apart, the hunk closes and a new one opens —
    // the previous version never closed one, emitting the whole file as a hunk.
    function unifiedDiff(aName, bName, ops) {
      const CTX = 3;
      // Annotate each op with its line number on both sides.
      const marked = [];
      let ai = 0, bi = 0;
      for (const op of ops) {
        marked.push({ ...op, ai, bi });
        if (op.type === '=') { ai++; bi++; }
        else if (op.type === '-') ai++;
        else bi++;
      }
      const changeIdx = marked.map((m, idx) => (m.type === '=' ? -1 : idx)).filter((x) => x >= 0);
      if (!changeIdx.length) return '';

      // Group change indices into hunks separated by more than 2*CTX context.
      const groups = [];
      let cur = [changeIdx[0]];
      for (let n = 1; n < changeIdx.length; n++) {
        if (changeIdx[n] - cur[cur.length - 1] > CTX * 2) { groups.push(cur); cur = []; }
        cur.push(changeIdx[n]);
      }
      groups.push(cur);

      let out = `--- ${aName}\n+++ ${bName}\n`;
      for (const g of groups) {
        const from = Math.max(0, g[0] - CTX);
        const to = Math.min(marked.length - 1, g[g.length - 1] + CTX);
        const slice = marked.slice(from, to + 1);
        const aCount = slice.filter((m) => m.type !== '+').length;
        const bCount = slice.filter((m) => m.type !== '-').length;
        const aStart = aCount ? slice.find((m) => m.type !== '+').ai + 1 : slice[0].ai;
        const bStart = bCount ? slice.find((m) => m.type !== '-').bi + 1 : slice[0].bi;
        out += `@@ -${aStart},${aCount} +${bStart},${bCount} @@\n`;
        for (const m of slice) out += (m.type === '=' ? ' ' : m.type) + m.line + '\n';
      }
      return out;
    }

    builtins.file = (args) => {
      const out = [];
      for (const p of args) {
        const { node } = resolveOrThrow(p);
        let desc;
        if (node.binaryLabel) desc = node.binaryLabel;
        else if (node.type === 'dir') desc = 'directory';
        else if (node.type === 'link') desc = `symbolic link to ${node.target}`;
        else if ((node.content || '').length === 0) desc = 'empty';
        else if (/\.sh$/.test(p)) desc = (node.mode & 0o111) ? 'Bourne-Again shell script, ASCII text executable' : 'Bourne-Again shell script, ASCII text';
        else desc = 'ASCII text';
        out.push(`${p}: ${desc}`);
      }
      return { stdout: out.join('\n') + '\n' };
    };

    builtins.stat = (args) => {
      const out = [];
      for (const p of args) {
        const { node } = resolveOrThrow(p);
        out.push(`  File: ${p}`);
        out.push(`  Size: ${nodeSize(node)}\t\tType: ${node.type === 'dir' ? 'directory' : node.type === 'link' ? 'symbolic link' : 'regular file'}`);
        out.push(`Access: (${octalFromMode(node.mode)}/${modeToString(node)})  Uid: (${node.owner})   Gid: (${node.group})`);
        out.push(`Modify: ${dateFormat(node.mtime, '%Y-%m-%d %T')}`);
      }
      return { stdout: out.join('\n') + '\n' };
    };

    builtins.zcat = (args) => {
      const out = [];
      for (const p of args) {
        const { node } = resolveOrThrow(p);
        out.push(node.content || '');
      }
      return { stdout: out.join('') };
    };
    builtins.zgrep = (args, stdin, c) => builtins.grep(args, stdin, c);

    // ---------------- pipes/redirection helpers ----------------
    builtins.echo = (args) => {
      let a = args.slice();
      let noNewline = false, interpret = false;
      while (a[0] === '-n' || a[0] === '-e' || a[0] === '-ne' || a[0] === '-en') {
        if (a[0].includes('n')) noNewline = true;
        if (a[0].includes('e')) interpret = true;
        a = a.slice(1);
      }
      let text = a.join(' ');
      if (interpret) text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      return { stdout: text + (noNewline ? '' : '\n') };
    };

    builtins.printf = (args) => {
      const fmt = args[0] || '';
      const rest = args.slice(1);
      let out = '';
      let ai = 0;
      const applyOnce = () => {
        for (let i = 0; i < fmt.length; i++) {
          if (fmt[i] === '\\' && fmt[i + 1] === 'n') { out += '\n'; i++; continue; }
          if (fmt[i] === '\\' && fmt[i + 1] === 't') { out += '\t'; i++; continue; }
          if (fmt[i] === '%' && fmt[i + 1]) {
            let j = i + 1, spec = '%';
            while (j < fmt.length && /[-0-9.]/.test(fmt[j])) { spec += fmt[j]; j++; }
            const conv = fmt[j]; spec += conv;
            const arg = rest[ai++];
            if (conv === 's') out += (arg === undefined ? '' : arg);
            else if (conv === 'd') out += String(parseInt(arg, 10) || 0);
            else if (conv === 'f') { const m = spec.match(/%\.(\d+)f/); const prec = m ? parseInt(m[1], 10) : 6; out += (parseFloat(arg) || 0).toFixed(prec); }
            else if (conv === '%') { out += '%'; ai--; }
            i = j;
          } else out += fmt[i];
        }
      };
      if (rest.length === 0) applyOnce();
      else while (ai < rest.length) applyOnce();
      return { stdout: out };
    };

    builtins.tee = (args, stdin) => {
      const { flags, rest } = parseFlags(args);
      for (const f of rest) {
        const segs = abs(f);
        const pn = fs.getParentAndName(segs);
        if (!pn.parent) continue;
        let node = pn.parent.children.get(pn.name);
        if (!node) { node = mkNode('file', { mode: 0o666 & ~state.umask, owner: user.name, group: user.primaryGroup }); pn.parent.children.set(pn.name, node); }
        node.content = (flags.has('a') ? (node.content || '') : '') + (stdin || '');
        node.mtime = now();
      }
      return { stdout: stdin || '' };
    };

    builtins.xargs = (args, stdin) => {
      let i = 0; let iFlag = null, nFlag = null, nullSep = false;
      const cmdArgs = [];
      while (i < args.length) {
        if (args[i] === '-I') { iFlag = args[i + 1]; i += 2; continue; }
        if (args[i].startsWith('-I') && args[i].length > 2) { iFlag = args[i].slice(2); i++; continue; }
        if (args[i] === '-n') { nFlag = parseInt(args[i + 1], 10); i += 2; continue; }
        if (/^-n\d+$/.test(args[i])) { nFlag = parseInt(args[i].slice(2), 10); i++; continue; } // -n1
        if (args[i] === '-0' || args[i] === '--null') { nullSep = true; i++; continue; }
        if (args[i] === '-P') { i += 2; continue; }
        if (/^-P\d+$/.test(args[i])) { i++; continue; } // -P4: parallelism is a no-op here
        cmdArgs.push(args[i]); i++;
      }
      const items = (stdin || '').split(nullSep ? '\0' : /\s+/).filter((s) => s.length);
      const cmdName = cmdArgs[0] || 'echo';
      const baseArgs = cmdArgs.slice(1);
      let out = '', errOut = '', code = 0;
      if (iFlag) {
        for (const item of items) {
          const substituted = baseArgs.map((a) => a.split(iFlag).join(item));
          const r = runBuiltin(cmdName, substituted, '', {});
          out += r.stdout; errOut += r.stderr; if (r.code) code = r.code;
        }
      } else if (nFlag) {
        for (let k = 0; k < items.length; k += nFlag) {
          const r = runBuiltin(cmdName, baseArgs.concat(items.slice(k, k + nFlag)), '', {});
          out += r.stdout; errOut += r.stderr; if (r.code) code = r.code;
        }
      } else {
        const r = runBuiltin(cmdName, baseArgs.concat(items), '', {});
        out += r.stdout; errOut += r.stderr; code = r.code;
      }
      return { stdout: out, stderr: errOut, code };
    };

    // ---------------- finding things ----------------
    builtins.which = (args) => {
      const out = args.map((a) => (state.commandsList && state.commandsList.includes(a) ? `/usr/bin/${a}` : null));
      const found = out.filter(Boolean);
      if (!found.length) return { code: 1 };
      return { stdout: found.join('\n') + '\n' };
    };
    builtins.type = (args) => {
      const out = args.map((a) => {
        if (state.aliases[a]) return `${a} is aliased to \`${state.aliases[a]}'`;
        if (BUILTIN_NAMES.has(a)) return `${a} is a shell builtin`;
        if (state.commandsList && state.commandsList.includes(a)) return `${a} is /usr/bin/${a}`;
        return `bash: type: ${a}: not found`;
      });
      return { stdout: out.join('\n') + '\n' };
    };
    builtins.command = (args, stdin, c) => {
      if (args[0] === '-v') return builtins.which(args.slice(1));
      return runBuiltin(args[0], args.slice(1), stdin, { ...c, noAlias: true });
    };
    const BUILTIN_NAMES = new Set(['cd', 'pwd', 'export', 'unset', 'alias', 'unalias', 'history', 'jobs', 'fg', 'bg', 'read', 'echo', 'exit', 'set', 'source', '.', 'help', 'type', 'umask', 'wait']);

    builtins.find = (args) => {
      let i = 0;
      const rawStart = (args[0] && !args[0].startsWith('-')) ? args[i++] : '.';
      // `find data/ ...` must print `data/bigfile.dat`, not `data//bigfile.dat`.
      const startPath = rawStart.length > 1 ? rawStart.replace(/\/+$/, '') : rawStart;
      const { node: startNode } = resolveOrThrow(startPath);
      // Predicates are collected into AND-groups split at each -o, so that
      // `-type f -name '*.log' -o -name '*.csv'` means
      // (type f AND name *.log) OR (name *.csv), like real find.
      const orGroups = [[]];
      let maxDepth = Infinity, doDelete = false, nulOut = false;
      const execGroups = [];
      let negateNext = false;
      const unsupported = [];
      for (; i < args.length; i++) {
        const a = args[i];
        if (a === '-maxdepth') { maxDepth = parseInt(args[++i], 10); continue; }
        if (a === '-delete') { doDelete = true; continue; }
        if (a === '-print') { continue; }
        if (a === '-print0') { nulOut = true; continue; }
        if (a === '!' || a === '-not') { negateNext = true; continue; }
        if (a === '-a' || a === '-and') { continue; }
        if (a === '-o' || a === '-or') { orGroups.push([]); continue; }
        let pred = null;
        if (a === '-name' || a === '-iname') { const pat = args[++i]; const re = Engine.__internal.globToRegex(pat); pred = (path, node, name) => a === '-iname' ? new RegExp(re.source, 'i').test(name) : re.test(name); }
        else if (a === '-type') { const t = args[++i]; pred = (path, node) => (t === 'f' ? node.type === 'file' : t === 'd' ? node.type === 'dir' : t === 'l' ? node.type === 'link' : false); }
        else if (a === '-mtime') { const spec = args[++i]; pred = (path, node) => matchesAge(now() - node.mtime, spec, 86400000); }
        else if (a === '-mmin') { const spec = args[++i]; pred = (path, node) => matchesAge(now() - node.mtime, spec, 60000); }
        else if (a === '-size') { const spec = args[++i]; pred = (path, node) => matchesSize(nodeSize(node), spec); }
        else if (a === '-user') { const u = args[++i]; pred = (path, node) => node.owner === u; }
        else if (a === '-perm') { const spec = args[++i]; pred = (path, node) => matchesPerm(node.mode, spec); }
        else if (a === '-empty') { pred = (path, node) => (node.type === 'dir' ? node.children.size === 0 : nodeSize(node) === 0); }
        else if (a === '-path') { const pat = args[++i]; const re = Engine.__internal.globToRegex(pat); pred = (path) => re.test(path); }
        else if (a === '-exec') {
          const cmd = []; i++;
          while (i < args.length && args[i] !== ';' && args[i] !== '+') { cmd.push(args[i]); i++; }
          const terminator = args[i];
          execGroups.push({ cmd, terminator });
          pred = () => true;
        } else {
          // Silently ignoring an unknown predicate produces plausible-but-wrong
          // output with no signal — say so instead.
          if (a.startsWith('-')) unsupported.push(a);
          continue;
        }
        if (negateNext) { const inner = pred; pred = (p, n, nm) => !inner(p, n, nm); negateNext = false; }
        orGroups[orGroups.length - 1].push(pred);
      }
      function matchesAge(ageMs, spec, unit) {
        const n = parseInt(spec, 10);
        const ageUnits = ageMs / unit;
        if (spec.startsWith('+')) return ageUnits > Math.abs(n);
        if (spec.startsWith('-')) return ageUnits < Math.abs(n);
        return Math.floor(ageUnits) === n;
      }
      function matchesSize(bytes, spec) {
        let mult = 1; let s = spec;
        if (/c$/.test(s)) { mult = 1; s = s.slice(0, -1); }
        else if (/k$/i.test(s)) { mult = 1024; s = s.slice(0, -1); }
        else if (/M$/.test(s)) { mult = 1024 * 1024; s = s.slice(0, -1); }
        else if (/G$/.test(s)) { mult = 1024 * 1024 * 1024; s = s.slice(0, -1); }
        else mult = 512;
        const n = parseInt(s, 10) * mult;
        if (spec.startsWith('+')) return bytes > Math.abs(n);
        if (spec.startsWith('-')) return bytes < Math.abs(n);
        return bytes === n;
      }
      function matchesPerm(mode, spec) {
        // Symbolic forms like -perm -u+x, as well as octal.
        const sym = /^(-?)([ugoa]*)([-+=])([rwx]+)$/.exec(spec);
        if (sym) {
          const whoChars = sym[2] || 'a';
          const shifts = [];
          if (whoChars.includes('u') || whoChars.includes('a')) shifts.push(6);
          if (whoChars.includes('g') || whoChars.includes('a')) shifts.push(3);
          if (whoChars.includes('o') || whoChars.includes('a')) shifts.push(0);
          let want = 0;
          for (const sh of shifts) {
            for (const ch of sym[4]) want |= (ch === 'r' ? 4 : ch === 'w' ? 2 : 1) << sh;
          }
          return (mode & want) === want;
        }
        if (spec.startsWith('-')) { const want = parseInt(spec.slice(1), 8); return (mode & want) === want; }
        return (mode & 0o777) === parseInt(spec, 8);
      }
      const results = [];
      const groups = orGroups.filter((g) => g.length);
      function walk(node, path, depth) {
        const name = path.split('/').pop() || path;
        // AND within a group, OR across groups; no predicates matches everything.
        const ok = !groups.length || groups.some((g) => g.every((p) => p(path, node, name)));
        if (ok) results.push({ path, node });
        if (node.type === 'dir' && depth < maxDepth && hasPerm(node, user, 'x')) {
          for (const [cname, child] of [...node.children.entries()].sort()) walk(child, path + '/' + cname, depth + 1);
        }
      }
      walk(startNode, startPath, 0);
      let out = '';
      if (execGroups.length) {
        for (const g of execGroups) {
          if (g.terminator === '+') {
            const fullCmd = g.cmd.map((t) => (t === '{}' ? results.map((r) => r.path) : t)).flat();
            const r = runBuiltin(fullCmd[0], fullCmd.slice(1), '', {});
            out += r.stdout;
          } else {
            for (const res of results) {
              const fullCmd = g.cmd.map((t) => (t === '{}' ? res.path : t));
              const r = runBuiltin(fullCmd[0], fullCmd.slice(1), '', {});
              out += r.stdout;
            }
          }
        }
      } else if (doDelete) {
        results.sort((a, b) => b.path.length - a.path.length);
        for (const r of results) {
          const segs = abs(r.path);
          const pn = fs.getParentAndName(segs);
          if (pn.parent && pn.parent.children.has(pn.name)) pn.parent.children.delete(pn.name);
        }
      } else if (nulOut) {
        // -print0 pairs with `xargs -0`, the safe way to handle odd filenames.
        out = results.map((r) => r.path + '\0').join('');
      } else {
        out = results.map((r) => r.path).join('\n') + (results.length ? '\n' : '');
      }
      const warn = unsupported.length
        ? `find: this sandbox doesn't implement ${unsupported.join(', ')} — results ignore it\n`
        : '';
      return { stdout: out, stderr: warn };
    };

    builtins.locate = (args) => {
      const term = args[args.length - 1] || '';
      const results = [];
      walkAll(fs.root, '', results);
      const matches = results.filter((r) => r.path.toLowerCase().includes(term.toLowerCase())).map((r) => '/' + r.path);
      return { stdout: matches.join('\n') + (matches.length ? '\n' : '') };
    };

    // ---------------- regex translation ----------------
    // JS regexes are close to ERE but not identical, and nothing like BRE.
    // Chapter 7 teaches that `+ ? | ( )` need `grep -E` (or backslashes in
    // BRE), so the distinction has to be real here or the lesson is wrong.
    const POSIX_CLASSES = {
      alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', space: ' \\t\\r\\n\\f\\v',
      upper: 'A-Z', lower: 'a-z', punct: '!-/:-@\\[-`{-~', blank: ' \\t',
      xdigit: '0-9A-Fa-f', word: 'A-Za-z0-9_', cntrl: '\\x00-\\x1f', print: '\\x20-\\x7e', graph: '\\x21-\\x7e',
    };
    // Rewrites [[:alpha:]] etc. inside bracket expressions, which JS lacks.
    function expandPosixClasses(src) {
      return src.replace(/\[:([a-z]+):\]/g, (m, name) => POSIX_CLASSES[name] !== undefined ? POSIX_CLASSES[name] : m);
    }
    function ereToJs(src) { return expandPosixClasses(src); }
    // In BRE, `+ ? { } ( ) |` are literal unless backslash-escaped — exactly
    // the reverse of JS — so swap the escaping of each.
    function breToJs(src) {
      src = expandPosixClasses(src);
      let out = '';
      let inClass = false;
      for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (inClass) { out += c; if (c === ']') inClass = false; continue; }
        if (c === '[') { inClass = true; out += c; continue; }
        if (c === '\\' && i + 1 < src.length) {
          const n = src[i + 1];
          if ('+?{}()|'.indexOf(n) !== -1) { out += n; i++; continue; }   // \+ -> +
          out += c + n; i++; continue;
        }
        if ('+?{}()|'.indexOf(c) !== -1) { out += '\\' + c; continue; }   // + -> \+
        out += c;
      }
      return out;
    }
    function globRe(glob) {
      return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    }

    builtins.grep = (args, stdin) => {
      // -A/-B/-C/-m/-e take a value; without this their number is mistaken for
      // the pattern (`grep -A 2 ERROR file` searched for "2").
      const { flags, rest, vals } = parseFlags(args, 'ABCme');
      const after = flags.has('C') ? parseInt(vals.C, 10) : (flags.has('A') ? parseInt(vals.A, 10) : 0);
      const before = flags.has('C') ? parseInt(vals.C, 10) : (flags.has('B') ? parseInt(vals.B, 10) : 0);
      const maxCount = flags.has('m') ? parseInt(vals.m, 10) : Infinity;
      const pattern = flags.has('e') ? vals.e : rest[0];
      const fileArgs = flags.has('e') ? rest : rest.slice(1);
      if (pattern === undefined) err('grep: missing pattern');
      let src = pattern;
      if (flags.has('F')) src = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      else src = flags.has('E') ? ereToJs(src) : breToJs(src);
      if (flags.has('w')) src = `\\b(?:${src})\\b`;
      let re;
      try { re = new RegExp(src, 'g' + (flags.has('i') ? 'i' : '')); } catch (e) { err(`grep: invalid pattern: ${pattern}`); }
      const test = (s) => { re.lastIndex = 0; return re.test(s); };

      // --include / --exclude-dir are silently ignored otherwise, which is the
      // worst failure mode: plausible but wrong output with no signal.
      const includeGlob = vals.include ? globRe(vals.include) : null;
      const excludeGlob = vals.exclude ? globRe(vals.exclude) : null;
      const excludeDir = vals['exclude-dir'] || null;

      let files = [];
      if (flags.has('r') || flags.has('R')) {
        const bases = fileArgs.length ? fileArgs : ['.'];
        for (const b of bases) {
          const clean = b.length > 1 ? b.replace(/\/$/, '') : b;
          const { node } = resolveOrThrow(clean);
          const list = [];
          walkAll(node, clean, list);
          for (const item of list) {
            if (item.node.type !== 'file') continue;
            const base = item.path.split('/').pop();
            if (includeGlob && !includeGlob.test(base)) continue;
            if (excludeGlob && excludeGlob.test(base)) continue;
            if (excludeDir && item.path.split('/').slice(0, -1).includes(excludeDir)) continue;
            files.push(item.path);
          }
        }
      } else files = fileArgs;

      const multi = files.length > 1 || flags.has('r') || flags.has('R');
      let totalCount = 0;
      let outLines = [];
      let matchedAnyFile = false;
      const listOnly = [];

      function processText(text, label) {
        const lines = text.split('\n');
        const hadTrail = text.endsWith('\n'); if (hadTrail) lines.pop();
        // Decide every match up front, so a line that happens to fall inside
        // the previous match's after-context is still labelled as a match
        // (`9:` rather than `9-`).
        const isMatch = lines.map((l) => (test(l) !== flags.has('v')));
        let count = 0; const printed = [];
        let lastPrintedIdx = -999;
        for (let idx = 0; idx < lines.length; idx++) {
          if (!isMatch[idx]) continue;
          count++;
          if (count > maxCount) break;
          if (flags.has('c') || flags.has('l') || flags.has('q')) continue;
          if (flags.has('o')) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(lines[idx])) !== null) {
              printed.push(fmtLine(m[0], idx, label, true));
              if (m.index === re.lastIndex) re.lastIndex++;
            }
            lastPrintedIdx = idx;
            continue;
          }
          const from = Math.max(0, idx - before);
          // A gap in printed lines gets the `--` separator, with or without -B.
          if ((before || after) && lastPrintedIdx !== -999 && from > lastPrintedIdx + 1) printed.push('--');
          for (let k = from; k <= idx; k++) if (k > lastPrintedIdx) { printed.push(fmtLine(lines[k], k, label, isMatch[k])); lastPrintedIdx = k; }
          for (let k = idx + 1; k <= Math.min(lines.length - 1, idx + after); k++) {
            if (k <= lastPrintedIdx) continue;
            printed.push(fmtLine(lines[k], k, label, isMatch[k]));
            lastPrintedIdx = k;
          }
        }
        return { count: Math.min(count, maxCount), printed };
      }
      function fmtLine(line, idx, label, isMatchLine) {
        let prefix = '';
        const sep = isMatchLine ? ':' : '-';
        if ((multi || flags.has('H')) && label !== null) prefix += label + sep;
        if (flags.has('n')) prefix += (idx + 1) + sep;
        return prefix + line;
      }

      const targets = files.length ? files.map((f) => ({ label: f, text: readFileOrThrow(f) })) : [{ label: null, text: stdin || '' }];
      for (const t of targets) {
        const { count, printed } = processText(t.text, t.label);
        if (count > 0) matchedAnyFile = true;
        totalCount += count;
        if (flags.has('l')) { if (count > 0) listOnly.push(t.label); continue; }
        if (flags.has('c')) { outLines.push((multi ? t.label + ':' : '') + count); continue; }
        outLines.push(...printed);
      }
      // -q is the "command as condition" idiom: status only, no output.
      if (flags.has('q')) return { stdout: '', code: matchedAnyFile ? 0 : 1 };
      if (flags.has('l')) return { stdout: listOnly.join('\n') + (listOnly.length ? '\n' : ''), code: listOnly.length ? 0 : 1 };
      const stdout = outLines.join('\n') + (outLines.length ? '\n' : '');
      return { stdout, code: matchedAnyFile ? 0 : 1 };
    };
    builtins.egrep = (args, stdin) => builtins.grep(['-E', ...args], stdin);

    // ---------------- sort / uniq / cut / tr ----------------
    builtins.sort = (args, stdin) => {
      // -t and -k take values; -k can repeat, so collect it separately.
      const keyFields = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-k') keyFields.push(args[i + 1]);
        else if (/^-k./.test(args[i])) keyFields.push(args[i].slice(2));
      }
      const { flags, rest, vals } = parseFlags(args, 'tk');
      const delim = vals.t !== undefined ? vals.t : null;
      const files = rest;
      const text = files.length ? files.map(readFileOrThrow).join('') : (stdin || '');
      const hadTrail = text.endsWith('\n');
      let lines = text.split('\n'); if (hadTrail) lines.pop();

      function fieldOf(line, spec) {
        const [startSpec] = spec.split(',');
        const idx = parseInt(startSpec, 10) - 1;
        const parts = delim ? line.split(delim) : line.trim().split(/\s+/);
        return parts[idx] !== undefined ? parts[idx] : '';
      }
      function humanToBytes(s) {
        const m = String(s).match(/^([\d.]+)([KMGT]?)/i);
        if (!m) return parseFloat(s) || 0;
        const mult = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2].toUpperCase()] || 1;
        return parseFloat(m[1]) * mult;
      }
      function cmpValues(a, b) {
        if (flags.has('h')) return humanToBytes(a) - humanToBytes(b);
        if (flags.has('n')) return (parseFloat(a) || 0) - (parseFloat(b) || 0);
        return a < b ? -1 : a > b ? 1 : 0;
      }
      // GNU sort falls back to a whole-line comparison to break ties, and with
      // -r that tiebreak is reversed too (not just the primary key) — so e.g.
      // two rows tied on count sort by *descending* line text under `sort -rn`.
      function lineCompare(la, lb) {
        if (keyFields.length) {
          for (const spec of keyFields) { const c = cmpValues(fieldOf(la, spec), fieldOf(lb, spec)); if (c !== 0) return c; }
        } else {
          const c = cmpValues(la, lb);
          if (c !== 0) return c;
        }
        return la < lb ? -1 : la > lb ? 1 : 0;
      }
      lines.sort((la, lb) => { const c = lineCompare(la, lb); return flags.has('r') ? -c : c; });
      if (flags.has('u')) lines = lines.filter((l, i) => i === 0 || l !== lines[i - 1]);
      return { stdout: lines.join('\n') + (lines.length ? '\n' : '') };
    };

    builtins.uniq = (args, stdin) => {
      const { flags, rest } = parseFlags(args);
      const text = rest.length ? readFileOrThrow(rest[0]) : (stdin || '');
      const hadTrail = text.endsWith('\n');
      let lines = text.split('\n'); if (hadTrail) lines.pop();
      const groups = [];
      for (const l of lines) { if (groups.length && groups[groups.length - 1].line === l) groups[groups.length - 1].count++; else groups.push({ line: l, count: 1 }); }
      let filtered = groups;
      if (flags.has('d')) filtered = groups.filter((g) => g.count > 1);
      if (flags.has('u')) filtered = groups.filter((g) => g.count === 1);
      const out = filtered.map((g) => (flags.has('c') ? `${String(g.count).padStart(7)} ${g.line}` : g.line));
      return { stdout: out.join('\n') + (out.length ? '\n' : '') };
    };

    builtins.cut = (args, stdin) => {
      const { flags, rest, vals } = parseFlags(args, 'dfc');
      const delim = vals.d !== undefined ? vals.d : '\t';
      const fieldSpec = vals.f !== undefined ? vals.f : null;
      const charSpec = vals.c !== undefined ? vals.c : null;
      const text = rest.length ? rest.map(readFileOrThrow).join('') : (stdin || '');
      const hadTrail = text.endsWith('\n');
      let lines = text.split('\n'); if (hadTrail) lines.pop();
      // cut always emits fields in ascending order and never repeats one,
      // whatever order the spec lists them in (`-f3,1` prints field 1 then 3).
      function expandSpec(spec, max) {
        const idxs = new Set();
        for (const part of spec.split(',')) {
          if (part.includes('-')) {
            const [a, b] = part.split('-');
            const start = a ? parseInt(a, 10) : 1;
            const end = b ? parseInt(b, 10) : max;
            for (let i = start; i <= end; i++) idxs.add(i);
          } else idxs.add(parseInt(part, 10));
        }
        return [...idxs].filter((n) => !isNaN(n)).sort((x, y) => x - y);
      }
      const out = lines.map((line) => {
        if (fieldSpec) {
          // A line without the delimiter is passed through whole (unless -s).
          if (line.indexOf(delim) === -1) return flags.has('s') ? null : line;
          const parts = line.split(delim);
          const idxs = expandSpec(fieldSpec, parts.length).filter((i) => i <= parts.length);
          return idxs.map((i) => parts[i - 1]).join(delim);
        }
        if (charSpec) { const idxs = expandSpec(charSpec, line.length); return idxs.map((i) => line[i - 1] ?? '').join(''); }
        return line;
      }).filter((l) => l !== null);
      return { stdout: out.join('\n') + (out.length ? '\n' : '') };
    };

    builtins.tr = (args, stdin) => {
      const { flags, rest } = parseFlags(args);
      // The shell passes `\n` through as two characters, so tr must decode the
      // escapes itself — otherwise `tr ' ' '\n'` inserts backslashes.
      function decodeEscapes(s) {
        return s.replace(/\\(n|t|r|f|v|0|\\)/g, (m, c) =>
          ({ n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', 0: '\0', '\\': '\\' }[c]));
      }
      function expandSet(s) {
        s = decodeEscapes(s);
        // POSIX classes are common in the taught form `tr -d '[:punct:]'`.
        s = s.replace(/\[:([a-z]+):\]/g, (m, name) => {
          const table = {
            alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', space: ' \t\r\n\f\v',
            upper: 'A-Z', lower: 'a-z', punct: '!-/:-@[-`{-~', blank: ' \t',
          };
          return table[name] !== undefined ? table[name] : m;
        });
        return s.replace(/(.)-(.)/g, (m, a, b) => {
          let out = '';
          for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) out += String.fromCharCode(c);
          return out;
        });
      }
      const set1 = expandSet(rest[0] || '');
      const set2 = expandSet(rest[1] || '');
      let text = stdin || '';
      if (flags.has('d')) { const re = new RegExp('[' + set1.replace(/[\\\]^]/g, '\\$&') + ']', 'g'); text = text.replace(re, ''); }
      else if (flags.has('s') && !rest[1]) { const re = new RegExp('([' + set1.replace(/[\\\]^]/g, '\\$&') + '])\\1+', 'g'); text = text.replace(re, '$1'); }
      else {
        let out = '';
        for (const ch of text) { const idx = set1.indexOf(ch); out += idx !== -1 && set2.length ? set2[Math.min(idx, set2.length - 1)] : ch; }
        text = out;
        if (flags.has('s')) { const re = new RegExp('([' + set2.replace(/[\\\]^]/g, '\\$&') + '])\\1+', 'g'); text = text.replace(re, '$1'); }
      }
      return { stdout: text };
    };

    builtins.nl = (args, stdin) => {
      const files = args.filter((a) => !a.startsWith('-'));
      const text = files.length ? files.map(readFileOrThrow).join('') : (stdin || '');
      const lines = text.replace(/\n$/, '').split('\n');
      return { stdout: lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n') + '\n' };
    };
    builtins.tac = (args, stdin) => {
      const text = args.length ? args.map(readFileOrThrow).join('') : (stdin || '');
      const hadTrail = text.endsWith('\n');
      const lines = text.split('\n'); if (hadTrail) lines.pop();
      return { stdout: lines.reverse().join('\n') + (lines.length ? '\n' : '') };
    };
    builtins.shuf = (args, stdin) => {
      let n = null; const nIdx = args.indexOf('-n');
      if (nIdx !== -1) n = parseInt(args[nIdx + 1], 10);
      const files = args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '-n');
      const text = files.length ? files.map(readFileOrThrow).join('') : (stdin || '');
      const lines = text.replace(/\n$/, '').split('\n');
      for (let i = lines.length - 1; i > 0; i--) { const j = Math.floor(pseudoRand(state) * (i + 1)); [lines[i], lines[j]] = [lines[j], lines[i]]; }
      const sel = n !== null ? lines.slice(0, n) : lines;
      return { stdout: sel.join('\n') + (sel.length ? '\n' : '') };
    };
    let randSeed = 42;
    function pseudoRand() { randSeed = (randSeed * 1103515245 + 12345) & 0x7fffffff; return randSeed / 0x7fffffff; }

    builtins.seq = (args) => {
      const nums = args.map(Number);
      let start = 1, step = 1, end;
      if (nums.length === 1) end = nums[0];
      else if (nums.length === 2) { [start, end] = nums; }
      else { [start, step, end] = nums; }
      const out = [];
      if (step > 0) for (let v = start; v <= end; v += step) out.push(v);
      else if (step < 0) for (let v = start; v >= end; v += step) out.push(v);
      return { stdout: out.join('\n') + (out.length ? '\n' : '') };
    };
    builtins.yes = (args) => ({ stdout: (args.join(' ') || 'y').repeat(1) + '\n(sandbox note: yes normally repeats forever — truncated to one line here)\n' });
    builtins.column = (args, stdin) => {
      const { flags } = parseFlags(args);
      let sep = /\s+/;
      const sIdx = args.indexOf('-s'); if (sIdx !== -1) sep = args[sIdx + 1];
      const lines = (stdin || '').replace(/\n$/, '').split('\n').map((l) => l.split(sep));
      const widths = [];
      for (const row of lines) row.forEach((cell, i) => { widths[i] = Math.max(widths[i] || 0, cell.length); });
      const out = lines.map((row) => row.map((cell, i) => i === row.length - 1 ? cell : cell.padEnd(widths[i] + 2)).join(''));
      return { stdout: out.join('\n') + '\n' };
    };
    builtins.base64 = (args, stdin) => {
      const text = args.length ? args.map(readFileOrThrow).join('') : (stdin || '');
      const b64 = (typeof Buffer !== 'undefined') ? Buffer.from(text, 'utf8').toString('base64') : btoa(unescape(encodeURIComponent(text)));
      return { stdout: b64 + '\n' };
    };

    // ---------------- sed / awk ----------------
    builtins.sed = (args, stdin) => {
      let extended = false, suppress = false, inPlace = false, bakSuffix = '';
      const rest = [];
      const scripts = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-E' || a === '-r') extended = true;
        else if (a === '-n') suppress = true;
        else if (a === '-e') { scripts.push(args[++i]); }
        else if (a.startsWith('-e') && a.length > 2) { scripts.push(a.slice(2)); }
        else if (a.startsWith('-i')) { inPlace = true; bakSuffix = a.slice(2); }
        else rest.push(a);
      }
      const script = scripts.length ? scripts.join(';') : rest.shift();
      const files = rest;
      const runOne = (text) => SedMini.run(script, text, { extended, suppress });
      if (!files.length) return { stdout: runOne(stdin || '') };
      let out = '';
      for (const f of files) {
        const text = readFileOrThrow(f);
        const result = runOne(text);
        if (inPlace) {
          const { node } = resolveOrThrow(f);
          // `sed -i.bak` keeps the original alongside — the safety net the
          // chapter recommends before editing anything in place.
          if (bakSuffix) {
            const pn = fs.getParentAndName(abs(f + bakSuffix));
            if (pn.parent) pn.parent.children.set(pn.name, mkNode('file', { content: text, mode: node.mode, owner: node.owner, group: node.group, mtime: node.mtime }));
          }
          node.content = result; node.mtime = now();
        } else out += result;
      }
      return { stdout: inPlace ? '' : out };
    };

    builtins.awk = (args, stdin) => {
      let FS = /\s+/;
      let program = null; const files = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-F') { FS = args[++i]; }
        else if (a.startsWith('-F') && a.length > 2) { FS = a.slice(2); }
        else if (program === null) program = a;
        else files.push(a);
      }
      if (program === null) err('awk: no program given');
      const text = files.length ? files.map(readFileOrThrow).join('') : (stdin || '');
      try { return { stdout: AwkMini.run(program, text, { FS }) }; }
      catch (e) { err(`awk: ${e.message}`); }
    };

    // ---------------- permissions ----------------
    function applyChmod(node, spec) {
      if (/^[0-7]{3,4}$/.test(spec)) { node.mode = parseInt(spec.slice(-3), 8); return; }
      for (const clause of spec.split(',')) {
        const m = clause.match(/^([ugoa]*)([+\-=])([rwxX]*)$/);
        if (!m) err(`chmod: invalid mode: '${spec}'`);
        let [, who, op, perms] = m;
        if (!who) who = 'a';
        const bitsFor = (p) => (p.includes('r') ? 4 : 0) | (p.includes('w') ? 2 : 0) | (p.includes('x') ? 1 : 0);
        // 'X' sets execute only on directories (or where it's already set) —
        // the safe way to do `chmod -R a+rX`.
        let effective = perms;
        if (perms.includes('X')) {
          const alreadyExec = node.type === 'dir' || (node.mode & 0o111) !== 0;
          effective = perms.replace(/X/g, alreadyExec ? 'x' : '');
        }
        const val = bitsFor(effective);
        const whoSet = who === 'a' ? ['u', 'g', 'o'] : who.split('');
        for (const w of whoSet) {
          const shift = w === 'u' ? 6 : w === 'g' ? 3 : 0;
          if (op === '+') node.mode |= (val << shift);
          else if (op === '-') node.mode &= ~(val << shift);
          else { node.mode &= ~(7 << shift); node.mode |= (val << shift); }
        }
      }
    }
    builtins.chmod = (args) => {
      // A mode can start with '-' (`chmod -x f` removes execute), so options
      // can't simply be "anything starting with a dash" — only the real option
      // letters are treated as flags.
      let recursive = false;
      const rest = [];
      for (const a of args) {
        if (a === '-R' || a === '--recursive') { recursive = true; continue; }
        if (/^--/.test(a) || (rest.length === 0 && /^-[Rvcf]+$/.test(a))) continue;
        rest.push(a);
      }
      const spec = rest[0]; const paths = rest.slice(1);
      if (!spec || !paths.length) err('chmod: missing operand');
      for (const p of paths) {
        const { node } = resolveOrThrow(p);
        if (recursive && node.type === 'dir') { const list = []; walkAll(node, p, list); for (const item of list) applyChmod(item.node, spec); }
        else applyChmod(node, spec);
      }
      return {};
    };
    builtins.chown = (args) => {
      const recursive = args.includes('-R');
      const rest = args.filter((a) => a !== '-R');
      const [spec, ...paths] = rest;
      const [owner, group] = spec.split(':');
      for (const p of paths) {
        const { node } = resolveOrThrow(p);
        const apply = (n) => { if (owner) n.owner = owner; if (group) n.group = group; };
        if (recursive && node.type === 'dir') { const list = []; walkAll(node, p, list); for (const item of list) apply(item.node); }
        else apply(node);
      }
      return {};
    };
    builtins.chgrp = (args) => builtins.chown([':' + args[0], ...args.slice(1)]);

    builtins.umask = (args) => {
      const symbolic = args.includes('-S');
      const rest = args.filter((a) => !a.startsWith('-'));
      const symOf = () => {
        const allow = 0o777 & ~state.umask;
        const part = (sh) => {
          const v = (allow >> sh) & 7;
          return (v & 4 ? 'r' : '') + (v & 2 ? 'w' : '') + (v & 1 ? 'x' : '');
        };
        return `u=${part(6)},g=${part(3)},o=${part(0)}`;
      };
      if (!rest.length) {
        return { stdout: (symbolic ? symOf() : '0' + state.umask.toString(8).padStart(3, '0')) + '\n' };
      }
      // Reject garbage rather than storing NaN, which silently corrupted every
      // later file creation in the session.
      if (!/^[0-7]{1,4}$/.test(rest[0])) return { stderr: `bash: umask: ${rest[0]}: invalid mode\n`, code: 1 };
      state.umask = parseInt(rest[0], 8);
      return {};
    };
    builtins.whoami = () => ({ stdout: user.name + '\n' });
    builtins.id = () => ({ stdout: `uid=1000(${user.name}) gid=1000(${user.primaryGroup}) groups=${user.groups.map((g, i) => `${1000 + i}(${g})`).join(',')}\n` });
    builtins.groups = () => ({ stdout: user.groups.join(' ') + '\n' });
    builtins.uname = (args) => ({ stdout: args.includes('-a') ? 'Linux web-01 6.8.0-generic #1 SMP x86_64 GNU/Linux\n' : 'Linux\n' });

    builtins.sudo = (args, stdin, c) => {
      user.sudo = true;
      try { return runBuiltin(args[0], args.slice(1), stdin, c); }
      finally { user.sudo = false; }
    };
    builtins.su = () => ({ stdout: '(sandbox note: there\'s only one user here — "dave" — so su has nothing to switch to. Try sudo instead.)\n' });

    // ---------------- processes / jobs ----------------
    function jobLine(j, verbose) {
      const status = j.status === 'Running' ? 'Running' : j.status === 'Stopped' ? 'Stopped' : 'Done';
      return `[${j.id}]${j.id === state.jobs.length ? '+' : '-'}  ${status.padEnd(10)} ${j.cmd} ${j.status === 'Running' ? '&' : ''}`.trim();
    }
    builtins.jobs = () => {
      const lines = state.jobs.filter((j) => j.status !== 'Killed').map((j) => jobLine(j));
      return { stdout: lines.join('\n') + (lines.length ? '\n' : '') };
    };
    function findJob(spec) {
      if (!spec) return state.jobs[state.jobs.length - 1];
      const m = String(spec).match(/^%?(\d+)$/);
      if (m) return state.jobs.find((j) => j.id === parseInt(m[1], 10));
      return state.jobs.find((j) => j.pid === parseInt(spec, 10));
    }
    builtins.fg = (args) => {
      const j = findJob(args[0]);
      if (!j) return { stderr: 'bash: fg: no such job\n', code: 1 };
      j.status = 'Running';
      return { stdout: j.cmd + '\n' };
    };
    builtins.bg = (args) => {
      const j = findJob(args[0]);
      if (!j) return { stderr: 'bash: bg: no such job\n', code: 1 };
      j.status = 'Running';
      return { stdout: `[${j.id}]+ ${j.cmd} &\n` };
    };
    builtins.wait = () => ({});
    builtins.kill = (args) => {
      // shift() already removes the signal — the old code then ALSO sliced,
      // silently dropping the first PID.
      const targets = args.slice();
      if (targets.length && targets[0].startsWith('-')) targets.shift();
      let errOut = '';
      for (const a of targets) {
        const j = a.startsWith('%') ? findJob(a) : state.jobs.find((jj) => jj.pid === parseInt(a, 10));
        if (j) { j.status = 'Killed'; if (j.timerReal) clearTimeout(j.timerReal); continue; }
        if (!a.startsWith('%') && state.procs.some((p) => p.pid === parseInt(a, 10))) continue;
        errOut += `bash: kill: (${a}) - No such process\n`;
      }
      return { stderr: errOut, code: errOut ? 1 : 0 };
    };
    builtins.pkill = (args) => {
      const { flags, rest } = parseFlags(args);
      const pattern = rest[0];
      let n = 0;
      for (const j of state.jobs) if (j.status === 'Running' && j.cmd.includes(pattern)) { j.status = 'Killed'; n++; }
      for (const p of state.procs) if (p.cmd.includes(pattern)) n++;
      return {};
    };
    builtins.pgrep = (args) => {
      const { flags, rest } = parseFlags(args);
      const pattern = rest[0];
      const matches = [
        ...state.procs.filter((p) => p.cmd.includes(pattern)).map((p) => ({ pid: p.pid, cmd: p.cmd })),
        ...state.jobs.filter((j) => j.status === 'Running' && j.cmd.includes(pattern)).map((j) => ({ pid: j.pid, cmd: j.cmd })),
      ];
      if (flags.has('a')) return { stdout: matches.map((m) => `${m.pid} ${m.cmd}`).join('\n') + (matches.length ? '\n' : '') };
      return { stdout: matches.map((m) => m.pid).join('\n') + (matches.length ? '\n' : '') };
    };
    builtins.killall = (args) => builtins.pkill(args);

    builtins.ps = (args) => {
      const wantAll = args.includes('aux') || args.includes('-ef') || args.includes('aux'.split('').join(''));
      const rows = [...state.procs.map((p) => ({ user: p.user, pid: p.pid, cpu: p.cpu, mem: p.mem, cmd: p.cmd })),
        ...state.jobs.filter((j) => j.status === 'Running').map((j) => ({ user: user.name, pid: j.pid, cpu: 0.5, mem: 0.2, cmd: j.cmd }))];
      let out = 'USER       PID %CPU %MEM COMMAND\n';
      for (const r of rows) out += `${r.user.padEnd(10)} ${String(r.pid).padStart(5)} ${r.cpu.toFixed(1).padStart(4)} ${r.mem.toFixed(1).padStart(4)} ${r.cmd}\n`;
      return { stdout: out };
    };
    builtins.top = builtins.htop = () => {
      const rows = [...state.procs].sort((a, b) => b.cpu - a.cpu).slice(0, 8);
      let out = `top - ${dateFormat(now(), '%T')} up 4 days,  load average: 0.42, 0.38, 0.31\n`;
      out += `Tasks: ${state.procs.length + state.jobs.filter((j) => j.status === 'Running').length} total\n\n`;
      out += 'PID     USER      %CPU  %MEM  COMMAND\n';
      for (const r of rows) out += `${String(r.pid).padEnd(8)}${r.user.padEnd(10)}${r.cpu.toFixed(1).padStart(5)} ${r.mem.toFixed(1).padStart(5)}  ${r.cmd}\n`;
      out += '(sandbox note: a static snapshot — real top refreshes continuously)\n';
      return { stdout: out };
    };
    builtins.nohup = (args, stdin, c) => {
      if (!args.length) return { stderr: 'nohup: missing command\n', code: 1 };
      const r = runBuiltin(args[0], args.slice(1), stdin, c);
      return { stdout: 'nohup: ignoring input and appending output to \'nohup.out\'\n' + r.stdout, stderr: r.stderr, code: r.code };
    };
    builtins.watch = (args) => {
      const cmdStr = args.filter((a) => !a.startsWith('-')).join(' ');
      return { stdout: `Every 2.0s: ${cmdStr}\n\n(sandbox note: watch normally reruns the command forever — showing one pass)\n\n` + runCapture(cmdStr, {}) };
    };
    builtins.sleep = (args) => ({});
    builtins.uptime = () => ({ stdout: ` ${dateFormat(now(), '%T')} up 4 days,  2:14,  1 user,  load average: 0.42, 0.38, 0.31\n` });
    builtins.free = (args) => ({ stdout: '              total        used        free      shared  buff/cache   available\nMem:        8123456     3456789      987654       12345     3678901     4321098\nSwap:       2097152           0     2097152\n' });
    builtins.df = () => ({ stdout: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        40G   18G   20G  48% /\ntmpfs           2.0G     0  2.0G   0% /tmp\n' });
    builtins.du = (args) => {
      const { flags, rest } = parseFlags(args, 'd');
      const targets = rest.length ? rest : ['.'];
      // Real du reports disk usage in 1K blocks, and every object occupies at
      // least one block — a 3-byte file still costs 4K.
      function bytesOf(n) {
        // A zero-byte file occupies no blocks at all.
        if (n.type !== 'dir') return Math.ceil(nodeSize(n) / 4096) * 4096;
        let s = 4096;
        for (const c of n.children.values()) s += bytesOf(c);
        return s;
      }
      const fmt = (bytes) => (flags.has('h') ? humanSize(bytes) : String(Math.ceil(bytes / 1024)));
      let out = '';
      for (const target of targets) {
        const clean = target.length > 1 ? target.replace(/\/$/, '') : target;
        const { node } = resolveOrThrow(clean);
        if (flags.has('s')) { out += `${fmt(bytesOf(node))}\t${target}\n`; continue; }
        // Depth-first, children before their parent, like real du.
        const emit = (n, path) => {
          if (n.type === 'dir') {
            for (const [name, child] of [...n.children.entries()].sort()) {
              emit(child, path + '/' + name);
            }
          } else if (!flags.has('a')) return; // files only shown with -a
          out += `${fmt(bytesOf(n))}\t${path}\n`;
        };
        emit(node, clean);
      }
      return { stdout: out };
    };
    builtins.lsof = (args) => {
      const portArg = args.find((a) => a.startsWith(':'));
      if (portArg) {
        const port = portArg.slice(1);
        const table = { '22': 'sshd', '80': 'nginx', '443': 'nginx', '5432': 'postgres', '8080': 'node' };
        const proc = table[port];
        if (!proc) return { stdout: '' };
        return { stdout: `COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n${proc.padEnd(9)} ${String(1200 + Number(port) % 100).padStart(4)} ${user.name.padEnd(6)}   3u  IPv4  1234      0t0  TCP *:${port} (LISTEN)\n` };
      }
      return { stdout: '' };
    };
    builtins.ss = (args) => ({ stdout: 'Netid  State   Local Address:Port   Peer Address:Port  Process\ntcp    LISTEN  0.0.0.0:22            0.0.0.0:*          sshd\ntcp    LISTEN  0.0.0.0:80            0.0.0.0:*          nginx\ntcp    LISTEN  127.0.0.1:5432        0.0.0.0:*          postgres\n' });

    // ---------------- environment / quoting ----------------
    builtins.export = (args, stdin, c) => {
      if (!args.length) { return { stdout: [...state.exported].sort().map((k) => `declare -x ${k}="${state.vars[k] || ''}"`).join('\n') + '\n' }; }
      for (const a of args) {
        const eq = a.indexOf('=');
        if (eq === -1) { state.exported.add(a); continue; }
        const name = a.slice(0, eq), value = a.slice(eq + 1);
        if (c && c.locals && Object.prototype.hasOwnProperty.call(c.locals, name)) c.locals[name] = value;
        else state.vars[name] = value;
        state.exported.add(name);
      }
      return {};
    };
    builtins.unset = (args) => { for (const a of args) { delete state.vars[a]; state.exported.delete(a); } return {}; };
    builtins.env = builtins.printenv = (args) => {
      if (args.length && !args[0].startsWith('-')) return { stdout: (state.vars[args[0]] || '') + '\n' };
      return { stdout: [...state.exported].sort().map((k) => `${k}=${state.vars[k] || ''}`).join('\n') + '\n' };
    };
    builtins.alias = (args) => {
      if (!args.length) return { stdout: Object.entries(state.aliases).map(([k, v]) => `alias ${k}='${v}'`).join('\n') + '\n' };
      const out = [];
      for (const a of args) {
        const eq = a.indexOf('=');
        if (eq === -1) { out.push(state.aliases[a] ? `alias ${a}='${state.aliases[a]}'` : `bash: alias: ${a}: not found`); continue; }
        let value = a.slice(eq + 1);
        if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
        state.aliases[a.slice(0, eq)] = value;
      }
      return { stdout: out.length ? out.join('\n') + '\n' : '' };
    };
    builtins.unalias = (args) => { for (const a of args) delete state.aliases[a]; return {}; };

    builtins.history = (args, stdin, c) => {
      let n = state.history.length;
      if (args[0] && /^\d+$/.test(args[0])) n = parseInt(args[0], 10);
      const items = state.history.slice(-n);
      const startIdx = state.history.length - items.length + 1;
      return { stdout: items.map((h, i) => `${String(startIdx + i).padStart(5)}  ${h}`).join('\n') + (items.length ? '\n' : '') };
    };
    builtins.clear = () => ({ stdout: '\x1bCLEAR\x1b' }); // special marker the UI intercepts

    builtins.date = (args) => {
      let fmt = null;
      const plusArg = args.find((a) => a.startsWith('+'));
      if (plusArg) fmt = plusArg.slice(1);
      return { stdout: dateFormat(now(), fmt) + '\n' };
    };

    builtins.read = (args, stdin, c) => {
      const names = args.filter((a) => !a.startsWith('-'));
      const name = names.length ? names[names.length - 1] : 'REPLY';
      let value;
      // Inside `while read ...; done < file` the loop owns a positioned stream,
      // so each call consumes the next line. Returning code 1 at EOF is what
      // ends the loop.
      if (c && c.stdinStream) {
        const line = c.stdinStream.readLine();
        if (line === null) return { code: 1 };
        value = line;
      } else {
        value = (stdin || '').split('\n')[0] || '';
        if (!value) return { code: 1 };
      }
      // `IFS= read -r line` (the safe idiom) keeps leading/trailing whitespace;
      // without an empty IFS, bash trims it.
      const ifs = Object.prototype.hasOwnProperty.call(state.vars, 'IFS') ? state.vars.IFS : ' \t\n';
      if (ifs !== '') value = value.replace(/^[ \t]+|[ \t]+$/g, '');
      if (c && c.locals && Object.prototype.hasOwnProperty.call(c.locals, name)) c.locals[name] = value; else state.vars[name] = value;
      return { code: 0 };
    };

    builtins.basename = (args) => { let p = args[0] || ''; let b = p.split('/').filter(Boolean).pop() || '/'; if (args[1] && b.endsWith(args[1])) b = b.slice(0, -args[1].length); return { stdout: b + '\n' }; };
    builtins.dirname = (args) => { const parts = (args[0] || '').split('/').filter(Boolean); parts.pop(); return { stdout: ('/' + parts.join('/')).replace(/^$/, (args[0] || '').startsWith('/') ? '/' : '.') + '\n' }; };
    builtins.realpath = builtins.readlink = (args) => {
      const flags2 = args.filter((a) => a.startsWith('-'));
      const p = args.find((a) => !a.startsWith('-'));
      const segs = abs(p);
      const res = fs.resolve(segs, user, false);
      if (res.node && res.node.type === 'link' && !flags2.includes('-f')) return { stdout: res.node.target + '\n' };
      return { stdout: prettyPath(segs) + '\n' };
    };

    builtins.man = (args) => {
      const topic = args[0];
      const pages = {
        ls: 'LS(1)\n\nNAME\n  ls - list directory contents\n\nSYNOPSIS\n  ls [OPTION]... [FILE]...\n\nCOMMON OPTIONS\n  -l  long listing   -a  show hidden   -h  human sizes   -t  sort by time   -r  reverse   -R  recursive\n',
        cd: 'CD(1) shell builtin\n\nNAME\n  cd - change the working directory\n\nSYNOPSIS\n  cd [DIRECTORY]\n\n  With no argument, changes to $HOME. "cd -" returns to the previous directory.\n',
        grep: 'GREP(1)\n\nNAME\n  grep - print lines that match a pattern\n\nSYNOPSIS\n  grep [OPTION]... PATTERN [FILE]...\n\nCOMMON OPTIONS\n  -i ignore case  -v invert  -n line numbers  -r recursive  -c count  -l files-with-matches  -E extended regex\n',
        chmod: 'CHMOD(1)\n\nNAME\n  chmod - change file mode bits\n\nSYNOPSIS\n  chmod MODE FILE...\n\n  MODE is either octal (755) or symbolic (u+x, go-w, a=rwx).\n',
        find: 'FIND(1)\n\nNAME\n  find - search for files in a directory hierarchy\n\nSYNOPSIS\n  find [PATH] [EXPRESSION]\n\nCOMMON TESTS\n  -name PATTERN  -type f|d|l  -mtime N  -size N  -maxdepth N  -delete  -exec CMD {} \\;\n',
        date: 'DATE(1)\n\nNAME\n  date - print or format the current time\n\nSYNOPSIS\n  date [+FORMAT]\n\nFORMAT SEQUENCES\n  %Y year  %m month  %d day  %H hour  %M minute  %S second  %F = %Y-%m-%d  %T = %H:%M:%S\n',
      };
      if (!topic) return { stderr: 'What manual page do you want?\n', code: 1 };
      if (pages[topic]) return { stdout: pages[topic] };
      if (state.commandsList && state.commandsList.includes(topic)) return { stdout: `${topic.toUpperCase()}(1)\n\nNAME\n  ${topic} - (this sandbox doesn't have a full page for this one — try ${topic} --help, or the book's chapter.)\n` };
      return { stderr: `No manual entry for ${topic}\n`, code: 1 };
    };
    builtins.apropos = (args) => ({ stdout: `${args[0]}: nothing appropriate\n(sandbox note: apropos search is not simulated — try 'help' for the command list)\n` });
    builtins.help = () => ({ stdout: 'Supported commands in this sandbox:\n' + (state.commandsList || []).join('  ') + '\n\nType any of them, or "man <command>" for a few short pages.\n' });

    // ---------------- archives / sync (functional, operating on the VFS) ----------------
    function serializeTree(node) {
      if (node.type === 'file') return { type: 'file', content: node.content, mode: node.mode };
      if (node.type === 'dir') { const children = {}; for (const [k, v] of node.children) children[k] = serializeTree(v); return { type: 'dir', mode: node.mode, children }; }
      return { type: 'link', target: node.target };
    }
    function materialize(tree) {
      if (tree.type === 'file') return mkNode('file', { content: tree.content, mode: tree.mode, owner: user.name, group: user.primaryGroup, mtime: now() });
      if (tree.type === 'link') return mkNode('link', { target: tree.target, owner: user.name, group: user.primaryGroup, mtime: now() });
      const d = mkNode('dir', { mode: tree.mode, owner: user.name, group: user.primaryGroup, mtime: now() });
      for (const k of Object.keys(tree.children)) d.children.set(k, materialize(tree.children[k]));
      return d;
    }
    builtins.tar = (args) => {
      // The archive is whatever follows the flag group containing `f`
      // (`-czf out.tgz src`, `-tzf out.tgz`, `tar czf ...`), NOT whatever
      // happens to end in .tar.gz — matching by extension made `tar -tzf` on
      // an oddly-named archive throw a raw TypeError.
      const flagsStr = args.find((a) => a.startsWith('-') && !a.startsWith('--')) ||
        (args[0] && !args[0].startsWith('-') && /^[cxtvzjf]+$/.test(args[0]) ? args[0] : '');
      let archivePath = null;
      const rest = [];
      const dashC = args.indexOf('-C');
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === flagsStr) {
          if (flagsStr.includes('f') && archivePath === null) archivePath = args[++i];
          continue;
        }
        if (a === '-f') { archivePath = args[++i]; continue; }
        if (a === '-C') { i++; continue; } // handled separately on extract
        if (a.startsWith('-')) continue;
        rest.push(a);
      }
      void dashC;
      const wantCreate = flagsStr.includes('c'), wantExtract = flagsStr.includes('x'), wantList = flagsStr.includes('t');
      if (wantCreate) {
        const sources = rest;
        const trees = {};
        for (const s of sources) { const { node } = resolveOrThrow(s.replace(/\/$/, '')); trees[s.replace(/\/$/, '')] = serializeTree(node); }
        const { parent, name } = fs.getParentAndName(abs(archivePath));
        parent.children.set(name, mkNode('file', { content: JSON.stringify(trees), mode: 0o644, owner: user.name, group: user.primaryGroup, mtime: now(), binaryLabel: 'gzip compressed data (tar archive, simulated)' }));
        return {};
      }
      if (!archivePath) err('tar: no archive name given (use -f FILE)');
      const { node: archiveNode } = resolveOrThrow(archivePath);
      let trees;
      try { trees = JSON.parse(archiveNode.content); } catch (e) { err(`tar: ${archivePath}: not a (simulated) tar archive`); }
      if (!trees || typeof trees !== 'object') err(`tar: ${archivePath}: not a (simulated) tar archive`);
      if (wantList) {
        const names = [];
        function listNames(tree, prefix) { names.push(prefix + (tree.type === 'dir' ? '/' : '')); if (tree.type === 'dir') for (const k of Object.keys(tree.children)) listNames(tree.children[k], prefix + '/' + k); }
        for (const key of Object.keys(trees)) listNames(trees[key], key);
        return { stdout: names.map((n) => n.replace(/^\//, '')).join('\n') + '\n' };
      }
      if (wantExtract) {
        const destFlagIdx = args.indexOf('-C');
        const destDir = destFlagIdx !== -1 ? args[destFlagIdx + 1] : '.';
        const destSegs = abs(destDir);
        const destNode = fs.mkdirp(destSegs, user);
        for (const key of Object.keys(trees)) { const name = key.split('/').pop(); destNode.children.set(name, materialize(trees[key])); }
        return {};
      }
      return { stderr: 'tar: specify one of -c, -x, -t\n', code: 1 };
    };
    builtins.gzip = (args) => {
      const p = args.find((a) => !a.startsWith('-'));
      if (!p) return {};
      const { segs, node } = resolveOrThrow(p);
      const pn = fs.getParentAndName(segs);
      pn.parent.children.delete(pn.name);
      pn.parent.children.set(pn.name + '.gz', mkNode('file', { content: node.content, mode: node.mode, owner: node.owner, group: node.group, mtime: now(), binaryLabel: 'gzip compressed data (simulated)' }));
      return {};
    };
    builtins.gunzip = (args) => {
      const p = args.find((a) => !a.startsWith('-'));
      if (!p || !p.endsWith('.gz')) return { stderr: 'gunzip: not a .gz file\n', code: 1 };
      const { segs, node } = resolveOrThrow(p);
      const pn = fs.getParentAndName(segs);
      pn.parent.children.delete(pn.name);
      pn.parent.children.set(pn.name.slice(0, -3), mkNode('file', { content: node.content, mode: node.mode, owner: node.owner, group: node.group, mtime: now() }));
      return {};
    };

    builtins.rsync = (args) => {
      const { flags, rest } = parseFlags(args);
      const dryRun = args.includes('--dry-run');
      const [src, dest] = rest;
      if (!src || !dest) err('rsync: missing source/dest');
      const { node: srcNode } = resolveOrThrow(src.replace(/\/$/, ''));
      // The classic rsync distinction: `src/` copies the CONTENTS into dest,
      // `src` (no slash) copies the directory itself into dest.
      const copyContents = src.endsWith('/');
      let destSegs = abs(dest.replace(/\/$/, ''));
      if (!copyContents && srcNode.type === 'dir') {
        destSegs = destSegs.concat(src.replace(/\/$/, '').split('/').filter(Boolean).pop());
      }
      const destNode = dryRun ? (fs.resolve(destSegs, user).node) : fs.mkdirp(destSegs, user);
      const changes = [];
      function diffCopy(sNode, dParent, path) {
        for (const [name, child] of sNode.children) {
          const existing = dParent && dParent.children ? dParent.children.get(name) : undefined;
          const same = existing && existing.type === child.type && (child.type !== 'file' || existing.content === child.content);
          if (!same) changes.push(path + name + (child.type === 'dir' ? '/' : ''));
          if (!dryRun) {
            if (child.type === 'dir') { let dc = existing && existing.type === 'dir' ? existing : mkNode('dir', { mode: child.mode, owner: user.name, group: user.primaryGroup, mtime: now() }); dParent.children.set(name, dc); diffCopy(child, dc, path + name + '/'); }
            else dParent.children.set(name, deepCopy(child, true));
          } else if (child.type === 'dir') diffCopy(child, existing, path + name + '/');
        }
      }
      diffCopy(srcNode, destNode, '');
      return { stdout: changes.join('\n') + (changes.length ? '\n' : '') + (dryRun ? `\n(dry run — nothing was copied; drop --dry-run to actually sync)\n` : `\nsent ${changes.length} files\n`) };
    };

    // ---------------- simulated network (clearly labeled) ----------------
    function simNote(text) { return `[simulated — no real network in this sandbox]\n${text}`; }
    builtins.ssh = (args) => {
      const host = args.find((a) => !a.startsWith('-'));
      const cmd = args.slice(args.indexOf(host) + 1).join(' ');
      if (cmd.includes('uptime')) return { stdout: simNote(` 09:41:02 up 62 days,  4:11,  1 user,  load average: 0.15, 0.22, 0.19\n`) };
      if (cmd.includes('df')) return { stdout: simNote(builtins.df().stdout) };
      return { stdout: simNote(`Connected to ${host}. (type a command like 'uptime' after the host to see simulated output)\n`) };
    };
    builtins['ssh-copy-id'] = (args) => ({ stdout: simNote(`Number of key(s) added: 1\n\nNow try logging into the machine with: "ssh '${args[0] || 'host'}'"\n`) });
    builtins.scp = () => ({ stdout: simNote('file transferred (simulated)\n') });
    builtins.curl = (args) => {
      const url = args.find((a) => !a.startsWith('-'));
      if (args.includes('-I')) return { stdout: simNote(`HTTP/1.1 200 OK\nContent-Type: text/html\nContent-Length: 1256\n`) };
      return { stdout: simNote(`{"status":"ok","url":"${url || ''}"}\n`) };
    };
    builtins.wget = (args) => ({ stdout: simNote(`Saving to: '${(args.find((a) => !a.startsWith('-')) || 'index.html').split('/').pop()}'\n100%[==================>] done\n`) });
    builtins.ping = (args) => {
      const host = args.find((a) => !a.startsWith('-')) || 'example.com';
      const count = 4;
      let out = simNote(`PING ${host}: 56 data bytes\n`);
      for (let i = 0; i < count; i++) out += `64 bytes from ${host}: icmp_seq=${i} ttl=54 time=${(12 + i * 1.3).toFixed(1)} ms\n`;
      out += `--- ${host} ping statistics ---\n${count} packets transmitted, ${count} received, 0% packet loss\n`;
      return { stdout: out };
    };
    builtins.dig = (args) => ({ stdout: simNote(`;; ANSWER SECTION:\n${(args.find((a) => !a.startsWith('-')) || 'example.com')}.\t300\tIN\tA\t93.184.216.34\n`) });
    builtins.traceroute = (args) => ({ stdout: simNote(`traceroute to ${args[0] || 'example.com'}, 30 hops max\n 1  gateway (10.0.0.1)  1.2 ms\n 2  93.184.216.34  14.8 ms\n`) });
    builtins.ip = () => ({ stdout: '2: eth0: <BROADCAST,MULTICAST,UP> mtu 1500\n    inet 10.0.0.14/24 brd 10.0.0.255 scope global eth0\n' });
    builtins.ifconfig = () => ({ stdout: 'eth0: flags=4163  mtu 1500\n        inet 10.0.0.14  netmask 255.255.255.0\n' });
    builtins.systemctl = (args) => ({ stdout: simNote(`● ${args[1] || 'myapp'}.service\n   Active: active (running)\n`) });
    builtins.journalctl = () => ({ stdout: simNote('-- Logs begin at Mon 2026-08-10. --\nAug 14 09:00:01 web-01 systemd[1]: Started myapp.\n') });
    builtins.crontab = (args) => {
      if (args.includes('-l')) return { stdout: (state.vars.__crontab || '(no crontab for this user)\n') };
      if (args.includes('-e')) return { stdout: '(sandbox note: there\'s no real editor here — try: crontab -l to see what a saved crontab looks like)\n' };
      return { stdout: '' };
    };

    // ---------------- misc/no-op shell state builtins ----------------
    builtins.set = (args) => { for (const a of args) if (a.startsWith('-')) { /* -euo pipefail: acknowledged, real effect only inside the script runner */ } return {}; };
    builtins.declare = (args, stdin, c) => builtins.export(args.filter((a) => a !== '-x'), stdin, c);
    builtins.local = (args, stdin, c) => {
      for (const a of args) { const eq = a.indexOf('='); const name = eq === -1 ? a : a.slice(0, eq); const value = eq === -1 ? '' : a.slice(eq + 1); if (c && c.locals) c.locals[name] = value; }
      return {};
    };
    builtins.true = () => ({ code: 0 });
    builtins.false = () => ({ code: 1 });
    builtins.test = builtins['['] = (args) => ({ code: evalTest(args) ? 0 : 1 });
    function evalTest(args) {
      if (args[args.length - 1] === ']' || args[args.length - 1] === ']]') args = args.slice(0, -1);
      // `!` negation and the -a/-o connectives, which `[ ... ]` supports too.
      if (args[0] === '!') return !evalTest(args.slice(1));
      const andIdx = args.indexOf('-a');
      if (andIdx > 0) return evalTest(args.slice(0, andIdx)) && evalTest(args.slice(andIdx + 1));
      const orIdx = args.indexOf('-o');
      if (orIdx > 0) return evalTest(args.slice(0, orIdx)) || evalTest(args.slice(orIdx + 1));
      if (args.length === 3) {
        const [a, op, b] = args;
        switch (op) {
          case '==': case '=': return a === b; case '!=': return a !== b;
          case '-eq': return Number(a) === Number(b); case '-ne': return Number(a) !== Number(b);
          case '-lt': return Number(a) < Number(b); case '-le': return Number(a) <= Number(b);
          case '-gt': return Number(a) > Number(b); case '-ge': return Number(a) >= Number(b);
          case '=~': try { return new RegExp(b).test(a); } catch (e) { return false; }
          // String ordering — this is the whole point of chapter 11's
          // `[[ "10" > "9" ]]` is false lesson, so it must compare as strings.
          case '>': return a > b;
          case '<': return a < b;
        }
      }
      if (args.length === 2) {
        const [op, a] = args;
        const res = fs.resolve(abs(a), user);
        switch (op) {
          case '-f': return !!res.node && res.node.type === 'file';
          case '-d': return !!res.node && res.node.type === 'dir';
          case '-e': return !!res.node;
          case '-s': return !!res.node && (res.node.content || '').length > 0;
          case '-z': return !a || a.length === 0;
          case '-n': return !!a && a.length > 0;
          case '-r': return !!res.node && hasPerm(res.node, user, 'r');
          case '-w': return !!res.node && hasPerm(res.node, user, 'w');
          case '-x': return !!res.node && hasPerm(res.node, user, 'x');
        }
      }
      if (args.length === 1) return !!args[0];
      return false;
    }
    // [[ ... ]] — bash's extended test. Our tokenizer treats "[[" and "]]" as
    // plain words (no special quoting rules), but for the teaching subset we
    // support here (-f/-d/-e/-z/-n, ==/!=/=~, -eq etc, && || ! chaining) the
    // simplified evaluation below matches real bash closely enough.
    builtins['[['] = (args) => {
      let a = args.slice();
      if (a[a.length - 1] === ']]') a = a.slice(0, -1);
      function evalSeq(tokens) {
        let result = null, pendingOp = null, i = 0;
        while (i < tokens.length) {
          let j = i;
          while (j < tokens.length && tokens[j] !== '&&' && tokens[j] !== '||') j++;
          let clause = tokens.slice(i, j);
          let neg = false;
          if (clause[0] === '!') { neg = true; clause = clause.slice(1); }
          let val = evalTest(clause);
          if (neg) val = !val;
          if (result === null) result = val;
          else if (pendingOp === '&&') result = result && val;
          else if (pendingOp === '||') result = result || val;
          pendingOp = tokens[j];
          i = j + 1;
        }
        return !!result;
      }
      return { code: evalSeq(a) ? 0 : 1 };
    };
    builtins.exit = () => ({ exitShell: true });
    builtins.source = builtins['.'] = (args, stdin, c) => {
      const text = readFileOrThrow(args[0]);
      let out = '', errOut = '';
      const sink = { write: (s) => out += s, writeErr: (s) => errOut += s };
      for (const line of text.split('\n')) if (line.trim() && !line.trim().startsWith('#')) execLine(line, sink, c);
      return { stdout: out, stderr: errOut };
    };
    builtins.bash = (args, stdin, c) => {
      const cIdx = args.indexOf('-c');
      if (cIdx === -1) {
        // `bash script.sh [args]` / `bash -x script.sh` — run the file.
        const file = args.find((a) => !a.startsWith('-'));
        if (file) {
          const text = readFileOrThrow(file);
          const rest = args.slice(args.indexOf(file) + 1);
          return state.runScriptText(text, file, rest, c);
        }
        return { stderr: 'bash: interactive sub-shells aren\'t supported in this sandbox — use bash -c \'...\' or bash script.sh\n', code: 2 };
      }
      const script = args[cIdx + 1] || '';
      const savedVars = state.vars, savedExported = state.exported;
      const isolatedVars = {};
      for (const k of state.exported) isolatedVars[k] = state.vars[k];
      state.vars = isolatedVars; state.exported = new Set(state.exported);
      let out = '', errOut = '';
      const sink = { write: (s) => out += s, writeErr: (s) => errOut += s };
      try { execLine(script, sink, {}); } finally { state.vars = savedVars; state.exported = savedExported; }
      return { stdout: out, stderr: errOut, code: state.lastExit };
    };
    builtins.sh = builtins.bash;

    return builtins;
  });
});
