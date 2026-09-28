import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, ConfigError } from './config.mjs';
import { openStore } from './store.mjs';
import { createDispatcher } from './dispatcher.mjs';
import { createServer } from './server.mjs';
import { createLogger } from './log.mjs';
import { createAudit, auditSettings, recordStandalone } from './audit.mjs';

const VERSION = (() => { try { return /version: (\S+)/.exec(fs.readFileSync(new URL('../VERSION', import.meta.url), 'utf8'))[1]; } catch { return 'unknown'; } })();

/** Starts everything; used by the container and, in-process, by the tests. */
export async function startDispatcher({ configFile, secretsDir, dataDir, port = 8080, host = '0.0.0.0', log = createLogger(), fetchImpl } = {}) {
  const config = loadConfig({ configFile, secretsDir });
  for (const s of [config.ingress.secret, ...config.enabled.map(d => d.secret)]) log.addSecret(s);
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'dispatcher.db');
  const store = openStore(dbFile);
  const open = store.openCounts();
  for (const [id, n] of Object.entries(open)) {
    if (!config.enabled.some(d => d.id === id)) log('BACKLOG_KEPT', { destination: id, open: n, reason: 'destination not enabled; kept, not delivered' });
  }
  // V0.1.1: observability only. Settings from the optional "audit" block; defaults otherwise.
  const { settings, warnings } = auditSettings(config.audit);
  for (const w of warnings) log('AUDIT_SETTING_IGNORED', { key: w, reason: 'invalid value; default used' });
  const audit = createAudit({ dbFile, dataDir, secretsDir, settings, config, store, log, version: VERSION,
    knownSecrets: [config.ingress.secret, ...config.destinations.filter(d => d.secret).map(d => d.secret)] });
  audit.purge();
  const dispatcher = createDispatcher({ store, config, log, fetchImpl, audit });
  const server = createServer({ store, config, dispatcher, log, audit });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(port, host, res); });
  dispatcher.start();
  log('STARTED', { port: server.address().port, destinations: config.enabled.map(d => `${d.id}@${d.host}:${d.port}`).join(','), backlog: JSON.stringify(open) });
  audit.record({ event_type: 'DISPATCHER_STARTED', status: 'OK', detail: { version: VERSION, destinations: config.enabled.map(d => d.id), disabled: config.destinations.filter(d => !d.enabled).map(d => d.id), backlog: open, audit_ui: audit.uiEnabled } });
  return {
    port: server.address().port, store, config, audit,
    async stop() { audit.record({ event_type: 'DISPATCHER_STOPPING', status: 'OK' }); await new Promise(r => server.close(r)); await dispatcher.stop(); audit.close(); store.close(); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const log = createLogger();
  const env = process.env;
  startDispatcher({
    configFile: env.KAWA_CONFIG || '/config/destinations.json',
    secretsDir: env.KAWA_SECRETS || '/secrets',
    dataDir: env.KAWA_DATA || '/data',
    port: Number(env.PORT || 8080),
    log,
  }).then((app) => {
    const bye = async (sig) => { log('STOPPING', { signal: sig }); await app.stop(); process.exit(0); };
    process.on('SIGTERM', () => bye('SIGTERM')); process.on('SIGINT', () => bye('SIGINT'));
  }).catch((e) => {
    log(e instanceof ConfigError ? 'CONFIG_INVALID' : 'START_FAILED', { reason: e.message });
    const dataDir = env.KAWA_DATA || '/data';   // V0.1.1: best-effort durable trace of why it did not start
    if (e instanceof ConfigError) recordStandalone(path.join(dataDir, 'dispatcher.db'), dataDir, { event_type: 'CONFIG_INVALID', status: 'FAILED', detail: { reason: e.message.slice(0, 300) } });
    process.exit(1);
  });
}
