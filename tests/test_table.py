"""Tests for table management: ownership, seating, buy-ins, ledger, extras."""
import pytest

from poker.game import Game, Phase
from poker.settings import TableSettings
from poker.cards import Card
from poker.extras import is_72_offsuit


def make_table(**kw):
    defaults = dict(small_blind=1, big_blind=2, default_buyin=200,
                    min_buyin=40, max_buyin=1000)
    defaults.update(kw)
    return Game(settings=TableSettings(**defaults), seed=42)


def test_first_member_is_owner():
    g = make_table()
    g.register_member("a", "Alice")
    g.register_member("b", "Bob")
    assert g.owner == "a"
    assert g.is_owner("a")
    assert not g.is_owner("b")


def test_owner_sits_instantly_other_needs_approval():
    g = make_table()
    g.register_member("a", "Alice")
    g.register_member("b", "Bob")
    g.request_sit("a", seat=0, amount=200)   # owner: instant
    g.request_sit("b", seat=1, amount=150)   # other: queued
    assert g.get("a") is not None
    assert g.get("b") is None
    assert len(g.requests) == 1
    g.approve_request("a", "b")
    assert g.get("b") is not None
    assert g.get("b").stack == 150
    assert len(g.requests) == 0


def test_non_owner_cannot_approve():
    g = make_table()
    g.register_member("a", "Alice")
    g.register_member("b", "Bob")
    g.request_sit("b", seat=1, amount=150)
    with pytest.raises(ValueError):
        g.approve_request("b", "b")  # Bob isn't the host


def test_buyin_clamped_to_limits():
    g = make_table(min_buyin=50, max_buyin=300)
    g.register_member("a", "Alice")
    g.request_sit("a", seat=0, amount=99999)
    assert g.get("a").stack == 300
    g.register_member("b", "Bob")
    g.request_sit("b", seat=1, amount=1)
    g.approve_request("a", "b")
    assert g.get("b").stack == 50


def test_seat_choice_respected_and_conflict_handled():
    g = make_table()
    g.register_member("a", "Alice")
    g.request_sit("a", seat=3, amount=200)
    assert g.get("a").seat == 3
    g.register_member("b", "Bob")
    with pytest.raises(ValueError):
        g.request_sit("b", seat=3, amount=200)  # taken


def test_topup_applies_between_hands_only():
    g = make_table()
    for pid, name in [("a", "Alice"), ("b", "Bob")]:
        g.register_member(pid, name)
    g.request_sit("a", 0, 200)
    g.request_sit("b", 1, 200)
    g.approve_request("a", "b")
    g.start_hand()
    # Owner top-up mid-hand should be pending, not instant.
    g.request_topup("a", 100)
    assert g.get("a").pending_topup == 100
    # Finish the hand quickly: everyone folds to one.
    # Drive to showdown by folding around.
    guard = 0
    while g.phase != Phase.SHOWDOWN and guard < 20:
        g.act(g.to_act, "fold")
        guard += 1
    g.end_hand()
    g.start_hand()
    assert g.get("a").pending_topup == 0  # applied


def test_ledger_tracks_net():
    g = make_table()
    g.register_member("a", "Alice")
    g.register_member("b", "Bob")
    g.request_sit("a", 0, 200)
    g.request_sit("b", 1, 200)
    g.approve_request("a", "b")
    rows = g.ledger.rows(g.live_stacks())
    assert {r["id"] for r in rows} == {"a", "b"}
    assert all(r["bought_in"] == 200 and r["net"] == 0 for r in rows)
    # Move chips: give Alice 50 of Bob's via a stack edit each.
    g.owner_set_stack("a", "a", 250)
    # Net for Alice = 250 - (200 buyin + 50 adjustment) = 0; stack edits are
    # treated as buy-ins so the ledger stays honest.
    arow = next(r for r in g.ledger.rows(g.live_stacks()) if r["id"] == "a")
    assert arow["bought_in"] == 250
    assert arow["net"] == 0


def test_72_offsuit_detection():
    assert is_72_offsuit([Card.from_str("7h"), Card.from_str("2c")])
    assert not is_72_offsuit([Card.from_str("7h"), Card.from_str("2h")])  # suited
    assert not is_72_offsuit([Card.from_str("8h"), Card.from_str("2c")])


def test_ante_adds_to_pot():
    g = make_table(ante=5)
    for pid, name in [("a", "Alice"), ("b", "Bob"), ("c", "Cara")]:
        g.register_member(pid, name)
    g.request_sit("a", 0, 200)
    g.request_sit("b", 1, 200)
    g.request_sit("c", 2, 200)
    g.approve_request("a", "b")
    g.approve_request("a", "c")
    g.start_hand()
    # 3 antes (15) + sb(1) + bb(2) = 18
    assert g.pot_total() == 18


