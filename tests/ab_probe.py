"""Probe: stop at the first preflop decision and print the exact fields the
new action bar consumes for the player to act. Manual check (needs server)."""
import asyncio
import json
import sys
import urllib.request
import urllib.error

import websockets

BASE = "http://localhost:8021"
WS = "ws://localhost:8021"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def create():
    data = b"table_name=ABProbe&small_blind=1&big_blind=2&stack=200"
    req = urllib.request.Request(f"{BASE}/create", data=data, method="POST")
    try:
        urllib.request.build_opener(NoRedirect()).open(req)
    except urllib.error.HTTPError as e:
        return e.headers["Location"].split("/")[-1]
    raise RuntimeError("expected redirect")


def new_pid():
    with urllib.request.urlopen(f"{BASE}/api/new_pid") as r:
        return json.load(r)["pid"]


async def recv_state(ws):
    while True:
        m = json.loads(await ws.recv())
        if m.get("type") == "state":
            return m


async def latest(ws, cur):
    out = cur
    while True:
        try:
            m = json.loads(await asyncio.wait_for(ws.recv(), 0.25))
        except asyncio.TimeoutError:
            return out
        if m.get("type") == "state":
            out = m


async def main():
    tid = create()
    p1, p2 = new_pid(), new_pid()
    async with websockets.connect(f"{WS}/ws/{tid}?pid={p1}&name=Alice") as a, \
               websockets.connect(f"{WS}/ws/{tid}?pid={p2}&name=Bob") as b:
        await recv_state(a); await recv_state(b)
        await a.send(json.dumps({"type": "sit", "seat": 0, "amount": 200}))
        await b.send(json.dumps({"type": "sit", "seat": 1, "amount": 200}))
        await asyncio.sleep(0.3)
        await a.send(json.dumps({"type": "approve", "target": p2}))
        await asyncio.sleep(0.3)
        await a.send(json.dumps({"type": "start"}))
        sa = await recv_state(a); sb = await recv_state(b)
        sa = await latest(a, sa); sb = await latest(b, sb)
        views = {p1: sa, p2: sb}

        s = sa
        actor = s["to_act"]
        assert actor, "someone should be to act preflop"
        v = views[actor]["you"]
        me = next(p for p in views[actor]["players"] if p["id"] == actor)
        minTo = max(v["min_raise_to"], s["current_bet"] + 1)
        maxRaiseTo = (s["current_bet"] - v["to_call"]) + v["stack"]
        can_raise = minTo <= maxRaiseTo
        ok = True
        def check(label, cond):
            print(f"  [{'OK' if cond else 'FAIL'}] {label}")
            return cond
        print("Action-bar data contract @ first decision:")
        ok &= check("hero has 2 hole cards (visible to self)",
                    len(me["hole"]) == 2 and "back" not in me["hole"])
        ok &= check("hero name present", bool(me["name"]))
        ok &= check("hero stack is int", isinstance(me["stack"], int))
        ok &= check("to_call present (int>=0)", isinstance(v["to_call"], int) and v["to_call"] >= 0)
        ok &= check("min_raise_to present", isinstance(v["min_raise_to"], int))
        ok &= check("can_check is bool", isinstance(v["can_check"], bool))
        ok &= check("raise bounds sane (min<=max)", can_raise and minTo <= maxRaiseTo)
        ok &= check("premove field exists", "premove" in v)
        ok &= check("auto_check_fold field exists", "auto_check_fold" in v)
        print(f"  hole={me['hole']} stack={me['stack']} to_call={v['to_call']} "
              f"min_raise_to={v['min_raise_to']} can_check={v['can_check']} "
              f"raiseBounds=({minTo},{maxRaiseTo})")

        # Exercise a RAISE submitted from the bar's amount field.
        amt = minTo + 4
        await a.send(json.dumps({"type": "action", "action": "raise", "amount": amt})
                     if actor == p1 else
                     json.dumps({"type": "action", "action": "raise", "amount": amt}))
        await asyncio.sleep(0.3)
        sa = await latest(a, sa)
        ok &= check(f"raise to {amt} accepted (current_bet rose)", sa["current_bet"] >= amt)
        print("PROBE OK" if ok else "PROBE FAILED")
        sys.exit(0 if ok else 1)


if __name__ == "__main__":
    asyncio.run(main())
