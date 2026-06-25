"""Room manager: owns the live tables and their WebSocket connections.

One process, in-memory. Perfect for a friends game. Each table maps to a
Game plus the set of connected sockets. We broadcast a personalized
snapshot to every viewer after any state change.
"""
from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass, field

from fastapi import WebSocket

from poker.game import Game
from poker import autoplay
from .serialize import snapshot


def new_table_id() -> str:
    # Short, URL-friendly, hard to guess.
    return secrets.token_urlsafe(6)


def new_player_id() -> str:
    return secrets.token_urlsafe(9)


@dataclass
class Room:
    table_id: str
    game: Game
    name: str = "Poker Table"
    sockets: dict[str, set[WebSocket]] = field(default_factory=dict)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    timer_task: asyncio.Task | None = field(default=None)
    autodeal_task: asyncio.Task | None = field(default=None)
    autoplay_task: asyncio.Task | None = field(default=None)
    runout_task: asyncio.Task | None = field(default=None)
    street_task: asyncio.Task | None = field(default=None)
    runvote_task: asyncio.Task | None = field(default=None)

    def connect(self, pid: str, ws: WebSocket) -> None:
        self.sockets.setdefault(pid, set()).add(ws)
        p = self.game.get(pid)
        if p:
            p.connected = True

    def disconnect(self, pid: str, ws: WebSocket) -> None:
        if pid in self.sockets:
            self.sockets[pid].discard(ws)
            if not self.sockets[pid]:
                del self.sockets[pid]
                # Keep them as a member/seat (reconnect-friendly) but mark
                # their seat as disconnected so they auto-sit-out.
                self.game.mark_disconnected(pid)
                vp = getattr(self.game, "voice_pids", None)
                if vp:
                    vp.discard(pid)

    async def relay_signal(self, pid: str, msg: dict) -> None:
        """Forward a WebRTC signaling blob from one player to a specific peer.
        Pure relay -- no game-state change, so no broadcast."""
        target = msg.get("to")
        if not target:
            return
        out = {"type": "signal", "from": pid,
               "kind": msg.get("kind"), "data": msg.get("data")}
        for ws in list(self.sockets.get(target, set())):
            try:
                await ws.send_json(out)
            except Exception:
                pass

    async def broadcast(self) -> None:
        dead: list[tuple[str, WebSocket]] = []
        for pid, conns in list(self.sockets.items()):
            payload = snapshot(self.game, pid)
            for ws in list(conns):
                try:
                    await ws.send_json(payload)
                except Exception:
                    dead.append((pid, ws))
        for pid, ws in dead:
            self.disconnect(pid, ws)
        self._arm_timer()
        self._arm_autodeal()
        self._arm_autoplay()
        self._arm_runout()
        self._arm_street()
        self._arm_runvote()

    # --- action clock ---------------------------------------------------
    def _arm_timer(self) -> None:
        """(Re)schedule the auto-fold timer for the current actor. Safe to
        call from inside the timer itself -- it won't cancel its own task."""
        current = asyncio.current_task()
        if (self.timer_task and self.timer_task is not current
                and not self.timer_task.done()):
            self.timer_task.cancel()
        left = self.game.time_left()
        if left is None or self.game.paused:
            self.timer_task = None
            return
        self.timer_task = asyncio.create_task(
            self._run_timer(self.game.turn_seq, left))

    async def _run_timer(self, seq: int, delay: float) -> None:
        try:
            await asyncio.sleep(delay + 0.25)  # tiny grace for network lag
        except asyncio.CancelledError:
            return
        async with self.lock:
            if self.game.turn_seq != seq:
                return  # the turn already moved on; this timer is stale
            left = self.game.time_left()
            if left and left > 0:
                return  # deadline got pushed; let the fresh timer handle it
            if self.game.auto_act_timeout():
                await self.broadcast()

    # --- paced auto-play (away / pre-moves / check-fold) -----------------
    AUTOPLAY_DELAY = 1.1  # cool-down so each auto action is visible

    def _arm_autoplay(self) -> None:
        """Schedule one paced auto action if the current actor has something
        queued. Re-arms itself via broadcast after each step."""
        g = self.game
        if g.paused or not autoplay.pending(g):
            return
        if asyncio.current_task() is self.autoplay_task:
            return
        if self.autoplay_task and not self.autoplay_task.done():
            return
        self.autoplay_task = asyncio.create_task(self._run_autoplay(g.turn_seq))

    async def _run_autoplay(self, seq: int) -> None:
        try:
            await asyncio.sleep(self.AUTOPLAY_DELAY)
        except asyncio.CancelledError:
            return
        async with self.lock:
            g = self.game
            if g.paused or g.turn_seq != seq:
                return  # turn moved (or paused) -- this step is stale
            if autoplay.step(g):
                await self.broadcast()

    # --- 1-second beat before each new board street ----------------------
    STREET_DELAY = 1.0

    def _arm_street(self) -> None:
        g = self.game
        if g.paused or not g.street_pending:
            return
        if asyncio.current_task() is self.street_task:
            return
        if self.street_task and not self.street_task.done():
            return
        self.street_task = asyncio.create_task(self._run_street(g.hand_no))

    async def _run_street(self, hand_no: int) -> None:
        try:
            await asyncio.sleep(self.STREET_DELAY)
        except asyncio.CancelledError:
            return
        async with self.lock:
            g = self.game
            if g.paused or g.hand_no != hand_no or not g.street_pending:
                return
            g.reveal_next_street()
            await self.broadcast()

    # --- run-it-twice vote clock (8s, then default to the minimum) -------
    def _arm_runvote(self) -> None:
        g = self.game
        if g.paused or not g.run_vote:
            return
        if asyncio.current_task() is self.runvote_task:
            return
        if self.runvote_task and not self.runvote_task.done():
            return
        self.runvote_task = asyncio.create_task(self._run_runvote(g.hand_no))

    async def _run_runvote(self, hand_no: int) -> None:
        import time
        while True:
            g = self.game
            rv = g.run_vote
            if not rv or g.hand_no != hand_no:
                return
            left = rv.get("deadline", 0) - time.monotonic()
            try:
                await asyncio.sleep(max(0.05, left + 0.1))
            except asyncio.CancelledError:
                return
            async with self.lock:
                g = self.game
                rv = g.run_vote
                if not rv or g.hand_no != hand_no or g.paused:
                    return
                if rv.get("deadline", 0) - time.monotonic() > 0:
                    continue   # deadline moved; wait again
                if g.run_vote_timeout():
                    await self.broadcast()
                return
    RUNOUT_DELAY = 2.5  # seconds between each board reveal

    def _arm_runout(self) -> None:
        g = self.game
        if g.paused or g.runout is None:
            return
        if asyncio.current_task() is self.runout_task:
            return
        if self.runout_task and not self.runout_task.done():
            return
        self.runout_task = asyncio.create_task(self._run_runout(g.hand_no))

    async def _run_runout(self, hand_no: int) -> None:
        while True:
            try:
                await asyncio.sleep(self.RUNOUT_DELAY)
            except asyncio.CancelledError:
                return
            async with self.lock:
                g = self.game
                if g.paused or g.hand_no != hand_no or g.runout is None:
                    return  # paused, new hand, or already finished
                g.reveal_runout_step()
                await self.broadcast()
                if g.runout is None:
                    return  # last street revealed -> showdown

    # --- auto-deal ------------------------------------------------------
    AUTODEAL_DELAY = 6.0  # seconds to admire the result / show cards before the next hand

    def _arm_autodeal(self) -> None:
        """If auto-deal is on and we're at showdown, schedule the next hand."""
        g = self.game
        ready = (g.settings.auto_deal and g.phase.value == "showdown"
                 and not g.paused
                 and len(g.dealable()) >= 2)
        if not ready:
            return
        if asyncio.current_task() is self.autodeal_task:
            return  # called from inside the running task; let it finish
        if self.autodeal_task and not self.autodeal_task.done():
            return  # already scheduled for this showdown
        self.autodeal_task = asyncio.create_task(self._run_autodeal(g.hand_no))

    async def _run_autodeal(self, hand_no: int) -> None:
        try:
            await asyncio.sleep(self.AUTODEAL_DELAY)
        except asyncio.CancelledError:
            return
        async with self.lock:
            g = self.game
            if (g.settings.auto_deal and g.phase.value == "showdown"
                    and g.hand_no == hand_no and len(g.dealable()) >= 2):
                g.end_hand()
                g.start_hand()
                await self.broadcast()


class RoomManager:
    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}

    def create(self, name: str, settings) -> Room:
        tid = new_table_id()
        game = Game(settings=settings)
        room = Room(table_id=tid, game=game, name=name or "Poker Table")
        self.rooms[tid] = room
        return room

    def get(self, table_id: str) -> Room | None:
        return self.rooms.get(table_id)
