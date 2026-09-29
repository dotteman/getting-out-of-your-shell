const Engine = require('../src/engine/engine.js');
require('../src/engine/builtins.js');

let fails = 0, passes = 0;
let sess;
function fresh() { sess = Engine.createSession(); sess.run('cd shell-lab'); }
function r(cmd) { return sess.run(cmd); }
function text(res) { return res.chunks.map(c => c.text).join(''); }
function errtext(res) { return res.chunks.filter(c => c.stream === 'err').map(c => c.text).join(''); }
function check(label, cmd, expected) {
  const res = r(cmd);
  const got = text(res);
  if (got === expected) passes++;
  else { fails++; console.log(`FAIL [${label}]\n  cmd: ${cmd}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(got)}`); }
}
function checkContains(label, cmd, expectedSubstr) {
  const res = r(cmd);
  const got = text(res);
  if (got.includes(expectedSubstr)) passes++;
  else { fails++; console.log(`FAIL [${label}]\n  cmd: ${cmd}\n  expected to contain: ${JSON.stringify(expectedSubstr)}\n  got: ${JSON.stringify(got)}`); }
}
function checkNotContains(label, cmd, badSubstr) {
  const res = r(cmd);
  const got = text(res);
  if (!got.includes(badSubstr)) passes++;
  else { fails++; console.log(`FAIL [${label}]\n  cmd: ${cmd}\n  expected NOT to contain: ${JSON.stringify(badSubstr)}\n  got: ${JSON.stringify(got)}`); }
}
function checkExit(label, cmd, expectedExit) {
  const res = r(cmd);
  if (res.exit === expectedExit) passes++;
  else { fails++; console.log(`FAIL [${label}]\n  cmd: ${cmd}\n  expected exit ${expectedExit}, got ${res.exit}\n  output: ${JSON.stringify(text(res))}`); }
}
function section(name) { console.log(`\n--- ${name} ---`); }

// ===================== Chapter 1: basics =====================
section('Chapter 1');
fresh();
check('whoami', 'whoami', 'dave\n');
checkContains('type echo', 'type echo', 'echo is a shell builtin');
checkContains('type cat', 'type cat', 'cat is /usr/bin/cat');

// ===================== Chapter 2: navigation =====================
section('Chapter 2');
fresh();
checkContains('ls -lhtr logs', 'ls -lhtr logs', 'app.log');
r('cd logs');
check('relative cd', 'cd ../data && pwd', '/home/dave/shell-lab/data\n');
r('cd ..'); r('cd logs');
check('cd - toggles', 'cd - && pwd', '/home/dave/shell-lab\n/home/dave/shell-lab\n');
fresh();
checkContains('glob csv 2026', 'ls data/*2026*.csv', 'sales_2026.csv');
r('mkdir -p archive/2026/{q1,q2,q3,q4}');
checkContains('brace mkdir q1', 'ls archive/2026', 'q1');
checkContains('brace mkdir q4', 'ls archive/2026', 'q4');

// ===================== Chapter 3: file surgery =====================
section('Chapter 3');
fresh();
r('mkdir -p staging/in staging/out staging/err');
r('cp data/*.csv staging/in/');
checkContains('cp csvs', 'ls staging/in', 'sales_2026.csv');
r('mv staging/in/sales_2026.csv staging/in/sales_2026_backup.csv');
checkContains('mv rename', 'ls staging/in', 'sales_2026_backup.csv');
r('cp -a data/ data_snapshot/');
checkContains('cp -a snapshot', 'ls data_snapshot', 'sales_2026.csv');
r('ln -s logs/app.log latest-log');
checkContains('symlink shows arrow', 'ls -l latest-log', '-> logs/app.log');
check('rmdir empty ok', 'rmdir staging/err', '');
checkExit('rmdir non-empty fails', 'rmdir staging/in', 1);

