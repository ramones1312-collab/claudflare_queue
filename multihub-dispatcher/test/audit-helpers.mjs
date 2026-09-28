/** V0.1.1 test helpers (the V0.1 helpers.mjs is left untouched). */
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, dest, mockHub, start } from './helpers.mjs';

export const AUDIT_TOKEN = 'audit-admin-token-0123456789';
export const auth = (pass = AUDIT_TOKEN, user = 'audit') => ({ authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') });

/** Sandbox + audit token + N mock Hubs (modes) + a started dispatcher; everything cleaned up after the test. */
export async function auditWorld(t, modes = ['ok', 'ok'], { destExtra = {}, audit, retry, token = AUDIT_TOKEN } = {}) {
  const hubs = await Promise.all(modes.map(m => mockHub(m)));
  const ids = modes.map((_, i) => `HUB_${String.fromCharCode(65 + i)}`);
  const destinations = ids.map((id, i) => dest(id, hubs[i].port, destExtra[id] || {}));
  const sb = sandbox({ destinations, ...(retry ? { retry } : {}) });
  if (audit) { const c = JSON.parse(fs.readFileSync(sb.configFile, 'utf8')); c.audit = audit; fs.writeFileSync(sb.configFile, JSON.stringify(c)); }
  if (token !== null) fs.writeFileSync(path.join(sb.secretsDir, 'audit_admin_token'), token + '\n');
  const app = await start(sb);
  t.after(async () => { await app.stop().catch(() => {}); await Promise.all(hubs.map(h => h.close())); sb.cleanup(); });
  return { app, hubs, ids, sb };
}

export const auditRows = (app, where = '1=1', ...args) => (app.audit.flush(), app.audit.db).prepare(`SELECT * FROM audit_events WHERE ${where} ORDER BY audit_id`).all(...args);
export const get = (app, p, headers = {}) => fetch(`http://127.0.0.1:${app.port}${p}`, { headers });

/** RFC 4180 parser (quotes, doubled quotes, CR/LF inside quotes). */
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r') { /* part of CRLF */ }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (q) throw new Error('unterminated quote');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
