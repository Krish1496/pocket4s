# Puppy Poker

A small, self-hosted **No-Limit Texas Hold'em** site for playing with friends
online -- think a tiny PokerNow clone. Create a table, share the link, play.
Chips only, no real money.

## Features
- Real-time multiplayer over WebSockets
- Full No-Limit Hold'em rules: blinds, betting rounds, all-ins, **side pots**
- Correct 7-card hand evaluation (brute-forced, fully tested)
- Create a table -> share an invite link
- Reconnect-friendly (your seat is remembered per table)
- In-table chat + action feed
- Zero JS dependencies on the client; Tailwind via CDN

## Run it locally
```bash
uv venv --python 3.12
uv pip install fastapi "uvicorn[standard]" pytest
.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8021
```
Open http://localhost:8021 and create a table. Friends on the same network
can join via your machine's LAN IP.

## Tests
```bash
.venv/bin/python -m pytest -q
```

## Playing with friends in other countries
This runs as a single server process. For remote friends you need to deploy it
somewhere publicly reachable (any host that supports WebSockets). The app reads
`$PORT` from the environment, so it drops straight onto most platforms:
```bash
uvicorn main:app --host 0.0.0.0 --port ${PORT:-8021}
```

## Project layout
```
poker/        Pure game logic (no web deps) -- cards, evaluator, engine, pots
server/       Room manager + JSON serialization for the browser
static/       Lobby + table UI (HTML/CSS/JS)
main.py       FastAPI app: routes + game WebSocket
tests/        Evaluator + engine tests
```