def test_settings_update_owner_only():
    g = make_table()
    g.register_member("a", "Alice")
    g.register_member("b", "Bob")
    g.owner_set_settings("a", big_blind=10, rabbit_hunting=False)
    assert g.bb == 10
    assert g.settings.rabbit_hunting is False
    with pytest.raises(ValueError):
        g.owner_set_settings("b", big_blind=999)


def _seat_two(g):
    for pid, name in [("a", "Alice"), ("b", "Bob")]:
        g.register_member(pid, name)
    g.request_sit("a", 0, 200)
    g.request_sit("b", 1, 200)
    g.approve_request("a", "b")


def test_chat_is_structured_for_colouring():
    g = make_table()
    g.register_member("a", "Alice")
    g.chat("a", "nice hand")
    entry = g.chat_log[-1]
    assert entry["id"] == "a" and entry["name"] == "Alice"
    assert entry["text"] == "nice hand"
    assert entry["n"] >= 1  # monotonic id so the client can spot new msgs


def test_turn_clock_set_and_cleared():
    g = make_table(action_timeout=30)
    _seat_two(g)
    g.start_hand()
    assert g.to_act is not None
    assert g.time_left() is not None and g.time_left() > 0
    seq_before = g.turn_seq
    g.act(g.to_act, "fold")  # ends heads-up hand -> showdown
    assert g.turn_seq > seq_before
    assert g.time_left() is None  # clock cleared at showdown


def test_timeout_disabled_means_no_clock():
    g = make_table(action_timeout=0)
    _seat_two(g)
    g.start_hand()
    assert g.time_left() is None


def test_auto_act_folds_when_facing_bet():
    g = make_table(action_timeout=30)
    _seat_two(g)
    g.start_hand()
    # Heads-up preflop: button/SB faces the BB, so timing out should FOLD.
    actor = g.to_act
    assert g.auto_act_timeout() is True
    assert g.get(actor).status.value == "folded"


def test_room_timer_auto_acts_after_deadline():
    """Integration: the Room's async clock auto-acts when time runs out."""
    import asyncio
    from server.rooms import Room

    g = make_table(action_timeout=1)
    _seat_two(g)
    room = Room(table_id="t", game=g)

    async def run():
        g.start_hand()
        actor = g.to_act
        room._arm_timer()
        await asyncio.sleep(1.8)  # let the 1s clock + grace elapse
        return actor

    actor = asyncio.run(run())
    assert g.get(actor).status.value == "folded"


def test_room_auto_deal_starts_next_hand():
    """With auto-deal on, the room deals the next hand after showdown."""
    import asyncio
    from server.rooms import Room

    g = make_table(auto_deal=True, action_timeout=0)
    _seat_two(g)
    room = Room(table_id="t", game=g)
    room.AUTODEAL_DELAY = 0.3  # speed up for the test

    async def run():
        g.start_hand()
        h1 = g.hand_no
        g.act(g.to_act, "fold")  # heads-up fold -> showdown
        assert g.phase.value == "showdown"
        room._arm_autodeal()
        await asyncio.sleep(0.7)
        return h1

    h1 = asyncio.run(run())
    assert g.hand_no == h1 + 1
    assert g.phase.value == "preflop"


def test_next_hand_not_blocked_by_a_reconnect_blip():
    """A brief disconnect must not stop the next hand from dealing."""
    g = make_table(action_timeout=0)
    _seat_two(g)
    g.start_hand()
    g.get("b").connected = False        # heartbeat blip
    g.act(g.to_act, "fold")
    assert g.phase.value == "showdown"
    assert len(g.seated_with_chips()) == 2   # blip doesn't drop the player
    g.end_hand()
    assert g.can_start()                 # not blocked by the blip
    g.start_hand()
    assert g.phase.value == "preflop"


def test_rabbit_hunt_is_on_demand():
    g = make_table(action_timeout=0, rabbit_hunting=True)
    _seat_two(g)
    g.start_hand()
    g.act(g.to_act, "fold")              # folded out preflop
    assert g.phase.value == "showdown" and len(g.board) < 5
    assert g.rabbit_board == []          # nothing auto-revealed
    g.reveal_rabbit("a")
    assert len(g.board) + len(g.rabbit_board) == 5


def test_rabbit_hunt_blocked_when_setting_off():
    g = make_table(action_timeout=0, rabbit_hunting=False)
    _seat_two(g)
    g.start_hand()
    g.act(g.to_act, "fold")
    with pytest.raises(ValueError):
        g.reveal_rabbit("a")