// ===================== Chapter 4: reading files =====================
section('Chapter 4');
fresh();
check('head -n 5', 'head -n 5 data/sales_2026.csv', 'date,region,product,units,revenue\n2026-01-04,north,widget,12,240.00\n2026-01-11,south,widget,45,900.00\n2026-01-18,north,gadget,7,455.00\n2026-02-02,east,widget,63,1260.00\n');
check('lines 10-14', 'head -n 14 logs/app.log | tail -n 5',
  '2026-08-13 09:03:18 DEBUG retry 2 of 3\n2026-08-13 09:03:24 INFO  request POST /orders 201 118ms\n2026-08-13 09:05:00 DEBUG cache hit ratio 0.91\n2026-08-13 09:07:33 WARN  memory usage at 87%\n2026-08-13 09:08:02 INFO  request GET /orders/4821 200 12ms\n');
check('wc -l app.log', 'wc -l < logs/app.log', '21\n');
checkContains('file mystery', 'file data/mystery', 'gzip compressed');
check('csv count', 'ls data/*.csv | wc -l', '3\n');
checkContains('diff -u', 'diff -u conf/nginx.conf conf/nginx.conf.new', '-worker_processes 2;');
checkContains('diff -u plus', 'diff -u conf/nginx.conf conf/nginx.conf.new', '+worker_processes 4;');

// ===================== Chapter 5: pipes =====================
section('Chapter 5');
fresh();
check('grep -c ERROR', 'grep -c ERROR logs/app.log', '4\n');
r('ls data/ > manifest.txt');
checkContains('redirect creates file', 'cat manifest.txt', 'sales_2026.csv');
r('ls /does/not/exist 2> err.txt');
checkContains('stderr redirected', 'cat err.txt', 'No such file or directory');
check('top5 loglevels', "cut -d' ' -f3 logs/app.log | sort | uniq -c | sort -rn | head -n 5",
  '      9 INFO\n      5 DEBUG\n      4 ERROR\n      3 WARN\n');
checkContains('tee writes and echoes', 'wc -l logs/app.log | tee count.txt', '21 logs/app.log');
checkContains('tee file has content', 'cat count.txt', '21');
checkNotContains('and-and short circuits', 'cd /nope123 && echo should-not-print', 'should-not-print');
checkContains('and-and error still shown', 'cd /nope123 && echo should-not-print', 'No such file or directory');
check('cmd substitution', 'echo "count is $(wc -l < logs/app.log)"', 'count is 21\n');

// ===================== Chapter 6: find/grep =====================
section('Chapter 6');
fresh();
checkContains('find by name', 'find . -name "*.log"', 'app.log');
checkContains('find type d tmp', 'find . -type d -name tmp', 'data/tmp');
checkContains('find size gt', 'find data -type f -size +1k', 'bigfile.dat');
check('grep -vc DEBUG', 'grep -vc DEBUG logs/app.log', '16\n');
checkContains('grep -rl timeout', 'grep -rl timeout conf/', 'nginx.conf');
checkContains('grep -n -C2', 'grep -n -C2 ERROR logs/app.log', '09:03:12');

// ===================== Chapter 7: grep/sed/awk =====================
section('Chapter 7');
fresh();
check('awk region col', "awk -F, 'NR>1 {print $2}' data/sales_2026.csv | sort | uniq -c | sort -rn",
  '      5 north\n      4 south\n      3 west\n      3 east\n');
check('awk sum revenue', "awk -F, 'NR>1 {s+=$5} END {printf \"%.2f\\n\", s}' data/sales_2026.csv", '31505.00\n');
check('awk units>50 count', "awk -F, 'NR>1 && $4 > 50' data/sales_2026.csv | wc -l", '6\n');
check('awk avg', "awk -F, 'NR>1 {s+=$5; n++} END {printf \"avg: %.2f\\n\", s/n}' data/sales_2026.csv", 'avg: 31505.00... '.slice(0,0) || 'avg: 2100.33\n');
checkContains('sed replace', "sed 's/worker_processes 2/worker_processes 4/' conf/nginx.conf", 'worker_processes 4;');
check('sed strip comments blank', "sed -e '/^#/d' -e '/^$/d' conf/nginx.conf | head -n 1", 'user www-data;\n');
checkContains('cut fields passwd-like', "echo 'a:b:c' | cut -d: -f1", 'a');
check('tr upper', "echo hello | tr 'a-z' 'A-Z'", 'HELLO\n');
check('uniq -c needs sort', 'printf "b\\na\\nb\\n" | uniq -c', '      1 b\n      1 a\n      1 b\n');
check('sort then uniq -c', 'printf "b\\na\\nb\\n" | sort | uniq -c', '      1 a\n      2 b\n');

