// classify.mjs — decides which `$` example lines get a ▶ Run button.
//
// Each block's commands are run, in order, in a fresh simulator session that
// starts in ~/shell-lab (exactly where Chapter 1's terminal leaves the reader).
// A line is runnable when it produces no error output: examples written with
// placeholder names (file.txt, app.log), unsupported commands (tmux, jq) and
// history shortcuts (!!) are skipped, so a click never lands on an error.
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const Engine = require(path.join(ROOT, 'src/engine/engine.js'));
require(path.join(ROOT, 'src/engine/awk-mini.js'));
require(path.join(ROOT, 'src/engine/sed-mini.js'));
require(path.join(ROOT, 'src/engine/builtins.js'));

// Lines that run without error but should still not be offered as a button.
// Keep this list short and give a reason for every entry.
export const NEVER_RUN = [
  // Deletes lab files that later chapters and labs depend on (or, for the
  // unquoted-variable examples, is the book's own "never do this" demonstration).
  /\brm\s+-\w*[rf]/,
  /-delete\b/,
  /-exec\s+(rm|gzip)\b/,
  /\bxargs\b.*\brm\b/,
  /\bpkill\b|\bkillall\b/,
  // Placeholders that only "succeed" because the simulator is forgiving.
  /^command\s*>/,
  /\blong_(running_command|job)\b|\.\/job\.sh\b|\bmyapp\b/,
  /\buser@host\b|\bssh\s+prod\b|https:\/\/host\//,
  /\bconvert\b|\bping -c1 host\b|\b4821\b|\b8080\b/,
  // Interactive full-screen or editor programs have nothing useful to show in a
  // click-to-run block.
  /\bcrontab\s+-e\b/,
  /\bwatch\b/,
];

export function classifyBlock(block) {
  const session = Engine.createSession();
  session.run('cd shell-lab');
  return block.commands.map((c) => {
    let res;
    try { res = session.run(c.cmd); }
    catch (e) { return { ...c, runnable: false, why: 'internal error: ' + e.message }; }
    const err = res.chunks.filter((x) => x.stream === 'err').map((x) => x.text).join('').trim();
    if (err) return { ...c, runnable: false, why: err.split('\n')[0] };
    // `2>&1 | tee` and friends carry error text on stdout, so look there too.
    const all = res.chunks.map((x) => x.text).join('');
    const bad = all.match(/^.*(command not found|No such file or directory|internal error|isn't supported|not supported|doesn't implement|not simulated).*$/m);
    if (bad) return { ...c, runnable: false, why: bad[0].trim() };
    const bare = c.cmd.replace(/\s+#.*$/, ''); // the trailing comment is not part of the command
    if (NEVER_RUN.some((re) => re.test(bare))) return { ...c, runnable: false, why: 'excluded' };
    return { ...c, runnable: true };
  });
}
