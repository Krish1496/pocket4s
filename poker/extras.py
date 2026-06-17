"""Optional poker flavor: rabbit hunting and the 7-2 offsuit bounty.

Kept out of the core engine so the betting state machine stays lean and
these crowd-pleasers are easy to toggle on/off.
"""
from __future__ import annotations


def is_72_offsuit(hole: list) -> bool:
    """True if the two hole cards are a 7 and a 2 of different suits."""
    if len(hole) != 2:
        return False
    ranks = sorted(c.rank for c in hole)
    suits = {c.suit for c in hole}
    return ranks == [2, 7] and len(suits) == 2


def apply_72_bounty(game) -> list[str]:
    """If a hand winner holds 7-2 offsuit, every other player who was dealt
    in pays them the bounty. Returns log lines. Chips are conserved."""
    s = game.settings
    if not s.bounty_72 or not game.last_results:
        return []
    amount = s.bounty_72_amount
    if amount <= 0:
        return []

    winners = set()
    for pot in game.last_results["pots"]:
        winners.update(pot["winners"])

    participants = [p for p in game.players if p.hole]  # dealt in this hand
    logs: list[str] = []
    for wid in winners:
        winner = game.get(wid)
        if not winner or not is_72_offsuit(winner.hole):
            continue
        collected = 0
        for p in participants:
            if p.id == wid:
                continue
            pay = min(amount, p.stack)
            p.stack -= pay
            collected += pay
        winner.stack += collected
        if collected:
            logs.append(f"BOUNTY! {winner.name} wins with 7-2 offsuit "
                        f"and collects {collected} from the table")
    return logs


def rabbit_runout(game) -> list[str]:
    """Deal the cards that *would* have come had the hand played to the
    river. Stored on game.rabbit_board for display only -- never affects
    the result. Returns the revealed card codes."""
    if not game.settings.rabbit_hunting or game.deck is None:
        return []
    revealed = []
    while len(game.board) + len(game.rabbit_board) < 5:
        game.deck.deal_one()  # burn, to mimic real dealing
        card = game.deck.deal_one()
        game.rabbit_board.append(card)
        revealed.append(card.code)
    return revealed


def reveal_rabbit(game) -> None:
    """Validate + perform an on-demand rabbit hunt. Raises ValueError with a
    user-facing message if it isn't allowed right now."""
    if game.phase.value != "showdown":
        raise ValueError("You can only rabbit-hunt right after a hand")
    if not game.settings.rabbit_hunting:
        raise ValueError("Rabbit hunting is turned off for this table")
    if len(game.board) >= 5:
        raise ValueError("The board already ran out")
    if game.rabbit_board:
        return  # already revealed this hand
    revealed = rabbit_runout(game)
    if revealed:
        game._log("Rabbit hunt: " + " ".join(revealed))
