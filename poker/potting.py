"""Side-pot construction and showdown payouts.

The classic layered side-pot algorithm: peel the pot one contribution
level at a time. Folded players still *fund* the layers they paid into,
but can never *win* them.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .evaluator import best_hand
from .player import Player, Status


@dataclass
class Pot:
    amount: int
    eligible: list[str] = field(default_factory=list)  # player ids who can win


def return_uncalled(game) -> None:
    """Hand back the slice of a bet that exceeded what anyone could call.
    e.g. you shove 400 into a foe with only 200 chips -- you get 200 back,
    so the pot is 400 (not 600). Call this once betting closes for the hand.
    """
    live = [p for p in game.players if p.in_hand]
    if len(live) < 2:
        return
    bets = sorted((p.round_bet for p in live), reverse=True)
    top = [p for p in live if p.round_bet == bets[0]]
    if bets[0] <= bets[1] or len(top) != 1:
        return                       # bet was matched (or tied) -- nothing owed
    p, refund = top[0], bets[0] - bets[1]
    p.stack += refund
    p.round_bet -= refund
    p.committed -= refund
    if p.stack > 0 and p.status == Status.ALL_IN:
        p.status = Status.ACTIVE      # got chips back -> no longer all-in
    game.current_bet = bets[1]
    game._log(f"Uncalled {refund} returned to {p.name}")


def build_pots(players: list[Player]) -> list[Pot]:
    """Build main + side pots from each player's `committed` chips."""
    contrib = {p.id: p.committed for p in players if p.committed > 0}
    folded = {p.id for p in players if p.status == Status.FOLDED}
    pots: list[Pot] = []

    while contrib:
        level = min(contrib.values())
        funders = list(contrib.keys())
        amount = level * len(funders)
        eligible = [pid for pid in funders if pid not in folded]
        pots.append(Pot(amount=amount, eligible=eligible))
        for pid in funders:
            contrib[pid] -= level
            if contrib[pid] == 0:
                del contrib[pid]

    # Merge adjacent pots that share the exact same eligibility set -- purely
    # cosmetic so the UI shows "Main pot" instead of three identical slivers.
    merged: list[Pot] = []
    for pot in pots:
        if merged and set(merged[-1].eligible) == set(pot.eligible):
            merged[-1].amount += pot.amount
        else:
            merged.append(pot)
    return merged


def settle(players: list[Player], board: list) -> dict:
    """Distribute every pot to its winner(s).

    Returns a result dict: {pot_index: {"winners": [ids], "amount_each": n,
    "score": tuple}} and credits each winner's stack in place.
    """
    by_id = {p.id: p for p in players}
    pots = build_pots(players)
    results = []

    # Pre-compute each contender's best hand once.
    scores: dict[str, tuple] = {}
    for p in players:
        if p.in_hand and p.hole:
            scores[p.id] = best_hand(p.hole + board)

    for i, pot in enumerate(pots):
        contenders = [pid for pid in pot.eligible if pid in scores]
        if not contenders:
            continue
        best = max(scores[pid] for pid in contenders)
        winners = [pid for pid in contenders if scores[pid] == best]
        share = pot.amount // len(winners)
        remainder = pot.amount - share * len(winners)
        for j, pid in enumerate(winners):
            payout = share + (1 if j < remainder else 0)  # odd chip to first seat(s)
            by_id[pid].stack += payout
        results.append({
            "pot": i,
            "amount": pot.amount,
            "winners": winners,
            "amount_each": share,
            "score": best,
        })
    return {"pots": results}
