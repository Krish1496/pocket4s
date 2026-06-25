"""NLHE table + hand engine. Framework-agnostic Game; flavor in extras/autoplay/runs, money in ledger."""
from __future__ import annotations

import time
from enum import Enum

from .cards import Deck
from .player import Player, Status
from .potting import settle, return_uncalled
from .evaluator import describe, best_hand
from .settings import TableSettings, SEAT_COUNT
from .ledger import Ledger
from . import extras
from . import autoplay
from . import runs


class Phase(str, Enum):
    WAITING = "waiting"
    PREFLOP = "preflop"
    FLOP = "flop"
    TURN = "turn"
    RIVER = "river"
    SHOWDOWN = "showdown"


STREET_ORDER = [Phase.PREFLOP, Phase.FLOP, Phase.TURN, Phase.RIVER]


class Game:
    def __init__(self, settings: TableSettings | None = None, small_blind: int = 1,
                 big_blind: int = 2, starting_stack: int = 200, seed: int | None = None) -> None:
        self.settings = settings or TableSettings(
            small_blind=small_blind, big_blind=big_blind, default_buyin=starting_stack)
        self.settings._normalize()
        self._seed = seed

        self.members: dict[str, str] = {}      # pid -> name
        self.owner: str | None = None
        self.ledger = Ledger()
        self.requests: list[dict] = []          # pending buy-in/top-up requests
        self.players: list[Player] = []        # seated players, sorted by seat

        self.phase = Phase.WAITING
        self.paused = False
        self.button = 0
        self._last_button_pid: str | None = None
        self.deck: Deck | None = None
        self.board: list = []
        self.rabbit_board: list = []
        self.run_boards: list = []          # one full board per run (RIT)
        self.run_vote: dict | None = None   # active run-it-twice vote, if any
        self.runout: dict | None = None     # paced all-in reveal in progress
        self.equity: dict = {}              # {pid: win%} during all-in runouts
        self.street_pending = False         # 1s beat before the next board card
        self.current_bet = 0
        self.min_raise = self.bb
        self.to_act: str | None = None
        self._acted: set[str] = set()
        self._straddle_idx: int | None = None
        self.last_results: dict | None = None
        self.hand_no = 0
        # True only when the hand reached an actual (contested) showdown or
        # an all-in runout -- i.e. cards are auto-revealed. A fold-out win
        # leaves it False, so the winner's cards stay hidden unless shown.
        self.went_to_showdown = False
        # Last player to bet/raise on the current street (resets each street).
        # Drives showdown reveal ORDER. None = street was checked through.
        self.last_aggressor: str | None = None
        # Player ids whose hands are auto-revealed at showdown (the shower
        # plus everyone who out-showed them; losers after the winner muck).
        self.showdown_reveals: set[str] = set()

        self.turn_deadline: float | None = None
        self.turn_seq = 0

        self.hand_log: list[str] = []
        self.chat_log: list[dict] = []
        self._chat_n = 0

    @property
    def sb(self) -> int:
        return self.settings.small_blind

    @property
    def bb(self) -> int:
        return self.settings.big_blind

    @property
    def starting_stack(self) -> int:
        return self.settings.default_buyin

    def register_member(self, pid: str, name: str) -> None:
        self.members[pid] = name
        self.ledger.record_name(pid, name)
        p = self.get(pid)
        if p:
            p.name = name
            p.connected = True
        if self.owner is None:
            self.owner = pid
            self._log(f"{name} is now the table host")

    def is_owner(self, pid: str) -> bool:
        return pid == self.owner

    def get(self, pid: str) -> Player | None:
        return next((p for p in self.players if p.id == pid), None)

    def seat_taken(self, seat: int) -> bool:
        return any(p.seat == seat for p in self.players)

    def open_seats(self) -> list[int]:
        return [s for s in range(SEAT_COUNT) if not self.seat_taken(s)]

    def seated_with_chips(self) -> list[Player]:
        return [p for p in self.players if p.stack > 0]  # no `connected` check (blip-safe)

    def dealable(self) -> list[Player]:
        """Players who will actually be dealt the NEXT hand: have chips and
        aren't away / sitting out. Used to decide if a hand can run at all."""
        return [p for p in self.players
                if p.stack > 0 and not p.away and not p.away_pending
                and not p.sit_out_next]

    def request_sit(self, pid: str, seat: int, amount: int) -> None:
        if self.get(pid):
            raise ValueError("You are already seated")
        if seat < 0 or seat >= SEAT_COUNT:
            raise ValueError("Invalid seat")
        if self.seat_taken(seat):
            raise ValueError("That seat is taken")
        amount = self._clamp_buyin(amount)
        name = self.members.get(pid, "Player")
        if self.is_owner(pid):
            self._seat_player(pid, name, seat, amount)
        else:
            self._queue_request(pid, "sit", amount, seat)

    def request_topup(self, pid: str, amount: int) -> None:
        p = self.get(pid)
        if not p:
            raise ValueError("Sit down before topping up")
        amount = max(1, int(amount))
        if self.is_owner(pid):
            self._grant_topup(pid, amount)
        else:
            self._queue_request(pid, "topup", amount, p.seat)

    def approve_request(self, owner_pid: str, target_pid: str) -> None:
        self._require_owner(owner_pid)
        req = self._pop_request(target_pid)
        if not req:
            raise ValueError("No such request")
        name = self.members.get(target_pid, "Player")
        if req["kind"] == "sit":
            if self.seat_taken(req["seat"]):
                req["seat"] = self._first_open_seat()
            self._seat_player(target_pid, name, req["seat"], req["amount"])
        else:
            self._grant_topup(target_pid, req["amount"])

    def deny_request(self, owner_pid: str, target_pid: str) -> None:
        self._require_owner(owner_pid)
        req = self._pop_request(target_pid)
        if req:
            name = self.members.get(target_pid, "Player")
            self._log(f"Host declined {name}'s buy-in request")

    def owner_set_stack(self, owner_pid: str, target_pid: str, amount: int) -> None:
        self._require_owner(owner_pid)
        p = self.get(target_pid)
        if not p:
            raise ValueError("That player is not seated")
        amount = max(0, int(amount))
        if self.phase != Phase.WAITING and p.in_hand:
            raise ValueError("Can't edit a stack mid-hand for an active player")
        delta = amount - p.stack
        p.stack = amount
        self.ledger.add_buyin(target_pid, delta)
        self._log(f"Host set {p.name}'s stack to {amount}")

    def owner_set_settings(self, owner_pid: str, **changes) -> None:
        self._require_owner(owner_pid)
        self.settings.apply(**changes)
        self._log("Host updated table settings")

    def _clamp_buyin(self, amount: int) -> int:
        amount = int(amount)
        return max(self.settings.min_buyin, min(self.settings.max_buyin, amount))

    def _seat_player(self, pid: str, name: str, seat: int, amount: int) -> None:
        p = Player(pid, name, seat, amount)
        self.players.append(p)
        self.players.sort(key=lambda x: x.seat)
        self.ledger.add_buyin(pid, amount)
        self._log(f"{name} sits in seat {seat + 1} with {amount} chips")

    def _grant_topup(self, pid: str, amount: int) -> None:
        p = self.get(pid)
        if not p:
            return
        if self.phase == Phase.WAITING:
            p.stack += amount
        else:
            p.pending_topup += amount
        self.ledger.add_buyin(pid, amount)
        when = "added" if self.phase == Phase.WAITING else "added next hand"
        self._log(f"{p.name} tops up {amount} ({when})")

    def _queue_request(self, pid: str, kind: str, amount: int, seat: int) -> None:
        self._pop_request(pid)  # one pending request per player
        self.requests.append({"id": pid, "name": self.members.get(pid, "Player"),
                              "kind": kind, "amount": amount, "seat": seat})
        self._log(f"{self.members.get(pid, 'Player')} requested a buy-in of {amount} (awaiting host)")

    def _pop_request(self, pid: str) -> dict | None:
        for i, r in enumerate(self.requests):
            if r["id"] == pid:
                return self.requests.pop(i)
        return None

    def _first_open_seat(self) -> int:
        seats = self.open_seats()
        if not seats:
            raise ValueError("No open seats")
        return seats[0]

    def _require_owner(self, pid: str) -> None:
        if not self.is_owner(pid):
            raise ValueError("Only the host can do that")

    def stand_up(self, pid: str) -> None:
        p = self.get(pid)
        if not p:
            return
        if self.phase != Phase.WAITING and p.in_hand:
            p.status = Status.FOLDED
        self.ledger.cash_out(pid, p.stack)
        self.players = [x for x in self.players if x.id != pid]
        self._log(f"{p.name} stood up (cashed out {p.stack})")

    def remove_member(self, pid: str) -> None:
        self.stand_up(pid)
        self._pop_request(pid)
        self.members.pop(pid, None)
        if self.owner == pid:
            self._reassign_owner()

    def mark_disconnected(self, pid: str) -> None:
        p = self.get(pid)
        if p:
            p.connected = False

    def _reassign_owner(self) -> None:
        if self.players:
            self.owner = self.players[0].id
        elif self.members:
            self.owner = next(iter(self.members))
        else:
            self.owner = None
        if self.owner:
            self._log(f"{self.members.get(self.owner, 'Player')} is now the host")

    def can_start(self) -> bool:
        return self.phase == Phase.WAITING and len(self.dealable()) >= 2

    def start_hand(self) -> None:
        if not self.can_start():
            raise ValueError("Need at least 2 players with chips to start")
        self.hand_no += 1
        self.went_to_showdown = False
        self.last_aggressor = None
        self.showdown_reveals = set()
        self.deck = Deck(seed=self._seed)
        self.board = []
        self.rabbit_board = []
        self.run_boards = []
        self.run_vote = None
        self.runout = None
        self.equity = {}
        self.street_pending = False
        self.current_bet = 0
        self.min_raise = self.bb
        self._acted = set()
        self._straddle_idx = None
        self.last_results = None
        for p in self.players:
            p.reset_for_hand()

        self._advance_button()
        self._post_antes()
        self._post_blinds()
        self._deal_holes()
        self.phase = Phase.PREFLOP
        self._log(f"--- Hand #{self.hand_no} ---")
        self._begin_betting(preflop=True)

    def _advance_button(self) -> None:
        elig = [i for i, p in enumerate(self.players) if p.in_hand]
        if not elig:
            return
        if self._last_button_pid is None:
            self.button = elig[0]
        else:
            start = next((i for i, p in enumerate(self.players) if p.id == self._last_button_pid), -1)
            self.button = self._next_in_hand(start) if start >= 0 else elig[0]
        self._last_button_pid = self.players[self.button].id

    def _in_hand_indices(self) -> list[int]:
        return [i for i, p in enumerate(self.players) if p.in_hand]

    def _next_in_hand(self, start: int) -> int:
        n = len(self.players)
        for offset in range(1, n + 1):
            idx = (start + offset) % n
            if self.players[idx].in_hand:
                return idx
        return start

    def _post_antes(self) -> None:
        ante = self.settings.ante
        if ante <= 0:
            return
        posted = sum(p.post_ante(ante) for p in self.players if p.status == Status.ACTIVE)
        if posted:
            self._log(f"Antes posted ({ante} each, {posted} total)")

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

        if self.settings.straddle and len(idxs) >= 3:
            straddle_idx = self._next_in_hand(bb_idx)
            if straddle_idx not in (sb_idx, bb_idx):
                amt = self.bb * 2
                self.players[straddle_idx].bet(amt)
                self.current_bet = amt
                self._straddle_idx = straddle_idx
                self._log(f"{self.players[straddle_idx].name} straddles {amt}")

    def _deal_holes(self) -> None:
        for p in (q for q in self.players if q.in_hand):
            p.hole = self.deck.deal(2)

    def _begin_betting(self, preflop: bool) -> None:
        self._acted = set()
        self.last_aggressor = None       # fresh street -> no aggressor yet
        if preflop:
            heads_up = len(self._in_hand_indices()) == 2
            if self._straddle_idx is not None:
                first = self._next_in_hand(self._straddle_idx)
            elif heads_up:
                first = self.button
            else:
                first = self._next_in_hand(self._bb_idx)
        else:
            self.current_bet = 0
            self.min_raise = self.bb
            for p in self.players:
                p.reset_for_street()
            first = self._next_in_hand(self.button)
        self._set_to_act(self._first_actor(first))
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
        if self.phase not in (Phase.PREFLOP, Phase.FLOP, Phase.TURN, Phase.RIVER):
            raise ValueError("No betting is open right now")
        if self.to_act != pid:
            raise ValueError("It is not your turn")
        p = self.get(pid)
        if not p or not p.can_act:
            raise ValueError("You cannot act")
        p.premove = None                     # acting clears any queued pre-move

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
        self.last_aggressor = p.id        # most-recent aggressor shows first
        if raise_size >= self.min_raise:
            self.min_raise = raise_size
            self._acted = {p.id}
        else:
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
            nxt_idx = next(i for i, p in enumerate(self.players) if p.id == self.to_act)
            self._set_to_act(self._first_actor(nxt_idx + 1))
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

    def _maybe_advance_street(self) -> None:
        if len(self._active_actors()) <= 1 and self._everyone_matched():
            return_uncalled(self)        # refund any over-bet nobody could match
            if len(self.board) >= 5:
                self._showdown()
            elif runs.should_offer(self):
                runs.offer(self)
            else:
                runs.begin_runout(self, 1)   # non-RIT: still paced
            return
        if self.phase == Phase.RIVER:
            self._showdown()             # no more cards -- straight to showdown
        else:
            self.street_pending = True   # pause; room reveals next card after 1s
            self._set_to_act(None)

    def reveal_next_street(self) -> None:
        if not self.street_pending:
            return
        self.street_pending = False
        self._next_street()

    def _everyone_matched(self) -> bool:
        return all(p.round_bet == self.current_bet
                   for p in self.players if p.status == Status.ACTIVE)

    def _next_street(self) -> None:
        idx = STREET_ORDER.index(self.phase)
        self.phase = STREET_ORDER[idx + 1]
        self._deal_board_for_phase()
        self._begin_betting(preflop=False)

    def _deal_board_for_phase(self) -> None:
        self.deck.deal_one()  # burn card, because tradition
        if self.phase == Phase.FLOP:
            self.board += self.deck.deal(3)
        elif self.phase in (Phase.TURN, Phase.RIVER):
            self.board += self.deck.deal(1)
        self._log(f"{self.phase.value.title()}: " + " ".join(c.code for c in self.board))

    def reveal_runout_step(self) -> bool:
        return runs.reveal_step(self)   # room calls this on a timer

    def _showdown(self) -> None:
        self.went_to_showdown = True   # contested -> hands auto-reveal
        self._compute_showdown_reveals()
        self.last_results = settle(self.players, self.board)
        for r in self.last_results["pots"]:
            names = ", ".join(self.get(w).name for w in r["winners"])
            self._log(f"{names} wins {r['amount']} with {describe(r['score'])}")
        self._finish_showdown()

    def _finish_showdown(self) -> None:
        self.phase = Phase.SHOWDOWN
        self._set_to_act(None)
        self._post_hand_extras()

    def _compute_showdown_reveals(self) -> None:
        """Table-stakes show order: the last aggressor on the final street
        shows first (or, if it was checked through, the first live player
        left of the button). Going clockwise, each later player only has to
        reveal if they can BEAT the best hand shown so far -- losers after
        the winner get to muck (they keep the option to show on cooldown)."""
        order = self._showdown_order()
        reveals: set[str] = set()
        best = None
        for p in order:
            score = best_hand(p.hole + self.board) if p.hole else None
            if score is None:
                continue
            if best is None or score >= best:   # first shower, or an improve/tie
                reveals.add(p.id)
                if best is None or score > best:
                    best = score
        self.showdown_reveals = reveals

    def _showdown_order(self) -> list[Player]:
        live = [p for p in self.players if p.in_hand and p.hole]
        if not live:
            return []
        agg = self.get(self.last_aggressor) if self.last_aggressor else None
        start = self.players.index(agg) if agg and agg in live else \
            self._next_in_hand(self.button)
        n = len(self.players)
        out = []
        for off in range(n):
            p = self.players[(start + off) % n]
            if p.in_hand and p.hole:
                out.append(p)
        return out

    def set_run_vote(self, pid: str, times: int) -> None:
        runs.vote(self, pid, times)

    def _award_uncontested(self, winner: Player) -> None:
        pot = sum(p.committed for p in self.players)
        winner.stack += pot
        self.last_results = {"pots": [{"pot": 0, "amount": pot, "score": None,
                             "winners": [winner.id], "amount_each": pot}]}
        self._log(f"{winner.name} wins {pot} (everyone folded)")
        self._finish_showdown()

    def _post_hand_extras(self) -> None:
        for line in extras.apply_72_bounty(self):
            self._log(line)

    def reveal_rabbit(self, pid: str | None = None) -> None:
        extras.reveal_rabbit(self)  # on-demand (click / H), display only

    def set_away(self, pid: str, value: bool) -> None:
        autoplay.set_away(self, pid, value)

    def set_auto_check_fold(self, pid: str, value: bool) -> None:
        autoplay.set_auto_check_fold(self, pid, value)

    def set_premove(self, pid: str, move: str | None) -> None:
        autoplay.set_premove(self, pid, move)

    def auto_advance(self) -> bool:
        return autoplay.auto_advance(self)

    def show_cards(self, pid: str, which) -> None:
        """After a hand ends, let a player voluntarily reveal one or both of
        their hole cards to the whole table. `which` is an iterable of card
        indices (0 and/or 1)."""
        if self.phase != Phase.SHOWDOWN:
            raise ValueError("You can only show cards after the hand ends")
        p = self.get(pid)
        if p is None or not p.hole:
            raise ValueError("You have no cards to show")
        idxs = sorted({int(i) for i in which if int(i) in (0, 1)})
        new = [i for i in idxs if i not in p.shown]
        if not new:
            return
        p.shown.update(new)
        codes = " ".join(p.hole[i].code for i in sorted(p.shown))
        self._log(f"{p.name} shows {codes}")

    def set_paused(self, pid: str, value: bool) -> None:
        self._require_owner(pid)
        self.paused = bool(value)

    def end_hand(self) -> None:
        self.phase = Phase.WAITING
        self._set_to_act(None)
        self.rabbit_board = []
        self.run_boards = []
        self.run_vote = None
        self.runout = None
        self.equity = {}
        self.street_pending = False
        for p in self.players:
            p.hole = []
            p.round_bet = 0
            p.committed = 0
            if p.away_pending:           # they went away mid-hand -> now apply it
                p.away = True
                p.away_pending = False
            if p.status != Status.SITTING_OUT:
                p.status = Status.SITTING_OUT

    def pot_total(self) -> int:
        return sum(p.committed for p in self.players)

    def live_stacks(self) -> dict[str, int]:
        return {p.id: p.stack for p in self.players}

    def _log(self, msg: str) -> None:
        self.hand_log.append(msg)
        self.hand_log = self.hand_log[-100:]

    def chat(self, pid: str, text: str) -> None:
        name = self.members.get(pid, "Player")
        self._chat_n += 1
        self.chat_log.append({"n": self._chat_n, "id": pid, "name": name, "text": text})
        self.chat_log = self.chat_log[-100:]

    def _set_to_act(self, pid: str | None) -> None:
        self.to_act = pid
        self.turn_seq += 1
        timeout = self.settings.action_timeout
        if pid is not None and timeout > 0:
            self.turn_deadline = time.monotonic() + timeout
        else:
            self.turn_deadline = None

    def time_left(self) -> float | None:
        if self.turn_deadline is None:
            return None
        return max(0.0, self.turn_deadline - time.monotonic())

    def auto_act_timeout(self) -> bool:
        pid = self.to_act
        p = self.get(pid) if pid else None
        if not p or not p.can_act:
            return False
        to_call = self.current_bet - p.round_bet
        action = "check" if to_call <= 0 else "fold"
        self._log(f"{p.name} timed out ({action})")
        self.act(pid, action)
        return True

    def add_player(self, pid: str, name: str) -> Player:
        if self.get(pid):
            return self.get(pid)
        self.register_member(pid, name)
        seat = self._first_open_seat()
        self._seat_player(pid, name, seat, self.starting_stack)
        return self.get(pid)
