"""Sanity tests for the hand evaluator. Correctness here is non-negotiable."""
from poker.cards import Card
from poker.evaluator import (
    best_hand, score_5, describe,
    HIGH_CARD, PAIR, TWO_PAIR, TRIPS, STRAIGHT, FLUSH,
    FULL_HOUSE, QUADS, STRAIGHT_FLUSH,
)


def H(*codes):
    return [Card.from_str(c) for c in codes]


def cat(codes):
    return score_5(H(*codes))[0]


def test_categories_detected():
    assert cat(["As", "Ks", "Qs", "Js", "Ts"]) == STRAIGHT_FLUSH
    assert cat(["9h", "9d", "9c", "9s", "2d"]) == QUADS
    assert cat(["8h", "8d", "8c", "Ks", "Kd"]) == FULL_HOUSE
    assert cat(["2h", "5h", "9h", "Jh", "Kh"]) == FLUSH
    assert cat(["5h", "6d", "7c", "8s", "9d"]) == STRAIGHT
    assert cat(["7h", "7d", "7c", "Ks", "2d"]) == TRIPS
    assert cat(["7h", "7d", "9c", "9s", "2d"]) == TWO_PAIR
    assert cat(["7h", "7d", "9c", "Js", "2d"]) == PAIR
    assert cat(["2h", "5d", "9c", "Js", "Kd"]) == HIGH_CARD


def test_wheel_straight():
    # A-2-3-4-5 is the lowest straight; ace plays low.
    s = score_5(H("Ah", "2d", "3c", "4s", "5d"))
    assert s[0] == STRAIGHT
    assert s[1] == 5  # five-high, not ace-high


def test_wheel_straight_flush():
    s = score_5(H("Ah", "2h", "3h", "4h", "5h"))
    assert s[0] == STRAIGHT_FLUSH
    assert s[1] == 5


def test_flush_beats_straight():
    flush = score_5(H("2h", "5h", "9h", "Jh", "Kh"))
    straight = score_5(H("5h", "6d", "7c", "8s", "9d"))
    assert flush > straight


def test_higher_pair_wins():
    aces = score_5(H("Ah", "Ad", "5c", "7s", "9d"))
    kings = score_5(H("Kh", "Kd", "5c", "7s", "9d"))
    assert aces > kings


def test_kicker_breaks_tie():
    ace_kicker = score_5(H("Ah", "Ad", "Kc", "7s", "9d"))
    queen_kicker = score_5(H("Ac", "As", "Qc", "7h", "9h"))
    assert ace_kicker > queen_kicker


def test_best_of_seven():
    # 7 cards: should pick the flush over lesser made hands.
    cards = H("As", "Ks", "Qs", "2h", "3d", "5s", "9s")
    score = best_hand(cards)
    assert score[0] == FLUSH


def test_seven_card_full_house():
    cards = H("Kh", "Kd", "Kc", "2s", "2d", "7h", "9c")
    assert best_hand(cards)[0] == FULL_HOUSE


def test_describe_runs():
    assert "Full House" in describe(score_5(H("8h", "8d", "8c", "Ks", "Kd")))