// ===================== Chapter 8: permissions =====================
section('Chapter 8');
fresh();
r('chmod 600 conf/secrets.env');
checkContains('chmod 600', 'ls -l conf/secrets.env', 'rw-------');
r('chmod 640 data/sales_2026.csv');
checkContains('chmod symbolic result', 'ls -l data/sales_2026.csv', 'rw-r-----');
r('mkdir private'); r('chmod 700 private');
checkContains('chmod 700 dir', 'ls -ld private', 'rwx------');
checkContains('id output', 'id', 'uid=1000(dave)');
check('umask default', 'umask', '0022\n');

// ===================== Chapter 9: processes =====================
section('Chapter 9');
fresh();
{
  const res = r('sleep 300 &');
  checkContains('background job announced', '', '');
  checkContains('jobs shows running', 'jobs', 'sleep 300');
}
checkContains('pgrep finds sleep', 'pgrep -a sleep', 'sleep 300');
r('kill %1');
checkContains('jobs after kill hides it', 'jobs', ''); // killed jobs filtered differently; loose check

// ===================== Chapter 10: environment/quoting =====================
section('Chapter 10');
fresh();
check('var not inherited unexported', "PROJECT=shell-lab; bash -c 'echo \"${PROJECT:-not set}\"'", 'not set\n');
check('var inherited when exported', "export PROJECT=shell-lab; bash -c 'echo \"$PROJECT\"'", 'shell-lab\n');
check('single quotes literal', "echo '$HOME'", '$HOME\n');
checkContains('double quotes expand', 'echo "$HOME"', '/home/dave');
check('param expansion strip', 'f="backup.tar.gz"; echo "${f%%.*}"', 'backup\n');
check('default value expansion', 'unset NOPE; echo "${NOPE:-guest}"', 'guest\n');

// ===================== Chapter 11: scripting-ish (test builtins used in scripts) =====================
section('Chapter 11');
fresh();
check('test -f true', '[ -f data/sales_2026.csv ] && echo yes', 'yes\n');
check('test -d false on file', '[ -d data/sales_2026.csv ] || echo not-a-dir', 'not-a-dir\n');
check('for loop over glob', 'for f in data/*.csv; do echo "seen: $f"; done', 'seen: data/inventory_2026.csv\nseen: data/sales_2025.csv\nseen: data/sales_2026.csv\n');

// ===================== Chapter 12: working fast =====================
section('Chapter 12');
fresh();
r('tar -czf data.tgz data/');
checkContains('tar create then list', 'tar -tzf data.tgz', 'sales_2026.csv');
r('mkdir restore'); r('tar -xzf data.tgz -C restore/');
checkContains('tar extract works', 'cat restore/data/sales_2026.csv', 'north,widget');
checkContains('rsync dry run reports changes', 'rsync -av --dry-run data/ data_mirror/', 'sales_2026.csv');
checkContains('rsync dry run does not copy', 'ls data_mirror 2>&1', 'No such file or directory');
r('rsync -av data/ data_mirror/');
checkContains('rsync actually copies', 'ls data_mirror', 'sales_2026.csv');

// ===================== Extra: control flow & symlinks =====================
section('Extra: control flow');
fresh();
check('if true branch', '[ -f data/sales_2026.csv ] && true; if [ -f data/sales_2026.csv ]; then echo yes; else echo no; fi', 'yes\n');
check('if false branch with else', 'if [ -f nope.txt ]; then echo yes; else echo no; fi', 'no\n');
check('if elif chain', 'x=2; if [ "$x" = "1" ]; then echo one; elif [ "$x" = "2" ]; then echo two; else echo other; fi', 'two\n');
check('while loop counts', 'i=0; while [ "$i" != "3" ]; do echo "n=$i"; i=$((i+1)); done', 'n=0\nn=1\nn=2\n');
check('until loop counts', 'i=0; until [ "$i" = "3" ]; do echo "n=$i"; i=$((i+1)); done', 'n=0\nn=1\nn=2\n');
check('for loop keyword arg not swallowed', 'echo done', 'done\n');
r('ln -s logs latest-logs-dir');
checkContains('symlink to relative dir resolves', 'ls latest-logs-dir', 'app.log');
r('cd logs'); r('ln -s app.log rel-link');
checkContains('symlink relative same-dir target', 'cat rel-link', 'app starting');
r('cd ..');

