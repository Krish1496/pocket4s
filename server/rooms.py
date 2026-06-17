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
                p = self.game.get(pid)
                if p:
                    p.connected = False

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


class RoomManager:
    def __init__(self) -> None:
        self.rooms: dict[str, Room] = {}

    def create(self, name: str, sb: int, bb: int, stack: int) -> Room:
        tid = new_table_id()
        game = Game(small_blind=sb, big_blind=bb, starting_stack=stack)
        room = Room(table_id=tid, game=game, name=name or "Poker Table")
        self.rooms[tid] = room
        return room

    def get(self, table_id: str) -> Room | None:
        return self.rooms.get(table_id)
