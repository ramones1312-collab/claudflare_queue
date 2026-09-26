// R3-02 reproduction: the R3 gate (spec text summary + R3 deployerVerdict) vs the new anchored gate,
// on the auditor's variants D2 (0 tests), D3 (process.exit(0) mid-file), D7 (conditional test), each next to a good file.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
const [,, r3Root, newRoot] = process.argv;
const R3 = await import(path.join(r3Root, 'deployer/lib/release.mjs'));
const NEW = await import(path.join(newRoot, 'deployer/lib/release.mjs'));
const T = "import { test } from 'node:test';\n";
const good = T + "test('a', () => {});\ntest('b', () => {});\n";
const variants = {
  D2: ['// no tests at all\n', 1],
  D3: [T + "test('first', () => {});\ntest('second', async () => { process.exit(0); });\ntest('third', () => { throw new Error('never runs'); });\n", 3],
  D7: [T + "if (process.env.NEVER_SET) { test('real', () => { throw new Error('would fail'); }); }\n", 1],
};
for (const [id, [body, n]] of Object.entries(variants)) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
  fs.writeFileSync(path.join(d, 'good.test.mjs'), good); fs.writeFileSync(path.join(d, 'audit.test.mjs'), body);
  const files = ['good.test.mjs', 'audit.test.mjs'].map(f => path.join(d, f));
  // R3: exactly the R3 command and summary parsing
  const a = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { encoding: 'utf8' });
  const num = (k) => { const m = new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(a.stdout); return m ? Number(m[1]) : 0; };
  const v3 = R3.deployerVerdict({ tests: num('tests'), pass: num('pass'), fail: num('fail'), cancelled: num('cancelled') }, a.status);
  // new: structured reporter + per-file anchor
  const ev = path.join(d, 'ev.jsonl');
  const b = spawnSync(process.execPath, ['--test', `--test-reporter=${path.join(newRoot, 'deployer/lib/test-reporter.mjs')}`, `--test-reporter-destination=${ev}`, ...files], { encoding: 'utf8' });
  const events = fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const vn = NEW.deployerVerdict(events, b.status, { 'good.test.mjs': 2, 'audit.test.mjs': n });
  console.log(`${id}: R3 gate -> ${v3.ok ? 'PASS' : 'FAIL'} (${num('pass')}/${num('tests')}, exit ${a.status}) | new gate -> ${vn.ok ? 'PASS' : 'FAIL'} ${JSON.stringify(vn.reasons)}`);
  fs.rmSync(d, { recursive: true, force: true });
}
