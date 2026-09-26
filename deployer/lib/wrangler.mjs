/**
 * The ONLY way the deployer runs wrangler: the PINNED binary from edge/node_modules, always with
 * an explicit --config for deploys, with a minimal environment. Output is redacted line by line.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WRANGLER_BIN, EDGE_DIR, RUNTIME_DIR, BUILD_DIR } from './paths.mjs';
import { out, redact, KawaError } from './log.mjs';

const PASSTHROUGH = ['PATH', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS',
                     'SSL_CERT_FILE', 'CLOUDFLARE_API_BASE_URL', 'TZ'];

export function pinnedVersion() {
  const lock = JSON.parse(fs.readFileSync(path.join(EDGE_DIR, 'package-lock.json'), 'utf8'));
  return lock.packages['node_modules/wrangler'].version;
}

export function createWrangler({ token, accountId, quiet = false } = {}) {
  function env() {
    const e = {};
    for (const k of PASSTHROUGH) if (process.env[k]) e[k] = process.env[k];
    const home = path.join(RUNTIME_DIR, 'home');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    Object.assign(e, {
      HOME: home,                              // wrangler's cache/logs land on tmpfs, not on the NAS volume
      XDG_CONFIG_HOME: path.join(home, '.config'),
      WRANGLER_LOG_PATH: path.join(home, 'wrangler-logs'),
      WRANGLER_SEND_METRICS: 'false',
      NO_COLOR: '1', FORCE_COLOR: '0', CI: 'true',
    });
    if (token) e.CLOUDFLARE_API_TOKEN = token;
    if (accountId) e.CLOUDFLARE_ACCOUNT_ID = accountId;
    return e;
  }

  function run(args, { allowFail = false, input = null } = {}) {
    if (args[0] === 'deploy' && !args.includes('--config') && !args.includes('--dry-run')) {
      throw new KawaError('AMBIGUOUS_DEPLOY', 'refusing a wrangler deploy without an explicit --config');
    }
    return new Promise((resolve, reject) => {
      // cwd = the build dir: wrangler's .wrangler/ scratch lands on tmpfs, never in the image.
      fs.mkdirSync(BUILD_DIR, { recursive: true });
      const child = spawn(WRANGLER_BIN, args, { cwd: BUILD_DIR, env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const pipe = (buf, which) => {
        const text = buf.toString();
        if (which === 'out') stdout += text; else stderr += text;
        if (!quiet) for (const line of text.split('\n')) if (line.trim()) out.info('   │ ' + redact(line));
      };
      child.stdout.on('data', b => pipe(b, 'out'));
      child.stderr.on('data', b => pipe(b, 'err'));
      if (input) child.stdin.write(input);
      child.stdin.end();
      child.on('error', reject);
      child.on('close', (code) => {
        const res = { code, stdout: redact(stdout), stderr: redact(stderr) };
        if (code !== 0 && !allowFail) {
          const tail = (res.stderr + '\n' + res.stdout).trim().split('\n').slice(-6).join(' | ');
          reject(new KawaError('WRANGLER_FAILED', `wrangler ${args.slice(0, 2).join(' ')} failed (exit ${code}): ${tail}`));
        } else resolve(res);
      });
    });
  }

  return {
    run,
    async version() {
      const r = await run(['--version'], { allowFail: true });
      const m = /(\d+\.\d+\.\d+)/.exec(r.stdout + r.stderr);
      return m ? m[1] : null;
    },
    deploy(configPath, secretsFile) {
      const args = ['deploy', '--config', configPath];
      if (secretsFile) args.push('--secrets-file', secretsFile);
      return run(args);
    },
    dryRun(configPath, outdir) {
      return run(['deploy', '--config', configPath, '--dry-run', '--outdir', outdir]);
    },
    pauseDelivery: (queue) => run(['queues', 'pause-delivery', queue]),
    resumeDelivery: (queue) => run(['queues', 'resume-delivery', queue]),
    // No --force: callers delete dependents (consumers, admin) before what they depend on.
    deleteWorker: (name) => run(['delete', name]),
    deleteQueue: (name) => run(['queues', 'delete', name]),
    tail: (name) => run(['tail', name, '--format', 'json']),
  };
}
