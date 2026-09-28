/**
 * V0.1 vs V0.1.1 benchmark with the same fixture: real dispatcher process, local mock Hubs, N sequential signals.
 *   node tools/bench.mjs <v0.1 root> <v0.1.1 root> [signals=1000]
 * Measures ingress ACK p50/p95/p99, delivery latency (POST start → Hub receipt), RSS (peak VmHWM), DB size.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const [,, v01, v011, nArg] = process.argv;
const N = Number(nArg || 1000);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };
const r2 = (x) => Math.round(x * 100) / 100;

async function hub() {
  const h = { got: new Map() };
  const srv = http.createServer((req, res) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => { h.got.set(Buffer.concat(c).toString(), performance.now()); res.writeHead(200); res.end('{}'); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  h.port = srv.address().port; h.close = () => new Promise(r => { srv.closeAllConnections(); srv.close(r); });
  return h;
}

async function run(root, hubsN, n = N, gapMs = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
  for (const d of ['config', 'secrets', 'data']) fs.mkdirSync(path.join(dir, d));
  const hubs = await Promise.all(Array.from({ length: hubsN }, hub));
  const destinations = hubs.map((h, i) => ({ id: `HUB_${String.fromCharCode(65 + i)}`, enabled: true, host: '127.0.0.1', port: h.port, webhook_secret_file: `h${i}` }));
  hubs.forEach((_, i) => fs.writeFileSync(path.join(dir, 'secrets', `h${i}`), `bench-secret-${i}-abcdef`));
  fs.writeFileSync(path.join(dir, 'secrets', 'ingress_webhook_token'), 'bench-ingress-token-1');
  fs.writeFileSync(path.join(dir, 'secrets', 'audit_admin_token'), 'bench-audit-token-0123456789');
  fs.writeFileSync(path.join(dir, 'config', 'destinations.json'), JSON.stringify({ destinations, ...(process.env.BENCH_AUDIT ? { audit: JSON.parse(process.env.BENCH_AUDIT) } : {}) }));
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'src', 'main.mjs')],
    { env: { ...process.env, KAWA_CONFIG: path.join(dir, 'config', 'destinations.json'), KAWA_SECRETS: path.join(dir, 'secrets'), KAWA_DATA: path.join(dir, 'data'), PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = ''; p.stdout.on('data', d => { out += d; });
  let port; for (let i = 0; i < 200 && !port; i++) { port = (/STARTED port=(\d+)/.exec(out) || [])[1]; await new Promise(r => setTimeout(r, 25)); }
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const postOnce = (body) => new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port, path: '/webhook/bench-ingress-token-1', method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (s) => { s.resume(); s.on('end', () => res(s.statusCode)); }); q.on('error', rej); q.end(body); });
  const ack = [], sent = new Map();
  for (let i = 0; i < n; i++) {
    if (gapMs) await new Promise(r => setTimeout(r, gapMs));
    const body = JSON.stringify({ ticker: 'BTCUSDT', order_id: `B-${i}`, order_action: 'buy', seq: i });
    const t0 = performance.now(); sent.set(body, t0);
    const code = await postOnce(body);
    if (code !== 200) throw new Error(`HTTP ${code}`);
    ack.push(performance.now() - t0);
  }
  const t0 = Date.now();
  while (!hubs.every(h => h.got.size === n) && Date.now() - t0 < 120000) await new Promise(r => setTimeout(r, 20));
  const deliv = hubs.flatMap(h => [...h.got].map(([b, t]) => t - sent.get(b)));
  const st = fs.readFileSync(`/proc/${p.pid}/status`, 'utf8');
  const kb = (k) => Number((new RegExp(`${k}:\\s+(\\d+)`).exec(st) || [])[1] || 0);
  const size = (f) => { try { return fs.statSync(path.join(dir, 'data', f)).size; } catch { return 0; } };
  p.kill('SIGTERM'); await new Promise(r => p.once('exit', r));
  const dbBytes = size('dispatcher.db') + size('dispatcher.db-wal');
  await Promise.all(hubs.map(h => h.close())); agent.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
  return { mode: gapMs ? `paced ${gapMs} ms` : 'burst', hubs: hubsN, signals: n, delivered_all: hubs.every(h => h.got.size === n),
    ack_p50_ms: r2(pct(ack, 50)), ack_p95_ms: r2(pct(ack, 95)), ack_p99_ms: r2(pct(ack, 99)),
    delivery_p50_ms: r2(pct(deliv, 50)), delivery_p95_ms: r2(pct(deliv, 95)), rss_peak_mb: r2(kb('VmHWM') / 1024), rss_end_mb: r2(kb('VmRSS') / 1024), db_mb: r2(dbBytes / 1048576) };
}

const results = [];
for (const [n, gap] of [[N, 0], [50, 100]]) for (const hubsN of [1, 2, 5]) for (const [name, root] of [['V0.1', v01], ['V0.1.1', v011]]) {
  const r = { version: name, ...(await run(root, hubsN, n, gap)) }; results.push(r); console.error(JSON.stringify(r));
}
console.log(JSON.stringify(results, null, 2));