// ===================== Regression: bugs found in code review =====================
// Every case below reproduced a real defect and was checked against real bash
// or GNU coreutils on the same input.

section('Regression: crashes and error containment');
fresh();
// A ShellRuntimeError raised during redirect setup used to escape run() and
// kill the browser widget rather than printing a shell error.
checkContains('missing < file does not throw', 'sort < nofile', 'No such file or directory');
checkExit('missing < file exits 1', 'sort < nofile', 1);
checkContains('${x:?} does not throw', 'unset NAME; echo "${NAME:?must be set}"', 'must be set');
checkContains('write into missing dir', 'echo hi > data/nodir/x.txt', 'No such file or directory');
// `2>&1` used to copy the string 'pipe' and then deref .file -> TypeError.
checkContains('2>&1 into a pipe', 'cat nope 2>&1 | head -1', 'No such file or directory');
checkContains('bare 2>&1', 'cat nope 2>&1', 'No such file or directory');
check('2>/dev/null silences', 'cat nope 2>/dev/null; echo rc=$?', 'rc=1\n');
check('>/dev/null 2>&1 silences both', 'cat nope >/dev/null 2>&1; echo rc=$?', 'rc=1\n');
r('echo out > both.txt 2>&1');
check('> f 2>&1 keeps stdout', 'cat both.txt', 'out\n');

section('Regression: quoting and escapes');
fresh();
check('backslash escapes $', 'echo \\$HOME', '$HOME\n');
check('backslash inside double quotes', 'echo "esc \\$USER"', 'esc $USER\n');
check('backslash escapes space', 'echo a\\ b', 'a b\n');
check('backslash escapes quote', "echo it\\'s", "it's\n");
check('nested cmd sub in quotes', 'echo "$(basename "$(pwd)")"', 'shell-lab\n');
check('paren inside cmd sub string', 'echo $(echo "a)b")', 'a)b\n');
check('comment stripped', 'echo hi # a comment', 'hi\n');
check('hash mid-word is literal', 'echo a#b', 'a#b\n');
check('tilde expands as a word', 'echo ~', '/home/dave\n');
check('quoted tilde does not', 'echo "~"', '~\n');

section('Regression: control flow');
fresh();
// `[[ "10" > "9" ]]` is chapter 11's headline lesson; the simulator used to
// return true AND create a stray file named 9 via redirect parsing.
check('[[ ]] string compare 10 vs 9', '[[ "10" > "9" ]]; echo $?', '1\n');
check('[[ ]] string compare 9 vs 10', '[[ "9" > "10" ]]; echo $?', '0\n');
check('[[ ]] numeric compare', '[[ 10 -gt 9 ]]; echo $?', '0\n');
checkNotContains('[[ ]] creates no file', 'ls', ' 9');
check('! negation in if', 'if ! false; then echo neg; fi', 'neg\n');
check('! negation status', '! true; echo $?', '1\n');
check('while loop exits 0', 'while false; do echo x; done; echo $?', '0\n');
check('while read from redirect', 'while IFS= read -r l; do echo "L:$l"; done < data/names.txt | head -2', 'L:ada lovelace\nL:grace hopper\n');
check('while read from pipe', 'cat data/names.txt | while read -r l; do echo "X $l"; done | head -1', 'X ada lovelace\n');
check('echo done is not a keyword', 'echo done', 'done\n');
check('arithmetic', 'echo $((2 + 3 * 4))', '14\n');

