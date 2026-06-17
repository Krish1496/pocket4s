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
