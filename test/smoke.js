const Engine = require('../src/engine/engine.js');
require('../src/engine/builtins.js');

let sess = Engine.createSession();
let fails = 0, passes = 0;
function r(cmd) { return sess.run(cmd); }
function text(res) { return res.chunks.map(c => c.text).join(''); }
function check(label, cmd, expected) {
  const res = r(cmd);
  const got = text(res);
  if (got === expected) { passes++; }
  else { fails++; console.log(`FAIL [${label}]\n  cmd: ${cmd}\n  expected: ${JSON.stringify(expected)}\n  got:      ${JSON.stringify(got)}`); }
}
function checkContains(label, cmd, expectedSubstr) {
  const res = r(cmd);
  const got = text(res);
  if (got.includes(expectedSubstr)) { passes++; }
  else { fails++; console.log(`FAIL [${label}]\n  cmd: ${cmd}\n  expected to contain: ${JSON.stringify(expectedSubstr)}\n  got: ${JSON.stringify(got)}`); }
}

// ---- basics ----
check('pwd', 'pwd', '/home/dave\n');
r('cd shell-lab');
check('pwd after cd', 'pwd', '/home/dave/shell-lab\n');
checkContains('ls', 'ls', 'data');
check('cd back', 'cd ..', '');

console.log(`\n${passes} passed, ${fails} failed so far (basics)\n`);
process.exitCode = fails ? 1 : 0;
