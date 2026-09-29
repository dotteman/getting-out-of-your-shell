// run-lines.mjs — finds the runnable `$` example lines in the chapter HTML.
//
// A "block" is one <pre><code>…</code></pre>. Inside it, a line starting with
// "$ " is a command; following lines that continue it (a trailing backslash) belong
// to the same command. Everything else is sample output. Blocks marked
// class="plain" are diagrams and never run.
export const decodeEntities = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const BLOCK_RE = /<pre><code( class="[^"]*")?>([\s\S]*?)<\/code><\/pre>/g;

// Returns [{ index, start, end, lines, commands: [{ line, span, cmd }] }] for every
// non-plain block that has at least one `$ ` line. `line` is the 0-based line the
// command starts on; `span` is how many lines it covers.
export function findBlocks(html) {
  const out = [];
  let m, index = 0;
  BLOCK_RE.lastIndex = 0;
  while ((m = BLOCK_RE.exec(html))) {
    const blockIndex = index++;
    if (m[1] && /\bplain\b/.test(m[1])) continue;
    const lines = decodeEntities(m[2]).split('\n');
    const commands = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('$ ')) continue;
      let cmd = lines[i].slice(2);
      let span = 1;
      while (/\\$/.test(cmd) && i + span < lines.length && !lines[i + span].startsWith('$ ')) {
        cmd = cmd.replace(/\\$/, '') + ' ' + lines[i + span].replace(/^\s+/, '');
        span++;
      }
      commands.push({ line: i, span, cmd });
      i += span - 1;
    }
    if (commands.length) out.push({ index: blockIndex, start: m.index, end: m.index + m[0].length, openTag: m[0].slice(0, m[0].indexOf('>', 11) + 1), lines, commands });
  }
  return out;
}
