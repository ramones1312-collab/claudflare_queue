import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startDispatcher } from '../src/main.mjs';
import { createLogger } from '../src/log.mjs';

export const INGRESS = 'ingress-token-0123456789';
export const secretOf = (id) => `secret-${id.toLowerCase()}-abcdef123456`;

/** A throw-away install folder: config/, secrets/, data/. */
export function sandbox({ destinations, retry = { schedule_seconds: [0.1, 0.2], max_attempts: 0 }, delivery, secrets = {}, raw } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhd-'));
  for (const d of ['config', 'secrets', 'data']) fs.mkdirSync(path.join(dir, d));
  fs.writeFileSync(path.join(dir, 'secrets', 'ingress_webhook_token'), INGRESS + '\n');
  for (const d of destinations || []) if (/^[A-Za-z0-9._-]+$/.test(d.webhook_secret_file || '')) fs.writeFileSync(path.join(dir, 'secrets', d.webhook_secret_file), secrets[d.id] ?? secretOf(d.id));
  fs.writeFileSync(path.join(dir, 'config', 'destinations.json'), raw ?? JSON.stringify({ retry, ...(delivery ? { delivery } : {}), destinations }));
  return { dir, configFile: path.join(dir, 'config', 'destinations.json'), secretsDir: path.join(dir, 'secrets'), dataDir: path.join(dir, 'data'),
           cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export const dest = (id, port, extra = {}) => ({ id, enabled: true, host: '127.0.0.1', port, webhook_secret_file: `${id.toLowerCase()}_webhook_token`, ...extra });

/** Mock Hub: records every request; `mode` decides the answer ('ok' | 'down' → 503 | 'hang' | a status number). */
export async function mockHub(mode = 'ok') {
  const hub = { received: [], mode };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      hub.received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      if (hub.mode === 'hang') return;                              // never answers
      const code = hub.mode === 'ok' ? 200 : hub.mode === 'down' ? 503 : hub.mode;
      res.writeHead(code, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  hub.port = server.address().port;
  hub.close = () => new Promise(r => { server.closeAllConnections(); server.close(r); });
  return hub;
}

export async function start(sb, opts = {}) {
  const lines = [];
  const log = createLogger((l) => lines.push(l));
  const app = await startDispatcher({ configFile: sb.configFile, secretsDir: sb.secretsDir, dataDir: sb.dataDir, port: 0, host: '127.0.0.1', log, ...opts });
  app.lines = lines;
  return app;
}

export function post(app, body, { token = INGRESS, contentType = 'text/plain; charset=utf-8', headers = {} } = {}) {
  return fetch(`http://127.0.0.1:${app.port}/webhook/${token}`, { method: 'POST', body, headers: { 'content-type': contentType, ...headers } });
}

export async function waitFor(what, fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`); await new Promise(r => setTimeout(r, 20)); }
}
export const rows = (app, id) => app.store.db.prepare('SELECT * FROM deliveries WHERE destination_id = ? ORDER BY event_id').all(id);
