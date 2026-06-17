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

    # --- action clock ---------------------------------------------------
    def _arm_timer(self) -> None:
        """(Re)schedule the auto-fold timer for the current actor. Safe to
        call from inside the timer itself -- it won't cancel its own task."""
        current = asyncio.current_task()
        if (self.timer_task and self.timer_task is not current
                and not self.timer_task.done()):
            self.timer_task.cancel()
        left = self.game.time_left()
        if left is None:
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
                self.game.auto_advance()
                await self.broadcast()

    # --- auto-deal ------------------------------------------------------
    AUTODEAL_DELAY = 4.5  # seconds to admire the result before the next hand

    def _arm_autodeal(self) -> None:
        """If auto-deal is on and we're at showdown, schedule the next hand."""
        g = self.game
        ready = (g.settings.auto_deal and g.phase.value == "showdown"
                 and len(g.seated_with_chips()) >= 2)
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
                    and g.hand_no == hand_no and len(g.seated_with_chips()) >= 2):
                g.end_hand()
                g.start_hand()
                g.auto_advance()
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
