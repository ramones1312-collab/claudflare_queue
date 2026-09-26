"""Edge Signal Buffer V1 · reordered-delivery safety against KAWA VECTOR R8.2.3.3.

Cloudflare Queues does NOT guarantee FIFO, even with max_batch_size=1 and max_concurrency=1. The
buffer therefore cannot promise ordered delivery, and the honest question is not "can we preserve
order" but "what does KAWA do when order is lost".

This file answers that empirically against an UNMODIFIED R8.2.3.3 tree. KAWA is not changed by the
buffer project; it is only exercised.

Run:  KAWA=/path/to/r8233 python3 -m unittest test_reordered_delivery -v
"""
import asyncio, json, os, sys, unittest
from itertools import permutations

KAWA = os.environ.get('KAWA', '/home/claude/r8233')
sys.path[:0] = [KAWA, os.path.join(KAWA, 'tests')]

from common import temp_config                     # noqa: E402
from app.store import StateStore                   # noqa: E402
from app.execution import ExecutionEngine          # noqa: E402
from app.constants import WRITE_ENABLED            # noqa: E402
from test_execution import FakeAdapter, ready_cfg  # noqa: E402

SYM = 'DOT'
ENTRY = ('KAWA VECTOR V2.4 PROD · TEMPORAL PROFILES | CORE-15 | LONG DOTUSDT.P | TEMP T2 NO TUE | '
         'ENTRY_PLAN 4.25 | $425.00 | QTY 100 | BASE PORTFOLIO $10000 | RISK 2%x1=2% | '
         'RISK$ 200 | STOP 3.95 | +1R 4.55')
STOP_UPDATE = ('KAWA VECTOR V2.4 PROD · TEMPORAL PROFILES | CORE-15 | LONG DOTUSDT.P | '
               'TEMP T2 NO TUE | STOP_UPDATE 4.10')
EXIT = 'KAWA VECTOR V2.4 PROD · TEMPORAL PROFILES | CORE-15 | CIERRA LONG DOTUSDT.P | TRAIL'

T1, T2, T3 = 1_700_000_000_000, 1_700_000_060_000, 1_700_000_120_000
PRIORITY = {'ENTRY': 100, 'STOP_UPDATE': 300, 'EXIT': 400}


class ReorderedDelivery(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.td, self.root, self.c = temp_config()
        self.c = ready_cfg(self.c)
        self.s = StateStore(self.c.testnet.state_db, 'TESTNET')
        self.f = FakeAdapter()
        self.e = ExecutionEngine(self.c, self.s, 'TESTNET', lambda: True, self.f)
        self.s.set_meta('market_cache', json.dumps(self.f.markets))
        self.s.set_meta('reconciled', '1'); self.s.set_meta('preflight_ready', '1')
        self.s.set_meta('write_lock', WRITE_ENABLED)
        self.s.set_meta('last_account',
                        json.dumps({'available_balance': '1000000', 'collateral': '1000000'}))

    async def asyncTearDown(self):
        self.td.cleanup()

    async def _deliver(self, order):
        """Deliver the three alerts in the given order, as a reordered queue would."""
        results = []
        for kind, raw, ts in order:
            sid = f'{kind}-{ts}'
            self.s.put_signal(sid, 'h-' + sid, raw, 'QUEUED')
            self.s.register_signal_runtime(sid, ts, kind, SYM, 'edge-batch', PRIORITY[kind])
            r = await self.e.process_signal(sid)
            results.append((kind, r.get('code') or 'OK', self.s.get_signal(sid)[5]))
        # drain any retryable HELD work, exactly as the real worker would
        for _ in range(40):
            rows = self.s.list_queued_prioritized(10, retry_after_ms=0)
            if not rows:
                break
            for row in rows:
                await self.e.process_signal(row[0])
        return results

    def _opening_writes(self):
        return [c for c in self.f.market_calls if not c.get('reduce_only')]

    # ---- the specific case the review named -----------------------------------------
    async def test_exit_t3_delivered_before_entry_t1(self):
        await self._deliver([('EXIT', EXIT, T3), ('ENTRY', ENTRY, T1),
                             ('STOP_UPDATE', STOP_UPDATE, T2)])
        phase = self.s.lifecycle(SYM)['phase']
        # The causal clock advanced to t3, so the older ENTRY is refused as stale. The outcome is a
        # MISSED trade, never an incorrect one: nothing opened, nothing left unprotected.
        self.assertEqual(phase, 'FLAT', f'reordering left the symbol in {phase}')
        self.assertEqual(self._opening_writes(), [],
                         'a stale ENTRY opened a position after its EXIT had been seen')

    async def test_stale_entry_is_explicitly_refused_not_silently_dropped(self):
        res = await self._deliver([('EXIT', EXIT, T3), ('ENTRY', ENTRY, T1)])
        entry = [r for r in res if r[0] == 'ENTRY'][0]
        self.assertEqual(entry[1], 'STALE_CAUSAL_SIGNAL')
        self.assertEqual(self.s.get_signal(f'ENTRY-{T1}')[6], 'STALE_CAUSAL_SIGNAL')

    # ---- every possible delivery order ------------------------------------------------
    async def test_no_permutation_can_leave_an_unclosed_or_unprotected_position(self):
        """The safety claim, stated as an exhaustive check rather than an argument."""
        alerts = [('ENTRY', ENTRY, T1), ('STOP_UPDATE', STOP_UPDATE, T2), ('EXIT', EXIT, T3)]
        for order in permutations(alerts):
            await self.asyncTearDown(); await self.asyncSetUp()
            await self._deliver(list(order))
            st = self.s.lifecycle(SYM)
            names = [k for k, _, _ in order]
            # Only two end states are acceptable: flat, or open WITH a verified protective stop.
            if st['phase'] == 'OPEN_PROTECTED':
                self.assertIsNotNone(st.get('stop_client_index'),
                                     f'{names}: open without a protective stop')
            else:
                self.assertEqual(st['phase'], 'FLAT',
                                 f'{names}: ended in {st["phase"]}, neither FLAT nor OPEN_PROTECTED')

    async def test_in_order_delivery_still_executes_the_full_round_trip(self):
        """The safety property must not come from refusing everything."""
        await self._deliver([('ENTRY', ENTRY, T1), ('STOP_UPDATE', STOP_UPDATE, T2),
                             ('EXIT', EXIT, T3)])
        self.assertEqual(self.s.lifecycle(SYM)['phase'], 'FLAT')
        self.assertEqual(len(self._opening_writes()), 1, 'the in-order round trip did not execute')

    async def test_entry_then_exit_out_of_order_with_stop_between_is_still_safe(self):
        await self._deliver([('ENTRY', ENTRY, T1), ('EXIT', EXIT, T3),
                             ('STOP_UPDATE', STOP_UPDATE, T2)])
        self.assertEqual(self.s.lifecycle(SYM)['phase'], 'FLAT')

    async def test_redelivery_of_the_same_alert_does_not_duplicate(self):
        """At-least-once delivery is normal; KAWA remains the deduplication authority."""
        sid = 'ENTRY-dup'
        self.s.put_signal(sid, 'h-dup', ENTRY, 'QUEUED')
        self.s.register_signal_runtime(sid, T1, 'ENTRY', SYM, 'edge-batch', PRIORITY['ENTRY'])
        await self.e.process_signal(sid)
        await self.e.process_signal(sid)
        await self.e.process_signal(sid)
        self.assertEqual(len(self._opening_writes()), 1, 'redelivery produced a duplicate entry')


if __name__ == '__main__':
    unittest.main()
