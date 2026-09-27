import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, ConfigError } from './config.mjs';
import { openStore } from './store.mjs';
import { createDispatcher } from './dispatcher.mjs';
import { createServer } from './server.mjs';
import { createLogger } from './log.mjs';

/** Starts everything; used by the container and, in-process, by the tests. */
export async function startDispatcher({ configFile, secretsDir, dataDir, port = 8080, host = '0.0.0.0', log = createLogger(), fetchImpl } = {}) {
  const config = loadConfig({ configFile, secretsDir });
  for (const s of [config.ingress.secret, ...config.enabled.map(d => d.secret)]) log.addSecret(s);
  fs.mkdirSync(dataDir, { recursive: true });
  const store = openStore(path.join(dataDir, 'dispatcher.db'));
  const open = store.openCounts();
  for (const [id, n] of Object.entries(open)) {
    if (!config.enabled.some(d => d.id === id)) log('BACKLOG_KEPT', { destination: id, open: n, reason: 'destination not enabled; kept, not delivered' });
  }
  const dispatcher = createDispatcher({ store, config, log, fetchImpl });
  const server = createServer({ store, config, dispatcher, log });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(port, host, res); });
  dispatcher.start();
  log('STARTED', { port: server.address().port, destinations: config.enabled.map(d => `${d.id}@${d.host}:${d.port}`).join(','), backlog: JSON.stringify(open) });
  return {
    port: server.address().port, store, config,
    async stop() { await new Promise(r => server.close(r)); await dispatcher.stop(); store.close(); },
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
    process.exit(1);
  });
}
