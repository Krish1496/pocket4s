"""Turn game state into JSON snapshots for the browser.

Rules:
- A player only sees their OWN hole cards until showdown (then all live
  hands reveal).
- Only the host sees the pending buy-in request queue + host controls.
"""
from __future__ import annotations

from poker.game import Game, Phase
from poker.evaluator import describe, describe_detail, best_hand
from poker.settings import SEAT_COUNT


def _pot_view(g: Game, r: dict) -> dict:
    return {**r,
            "winner_names": [g.get(w).name for w in r["winners"] if g.get(w)],
            "hand_name": describe(r["score"]) if r.get("score") else None}


def _hand_name(g: Game, p) -> str | None:
    if not p.hole or len(g.board) < 3:
        return None
    cards = list(p.hole) + list(g.board)
    if len(cards) < 5:
        return None
    return describe_detail(best_hand(cards))


def _player_view(g: Game, p, viewer_id: str) -> dict:
    show = (p.id == viewer_id
            or (g.phase == Phase.SHOWDOWN and p.in_hand and p.hole)
            or (g.run_vote and p.in_hand and p.hole))   # cards up while voting
    return {
        "id": p.id,
        "name": p.name,
        "seat": p.seat,
        "stack": p.stack,
        "round_bet": p.round_bet,
        "committed": p.committed,
        "status": p.status.value,
        "connected": p.connected,
        "away": p.away,
        "pending_topup": p.pending_topup,
        "is_button": g.players.index(p) == g.button if g.players else False,
        "is_turn": g.to_act == p.id,
        "is_owner": g.owner == p.id,
        "hole": [c.code for c in p.hole] if show else (
            ["back", "back"] if p.in_hand and p.hole else []),
        "hand_name": _hand_name(g, p) if show else None,
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
        results = {"pots": [_pot_view(g, r) for r in g.last_results["pots"]]}
        if g.last_results.get("runs"):
            results["run_count"] = g.last_results.get("run_count", 1)
            results["runs"] = [
                {"board": run["board"],
                 "pots": [_pot_view(g, rp) for rp in run["pots"]]}
                for run in g.last_results["runs"]]

    run_vote = None
    if g.run_vote:
        rv = g.run_vote
        run_vote = {
            "max": rv["max"],
            "your_turn": rv["votes"].get(viewer_id) is None and viewer_id in rv["votes"],
            "your_vote": rv["votes"].get(viewer_id),
            "voters": [{"name": g.get(pid).name if g.get(pid) else "?",
                        "vote": rv["votes"][pid]} for pid in rv["voters"]],
        }

    # Owner sees the full request queue; others only see their own request.
    if is_owner:
        requests = g.requests
    else:
        requests = [r for r in g.requests if r["id"] == viewer_id]

    return {
        "type": "state",
        "phase": g.phase.value,
        "paused": getattr(g, "paused", False),
        "hand_no": g.hand_no,
        "board": [c.code for c in g.board],
        "rabbit": [c.code for c in g.rabbit_board],
        "run_vote": run_vote,
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
            "away": viewer.away if viewer else False,
            "auto_check_fold": viewer.auto_check_fold if viewer else False,
            "premove": viewer.premove if viewer else None,
        },
        "can_start": g.can_start(),
        "hand_log": g.hand_log[-40:],
        "chat_log": g.chat_log[-40:],
        "results": results,
    }
