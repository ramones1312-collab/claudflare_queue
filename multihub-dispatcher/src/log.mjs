/** One line per event. Never a body, a header value or a URL path (secrets live in paths). */
export function createLogger(write = (l) => process.stdout.write(l + '\n'), secrets = []) {
  const redact = (s) => { let t = String(s); for (const x of secrets) if (x) t = t.split(x).join('[REDACTED]'); return t; };
  const log = (event, fields = {}) => {
    const kv = Object.entries(fields).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${String(v).includes(' ') ? JSON.stringify(String(v)) : v}`).join(' ');
    write(redact(`${new Date().toISOString()} ${event}${kv ? ' ' + kv : ''}`));
  };
  log.addSecret = (s) => { if (s) secrets.push(s); };
  return log;
}
