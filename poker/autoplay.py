"""Away mode, queued pre-moves, and auto check/fold.

Kept out of the core betting engine so game.py stays focused on running a
hand. Every function operates on a Game instance.
"""
from __future__ import annotations

from .settings import SEAT_COUNT


def set_away(game, pid: str, value: bool) -> None:
    _seated(game, pid).away = bool(value)


def set_auto_check_fold(game, pid: str, value: bool) -> None:
    _seated(game, pid).auto_check_fold = bool(value)


def set_premove(game, pid: str, move: str | None) -> None:
    if move not in (None, "check", "call", "checkfold"):
        raise ValueError("Unknown pre-move")
    _seated(game, pid).premove = move


def auto_advance(game) -> bool:
    """Resolve automatic actions for whoever is to act: away players, auto
    check/fold mode, or a queued pre-move. Loops because one auto action can
    hand the turn to another auto player."""
    acted = False
    for _ in range(SEAT_COUNT * 2):
        if game.to_act is None:
            break
        p = game.get(game.to_act)
        if p is None:
            break
        mv = _auto_move_for(game, p)
        if mv is None:
            break
        game.act(p.id, mv)
        acted = True
    return acted


def _auto_move_for(game, p) -> str | None:
    to_call = game.current_bet - p.round_bet
    if p.away or p.auto_check_fold:
        return "check" if to_call <= 0 else "fold"
    pm = p.premove
    if not pm:
        return None
    p.premove = None                          # one-shot
    if pm == "check":
        return "check" if to_call <= 0 else None   # cancelled: a bet came in
    if pm == "call":
        return "call" if to_call > 0 else "check"
    if pm == "checkfold":
        return "check" if to_call <= 0 else "fold"
    return None


def _seated(game, pid: str):
    p = game.get(pid)
    if not p:
        raise ValueError("Sit down first")
    return p
