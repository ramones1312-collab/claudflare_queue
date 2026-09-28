'use strict';
// Talks only to /audit/api/* on the same origin; the browser re-sends the Basic Auth credentials itself.
const $ = (id) => document.getElementById(id);
const text = (tag, t, cls) => { const e = document.createElement(tag); e.textContent = t == null ? '' : String(t); if (cls) e.className = cls; return e; };
const COLS = ['audit_id', 'ts', 'event_id', 'event_type', 'destination_id', 'attempt', 'status', 'http_status', 'latency_ms', 'error_code', 'next_retry', 'symbol', 'order_id', 'body_bytes', 'payload_sha256', 'request_id'];
const iso = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 23) : '');

function params() {
  const p = new URLSearchParams();
  for (const [k, v] of new FormData($('f'))) {
    if (!v) continue;
    p.set(k, (k === 'from' || k === 'to') ? String(new Date(v).getTime()) : v);
  }
  return p;
}

async function getJson(url) {
  const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

function renderSummary(s) {
  const c = $('cards'); c.replaceChildren();
  const card = (title, value, cls) => { const d = text('div', '', 'card'); d.append(text('b', title), text('span', value, cls)); c.append(d); };
  card('dispatcher', s.dispatcher, 'ok');
  card('auditoría', s.audit, s.audit === 'ok' ? 'ok' : 'bad');
  card('último event_id', s.last_event_id ?? '—');
  const sel = $('dest'), cur = sel.value; sel.replaceChildren(text('option', '(todos)'));
  sel.firstChild.value = '';
  for (const d of s.destinations) {
    card(`${d.id}${d.enabled ? '' : ' (deshabilitado)'}`, `backlog ${d.backlog}${d.last_error ? ' · último error ' + d.last_error : ''}`, d.backlog ? 'warn' : 'ok');
    const o = text('option', d.id); o.value = d.id; sel.append(o);
  }
  sel.value = cur;
}

function describe(r) {
  const parts = [r.destination_id, r.status || r.event_type];
  if (r.http_status) parts.push(`HTTP ${r.http_status}`);
  if (r.error_code && !r.http_status) parts.push(r.error_code);
  if (r.latency_ms != null) parts.push(`${r.latency_ms} ms`);
  if (r.attempt) parts.push(`attempt ${r.attempt}`);
  if (r.next_retry_at) parts.push(`next retry ${Math.max(0, Math.round((r.next_retry_at - Date.now()) / 1000))}s`);
  return parts.join(' · ');
}

function renderEvents(rows) {
  // One block per event_id: the LATEST outcome row per destination (rows arrive newest first).
  const byEvent = new Map();
  for (const r of rows) {
    if (r.event_id == null) continue;
    const e = byEvent.get(r.event_id) || { dests: new Map(), facts: null };
    if (r.event_type === 'INGRESS_PERSISTED') e.facts = r;
    if (r.destination_id && ['DELIVERED', 'RETRY_SCHEDULED', 'FAILED_PERMANENT'].includes(r.event_type) && !e.dests.has(r.destination_id)) e.dests.set(r.destination_id, r);
    byEvent.set(r.event_id, e);
  }
  const box = $('events'); box.replaceChildren();
  for (const [id, e] of byEvent) {
    const d = text('div', '', 'ev');
    d.append(text('div', `event_id ${id}${e.facts ? ` · ${iso(e.facts.ts_ms)} · ${e.facts.symbol || ''} ${e.facts.order_id || ''} · ${e.facts.body_bytes} B` : ''}`));
    for (const r of [...e.dests.values()].sort((a, b) => a.destination_id.localeCompare(b.destination_id))) {
      d.append(text('div', describe(r), r.event_type === 'DELIVERED' ? 'ok' : r.event_type === 'FAILED_PERMANENT' ? 'bad' : 'warn'));
    }
    box.append(d);
  }
}

function renderTable(rows) {
  const head = $('t').tHead; head.replaceChildren();
  const tr = document.createElement('tr'); for (const c of COLS) tr.append(text('th', c)); head.append(tr);
  const body = $('t').tBodies[0]; body.replaceChildren();
  for (const r of rows) {
    const row = document.createElement('tr');
    const v = { ...r, ts: iso(r.ts_ms), next_retry: iso(r.next_retry_at), payload_sha256: r.payload_sha256 ? r.payload_sha256.slice(0, 12) + '…' : '' };
    for (const c of COLS) row.append(text('td', v[c]));
    body.append(row);
  }
}

async function load() {
  const p = params();
  $('csv').href = `/audit/export.csv?${p}`; $('json').href = `/audit/export.json?${p}`;
  try {
    renderSummary(await getJson('/audit/api/summary'));
    const r = await getJson(`/audit/api/events?${p}`);
    renderEvents(r.events); renderTable(r.events);
  } catch (e) { $('events').replaceChildren(text('div', e.message, 'bad')); }
}

$('f').addEventListener('submit', (ev) => { ev.preventDefault(); load(); });
load();
setInterval(() => { if (!document.hidden) load(); }, 15000);
