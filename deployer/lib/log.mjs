/**
 * Output and redaction. Every line that reaches the terminal or a log file passes through
 * `redact()`: registered secret values, bearer tokens and webhook path tokens are replaced before
 * anything is written. A secret is registered the moment it is read, before it is used.
 */
import fs from 'node:fs';
import path from 'node:path';

const secrets = new Set();
let logFile = null;

export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 6) secrets.add(value);
  return value;
}

export function redact(text) {
  let s = String(text);
  // Longest first, so a secret that contains another one is fully masked.
  for (const v of [...secrets].sort((a, b) => b.length - a.length)) s = s.split(v).join('[REDACTED]');
  s = s.replace(/(\/webhook\/)[^\s/"'?#]{6,}/g, '$1[REDACTED]');
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1[REDACTED]');
  return s;
}

export function openLog(stateDir, command) {
  const dir = path.join(stateDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  logFile = path.join(dir, `${ts}-${command}.log`);
  return logFile;
}

function write(stream, line) {
  const clean = redact(line);
  stream.write(clean + '\n');
  if (logFile) {
    try { fs.appendFileSync(logFile, clean.replace(/\x1b\[[0-9;]*m/g, '') + '\n'); } catch { /* log is best effort */ }
  }
}

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

export const out = {
  raw: (s) => write(process.stdout, s),
  step: (s) => write(process.stdout, c('1;36', `\n== ${s}`)),
  info: (s) => write(process.stdout, `   ${s}`),
  ok: (s) => write(process.stdout, c('32', ` ✔ ${s}`)),
  warn: (s) => write(process.stdout, c('33', ` ! ${s}`)),
  fail: (s) => write(process.stderr, c('31', ` ✘ ${s}`)),
  banner(result, detail = '') {
    const color = result === 'PASS' ? '1;42;30' : result === 'BLOCKED' ? '1;43;30' : '1;41;97';
    write(process.stdout, '\n' + c(color, `  ${result}  `) + (detail ? `  ${detail}` : ''));
  },
};

/** A failure the operator must act on. `code` is stable and documented in the runbook. */
export class KawaError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}
