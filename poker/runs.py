"""Run It Twice (or thrice... up to 5x).

When the betting is closed but >=2 players are all-in with board cards
still to come, players may agree to run the remaining board several times.
Everyone still in the hand votes 1-5; the *minimum* vote wins. The pot is
split into that many equal parts -- each runout is dealt + evaluated
independently and pays out its share to that run's winner(s).

Kept separate from game.py so the core engine stays lean. Every function
takes the Game instance.
"""
from __future__ import annotations

from .evaluator import best_hand
from .potting import build_pots

MAX_RUNS = 5


def should_offer(game) -> bool:
    """All-in runout with cards still to come and the feature switched on?"""
    if not game.settings.run_it_twice:
        return False
    if len(game.board) >= 5:
        return False
    in_hand = [p for p in game.players if p.in_hand]
    if len(in_hand) < 2:
        return False
    # At least one player is all-in (otherwise normal play continues).
    return any(p.status.value == "all_in" for p in in_hand)


def _cards_per_run(game) -> int:
    return (5 - len(game.board)) * 2  # +1 burn per board card dealt


def max_runs(game) -> int:
    if game.deck is None:
        return 1
    per = max(1, _cards_per_run(game))
    return max(1, min(MAX_RUNS, len(game.deck) // per))


def offer(game) -> None:
    """Pause the hand and open voting. Disconnected players auto-vote 1 so a
    missing player can never stall the table."""
    voters = [p.id for p in game.players if p.in_hand]
    votes = {p.id: (None if p.connected else 1)
             for p in game.players if p.in_hand}
    game.run_vote = {"voters": voters, "votes": votes, "max": max_runs(game)}
    game._set_to_act(None)
    game._log("All in! Players are choosing how many times to run it.")
    _maybe_resolve(game)


def vote(game, pid: str, times: int) -> None:
    rv = game.run_vote
    if not rv or pid not in rv["votes"]:
        raise ValueError("There's no run-it-twice vote for you right now")
    rv["votes"][pid] = max(1, min(rv["max"], int(times)))
    game._log(f"{game.get(pid).name} wants to run it {rv['votes'][pid]}x")
    _maybe_resolve(game)


def _maybe_resolve(game) -> None:
    rv = game.run_vote
    if any(v is None for v in rv["votes"].values()):
        return  # still waiting on someone
    n = min(rv["votes"].values())
    game.run_vote = None
    resolve(game, n)


def resolve(game, n: int) -> None:
    """Deal + settle `n` runs of the remaining board."""
    n = max(1, min(max_runs(game), n))
    base = list(game.board)
    boards = []
    for _ in range(n):
        b = list(base)
        while len(b) < 5:
            game.deck.deal_one()          # burn, as tradition demands
            b += game.deck.deal(1)
        boards.append(b)
    game.run_boards = boards
    game.board = boards[0]                 # main board shows run #1
    game.last_results = _settle_runs(game, boards)
    for i, b in enumerate(boards, 1):
        label = f"Run {i}: " if n > 1 else "Runout: "
        game._log(label + " ".join(c.code for c in b))
    game._finish_showdown()


def _settle_runs(game, boards: list) -> dict:
    """Split every pot into len(boards) equal shares and pay each run's
    winner(s). Returns aggregate pots (for the banner/glow) plus per-run
    detail (for the stacked board display)."""
    pots = build_pots(game.players)
    n = len(boards)
    totals: dict[str, int] = {}
    runs_out = []

    for run_i, board in enumerate(boards):
        scores = {p.id: best_hand(p.hole + board)
                  for p in game.players if p.in_hand and p.hole}
        run_pots = []
        for pot in pots:
            contenders = [pid for pid in pot.eligible if pid in scores]
            if not contenders:
                continue
            share_pot = pot.amount // n
            extra = pot.amount - share_pot * n
            this = share_pot + (1 if run_i < extra else 0)  # odd chips early
            best = max(scores[pid] for pid in contenders)
            winners = [pid for pid in contenders if scores[pid] == best]
            each = this // len(winners)
            rem = this - each * len(winners)
            for j, pid in enumerate(winners):
                pay = each + (1 if j < rem else 0)
                game.get(pid).stack += pay
                totals[pid] = totals.get(pid, 0) + pay
            run_pots.append({"amount": this, "winners": winners,
                             "amount_each": each, "score": best})
        runs_out.append({"board": [c.code for c in board], "pots": run_pots})

    agg = [{"pot": i, "amount": amt, "winners": [pid],
            "amount_each": amt, "score": None}
           for i, (pid, amt) in enumerate(totals.items())]
    return {"pots": agg, "runs": runs_out, "run_count": n}
