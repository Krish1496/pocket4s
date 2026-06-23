# PokerNow Mobile UI — Design Spec (from screen recording 19180.mp4)

Source: pokernow.com, portrait mobile capture **1080 x 2352** (aspect ~0.459, a tall phone),
60fps, ~2m50s. Goal: make puppy-poker's table match this look, layout, and dimensions.

## Color tokens (sampled from full-res frames)
| Token | Hex | Use |
|-------|-----|-----|
| `--bg` | `#1e1b1c` → `#272727` | app background (near-black, very slight gradient) |
| `--felt` | `#2a8955` | table felt green (radial: a touch lighter in center, darker at edges) |
| `--rail` | `#1f1d1e` | thick dark rounded rail around the felt |
| `--pod` | `#313131` | player pod background (idle) |
| `--pod-active` | `#fdfdfd` | player pod background when it's their turn (white) |
| `--card-face` | `#fdfdfd` | community/hole card face (white) |
| `--card-back` | `~#c0504d` salmon-red | hole-card backs (diagonal stripes + "POKER NOW") |
| `--chip` | lime-yellow `#d6e84f`-ish | bet chips (round, bold dark number) |
| `--dealer` | `#5c959e` teal | dealer "D" button (light teal circle, white D) |
| timer bar | gradient **purple `#8b5cf6` → lime `#a3e635`** | thin bar under active (white) pod |
| text | white `#f5f5f5` on pods; dark on white pod/cards | |

## Layout (portrait)
- **Browser chrome at top is NOT part of the app** (status bar + pokernow.com bar) — ignore.
- **Table:** large vertical rounded-rectangle filling most of the screen. Thick dark rail
  (`--rail`) with big corner radius (~36–44px), green felt inside, subtle inner shadow/bevel.
- **8 seats** around the table edge, pods sit ON the rail (slightly overlapping the felt edge):
  - top-center, top-right, right-mid, right-lower, bottom-center (HERO), bottom-left,
    left-lower, left-mid. (Exact 8-handed ring.)
- **Pod:** dark rounded rect; **name** (bold, white) on line 1, **stack** (white) on line 2.
  Each pod has its 2 **hole cards** fanned just above/behind it (red backs for others;
  hero sees real faces at the bottom).
- **Active pod:** turns **white**, dark text, with a thin **purple→lime timer bar** along the bottom.
- **Bet chips:** small **lime-yellow round** badges with a bold number, placed between each
  player and the pot (shows that player's current-street wager). Animate toward the pot.
- **Pot:** centered **dark pill** with white number; tiny "total N" label above-right of the pill.
- **Board (community cards):** white rounded cards, **big rank top-left, large suit below**;
  black for , red for . 3 on flop, 4 turn, 5 river, centered.
- **Action labels:** transient **white rounded pill** ("check", "call", "raise", "fold")
  pops near the acting player's pod.
- **Dealer button:** small teal circle "D" near the button seat.
- **Stakes label:** center felt, e.g. `NLH ~ 1 / 2` + small icon.
- **Watermark:** faint "POWERED BY POKER NOW" + logo center felt.

## Top bar (in-app, below browser)
- Left: hamburger (≡) + "OPTIONS" label. When seated: also "LEAVE SEAT" + "AWAY" icons appear.
- Right: rounded **sound** toggle button.

## Bottom UI
- Left stack: **CHAT (n)** and **LOG** outlined buttons; a **LIVE / JOIN** mic widget.
- Hero pod at bottom-center with real cards; "IN NEXT HAND" pill when sitting out.
- **Action bar** (when it's hero's turn): a row of 4 wide buttons on dark bg with colored
  text/borders — **CALL n** (green), **RAISE** (green), **CHECK** (grey), **FOLD** (red border).
- **Raise panel** (after tapping RAISE): "Your bet" box with big amount + `NN BB` hint;
  preset row **MIN RAISE · 1/2 POT · 3/4 POT · POT · ALL IN**; a slider with − / + steppers;
  **BACK** (grey) + **RAISE** (green) confirm. "EXTRA TIME ACTIVATED" pill may show.
- Bottom-right: **fullscreen** expand icon.

## Card face geometry
- White rounded rect, ratio ~ 0.72 (w:h). Rank glyph large, top-left aligned; suit glyph
  large, centered/below. Heavy bold font. (PokerNow uses a single big rank + big suit, not the
  4-corner playing-card layout.)

## Showdown / states observed
- "All In" replaces stack text on pods that are all-in.
- Hand-rank tag (e.g. red "HIGH CARD") near hero pod at showdown.
- Multiple side-pot totals roll up into the central pill ("total 1127").