def test_away_player_is_sat_out_on_reset():
    g = make_table()
    _seat_two(g)
    g.get("b").away = True
    g.get("a").reset_for_hand()
    g.get("b").reset_for_hand()
    assert g.get("a").status.value == "active"
    assert g.get("b").status.value == "sitting_out"


def test_auto_check_fold_folds_facing_a_bet():
    g = make_table(action_timeout=0)
    _seat_two(g)
    g.start_hand()
    actor = g.to_act                 # button/SB preflop, faces the BB
    g.set_auto_check_fold(actor, True)
    g.auto_advance()
    assert g.phase.value == "showdown"  # auto-folded -> hand over


def test_premove_call_fires_on_your_turn():
    g = make_table(action_timeout=0)
    _seat_two(g)
    g.start_hand()
    actor = g.to_act
    g.set_premove(actor, "call")
    g.auto_advance()
    assert g.get(actor).round_bet == g.current_bet  # called the blind
    assert g.to_act != actor                        # turn moved on


def test_bad_premove_is_rejected():
    g = make_table()
    _seat_two(g)
    with pytest.raises(ValueError):
        g.set_premove("a", "raise")


def test_precall_cancels_if_bet_rises_above_queued_level():
    from poker import autoplay
    g = make_table(action_timeout=0)
    _seat_two(g)
    g.start_hand()
    p = g.get(g.to_act)
    g.set_premove(p.id, "call")            # agree to the current bet
    g.current_bet += g.settings.big_blind * 3   # someone shoves bigger
    assert autoplay.step(g) is False       # pre-call does NOT fire
    assert p.premove is None               # and it's consumed


def test_pause_requires_owner_and_toggles():
    g = make_table()
    _seat_two(g)
    with pytest.raises(ValueError):
        g.set_paused("b", True)        # not the owner
    g.set_paused("a", True)
    assert g.paused is True
    g.set_paused("a", False)
    assert g.paused is False


def test_describe_detail_labels():
    from poker.evaluator import describe_detail, HIGH_CARD, PAIR, TWO_PAIR, STRAIGHT
    assert describe_detail((HIGH_CARD, 14, 13, 12, 11, 9)).startswith("High Card")
    assert describe_detail((PAIR, 13, 14, 12, 11)).startswith("Pair (K")
    assert "Two Pair" in describe_detail((TWO_PAIR, 14, 7, 5))
    assert "Straight" in describe_detail((STRAIGHT, 10))


def test_hand_name_appears_in_snapshot_for_your_own_cards():
    from server.serialize import snapshot
    g = make_table(action_timeout=0)
    _seat_two(g)
    g.start_hand()
    # Deal a flop so there are >= 5 cards to evaluate.
    g.act(g.to_act, "call")
    g.act(g.to_act, "check")
    snap = snapshot(g, "a")
    me = next(p for p in snap["players"] if p["id"] == "a")
    assert me["hand_name"] is not None


def _drive_all_in_heads_up(g):
    """Both players jam preflop -> the hand is now all-in with cards to come."""
    g.start_hand()
    actor = g.get(g.to_act)
    g.act(actor.id, "raise", actor.round_bet + actor.stack)   # shove
    g.act(g.to_act, "call")                                   # call it off


def test_run_it_twice_offered_on_all_in():
    g = make_table(action_timeout=0, run_it_twice=True)
    _seat_two(g)
    _drive_all_in_heads_up(g)
    assert g.run_vote is not None
    assert g.phase != Phase.SHOWDOWN          # paused for the vote
    assert set(g.run_vote["votes"]) == {"a", "b"}


def test_run_it_twice_uses_minimum_vote_and_conserves_chips():
    g = make_table(action_timeout=0, run_it_twice=True)
    _seat_two(g)
    _drive_all_in_heads_up(g)
    g.set_run_vote("a", 3)
    g.set_run_vote("b", 2)                    # minimum (2) wins
    assert g.phase == Phase.SHOWDOWN
    assert g.last_results["run_count"] == 2
    assert len(g.run_boards) == 2
    assert all(len(b) == 5 for b in g.run_boards)
    assert sum(p.stack for p in g.players) == 400   # every chip paid back


def test_no_run_it_twice_when_disabled():
    g = make_table(action_timeout=0, run_it_twice=False)
    _seat_two(g)
    _drive_all_in_heads_up(g)
    assert g.run_vote is None
    assert g.phase == Phase.SHOWDOWN          # ran out once, normally
