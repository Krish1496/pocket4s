"""No-Limit Texas Hold'em game engine.

A single `Game` owns one table's worth of state and runs hands as a
state machine. It is deliberately framework-agnostic: it knows nothing
about WebSockets or HTTP. Feed it actions, ask it for snapshots.
"""
from __future__ import annotations

from enum import Enum

from .cards import Deck
from .player import Player, Status
from .potting import build_pots, settle
from .evaluator import describe


class Phase(str, Enum):
    WAITING = "waiting"
    PREFLOP = "preflop"
    FLOP = "flop"
    TURN = "turn"
    RIVER = "river"
    SHOWDOWN = "showdown"


STREET_ORDER = [Phase.PREFLOP, Phase.FLOP, Phase.TURN, Phase.RIVER]


class Game:
    def __init__(self, small_blind: int = 1, big_blind: int = 2,
                 starting_stack: int = 200, seed: int | None = None) -> None:
        self.players: list[Player] = []  # seat order
        self.sb = small_blind
        self.bb = big_blind
        self.starting_stack = starting_stack
        self._seed = seed

        self.phase = Phase.WAITING
        self.button = 0
        self.deck: Deck | None = None
        self.board: list = []
        self.current_bet = 0
        self.min_raise = big_blind
        self.to_act: str | None = None  # player id whose turn it is
        self._acted: set[str] = set()
        self.log: list[str] = []
        self.last_results: dict | None = None
        self.hand_no = 0

    # ------------------------------------------------------------------ seats
    def add_player(self, pid: str, name: str) -> Player:
        if any(p.id == pid for p in self.players):
            return self.get(pid)
        seat = self._first_free_seat()
        p = Player(pid, name, seat, self.starting_stack)
        self.players.append(p)
        self.players.sort(key=lambda x: x.seat)
        self._log(f"{name} sat down in seat {seat + 1}")
        return p

    def remove_player(self, pid: str) -> None:
        p = self.get(pid)
        if not p:
            return
        if self.phase != Phase.WAITING and p.in_hand:
            # Fold them out of the live hand first.
            p.status = Status.FOLDED
        self.players = [x for x in self.players if x.id != pid]
        self._log(f"{p.name} left the table")

    def get(self, pid: str) -> Player | None:
        return next((p for p in self.players if p.id == pid), None)

    def _first_free_seat(self) -> int:
        taken = {p.seat for p in self.players}
        seat = 0
        while seat in taken:
            seat += 1
        return seat

    def seated_with_chips(self) -> list[Player]:
        return [p for p in self.players if p.stack > 0 and p.connected]

    # ----------------------------------------------------------------- hands
    def can_start(self) -> bool:
        return self.phase == Phase.WAITING and len(self.seated_with_chips()) >= 2

    def start_hand(self) -> None:
        if not self.can_start():
            raise ValueError("Need at least 2 players with chips to start")
        self.hand_no += 1
        self.deck = Deck(seed=self._seed)
        self.board = []
        self.current_bet = 0
        self.min_raise = self.bb
        self._acted = set()
        self.last_results = None
        for p in self.players:
            p.reset_for_hand()

        self._advance_button()
        self._post_blinds()
        self._deal_holes()
        self.phase = Phase.PREFLOP
        self._log(f"--- Hand #{self.hand_no} ---")
        self._begin_betting(preflop=True)

    def _advance_button(self) -> None:
        contenders = [i for i, p in enumerate(self.players) if p.in_hand]
        if not contenders:
            return
        # Move button to the next eligible seat after its current spot.
        nxt = None
        for offset in range(1, len(self.players) + 1):
            idx = (self.button + offset) % len(self.players)
            if self.players[idx].in_hand:
                nxt = idx
                break
        self.button = nxt if nxt is not None else contenders[0]

    def _in_hand_indices(self) -> list[int]:
        return [i for i, p in enumerate(self.players) if p.in_hand]

    def _next_in_hand(self, start: int) -> int:
        n = len(self.players)
        for offset in range(1, n + 1):
            idx = (start + offset) % n
            if self.players[idx].in_hand:
                return idx
        return start

    def _post_blinds(self) -> None:
        idxs = self._in_hand_indices()
        heads_up = len(idxs) == 2
        if heads_up:
            sb_idx = self.button
            bb_idx = self._next_in_hand(self.button)
        else:
            sb_idx = self._next_in_hand(self.button)
            bb_idx = self._next_in_hand(sb_idx)
        sb_p, bb_p = self.players[sb_idx], self.players[bb_idx]
        sb_p.bet(self.sb)
        bb_p.bet(self.bb)
        self.current_bet = self.bb
        self.min_raise = self.bb
        self._sb_idx, self._bb_idx = sb_idx, bb_idx
        self._log(f"{sb_p.name} posts small blind {self.sb}")
        self._log(f"{bb_p.name} posts big blind {self.bb}")

    def _deal_holes(self) -> None:
        for p in self.players:
            if p.in_hand:
                p.hole = self.deck.deal(2)

    # ------------------------------------------------------------ betting
    def _begin_betting(self, preflop: bool) -> None:
        self._acted = set()
        if preflop:
            heads_up = len(self._in_hand_indices()) == 2
            first = self.button if heads_up else self._next_in_hand(self._bb_idx)
        else:
            self.current_bet = 0
            self.min_raise = self.bb
            for p in self.players:
                p.reset_for_street()
            first = self._next_in_hand(self.button)
        # Skip players who can't act (already all-in).
        self.to_act = self._first_actor(first)
        if self.to_act is None:
            self._maybe_advance_street()

    def _first_actor(self, start_idx: int) -> str | None:
        n = len(self.players)
        for offset in range(n):
            idx = (start_idx + offset) % n
            if self.players[idx].can_act:
                return self.players[idx].id
        return None

    def _active_actors(self) -> list[Player]:
        return [p for p in self.players if p.can_act]

    def act(self, pid: str, action: str, amount: int = 0) -> None:
        """Apply a player action. Raises ValueError if illegal."""
        if self.phase not in (Phase.PREFLOP, Phase.FLOP, Phase.TURN, Phase.RIVER):
            raise ValueError("No betting is open right now")
        if self.to_act != pid:
            raise ValueError("It is not your turn")
        p = self.get(pid)
        if not p or not p.can_act:
            raise ValueError("You cannot act")

        to_call = self.current_bet - p.round_bet
        if action == "fold":
            p.status = Status.FOLDED
            self._log(f"{p.name} folds")
        elif action == "check":
            if to_call > 0:
                raise ValueError("Cannot check facing a bet -- call, raise, or fold")
            self._log(f"{p.name} checks")
            self._acted.add(pid)
        elif action == "call":
            if to_call <= 0:
                raise ValueError("Nothing to call -- check instead")
            paid = p.bet(to_call)
            self._log(f"{p.name} calls {paid}")
            self._acted.add(pid)
        elif action in ("bet", "raise"):
            self._apply_raise(p, amount, to_call)
        else:
            raise ValueError(f"Unknown action: {action}")

        self._after_action()

    def _apply_raise(self, p: Player, amount: int, to_call: int) -> None:
        # `amount` is the total chips the player wants their round bet to reach.
        target = amount
        if target <= self.current_bet:
            raise ValueError("A raise must exceed the current bet")
        max_target = p.round_bet + p.stack
        if target > max_target:
            raise ValueError("You don't have enough chips for that")
        raise_size = target - self.current_bet
        all_in = target == max_target
        if raise_size < self.min_raise and not all_in:
            raise ValueError(f"Minimum raise is to {self.current_bet + self.min_raise}")
        p.bet(target - p.round_bet)
        verb = "bets" if to_call == 0 else "raises to"
        self._log(f"{p.name} {verb} {target}")
        # A full-size raise reopens the action.
        if raise_size >= self.min_raise:
            self.min_raise = raise_size
            self._acted = {p.id}
        else:
            # Short all-in: does not reopen for those who already acted.
            self._acted.add(p.id)
        self.current_bet = target

    def _after_action(self) -> None:
        in_hand = [p for p in self.players if p.in_hand]
        if len(in_hand) == 1:
            self._award_uncontested(in_hand[0])
            return
        if self._betting_round_complete():
            self._maybe_advance_street()
        else:
            nxt_idx = next(i for i, p in enumerate(self.players)
                           if p.id == self.to_act)
            self.to_act = self._first_actor(nxt_idx + 1)
            if self.to_act is None:
                self._maybe_advance_street()

    def _betting_round_complete(self) -> bool:
        actors = self._active_actors()
        if not actors:
            return True
        for p in actors:
            if p.id not in self._acted:
                return False
            if p.round_bet != self.current_bet:
                return False
        return True

    # --------------------------------------------------------- street flow
    def _maybe_advance_street(self) -> None:
        # If at most one player can still act, no more betting is possible:
        # run the board out to showdown.
        if len(self._active_actors()) <= 1 and self._everyone_matched():
            self._run_out_and_showdown()
            return
        self._next_street()

    def _everyone_matched(self) -> bool:
        return all(p.round_bet == self.current_bet
                   for p in self.players if p.status == Status.ACTIVE)

    def _next_street(self) -> None:
        idx = STREET_ORDER.index(self.phase)
        if self.phase == Phase.RIVER:
            self._showdown()
            return
        self.phase = STREET_ORDER[idx + 1]
        self._deal_board_for_phase()
        self._begin_betting(preflop=False)

    def _deal_board_for_phase(self) -> None:
        self.deck.deal_one()  # burn card, because tradition
        if self.phase == Phase.FLOP:
            self.board += self.deck.deal(3)
        elif self.phase in (Phase.TURN, Phase.RIVER):
            self.board += self.deck.deal(1)
        self._log(f"{self.phase.value.title()}: "
                  + " ".join(c.code for c in self.board))

    def _run_out_and_showdown(self) -> None:
        while len(self.board) < 5:
            self.deck.deal_one()  # burn
            self.board += self.deck.deal(1)
        self._log("Run it out: " + " ".join(c.code for c in self.board))
        self._showdown()

    def _showdown(self) -> None:
        self.phase = Phase.SHOWDOWN
        self.to_act = None
        self.last_results = settle(self.players, self.board)
        for r in self.last_results["pots"]:
            names = ", ".join(self.get(w).name for w in r["winners"])
            self._log(f"{names} wins {r['amount']} with {describe(r['score'])}")

    def _award_uncontested(self, winner: Player) -> None:
        pot = sum(p.committed for p in self.players)
        winner.stack += pot
        self.phase = Phase.SHOWDOWN
        self.to_act = None
        self.last_results = {"pots": [{
            "pot": 0, "amount": pot, "winners": [winner.id],
            "amount_each": pot, "score": None,
        }]}
        self._log(f"{winner.name} wins {pot} (everyone folded)")

    def end_hand(self) -> None:
        """Reset to WAITING and clear busted players' seats remain (stack 0)."""
        self.phase = Phase.WAITING
        self.to_act = None
        for p in self.players:
            p.hole = []
            p.round_bet = 0
            p.committed = 0
            if p.status != Status.SITTING_OUT:
                p.status = Status.SITTING_OUT

    # -------------------------------------------------------------- helpers
    def pot_total(self) -> int:
        return sum(p.committed for p in self.players)

    def _log(self, msg: str) -> None:
        self.log.append(msg)
        self.log = self.log[-60:]  # keep the feed bounded
