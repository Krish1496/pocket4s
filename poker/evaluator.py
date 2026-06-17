"""Texas Hold'em hand evaluation.

Given up to 7 cards, find the best 5-card poker hand and return a
comparable score. Bigger score == better hand. We brute-force the 21
combinations of 5-from-7 -- dead simple, correct, and plenty fast for a
friendly table.

A score is a tuple: (category, tiebreaker_ranks...). Tuple comparison
does exactly what we want: compare category first, then kickers in order.
"""
from __future__ import annotations

from collections import Counter
from itertools import combinations

from .cards import Card, INT_TO_RANK

# Hand categories, low to high.
HIGH_CARD = 0
PAIR = 1
TWO_PAIR = 2
TRIPS = 3
STRAIGHT = 4
FLUSH = 5
FULL_HOUSE = 6
QUADS = 7
STRAIGHT_FLUSH = 8

CATEGORY_NAMES = {
    HIGH_CARD: "High Card",
    PAIR: "Pair",
    TWO_PAIR: "Two Pair",
    TRIPS: "Three of a Kind",
    STRAIGHT: "Straight",
    FLUSH: "Flush",
    FULL_HOUSE: "Full House",
    QUADS: "Four of a Kind",
    STRAIGHT_FLUSH: "Straight Flush",
}


def _straight_high(ranks: set[int]) -> int | None:
    """Return the high card of a straight made from `ranks`, or None.

    Handles the wheel (A-2-3-4-5) where the ace plays low.
    """
    if len(ranks) < 5:
        return None
    # Ace can be low for the wheel.
    rank_set = set(ranks)
    if 14 in rank_set:
        rank_set.add(1)
    ordered = sorted(rank_set, reverse=True)
    run = 1
    for i in range(1, len(ordered)):
        if ordered[i] == ordered[i - 1] - 1:
            run += 1
            if run >= 5:
                return ordered[i] + 4
        else:
            run = 1
    return None


def score_5(cards: list[Card]) -> tuple:
    """Score exactly 5 cards."""
    ranks = sorted((c.rank for c in cards), reverse=True)
    suits = [c.suit for c in cards]
    is_flush = len(set(suits)) == 1
    straight_high = _straight_high(set(ranks))

    counts = Counter(ranks)
    # Sort by (count, rank) so pairs/trips/quads float to the front.
    by_count = sorted(counts.items(), key=lambda kv: (kv[1], kv[0]), reverse=True)
    count_pattern = [cnt for _, cnt in by_count]
    ordered_ranks = [rank for rank, _ in by_count]

    if straight_high and is_flush:
        return (STRAIGHT_FLUSH, straight_high)
    if count_pattern[0] == 4:
        return (QUADS, ordered_ranks[0], ordered_ranks[1])
    if count_pattern[:2] == [3, 2]:
        return (FULL_HOUSE, ordered_ranks[0], ordered_ranks[1])
    if is_flush:
        return (FLUSH, *ranks)
    if straight_high:
        return (STRAIGHT, straight_high)
    if count_pattern[0] == 3:
        return (TRIPS, ordered_ranks[0], *ordered_ranks[1:])
    if count_pattern[:2] == [2, 2]:
        # ordered_ranks = [high_pair, low_pair, kicker]
        return (TWO_PAIR, ordered_ranks[0], ordered_ranks[1], ordered_ranks[2])
    if count_pattern[0] == 2:
        return (PAIR, ordered_ranks[0], *ordered_ranks[1:])
    return (HIGH_CARD, *ranks)


def best_hand(cards: list[Card]) -> tuple:
    """Best 5-card score from 5, 6, or 7 cards."""
    if len(cards) < 5:
        raise ValueError("Need at least 5 cards to evaluate")
    if len(cards) == 5:
        return score_5(cards)
    return max(score_5(list(combo)) for combo in combinations(cards, 5))


def describe(score: tuple) -> str:
    """Human-readable name for a score tuple, e.g. 'Full House'."""
    name = CATEGORY_NAMES[score[0]]
    if score[0] in (HIGH_CARD, PAIR, TRIPS, QUADS):
        return f"{name}, {INT_TO_RANK[score[1]]} high"
    if score[0] in (STRAIGHT, STRAIGHT_FLUSH):
        return f"{name}, {INT_TO_RANK[min(score[1], 14)]} high"
    return name
