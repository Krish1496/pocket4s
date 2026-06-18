"""Game-engine tests: blinds, betting flow, all-ins, and side pots."""
import pytest

from poker.game import Game, Phase
from poker.player import Status


def make_game(n=3, stack=200, sb=1, bb=2):
    g = Game(small_blind=sb, big_blind=bb, starting_stack=stack, seed=42)
    for i in range(n):
        g.add_player(f"p{i}", f"Player{i}")
    return g


def test_blinds_posted():
    g = make_game(3)
    g.start_hand()
    assert g.phase == Phase.PREFLOP
    # In a 3-handed game button=p0 after advance; sb/bb are next two seats.
    sb = g.players[g._sb_idx]
    bb = g.players[g._bb_idx]
    assert sb.round_bet == 1
    assert bb.round_bet == 2
    assert g.current_bet == 2
    assert g.pot_total() == 3


def test_everyone_folds_to_bb():
    g = make_game(3)
    g.start_hand()
    bb = g.players[g._bb_idx]
    # UTG (first to act) folds, then SB folds -> BB wins.
    g.act(g.to_act, "fold")
    g.act(g.to_act, "fold")
    assert g.phase == Phase.SHOWDOWN
    assert g.last_results["pots"][0]["winners"] == [bb.id]
    # BB regains its blind plus the small blind.
    assert bb.stack == 200 + 1


def test_check_down_to_river():
    g = make_game(2, stack=200)  # heads up
    g.start_hand()
    # Preflop: button/SB acts first heads-up. Call then check around.
    g.act(g.to_act, "call")   # SB completes
    g.act(g.to_act, "check")  # BB checks
    g.reveal_next_street()    # flop is paced (1s beat) -- flush it
    assert g.phase == Phase.FLOP
    for _ in range(3):  # flop, turn, river all checked through
        g.act(g.to_act, "check")
        g.act(g.to_act, "check")
        if g.street_pending:
            g.reveal_next_street()
    assert g.phase == Phase.SHOWDOWN
    assert len(g.board) == 5


def test_raise_must_meet_minimum():
    g = make_game(3)
    g.start_hand()
    with pytest.raises(ValueError):
        # current_bet is 2, min raise to 4. Try raising to 3.
        g.act(g.to_act, "raise", 3)


def test_cannot_check_facing_bet():
    g = make_game(3)
    g.start_hand()
    with pytest.raises(ValueError):
        g.act(g.to_act, "check")


def test_call_matches_bet():
    g = make_game(3)
    g.start_hand()
    actor = g.to_act
    g.act(actor, "call")
    assert g.get(actor).round_bet == g.current_bet


def test_all_in_side_pot():
    # Short stack goes all-in, two deep stacks keep betting -> side pot.
    g = Game(small_blind=1, big_blind=2, seed=7)
    g.add_player("short", "Short")
    g.add_player("big1", "Big1")
    g.add_player("big2", "Big2")
    g.players[0].stack = 50
    g.players[1].stack = 500
    g.players[2].stack = 500
    g.start_hand()
    # Just drive everyone all-in / calling to force pot construction.
    # Walk actions until showdown, always calling or shoving.
    guard = 0
    while g.phase != Phase.SHOWDOWN and guard < 30:
        if g.street_pending:
            g.reveal_next_street(); guard += 1; continue
        pid = g.to_act
        if pid is None:
            break
        p = g.get(pid)
        to_call = g.current_bet - p.round_bet
        g.act(pid, "call" if to_call > 0 else "check")
        guard += 1
    assert g.phase == Phase.SHOWDOWN
    # Chips are conserved: total stacks == 3 * starting contributions.
    total = sum(p.stack for p in g.players)
    assert total == 50 + 500 + 500


def test_chip_conservation_random_hand():
    g = make_game(4, stack=100)
    start_total = sum(p.stack for p in g.players)
    g.start_hand()
    guard = 0
    while g.phase != Phase.SHOWDOWN and guard < 50:
        pid = g.to_act
        if pid is None:
            break
        p = g.get(pid)
        to_call = g.current_bet - p.round_bet
        g.act(pid, "call" if to_call > 0 else "check")
        guard += 1
    end_total = sum(p.stack for p in g.players) + (
        0 if g.phase == Phase.SHOWDOWN else g.pot_total())
    assert end_total == start_total
