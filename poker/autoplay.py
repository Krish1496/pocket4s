"""Away mode, queued pre-moves, and auto check/fold.

Kept out of the core betting engine so game.py stays focused on running a
hand. Every function operates on a Game instance.
"""
from __future__ import annotations

from .settings import SEAT_COUNT


def set_away(game, pid: str, value: bool) -> None:
    p = _seated(game, pid)
    if not value:
        p.away = False
        p.away_pending = False
        return
    # Turning away ON: if they're in a LIVE hand, let them finish it first --
    # don't auto-fold. Otherwise take effect immediately.
    if p.in_hand and game.phase.value != "waiting":
        p.away_pending = True
    else:
        p.away = True


def set_auto_check_fold(game, pid: str, value: bool) -> None:
    _seated(game, pid).auto_check_fold = bool(value)


def set_premove(game, pid: str, move: str | None) -> None:
    if move not in (None, "check", "call", "checkfold", "fold"):
        raise ValueError("Unknown pre-move")
    p = _seated(game, pid)
    p.premove = move
    p.premove_level = game.current_bet      # remember the bet you agreed to


def auto_advance(game) -> bool:
    """Resolve all pending auto actions at once (used by tests). The server
    instead paces them with `step` + `pending` so each shows briefly."""
    acted = False
    for _ in range(SEAT_COUNT * 2):
        if not step(game):
            break
        acted = True
    return acted


def pending(game) -> bool:
    """True if whoever is to act has something automatic queued."""
    if game.to_act is None:
        return False
    p = game.get(game.to_act)
    if p is None:
        return False
    return bool(p.away or p.auto_check_fold or p.premove)


def step(game) -> bool:
    """Apply at most one auto action. Returns True if a move was made."""
    if game.to_act is None:
        return False
    p = game.get(game.to_act)
    if p is None:
        return False
    mv = _auto_move_for(game, p)
    if mv is None:
        return False
    game.act(p.id, mv)
    return True


def _auto_move_for(game, p) -> str | None:
    to_call = game.current_bet - p.round_bet
    if p.away or p.auto_check_fold:
        return "check" if to_call <= 0 else "fold"
    pm = p.premove
    if not pm:
        return None
    p.premove = None                          # one-shot
    if pm == "fold":
        return "fold"                         # pre-fold: give it up when it's on you
    if pm == "check":
        return "check" if to_call <= 0 else None   # cancelled: a bet came in
    if pm == "call":
        if game.current_bet > p.premove_level:
            return None                       # someone bet more -> you decide
        return "call" if to_call > 0 else "check"
    if pm == "checkfold":
        return "check" if to_call <= 0 else "fold"
    return None


def _seated(game, pid: str):
    p = game.get(pid)
    if not p:
        raise ValueError("Sit down first")
    return p
