"""Cards and decks. The atoms of poker.

Ranks are integers 2..14 (14 = Ace). Suits are single chars c/d/h/s.
Keeping it tiny and immutable so it's cheap to copy and impossible to
accidentally mutate a card mid-hand.
"""
from __future__ import annotations

import random
from dataclasses import dataclass

RANKS = "23456789TJQKA"
SUITS = "cdhs"
RANK_TO_INT = {r: i + 2 for i, r in enumerate(RANKS)}
INT_TO_RANK = {v: k for k, v in RANK_TO_INT.items()}
SUIT_SYMBOLS = {"c": "c", "d": "d", "h": "h", "s": "s"}


@dataclass(frozen=True)
class Card:
    rank: int  # 2..14
    suit: str  # one of "cdhs"

    @classmethod
    def from_str(cls, s: str) -> "Card":
        # e.g. "As", "Td", "2c"
        return cls(RANK_TO_INT[s[0].upper()], s[1].lower())

    @property
    def code(self) -> str:
        """Compact code like 'As' used by the frontend."""
        return f"{INT_TO_RANK[self.rank]}{self.suit}"

    def __str__(self) -> str:
        return f"{INT_TO_RANK[self.rank]}{SUIT_SYMBOLS[self.suit]}"


def full_deck() -> list[Card]:
    return [Card(RANK_TO_INT[r], s) for s in SUITS for r in RANKS]


class Deck:
    """A shuffled deck you deal from the top."""

    def __init__(self, seed: int | None = None) -> None:
        self._cards = full_deck()
        self._rng = random.Random(seed)
        self._rng.shuffle(self._cards)

    def deal(self, n: int = 1) -> list[Card]:
        if n > len(self._cards):
            raise ValueError("Not enough cards left in the deck")
        dealt, self._cards = self._cards[:n], self._cards[n:]
        return dealt

    def deal_one(self) -> Card:
        return self.deal(1)[0]

    def __len__(self) -> int:
        return len(self._cards)
