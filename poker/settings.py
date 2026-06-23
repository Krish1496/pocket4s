"""Table-level configuration the owner can tweak between hands.

Pure data + validation. The game engine reads these flags; it never
writes them. Keeps "what game are we playing" separate from "how is this
hand going".
"""
from __future__ import annotations

from dataclasses import dataclass, asdict

SEAT_COUNT = 10


@dataclass
class TableSettings:
    small_blind: int = 1
    big_blind: int = 2
    ante: int = 0                 # posted by every player in the hand, pre-blinds
    straddle: bool = False        # UTG posts 2x BB blind, action starts left of it
    default_buyin: int = 200      # suggested buy-in / top-up amount
    min_buyin: int = 40
    max_buyin: int = 1000
    rabbit_hunting: bool = True    # reveal the would-be board after a fold-out
    bounty_72: bool = False        # winning with 7-2 offsuit pays a bounty
    bounty_72_amount: int = 0      # chips each other player pays the winner
    action_timeout: int = 30       # seconds to act before auto check/fold (0 = off)
    auto_deal: bool = True          # auto-start the next hand after showdown
    run_it_twice: bool = True       # all-in? let players run the board 1-5 times

    def to_dict(self) -> dict:
        return asdict(self)

    def apply(self, **changes) -> None:
        """Validate + apply a partial settings update from the owner."""
        for key, value in changes.items():
            if not hasattr(self, key):
                continue
            cur = getattr(self, key)
            if isinstance(cur, bool):
                setattr(self, key, bool(value))
            else:
                setattr(self, key, int(value))
        self._normalize()

    def _normalize(self) -> None:
        self.small_blind = max(1, self.small_blind)
        self.big_blind = max(self.small_blind + 1, self.big_blind)
        self.ante = max(0, self.ante)
        self.min_buyin = max(self.big_blind * 2, self.min_buyin)
        self.max_buyin = max(self.min_buyin, self.max_buyin)
        self.default_buyin = min(max(self.min_buyin, self.default_buyin),
                                 self.max_buyin)
        self.bounty_72_amount = max(0, self.bounty_72_amount)
        self.action_timeout = max(0, min(300, self.action_timeout))
        if self.bounty_72 and self.bounty_72_amount == 0:
            self.bounty_72_amount = self.big_blind * 5
