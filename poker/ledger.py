"""The money ledger: who bought in for how much, and where they stand.

`net = current_stack (or cashed-out stack) - total_bought_in`. Summed over
everyone it should always be ~0 (chips are conserved; the ledger just
re-frames stacks as profit/loss vs. buy-ins). Owner stack edits are folded
into buy-ins so the math stays honest.
"""
from __future__ import annotations


class Ledger:
    def __init__(self) -> None:
        self.bought_in: dict[str, int] = {}   # pid -> lifetime chips bought
        self.names: dict[str, str] = {}       # pid -> latest display name
        self.cashed: dict[str, int] = {}      # pid -> stack when they stood up

    def record_name(self, pid: str, name: str) -> None:
        self.names[pid] = name

    def add_buyin(self, pid: str, amount: int) -> None:
        self.bought_in[pid] = self.bought_in.get(pid, 0) + amount

    def cash_out(self, pid: str, stack: int) -> None:
        self.cashed[pid] = self.cashed.get(pid, 0) + stack

    def rows(self, live_stacks: dict[str, int]) -> list[dict]:
        """One row per player who has ever bought in.

        `live_stacks` maps pid -> current stack for seated players.
        """
        out = []
        for pid, bought in self.bought_in.items():
            seated = pid in live_stacks
            stack = live_stacks.get(pid, self.cashed.get(pid, 0))
            out.append({
                "id": pid,
                "name": self.names.get(pid, "Player"),
                "bought_in": bought,
                "stack": stack,
                "net": stack - bought,
                "seated": seated,
            })
        out.sort(key=lambda r: r["net"], reverse=True)
        return out

    def table_net(self, live_stacks: dict[str, int]) -> int:
        return sum(r["net"] for r in self.rows(live_stacks))
