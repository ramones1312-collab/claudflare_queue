"""Causality matrix: ordered delivery vs Edge-reordered delivery, against KAWA R8.2.3.3 UNMODIFIED.

For every sequence VECTOR V2.4 can really emit, the same alerts are delivered in strategy order and
in reordered order from the same initial state. The final physical state must be causally
equivalent. KAWA is not modified; it is only exercised.
"""
import asyncio, json, os, sys
from itertools import permutations

KAWA = os.environ.get('KAWA', '/home/claude/r8233')
sys.path[:0] = [KAWA, os.path.join(KAWA, 'tests')]
from common import temp_config
from app.store import StateStore
from app.execution import ExecutionEngine
from app.constants import WRITE_ENABLED
from test_execution import FakeAdapter, ready_cfg

SYM = 'DOT'
LONG_ENTRY = ('KAWA VECTOR V2.4 PROD · TEMPORAL PROFILES | CORE-15 | LONG DOTUSDT.P | TEMP T2 NO TUE | '
              'ENTRY_PLAN 4.25 | $425.00 | QTY 100 | BASE PORTFOLIO $10000 | RISK 2%x1=2% | '
              'RISK$ 200 | STOP 3.95 | +1R 4.55')
SHORT_ENTRY = ('KAWA VECTOR V2.4 PROD · TEMPORAL PROFILES | CORE-15 | SHORT DOTUSDT.P | TEMP T2 NO TUE | '
               'ENTRY_PLAN 4.25 | $425.00 | QTY 100 | BASE PORTFOLIO $10000 | RISK 2%x1=2% | '
               'RISK$ 200 | STOP 4.55 | +1R 3.95')
STOP_UP = ('KAWA VECTOR V2.4 PROD · TEMPORAL PROFILES | CORE-15 | LONG DOTUSDT.P | TEMP T2 NO TUE | '
           'STOP_UPDATE 4.10')
EXIT_L = 'KAWA VECTOR V2.4 PROD · TEMPORAL PROFILES | CORE-15 | CIERRA LONG DOTUSDT.P | TRAIL'
PRIO = {'ENTRY': 100, 'STOP_UPDATE': 300, 'EXIT': 400}
T = 1_700_000_000_000


async def fresh():
    td, root, c = temp_config(); c = ready_cfg(c)
    s = StateStore(c.testnet.state_db, 'TESTNET'); f = FakeAdapter()
    e = ExecutionEngine(c, s, 'TESTNET', lambda: True, f)
    s.set_meta('market_cache', json.dumps(f.markets)); s.set_meta('reconciled', '1')
    s.set_meta('preflight_ready', '1'); s.set_meta('write_lock', WRITE_ENABLED)
    s.set_meta('last_account', json.dumps({'available_balance': '1000000', 'collateral': '1000000'}))
    return td, s, e, f


async def run(seq, preopen=False):
    """Deliver `seq` = [(kind, raw, ts)] and return the observable final state."""
    td, s, e, f = await fresh()
    try:
        if preopen:
            sid = 'pre'
            s.put_signal(sid, 'h-pre', LONG_ENTRY, 'QUEUED')
            s.register_signal_runtime(sid, T - 600_000, 'ENTRY', SYM, 'b', PRIO['ENTRY'])
            await e.process_signal(sid)
        base = len([c for c in f.market_calls if not c.get('reduce_only')])
        for i, (kind, raw, ts) in enumerate(seq):
            sid = f'{kind}-{ts}-{i}'
            s.put_signal(sid, 'h-' + sid, raw, 'QUEUED')
            s.register_signal_runtime(sid, ts, kind, SYM, 'b', PRIO[kind])
            await e.process_signal(sid)
        for _ in range(40):
            rows = s.list_queued_prioritized(10, retry_after_ms=0)
            if not rows: break
            for row in rows: await e.process_signal(row[0])
        st = s.lifecycle(SYM)
        return {'phase': st['phase'], 'side': st.get('side'),
                'protected': st.get('stop_client_index') is not None,
                'opens': len([c for c in f.market_calls if not c.get('reduce_only')]) - base}
    finally:
        td.cleanup()


CASES = [
    ('ENTRY/EXIT distinct ts, FLAT',        [('ENTRY', LONG_ENTRY, T), ('EXIT', EXIT_L, T + 60_000)], False),
    ('ENTRY/EXIT SAME ts, FLAT',            [('ENTRY', LONG_ENTRY, T), ('EXIT', EXIT_L, T)], False),
    ('ENTRY/EXIT distinct ts, OPEN',        [('ENTRY', LONG_ENTRY, T), ('EXIT', EXIT_L, T + 60_000)], True),
    ('ENTRY/EXIT SAME ts, OPEN',            [('ENTRY', LONG_ENTRY, T), ('EXIT', EXIT_L, T)], True),
    ('EXIT + reversal SHORT SAME ts, OPEN', [('EXIT', EXIT_L, T), ('ENTRY', SHORT_ENTRY, T)], True),
    ('STOP_UPDATE + EXIT SAME ts, OPEN',    [('STOP_UPDATE', STOP_UP, T), ('EXIT', EXIT_L, T)], True),
    ('STOP_UPDATE + EXIT distinct ts, OPEN',[('STOP_UPDATE', STOP_UP, T), ('EXIT', EXIT_L, T + 60_000)], True),
    ('ENTRY/STOP/EXIT SAME ts, FLAT',       [('ENTRY', LONG_ENTRY, T), ('STOP_UPDATE', STOP_UP, T),
                                             ('EXIT', EXIT_L, T)], False),
    ('ENTRY/STOP/EXIT distinct ts, FLAT',   [('ENTRY', LONG_ENTRY, T), ('STOP_UPDATE', STOP_UP, T + 30_000),
                                             ('EXIT', EXIT_L, T + 60_000)], False),
]


async def main():
    print(f"{'CASE':<40} {'ORDERED':<34} {'REORDERED (worst)':<34} VERDICT")
    print('-' * 130)
    violations = []
    for name, seq, preopen in CASES:
        ordered = await run(seq, preopen)
        worst = None
        for perm in permutations(seq):
            if list(perm) == list(seq): continue
            r = await run(list(perm), preopen)
            if r != ordered:
                worst = (r, [k for k, _, _ in perm]); break
        fmt = lambda d: f"{d['phase']}/{d['side'] or '-'}/prot={int(d['protected'])}/opens={d['opens']}"
        if worst is None:
            print(f"{name:<40} {fmt(ordered):<34} {'(identical)':<34} INVARIANT")
        else:
            r, order = worst
            print(f"{name:<40} {fmt(ordered):<34} {fmt(r):<34} *** DIVERGES {order}")
            violations.append((name, ordered, r, order))
    print()
    print('VIOLATIONS:', len(violations))
    for v in violations: print('  ', v[0], '| ordered:', v[1], '| reordered:', v[2], '| order:', v[3])

asyncio.run(main())
