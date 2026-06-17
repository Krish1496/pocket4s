"""Turn game state into JSON snapshots for the browser.

Crucial rule: a player only ever sees their OWN hole cards until
showdown. Everyone's cards are revealed once the hand reaches showdown
(among players still in the hand). This is built per-viewer.
"""
from __future__ import annotations

from poker.game import Game, Phase
from poker.evaluator import describe
from poker.player import Status


def _player_view(g: Game, p, viewer_id: str) -> dict:
    show_cards = (
        p.id == viewer_id
        or (g.phase == Phase.SHOWDOWN and p.in_hand and p.hole)
    )
    return {
        "id": p.id,
        "name": p.name,
        "seat": p.seat,
        "stack": p.stack,
        "round_bet": p.round_bet,
        "committed": p.committed,
        "status": p.status.value,
        "connected": p.connected,
        "is_button": g.players.index(p) == g.button if g.players else False,
        "is_turn": g.to_act == p.id,
        "hole": [c.code for c in p.hole] if show_cards else (
            ["back", "back"] if p.in_hand and p.hole else []),
    }


def snapshot(g: Game, viewer_id: str) -> dict:
    viewer = g.get(viewer_id)
    to_call = 0
    min_raise_to = 0
    if viewer and g.to_act == viewer_id:
        to_call = max(0, g.current_bet - viewer.round_bet)
        min_raise_to = g.current_bet + g.min_raise

    results = None
    if g.last_results:
        results = {"pots": [{
            **r,
            "winner_names": [g.get(w).name for w in r["winners"] if g.get(w)],
            "hand_name": describe(r["score"]) if r.get("score") else None,
        } for r in g.last_results["pots"]]}

    return {
        "type": "state",
        "phase": g.phase.value,
        "hand_no": g.hand_no,
        "board": [c.code for c in g.board],
        "pot": g.pot_total(),
        "current_bet": g.current_bet,
        "blinds": {"sb": g.sb, "bb": g.bb},
        "to_act": g.to_act,
        "button_seat": g.players[g.button].seat if g.players else None,
        "players": [_player_view(g, p, viewer_id) for p in g.players],
        "you": {
            "id": viewer_id,
            "to_call": to_call,
            "min_raise_to": min_raise_to,
            "can_check": viewer is not None and g.to_act == viewer_id and to_call == 0,
            "stack": viewer.stack if viewer else 0,
            "in_hand": viewer.in_hand if viewer else False,
        },
        "can_start": g.can_start(),
        "log": g.log[-25:],
        "results": results,
    }
