/**
 * Configuration: config/destinations.json (no secrets) + one secret file per Hub in secrets/.
 * Fail closed: any invalid value stops the dispatcher at startup with a clear message.
 */
import fs from 'node:fs';
import path from 'node:path';

export class ConfigError extends Error {}
const fail = (msg) => { throw new ConfigError(msg); };

const DEFAULTS = {
  ingress: { path_prefix: '/webhook/', secret_file: 'ingress_webhook_token', max_body_bytes: 65536 },
  retry: { schedule_seconds: [5, 15, 30, 60, 120, 300], max_attempts: 0 },
  delivery: { timeout_ms: 10000, path_prefix: '/webhook/' },
  // Ports a destination may never point at: the Hub control port and the dispatcher itself.
  forbidden_ports: [8080, 8180, 8191],
};
const ID_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PREFIX_RE = /^\/[A-Za-z0-9._~\/-]*\/$/;

function readSecret(dir, file, what) {
  if (typeof file !== 'string' || !FILE_RE.test(file)) fail(`${what}: secret file name must be a plain file name inside secrets/ (got ${JSON.stringify(file)})`);
  const p = path.join(dir, file);
  let v;
  try { v = fs.readFileSync(p, 'utf8').trim(); } catch { fail(`${what}: secrets/${file} not found`); }
  if (!v) fail(`${what}: secrets/${file} is empty`);
  if (!/^[A-Za-z0-9._~-]{8,256}$/.test(v)) fail(`${what}: secrets/${file} must be 8-256 URL-safe characters (no spaces, slashes or '?')`);
  return v;
}

const posInt = (v, what, min, max) => {
  if (!Number.isInteger(v) || v < min || v > max) fail(`${what} must be an integer ${min}-${max} (got ${JSON.stringify(v)})`);
  return v;
};

export function loadConfig({ configFile, secretsDir }) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (e) { fail(`config ${configFile}: ${e.code === 'ENOENT' ? 'not found' : 'invalid JSON'}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('config must be a JSON object');
  const ingress = { ...DEFAULTS.ingress, ...(raw.ingress || {}) };
  const retry = { ...DEFAULTS.retry, ...(raw.retry || {}) };
  const delivery = { ...DEFAULTS.delivery, ...(raw.delivery || {}) };
  const forbidden = Array.isArray(raw.forbidden_ports) ? raw.forbidden_ports : DEFAULTS.forbidden_ports;

  if (typeof ingress.path_prefix !== 'string' || !PREFIX_RE.test(ingress.path_prefix)) fail('ingress.path_prefix must look like /webhook/');
  posInt(ingress.max_body_bytes, 'ingress.max_body_bytes', 1024, 1048576);
  if (!Array.isArray(retry.schedule_seconds) || !retry.schedule_seconds.length || !retry.schedule_seconds.every(s => typeof s === 'number' && s > 0 && s <= 86400)) fail('retry.schedule_seconds must be a non-empty list of seconds (0 < s <= 86400)');
  posInt(retry.max_attempts, 'retry.max_attempts (0 = unlimited)', 0, 1000000);
  posInt(delivery.timeout_ms, 'delivery.timeout_ms', 100, 120000);
  if (typeof delivery.path_prefix !== 'string' || !PREFIX_RE.test(delivery.path_prefix)) fail('delivery.path_prefix must look like /webhook/');

  if (!Array.isArray(raw.destinations) || raw.destinations.length === 0) fail('destinations must be a non-empty list');
  const seen = new Set();
  const destinations = raw.destinations.map((d, i) => {
    const w = `destinations[${i}]`;
    if (!d || typeof d !== 'object') fail(`${w} must be an object`);
    if (typeof d.id !== 'string' || !ID_RE.test(d.id)) fail(`${w}.id must be like HUB_A (A-Z, 0-9, _)`);
    if (seen.has(d.id)) fail(`${w}.id ${d.id} is duplicated`);
    seen.add(d.id);
    if (typeof d.enabled !== 'boolean') fail(`${d.id}.enabled must be true or false`);
    if (typeof d.host !== 'string' || !HOST_RE.test(d.host)) fail(`${d.id}.host must be a host name or IPv4 address (no scheme, port or path)`);
    posInt(d.port, `${d.id}.port`, 1, 65535);
    if (forbidden.includes(d.port)) fail(`${d.id}.port ${d.port} is forbidden (control port or the dispatcher itself)`);
    const scheme = d.scheme === undefined ? 'http' : d.scheme;
    if (scheme !== 'http' && scheme !== 'https') fail(`${d.id}.scheme must be http or https`);
    const timeout_ms = d.timeout_ms === undefined ? delivery.timeout_ms : posInt(d.timeout_ms, `${d.id}.timeout_ms`, 100, 120000);
    const prefix = d.path_prefix === undefined ? delivery.path_prefix : d.path_prefix;
    if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix)) fail(`${d.id}.path_prefix must look like /webhook/`);
    for (const k of Object.keys(d)) if (/secret|token|password/i.test(k) && k !== 'webhook_secret_file') fail(`${d.id}.${k}: secrets never go in the config; use webhook_secret_file`);
    const secret = d.enabled ? readSecret(secretsDir, d.webhook_secret_file, `${d.id}.webhook_secret_file`) : null;
    return { id: d.id, enabled: d.enabled, host: d.host, port: d.port, scheme, timeout_ms, path_prefix: prefix, secret };
  });
  const enabled = destinations.filter(d => d.enabled);
  if (!enabled.length) fail('no destination is enabled');
  const secrets = new Map();
  for (const d of enabled) { if (secrets.has(d.secret)) fail(`${d.id} and ${secrets.get(d.secret)} use the same webhook secret; each Hub needs its own`); secrets.set(d.secret, d.id); }
  const ingressSecret = readSecret(secretsDir, ingress.secret_file, 'ingress.secret_file');
  return { ingress: { ...ingress, secret: ingressSecret }, retry, destinations, enabled, audit: raw.audit };   // V0.1.1: audit block passed through
}