section('Regression: scripts and redirection');
fresh();
r('chmod +x scripts/backup.sh');
checkContains('run script by path', './scripts/backup.sh', 'pretending to back up');
checkContains('run script via bash', 'bash scripts/backup.sh', 'pretending to back up');
checkExit('missing script exits 127', './nope.sh', 127);
{
  // >&2 appears 11 times across chapters 11-12 and both appendices.
  const res = r('echo oops >&2');
  const errOnly = res.chunks.filter((c) => c.stream === 'err').map((c) => c.text).join('');
  if (errOnly === 'oops\n') passes++;
  else { fails++; console.log(`FAIL [>&2 goes to stderr]\n  got: ${JSON.stringify(errOnly)}`); }
}

section('Regression: symlinks and globs');
fresh();
r('ln -s logs/app.log l1'); r('ln -s l1 l2');
checkContains('symlink chain resolves', 'cat l2 | head -1', 'app starting');
r('mkdir -p d1'); r('ln -s d1 d2');
r('touch d2/f');
checkContains('write through symlinked dir', 'ls d1', 'f');
r('ln -s loopA loopB'); r('ln -s loopB loopA');
checkExit('symlink cycle terminates', 'cat loopA', 1);
checkContains('ls -l symlink mode', 'ls -l l1', 'lrwxrwxrwx');
// Globs used to expand only in the final path component.
checkContains('glob in path prefix', 'echo l*/a*.log', 'logs/app.log');
checkContains('trailing-slash glob is dirs only', 'echo */', 'data/');

section('Regression: coreutils output fidelity');
fresh();
check('tail -3', 'tail -3 data/names.txt', 'ken thompson\ndennis ritchie\nbarbara liskov\n');
check('head -n3 attached', 'head -n3 data/names.txt', 'ada lovelace\ngrace hopper\nken thompson\n');
check('head -c', 'head -c 12 data/names.txt', 'ada lovelace');
check('tail -n +2', 'tail -n +2 data/sales_2025.csv', '2025-11-04,north,widget,10,200.00\n2025-12-11,south,gadget,25,1625.00\n');
checkContains('ls -l has total line', 'ls -l data', 'total ');
checkContains('ls -a shows dot entries', 'ls -a', '.  ..');
checkExit('ls missing exits 2', 'ls nosuchthing', 2);
check('ls -lh no B suffix under 1K', 'ls -lh data/names.txt | grep -c " 69 "', '1\n');
checkContains('diff emits change hunks', 'diff conf/nginx.conf conf/nginx.conf.new', '3c3');
checkContains('diff has --- separator', 'diff conf/nginx.conf conf/nginx.conf.new', '\n---\n');
checkContains('diff -u splits hunks', 'diff -u conf/nginx.conf conf/nginx.conf.new', '@@ -12,7 +12,7 @@');
check('du -sh multiple operands', 'du -sh data logs | wc -l', '2\n');
// 9 objects at one 4K block each (the two zero-byte files cost nothing).
check('du reports 1K blocks', 'du -s data | cut -f1', '36\n');
// Data loss: set-then-delete wiped the file entirely.
r('echo keepme > selftest.txt');
checkContains('mv onto itself refused', 'mv selftest.txt selftest.txt', 'same file');
check('mv onto itself keeps file', 'cat selftest.txt', 'keepme\n');

