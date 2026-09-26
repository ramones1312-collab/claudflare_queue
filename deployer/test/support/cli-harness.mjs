/**
 * Runs the real deployer CLI as the operator would, against the mock Cloudflare API, in a private
 * sandbox (config, state, secrets, runtime and build dirs). `answers` are typed at hidden prompts
 * through a real pseudo-terminal (util-linux `script`), so the interactive path is what is tested.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli.mjs');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function sandbox({ accountId, token, mutate } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawa-e2e-'));
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'kawa-edge.example.json'), 'utf8'));
  cfg.cloudflare.account_id = accountId;
  if (mutate) mutate(cfg);
  for (const d of ['config', 'state', 'secrets', 'runtime', 'build']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'kawa-edge.json'), JSON.stringify(cfg, null, 2));
  const sb = {
    dir,
    configFile: path.join(dir, 'config', 'kawa-edge.json'),
    stateDir: path.join(dir, 'state'),
    tokenFile: path.join(dir, 'secrets', 'cloudflare_api_token'),
    dropToken(t = token) { fs.writeFileSync(sb.tokenFile, t + '\n', { mode: 0o600 }); },
    config() { return JSON.parse(fs.readFileSync(sb.configFile, 'utf8')); },
    /** Every byte the deployer left on disk (state, logs, reports, evidence). */
    persisted() {
      const outText = [];
      (function walk(p) { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else outText.push(fs.readFileSync(f, 'utf8')); } })(path.join(dir, 'state'));
      return outText.join('\n');
    },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
  return sb;
}

export function runCli(sb, apiBase, args, { answers = null, timeoutMs = 300000 } = {}) {
  const env = {
    PATH: process.env.PATH, HOME: path.join(sb.dir, 'runtime'),
    KAWA_CONFIG: sb.configFile, KAWA_STATE: sb.stateDir, KAWA_SECRETS: path.join(sb.dir, 'secrets'),
    KAWA_RUNTIME: path.join(sb.dir, 'runtime'), KAWA_BUILD: path.join(sb.dir, 'build'),
    CLOUDFLARE_API_BASE_URL: apiBase, NO_COLOR: '1',
  };
  const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const [cmd, argv] = answers
    ? ['script', ['-qec', [process.execPath, CLI, ...args].map(quote).join(' '), '/dev/null']]
    : [process.execPath, [CLI, ...args]];
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', b => { text += b; });
    child.stderr.on('data', b => { text += b; });
    if (answers) {
      let i = 0;
      const feed = setInterval(() => {
        // Answer each prompt as it appears.
        const prompts = (text.match(/input hidden[^)]*\): |Type [^:]*: /g) || []).length;
        while (i < prompts && i < answers.length) child.stdin.write(answers[i++] + '\r');
        if (i >= answers.length) { clearInterval(feed); }
      }, 100);
      child.on('close', () => clearInterval(feed));
    } else child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, text }); });
  });
}
