"""A player at the table. Pure data + a few tiny helpers, no game logic."""
from __future__ import annotations

from enum import Enum

from .cards import Card


class Status(str, Enum):
    SITTING_OUT = "sitting_out"   # at the table but not in the current hand
    ACTIVE = "active"             # in the hand, can still act
    FOLDED = "folded"             # out of this hand
    ALL_IN = "all_in"            # committed all chips, can't act further


class Player:
    def __init__(self, pid: str, name: str, seat: int, stack: int) -> None:
        self.id = pid
        self.name = name
        self.seat = seat
        self.stack = stack
        self.status = Status.SITTING_OUT
        self.hole: list[Card] = []
        # Chips put in during the current betting round (street).
        self.round_bet = 0
        # Total chips committed across the whole hand (drives side pots).
        self.committed = 0
        self.connected = True

    # --- helpers ---------------------------------------------------------
    def reset_for_hand(self) -> None:
        self.hole = []
        self.round_bet = 0
        self.committed = 0
        # Players with chips who are present get dealt in.
        if self.stack > 0 and self.connected:
            self.status = Status.ACTIVE
        else:
            self.status = Status.SITTING_OUT

    def reset_for_street(self) -> None:
        self.round_bet = 0

    @property
    def in_hand(self) -> bool:
        return self.status in (Status.ACTIVE, Status.ALL_IN)

    @property
    def can_act(self) -> bool:
        return self.status == Status.ACTIVE

    def bet(self, amount: int) -> int:
        """Move up to `amount` chips from stack into the pot. Returns the
        actual amount moved (capped at the stack -> triggers all-in)."""
        amount = min(amount, self.stack)
        self.stack -= amount
        self.round_bet += amount
        self.committed += amount
        if self.stack == 0:
            self.status = Status.ALL_IN
        return amount
