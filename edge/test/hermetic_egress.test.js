/**
 * V1.3.1 · HARNESS GUARD — the suite must never depend on the host's network or DNS.
 *
 * R4 failed 53/90 on a Synology NAS because halt notifications left the runtime as real DNS lookups
 * of `halt-notify.test`. vitest.config.js now routes all runtime egress to a local outbound service.
 * These tests pin that property: if someone removes it, they fail here, on any host, instead of
 * turning into environment-dependent timeouts elsewhere. No production code is exercised.
 */
import { describe, it, expect } from 'vitest';

describe('hermetic egress (harness guard)', () => {
  it('the halt-notification collector answers locally, without DNS', async () => {
    const t0 = Date.now();
    const res = await fetch('https://halt-notify.test/hook', { method: 'POST', body: '{}' });
    expect(res.status).toBe(204);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('any other host fails immediately instead of reaching the network', async () => {
    const t0 = Date.now();
    let failed = false;
    try {
      const res = await fetch('https://example.com/');
      failed = !res.ok;
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
