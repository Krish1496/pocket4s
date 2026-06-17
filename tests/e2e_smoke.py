"""End-to-end smoke test: two players join over WS and play a full hand.

Run against a live server on :8021. Not part of the pytest suite (it needs
the running server), just a manual confidence check.
"""
import asyncio
import json
import urllib.request

import websockets

BASE = "http://localhost:8021"
WS = "ws://localhost:8021"


def http_post_create() -> str:
    data = b"table_name=E2E&small_blind=1&big_blind=2&stack=200"
    req = urllib.request.Request(f"{BASE}/create", data=data, method="POST")
    # Don't follow redirect; read Location.
    opener = urllib.request.build_opener(NoRedirect())
    try:
        opener.open(req)
    except urllib.error.HTTPError as e:
        return e.headers["Location"].split("/")[-1]
    raise RuntimeError("expected redirect")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def new_pid() -> str:
    with urllib.request.urlopen(f"{BASE}/api/new_pid") as r:
        return json.load(r)["pid"]


async def recv_state(ws):
    while True:
        msg = json.loads(await ws.recv())
        if msg.get("type") == "state":
            return msg


async def recv_until(ws, phase):
    """Drain buffered states until we reach the expected phase."""
    for _ in range(20):
        s = await recv_state(ws)
        if s["phase"] == phase:
            return s
    raise AssertionError(f"never reached phase {phase}")


async def main():
    tid = http_post_create()
    print("table:", tid)
    p1, p2 = new_pid(), new_pid()

    async with websockets.connect(f"{WS}/ws/{tid}?pid={p1}&name=Alice") as a, \
               websockets.connect(f"{WS}/ws/{tid}?pid={p2}&name=Bob") as b:
        await recv_state(a)
        await recv_state(b)

        # Start the hand from Alice.
        await a.send(json.dumps({"type": "start"}))
        sa = await recv_until(a, "preflop")
        await recv_until(b, "preflop")
        print("phase after start:", sa["phase"], "pot:", sa["pot"])
        assert sa["phase"] == "preflop"
        assert sa["pot"] == 3  # sb + bb

        # Drive the hand: actor checks if allowed else calls, until showdown.
        clients = {p1: a, p2: b}
        latest = {p1: await drain_latest(a, sa), p2: await drain_latest(b, sa)}
        guard = 0
        while latest[p1]["phase"] != "showdown" and guard < 40:
            state = latest[p1]
            actor = state["to_act"]
            if actor is None:
                break
            view = latest[actor]
            action = "check" if view["you"]["can_check"] else "call"
            await clients[actor].send(
                json.dumps({"type": "action", "action": action}))
            latest[p1] = await drain_latest(a, latest[p1])
            latest[p2] = await drain_latest(b, latest[p2])
            guard += 1

        state = latest[p1]
        print("final phase:", state["phase"])
        print("board:", state["board"])
        print("results:", state["results"])
        assert state["phase"] == "showdown"
        assert state["results"] is not None
        total = sum(p["stack"] for p in state["players"])
        print("total chips:", total)
        assert total == 400  # 2 x 200, conserved
        print("E2E OK")


async def drain_latest(ws, current):
    """Return the most recent state available on ws (non-blocking drain)."""
    latest = current
    while True:
        try:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=0.25))
        except asyncio.TimeoutError:
            return latest
        if msg.get("type") == "state":
            latest = msg


if __name__ == "__main__":
    asyncio.run(main())
