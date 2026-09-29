// run-lines.mjs — the rules that decide which `$` examples get a ▶ Run button.
import { findBlocks } from '../book/tools/run-lines.mjs';
import { classifyBlock } from '../book/tools/classify.mjs';

let fails = 0;
const check = (label, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ' — ' + detail : ''}`); };
const run = (code, cls = '') => {
  const blocks = findBlocks(`<pre><code${cls}>${code}</code></pre>`);
  return blocks.length ? classifyBlock(blocks[0]) : [];
};

const a = run('$ ls -l | wc -l   # count\n7\n$ ls /nope\nls: cannot access');
check('a clean command is runnable, sample output is ignored', a.length === 2 && a[0].runnable && a[0].line === 0);
check('a command that errors gets no button', !a[1].runnable, a[1].why);
check('placeholder file names get no button', !run('$ grep ERROR app.log')[0].runnable);
check('unknown commands get no button', !run('$ tmux ls')[0].runnable);
check('errors carried on stdout by 2>&1 are caught', !run('$ nosuchcmd 2&gt;&amp;1 | tee out.txt')[0].runnable);
check('destructive examples are never offered', !run('$ rm -rf data')[0].runnable && !run('$ find . -name "*.log" -delete')[0].runnable);
check('the word "watch" in a comment does not exclude a line', run('$ ls   # watch the output')[0].runnable);
check('HTML entities are decoded', run('$ echo &quot;a &amp; b&quot; &gt; t.txt')[0].cmd === 'echo "a & b" > t.txt');
const cont = run('$ echo one \\\n    two \\\n    three\n$ pwd');
check('backslash continuations join into one command', cont.length === 2 && cont[0].span === 3 && cont[0].cmd.split(/\s+/).join(' ') === 'echo one two three' && cont[1].line === 3, JSON.stringify(cont));
check('plain (diagram) blocks are skipped', run('$ ls', ' class="plain"').length === 0);
check('blocks without a $ line are skipped', run('just output\nmore output').length === 0);
const seq = run('$ mkdir demo\n$ cd demo && touch a.txt\n$ ls');
check('lines in a block run in order in one session', seq.every((c) => c.runnable), JSON.stringify(seq.map((c) => c.why)));

console.log(`\n===== run-lines: ${fails} failed =====`);
process.exitCode = fails ? 1 : 0;
