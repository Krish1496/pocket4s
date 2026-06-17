"""Turn game state into JSON snapshots for the browser.

Rules:
- A player only sees their OWN hole cards until showdown (then all live
  hands reveal).
- Only the host sees the pending buy-in request queue + host controls.
"""
from __future__ import annotations

from poker.game import Game, Phase
from poker.evaluator import describe
from poker.settings import SEAT_COUNT


def _player_view(g: Game, p, viewer_id: str) -> dict:
    show = (p.id == viewer_id
            or (g.phase == Phase.SHOWDOWN and p.in_hand and p.hole))
    return {
        "id": p.id,
        "name": p.name,
        "seat": p.seat,
        "stack": p.stack,
        "round_bet": p.round_bet,
        "committed": p.committed,
        "status": p.status.value,
        "connected": p.connected,
        "pending_topup": p.pending_topup,
        "is_button": g.players.index(p) == g.button if g.players else False,
        "is_turn": g.to_act == p.id,
        "is_owner": g.owner == p.id,
        "hole": [c.code for c in p.hole] if show else (
            ["back", "back"] if p.in_hand and p.hole else []),
    }


def snapshot(g: Game, viewer_id: str) -> dict:
    viewer = g.get(viewer_id)
    is_owner = g.is_owner(viewer_id)
    to_call = min_raise_to = 0
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

    # Owner sees the full request queue; others only see their own request.
    if is_owner:
        requests = g.requests
    else:
        requests = [r for r in g.requests if r["id"] == viewer_id]

    return {
        "type": "state",
        "phase": g.phase.value,
        "hand_no": g.hand_no,
        "board": [c.code for c in g.board],
        "rabbit": [c.code for c in g.rabbit_board],
        "pot": g.pot_total(),
        "current_bet": g.current_bet,
        "settings": g.settings.to_dict(),
        "to_act": g.to_act,
        "turn_seconds_left": g.time_left(),
        "action_timeout": g.settings.action_timeout,
        "turn_seq": g.turn_seq,
        "seat_count": SEAT_COUNT,
        "open_seats": g.open_seats(),
        "owner": g.owner,
        "players": [_player_view(g, p, viewer_id) for p in g.players],
        "requests": requests,
        "ledger": g.ledger.rows(g.live_stacks()),
        "you": {
            "id": viewer_id,
            "seated": viewer is not None,
            "is_owner": is_owner,
            "seat": viewer.seat if viewer else None,
            "to_call": to_call,
            "min_raise_to": min_raise_to,
            "can_check": viewer is not None and g.to_act == viewer_id and to_call == 0,
            "stack": viewer.stack if viewer else 0,
            "in_hand": viewer.in_hand if viewer else False,
        },
        "can_start": g.can_start(),
        "hand_log": g.hand_log[-40:],
        "chat_log": g.chat_log[-40:],
        "results": results,
    }
