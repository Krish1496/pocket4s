"""FastAPI app: lobby + table pages and the live game WebSocket.

Run with:  uvicorn main:app --host 0.0.0.0 --port 8021
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Form
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from server.rooms import RoomManager, new_player_id

BASE = Path(__file__).parent
app = FastAPI(title="Puppy Poker")
manager = RoomManager()

app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")


def _page(name: str) -> str:
    return (BASE / "static" / name).read_text(encoding="utf-8")


@app.get("/", response_class=HTMLResponse)
def lobby() -> str:
    return _page("lobby.html")


@app.post("/create")
def create_table(
    table_name: str = Form("Poker Night"),
    small_blind: int = Form(1),
    big_blind: int = Form(2),
    stack: int = Form(200),
):
    sb = max(1, small_blind)
    bb = max(sb + 1, big_blind)
    stack = max(bb * 10, stack)
    room = manager.create(table_name, sb, bb, stack)
    return RedirectResponse(url=f"/t/{room.table_id}", status_code=303)


@app.get("/t/{table_id}", response_class=HTMLResponse)
def table_page(table_id: str):
    room = manager.get(table_id)
    if not room:
        return HTMLResponse(_page("notfound.html"), status_code=404)
    return HTMLResponse(_page("table.html"))


@app.get("/api/new_pid")
def api_new_pid():
    return JSONResponse({"pid": new_player_id()})


@app.get("/api/table/{table_id}")
def api_table_info(table_id: str):
    room = manager.get(table_id)
    if not room:
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse({
        "table_id": table_id,
        "name": room.name,
        "blinds": {"sb": room.game.sb, "bb": room.game.bb},
        "stack": room.game.starting_stack,
        "players": len(room.game.players),
    })


@app.websocket("/ws/{table_id}")
async def ws_game(ws: WebSocket, table_id: str, pid: str = "", name: str = "Player"):
    room = manager.get(table_id)
    if not room or not pid:
        await ws.close(code=4404)
        return
    await ws.accept()

    name = (name or "Player").strip()[:20] or "Player"
    async with room.lock:
        room.game.add_player(pid, name)
        room.connect(pid, ws)
        await room.broadcast()

    try:
        while True:
            msg = await ws.receive_json()
            async with room.lock:
                await _handle(room, pid, msg)
                await room.broadcast()
    except WebSocketDisconnect:
        async with room.lock:
            room.disconnect(pid, ws)
            await room.broadcast()
    except Exception:
        async with room.lock:
            room.disconnect(pid, ws)


async def _handle(room, pid: str, msg: dict) -> None:
    g = room.game
    t = msg.get("type")
    try:
        if t == "action":
            g.act(pid, msg.get("action", ""), int(msg.get("amount", 0)))
        elif t == "start":
            if g.can_start():
                g.start_hand()
        elif t == "next_hand":
            if g.phase.value == "showdown":
                g.end_hand()
                if g.can_start():
                    g.start_hand()
        elif t == "chat":
            text = str(msg.get("text", ""))[:140].strip()
            p = g.get(pid)
            if text and p:
                g._log(f"[chat] {p.name}: {text}")
        elif t == "leave":
            g.remove_player(pid)
        elif t == "ping":
            pass
    except ValueError as e:
        # Send a private error back to just this player.
        for ws in room.sockets.get(pid, set()):
            await ws.send_json({"type": "error", "message": str(e)})
