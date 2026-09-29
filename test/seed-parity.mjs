// seed-parity.mjs — the in-browser sandbox must contain exactly what the real
// lab/setup.sh creates, or the book's answer key only holds in one of them.
//
// Runs lab/setup.sh with real bash into a temp directory, then compares every
// file it produced against the simulator's seeded filesystem.
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const Engine = require(path.join(ROOT, 'src/engine/engine.js'));
require(path.join(ROOT, 'src/engine/builtins.js'));

// data/mystery is a real gzip file on disk; the simulator stores its plain text
// and reports it as gzip via `file`, so its bytes legitimately differ.
const KNOWN_DIFFERENT = new Set(['data/mystery']);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-lab-'));
const lab = path.join(tmp, 'shell-lab');
// Pin the umask the book assumes (Chapter 8: 022), so file modes don't depend on the machine.
execFileSync('bash', ['-c', 'umask 022 && exec bash "$0" "$1"', path.join(ROOT, 'lab/setup.sh'), lab], { stdio: 'pipe' });

const session = Engine.createSession();
const vfs = session.fs;
const labSegs = ['home', 'dave', 'shell-lab'];

let fails = 0, checked = 0;
const fail = (msg) => { fails++; console.log('FAIL ' + msg); };

// Every file setup.sh creates must exist in the sandbox with identical content.
function walkReal(dir, rel) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    const st = fs.statSync(full);
    const node = vfs.resolve(labSegs.concat(r.split('/')), null).node;
    if (!node) { fail(`${r}: created by setup.sh but missing from the sandbox`); continue; }
    if (st.isDirectory()) {
      if (node.type !== 'dir') fail(`${r}: directory on disk, ${node.type} in the sandbox`);
      walkReal(full, r);
      continue;
    }
    checked++;
    if (KNOWN_DIFFERENT.has(r)) continue;
    const real = fs.readFileSync(full, 'utf8');
    if (node.content !== real) fail(`${r}: content differs (${Buffer.byteLength(real)} bytes on disk vs ${Buffer.byteLength(node.content || '')} in the sandbox)`);
    const realMode = (st.mode & 0o777).toString(8), simMode = (node.mode & 0o777).toString(8);
    if (realMode !== simMode) fail(`${r}: mode ${realMode} on disk vs ${simMode} in the sandbox`);
  }
}
walkReal(lab, '');

// And nothing extra in the sandbox that setup.sh doesn't create.
function walkSim(node, rel) {
  for (const [name, child] of node.children) {
    const r = rel ? `${rel}/${name}` : name;
    if (!fs.existsSync(path.join(lab, r))) fail(`${r}: in the sandbox but not created by setup.sh`);
    if (child.type === 'dir') walkSim(child, r);
  }
}
walkSim(vfs.resolve(labSegs, null).node, '');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n===== seed parity: ${checked} files compared, ${fails} problems =====`);
process.exitCode = fails ? 1 : 0;
