"""All-in equity: each remaining player's chance to win the current hand.

When the money's in and cards are still to come, we compute everyone's
win% over every possible runout. With <=2 board cards left we enumerate
exactly; otherwise we Monte-Carlo a few thousand boards. A tie splits the
win credit evenly (so the numbers always add up to ~100%).
"""
from __future__ import annotations

import random
from itertools import combinations

from .cards import full_deck
from .evaluator import best_hand

MC_SAMPLES = 1500


def win_chances(holes: dict[str, list], board: list,
                seed: int | None = None) -> dict[str, float]:
    """holes: {pid: [Card, Card]} for live players. Returns {pid: percent}."""
    ids = [pid for pid, h in holes.items() if h]
    if len(ids) < 2:
        return {pid: 100.0 for pid in ids}

    known = {(c.rank, c.suit) for h in holes.values() for c in h}
    known |= {(c.rank, c.suit) for c in board}
    deck = [c for c in full_deck() if (c.rank, c.suit) not in known]
    need = 5 - len(board)
    if need <= 0:
        runouts = [()]
    elif need <= 2:
        runouts = list(combinations(deck, need))      # exact enumeration
    else:
        rng = random.Random(seed)
        runouts = [tuple(rng.sample(deck, need)) for _ in range(MC_SAMPLES)]

    wins = {pid: 0.0 for pid in ids}
    for extra in runouts:
        full = board + list(extra)
        scored = {pid: best_hand(holes[pid] + full) for pid in ids}
        best = max(scored.values())
        winners = [pid for pid in ids if scored[pid] == best]
        for pid in winners:
            wins[pid] += 1.0 / len(winners)

    total = len(runouts) or 1
    return {pid: round(100.0 * wins[pid] / total, 1) for pid in ids}
