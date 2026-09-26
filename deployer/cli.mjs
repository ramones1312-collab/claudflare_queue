#!/usr/bin/env node
/**
 * KAWA VECTOR · EDGE SIGNAL BUFFER · NAS DEPLOYER
 *
 * One entry point for everything the operator does. Run it through ./kawa-edge on the NAS
 * (docker compose run --rm installer <command>). Exit codes: 0 PASS · 1 FAIL · 2 BLOCKED · 64 usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, STATE_DIR, ROOT } from './lib/paths.mjs';
import { out, openLog, KawaError } from './lib/log.mjs';
import { COMMANDS } from './lib/commands.mjs';

const [cmd = 'help', ...args] = process.argv.slice(2);
const def = COMMANDS[cmd];

function usage() {
  out.raw('KAWA Edge deployer — commands (run as: ./kawa-edge <command>)\n');
  for (const [name, c] of Object.entries(COMMANDS)) if (!c.hidden) out.raw(`  ${name.padEnd(18)} ${c.help}`);
  out.raw('\nDocs: README_NAS_INSTALL.md (install) · RUNBOOK_VIGENTE.md (operations)');
}

if (!def || cmd === 'help' || args.includes('--help')) {
  usage();
  process.exit(def || cmd === 'help' ? 0 : 64);
}

const t0 = Date.now();
let logFile = '(none)';
try {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    logFile = openLog(STATE_DIR, cmd);
  } catch (err) {
    throw new KawaError('STATE_NOT_WRITABLE', `cannot write ${STATE_DIR} (${err.code || err.message})`,
      'Run through ./kawa-edge: it makes state/ belong to the folder owner the container runs as.');
  }
  const res = await def.run({ args, configFile: CONFIG_FILE, root: ROOT, stateDir: STATE_DIR });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  out.banner(res.result, `${cmd} · ${secs} s${res.detail ? ' · ' + res.detail : ''}`);
  out.raw(`   log: ${path.relative(ROOT, logFile)}${res.report ? `\n   evidence: ${path.relative(ROOT, res.report)}` : ''}`);
  process.exit(res.result === 'PASS' ? 0 : res.result === 'BLOCKED' ? 2 : 1);
} catch (err) {
  if (err instanceof KawaError) {
    out.fail(`${err.code}: ${err.message}`);
    if (err.hint) out.info(`→ ${err.hint}`);
  } else {
    out.fail(`UNEXPECTED: ${err && err.stack || err}`);
  }
  out.banner('FAIL', `${cmd} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  out.raw(`   log: ${path.relative(ROOT, logFile)}`);
  process.exit(1);
}
