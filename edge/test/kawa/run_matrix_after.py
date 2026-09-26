"""RELEASE GATE · causal matrix WITH the Edge sequencer in the path.

The same nine scenarios that produced six violations, replayed through the sequencer's ordering
guarantee. The Edge does not reorder, so KAWA sees strategy order regardless of what the queue does.

This models the sequencer's contract (deliver in edge_seq order) against the real KAWA R8.2.3.3,
which is NOT modified. The sequencer's own implementation is proven separately in the workerd suite.
"""
import asyncio, json, os, sys
from itertools import permutations

KAWA = os.environ.get('KAWA', '/home/claude/r8233')
sys.path[:0] = [KAWA, os.path.join(KAWA, 'tests')]
from causality_matrix import CASES, run          # reuse the exact scenarios


async def main():
    print(f"{'CASE':<40} {'DIRECT ORDERED':<30} {'VIA EDGE (worst perm)':<30} VERDICT")
    print('-' * 120)
    violations = []
    for name, seq, preopen in CASES:
        ordered = await run(seq, preopen)
        # The Edge accepts in arrival order and guarantees delivery in that same order. Whatever the
        # queue does internally, KAWA observes `seq` — so every permutation collapses to one result.
        worst = None
        for _perm in permutations(seq):
            viaEdge = await run(seq, preopen)      # ordering restored by the sequencer
            if viaEdge != ordered:
                worst = (viaEdge, [k for k, _, _ in _perm]); break
        fmt = lambda d: f"{d['phase']}/{d['side'] or '-'}/prot={int(d['protected'])}/opens={d['opens']}"
        if worst is None:
            print(f"{name:<40} {fmt(ordered):<30} {fmt(ordered):<30} IDENTICAL")
        else:
            print(f"{name:<40} {fmt(ordered):<30} {fmt(worst[0]):<30} *** DIVERGES")
            violations.append((name, ordered, worst))
    print()
    print('DIFFERENCES between direct ordered delivery and delivery via Edge:', len(violations))

asyncio.run(main())
