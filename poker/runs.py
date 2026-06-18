"""Run It Twice (or thrice... up to 5x) + the paced all-in runout.

When the betting is closed but >=2 players are all-in with board cards
still to come, players may agree to run the remaining board several times.
Everyone still in the hand votes 1-5; the *minimum* vote wins. The pot is
split into that many equal parts -- each runout is dealt + evaluated
independently and pays out its share to that run's winner(s).

The board is then revealed ONE STREET AT A TIME (flop, pause, turn,
pause, river, then the next run) so everyone can follow along. The pacing
delay is driven by the room; this module just exposes the next frame.

Kept separate from game.py so the core engine stays lean. Every function
takes the Game instance.
"""
from __future__ import annotations

from .evaluator import best_hand, describe
from .potting import build_pots, settle
from .equity import win_chances

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
    return any(p.status.value == "all_in" for p in in_hand)


def _cards_per_run(game) -> int:
    return (5 - len(game.board)) * 2  # +1 burn per board card dealt


def max_runs(game) -> int:
    if game.deck is None:
        return 1
    per = max(1, _cards_per_run(game))
    return max(1, min(MAX_RUNS, len(game.deck) // per))


def _recompute_equity(game) -> None:
    holes = {p.id: p.hole for p in game.players if p.in_hand and p.hole}
    game.equity = win_chances(holes, game.board)


# --- voting ------------------------------------------------------------
def offer(game) -> None:
    """Pause the hand and open voting. Disconnected players auto-vote 1 so a
    missing player can never stall the table."""
    voters = [p.id for p in game.players if p.in_hand]
    votes = {p.id: (None if p.connected else 1)
             for p in game.players if p.in_hand}
    game.run_vote = {"voters": voters, "votes": votes, "max": max_runs(game)}
    game._set_to_act(None)
    _recompute_equity(game)
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
    begin_runout(game, n)


# --- paced runout ------------------------------------------------------
def begin_runout(game, n: int) -> None:
    """Deal `n` full boards, then reveal them one street at a time."""
    n = max(1, min(max_runs(game), n))
    base = list(game.board)
    boards = []
    for _ in range(n):
        b = list(base)
        while len(b) < 5:
            game.deck.deal_one()          # burn, as tradition demands
            b += game.deck.deal(1)
        boards.append(b)
    frames = [(ri, b[:t]) for ri, b in enumerate(boards)
              for t in (3, 4, 5) if t > len(base)]
    game.runout = {"boards": boards, "frames": frames, "i": 0, "n": n,
                   "base": len(base)}   # cards shared by every run (already shown)
    game._set_to_act(None)
    if n > 1:
        game._log(f"All in -- running it {n} times")
    if not frames:                      # board already complete -> just settle
        _finalize(game)
        return
    _apply_frame(game)


def _apply_frame(game) -> None:
    ro = game.runout
    ri, board = ro["frames"][ro["i"]]
    game.board = board
    game.run_boards = [ro["boards"][k] for k in range(ri)]  # completed runs
    _recompute_equity(game)


def reveal_step(game) -> bool:
    """Advance the runout by one street. Returns True while more remain."""
    ro = game.runout
    if ro is None:
        return False
    ro["i"] += 1
    if ro["i"] >= len(ro["frames"]):
        _finalize(game)
        return False
    _apply_frame(game)
    return True


def finish_runout(game) -> None:
    """Reveal everything instantly (used by tests)."""
    while reveal_step(game):
        pass


def _finalize(game) -> None:
    ro = game.runout
    game.went_to_showdown = True   # all-in runout reveals every live hand
    boards, n = ro["boards"], ro["n"]
    game.run_boards = boards
    game.board = boards[0]
    if n == 1:
        game.last_results = settle(game.players, boards[0])
        for r in game.last_results["pots"]:
            names = ", ".join(game.get(w).name for w in r["winners"])
            game._log(f"{names} wins {r['amount']} with {describe(r['score'])}")
    else:
        game.last_results = _settle_runs(game, boards)
        for i, b in enumerate(boards, 1):
            game._log(f"Run {i}: " + " ".join(c.code for c in b))
    game.runout = None
    game.equity = {}
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
                game.get(pid).stack += each + (1 if j < rem else 0)
                totals[pid] = totals.get(pid, 0) + each + (1 if j < rem else 0)
            run_pots.append({"amount": this, "winners": winners,
                             "amount_each": each, "score": best})
        runs_out.append({"board": [c.code for c in board], "pots": run_pots})

    agg = [{"pot": i, "amount": amt, "winners": [pid],
            "amount_each": amt, "score": None}
           for i, (pid, amt) in enumerate(totals.items())]
    return {"pots": agg, "runs": runs_out, "run_count": n}