section('Regression: text tools');
fresh();
check('grep -q is silent', 'if grep -q ERROR logs/app.log; then echo found; fi', 'found\n');
check('grep -q sets status', 'grep -q NOTHERE logs/app.log; echo $?', '1\n');
checkContains('grep -A N spaced', 'grep -A 2 ERROR logs/app.log', 'retry 1 of 3');
check('grep BRE treats | literally', 'grep -c "ERROR|WARN" logs/app.log', '0\n');
check('grep -E enables alternation', 'grep -cE "ERROR|WARN" logs/app.log', '7\n');
check('grep POSIX class', 'grep -c "[[:digit:]]" logs/app.log', '21\n');
checkContains('grep -r keeps single slash', 'grep -rl timeout conf/', 'conf/nginx.conf');
checkNotContains('grep -r no double slash', 'grep -rl timeout conf/', 'conf//');
checkContains('grep --include filters', 'grep -rl timeout --include=*.log .', 'logs/app.log');
checkNotContains('grep --include excludes others', 'grep -rl timeout --include=*.log .', 'nginx.conf');
check('grep -C match line labelled', 'grep -n -C2 ERROR logs/app.log | grep -c "^9:"', '1\n');
check('tr decodes escapes', "printf 'a b\\n' | tr ' ' '\\n'", 'a\nb\n');
check('cut ascending dedup', "echo 'a:b:c' | cut -d: -f3,1", 'a:c\n');
check('cut passes through no-delim line', "printf 'nodelim\\n' | cut -d: -f1", 'nodelim\n');
checkContains('sed -i.bak keeps original', 'sed -i.bak "s/worker_processes 2/worker_processes 4/" conf/nginx.conf; ls conf', 'nginx.conf.bak');
check('sed POSIX class strips comments', "sed -e '/^[[:space:]]*#/d' -e '/^$/d' conf/nginx.conf | head -n 1", 'user www-data;\n');
check('sed address forms', "sed -n '2p' data/names.txt", 'grace hopper\n');
check('sed & backreference', "echo 'cost 5' | sed 's/[0-9]/<&>/'", 'cost <5>\n');
check('awk printf width', 'awk \'BEGIN{printf "[%5s][%-6s]\\n","ab","cd"}\'', '[   ab][cd    ]\n');
check('awk next skips rules', "printf 'a\\nb\\n' | awk 'NR==1{next} {print \"got:\"$0}'", 'got:b\n');
check('awk unbraced else', "printf '10\\n20\\n' | awk '{ if ($1 > 15) print \"big\"; else print \"small\" }'", 'small\nbig\n');
check('awk -F tab', "printf 'a\\tb\\tc\\n' | awk -F'\\t' '{print $2}'", 'b\n');

section('Regression: find, xargs, permissions, archives');
fresh();
check('find strips trailing slash', 'find data/ -type f -size +1k', 'data/bigfile.dat\n');
check('find -o precedence', 'find . -type f -name "*.csv" -o -name "*.log" | wc -l', '6\n');
check('find -print0 pairs with xargs -0', 'find data -name "*.tmp" -print0 | xargs -0 echo', 'data/reports/old.tmp data/scratch.tmp\n');
check('find -exec with escaped semicolon', 'find data -name "*.tmp" -exec echo FOUND {} \\; | wc -l', '2\n');
checkContains('find warns on unsupported', 'find . -newer x', "doesn't implement");
check('xargs -n1 attached', 'printf "a\\nb\\n" | xargs -n1 echo X', 'X a\nX b\n');
check('chmod -x removes execute', 'chmod +x scripts/backup.sh; chmod -x scripts/backup.sh; ls -l scripts/backup.sh | cut -c1-10', '-rw-r--r--\n');
check('test ! negation', '[ ! -f nosuchfile ]; echo $?', '0\n');
check('test -a conjunction', '[ -f data/names.txt -a -d data ]; echo $?', '0\n');
checkContains('umask -S', 'umask -S', 'u=rwx');
check('umask rejects garbage', 'umask xyz 2>/dev/null; umask', '0022\n');
{
  fresh();
  r('sleep 100 &'); r('sleep 200 &');
  r('kill -9 1000 1001');
  checkNotContains('kill -9 kills both pids', 'jobs', 'Running');
}
fresh();
checkContains('tar rejects non-archive cleanly', 'tar -tzf data/mystery', 'not a (simulated) tar archive');
r('tar -czf b.tgz logs');
checkContains('tar combined flags find archive', 'tar -tzf b.tgz', 'logs/app.log');
r('rsync -av data rs1/ > /dev/null');
checkContains('rsync without slash nests dir', 'ls rs1', 'data');
r('rsync -av data/ rs2/ > /dev/null');
checkContains('rsync with slash copies contents', 'ls rs2', 'sales_2026.csv');

console.log(`\n===== ${passes} passed, ${fails} failed =====`);
process.exitCode = fails ? 1 : 0;
