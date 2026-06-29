// Puppy Poker - core client. WebSocket + table/seat/action rendering.

const SUIT = {
  c: { sym: "\u2663", color: "black" },
  d: { sym: "\u2666", color: "red" },
  h: { sym: "\u2665", color: "red" },
  s: { sym: "\u2660", color: "black" },
};
const RANK_LABEL = { T: "10" };

// Small mic glyph shown on the top-left of a player's pod when they're in voice.
const MIC_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true">' +
  '<path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/>' +
  '<path d="M19 11a1 1 0 0 0-2 0 5 5 0 0 1-10 0 1 1 0 0 0-2 0 7 7 0 0 0 6 6.92V21a1 1 0 0 0 2 0v-3.08A7 7 0 0 0 19 11z"/></svg>';

const tableId = location.pathname.split("/").pop();
const pidKey = `pp_pid_${tableId}`;
const nameKey = "pp_name";

const PP = {
  tableId,
  pid: localStorage.getItem(pidKey),
  name: localStorage.getItem(nameKey) || "",
  ws: null,
  state: null,
  send,
  toast,
  $: (id) => document.getElementById(id),
};
window.PP = PP;

const $ = PP.$;

function cardEl(code, small) {
  const div = document.createElement("div");
  if (code === "back") {
    div.className = "card back" + (small ? " small" : "");
    return div;
  }
  const info = SUIT[code[1]] || { sym: "?", color: "black" };
  div.className = `card ${info.color}` + (small ? " small" : "");
  const r = document.createElement("span");
  r.className = "rank";
  r.textContent = RANK_LABEL[code[0]] || code[0];
  const s = document.createElement("span");
  s.className = "suit";
  s.textContent = info.sym;
  div.append(r, s);
  return div;
}
PP.cardEl = cardEl;

function flipCardEl(code, small, delay) {
  const wrap = document.createElement("div");
  wrap.className = "flip3d" + (small ? " small" : "");
  const inner = document.createElement("div");
  inner.className = "flip-inner";
  if (delay) inner.style.animationDelay = delay + "s";
  const back = document.createElement("div");
  back.className = "flip-face flip-back";
  const front = cardEl(code, small);
  front.classList.add("flip-face", "flip-front");
  inner.append(back, front);
  wrap.append(inner);
  return wrap;
}

function placeholderCard() {
  const div = document.createElement("div");
  div.className = "card placeholder";
  return div;
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2800);
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
PP.escapeHtml = escapeHtml;

async function ensurePid() {
  if (!PP.pid) {
    const r = await fetch("/api/new_pid");
    PP.pid = (await r.json()).pid;
    localStorage.setItem(pidKey, PP.pid);
  }
}

async function loadTableInfo() {
  try {
    const r = await fetch(`/api/table/${tableId}`);
    if (!r.ok) return;
    const info = await r.json();
    $("tableName").textContent = info.name;
  } catch (e) { /* ignore */ }
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws/${tableId}` +
    `?pid=${encodeURIComponent(PP.pid)}&name=${encodeURIComponent(PP.name)}`;
  PP.ws = new WebSocket(url);

  PP.ws.onopen = () => {
    PP.reconnectAttempts = 0;
    $("connDot").textContent = "connected";
    $("connDot").className = "text-xs text-emerald-400";
    startHeartbeat();
  };

  PP.ws.onclose = (ev) => {
    stopHeartbeat();
    console.warn("WebSocket closed", { code: ev && ev.code, reason: ev && ev.reason });
    // 4404 = the server has no such table (it restarted and lost it, or the
    if (ev && ev.code === 4404) {
      tableGone();
      return;
    }
    const n = (PP.reconnectAttempts = (PP.reconnectAttempts || 0) + 1);
    const delay = Math.min(1000 * 2 ** (n - 1), 15000) + Math.random() * 400;
    $("connDot").textContent = `reconnecting (${n})...`;
    $("connDot").className = "text-xs text-amber-400";
    clearTimeout(PP.reconnectTimer);
    PP.reconnectTimer = setTimeout(connect, delay);
  };

  PP.ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === "state") { PP.state = data; onStateTimer(); onStateChat(); render(); }
    else if (data.type === "error") { toast(data.message); }
    else if (data.type === "signal") { if (window.PPVoice) PPVoice.onSignal(data); }
  };
}

function startHeartbeat() {
  stopHeartbeat();
  PP.heartbeat = setInterval(() => {
    if (PP.ws && PP.ws.readyState === WebSocket.OPEN) {
      PP.ws.send(JSON.stringify({ type: "ping" }));
    }
  }, 20000);
}
function stopHeartbeat() {
  if (PP.heartbeat) { clearInterval(PP.heartbeat); PP.heartbeat = null; }
}

function tableGone() {
  $("connDot").textContent = "table not found";
  $("connDot").className = "text-xs text-rose-400";
  const w = $("waitMsg");
  if (w) {
    w.innerHTML = "This table no longer exists (the server may have " +
      'restarted). <a href="/" class="underline text-emerald-400">' +
      "Create a new table</a>.";
  }
  toast("Table not found - it may have reset. Make a new one.");
}

function send(obj) {
  if (PP.ws && PP.ws.readyState === WebSocket.OPEN) PP.ws.send(JSON.stringify(obj));
}

function render() {
  const s = PP.state;
  if (!s) return;
  computeAnims(s);
  $("potLabel").textContent = s.pot;
  if (PP.anim.potBump) {
    const pl = $("potLabel");
    pl.classList.remove("bump"); void pl.offsetWidth; pl.classList.add("bump");
  }
  $("phaseLabel").textContent = s.phase === "waiting" ? "Waiting for players" : s.phase;
  const rabbitable = s.phase === "showdown" && (s.board || []).length < 5 &&
    s.settings.rabbit_hunting && !(s.rabbit && s.rabbit.length);
  $("board").classList.toggle("rabbitable", rabbitable);
  $("board").title = rabbitable ? "Click or press H to rabbit-hunt" : "";
  const rh = $("rabbitHint");
  if (rh) { rh.classList.toggle("hidden", !rabbitable); }
  $("blindsInfo").textContent =
    `Blinds ${s.settings.small_blind}/${s.settings.big_blind}` +
    (s.settings.ante ? ` \u2022 ante ${s.settings.ante}` : "") +
    ` \u2022 buy-in ${s.settings.min_buyin}-${s.settings.max_buyin}`;

  renderBoard();
  if (window.renderRuns) window.renderRuns();
  renderSeats();
  renderActionBar();
  if (window.renderRunVote) window.renderRunVote();
  renderResult();
  if (window.renderPanels) window.renderPanels(s);
  if (window.PPVoice) PPVoice.onState();
}

function computeAnims(s) {
  const a = { boardFrom: s.board.length, dealHoles: false,
              flipReveal: false, potBump: false, winners: {} };
  const newHand = s.hand_no !== PP.prevHandNo;
  if (newHand) { PP.prevBoardLen = 0; PP.prevRunsDone = 0; PP.prevRabbitLen = 0; PP.shownCells = new Set(); }
  a.boardFrom = PP.prevBoardLen || 0;
  a.rabbitFrom = PP.prevRabbitLen || 0;   // flip in only the freshly-revealed rabbit cards
  // Run-it-twice: when a NEW run starts, only flip the fresh street(s) for
  // that run -- the shared flop/turn revealed before the all-in stays put
  // and must NOT re-flip. (Detect the new run by the completed-runs count,
  // which is robust even when every run is the same length, e.g. a turn
  // all-in where each run only adds the river.)
  const runsDone = (s.run_boards || []).length;
  if (s.running_out && runsDone > (PP.prevRunsDone || 0)) {
    a.boardFrom = s.run_base || 0;
  }
  a.dealHoles = newHand && s.phase === "preflop";
  a.flipReveal = s.phase === "showdown" && PP.prevPhase !== "showdown";
  a.potBump = s.pot > (PP.prevPot || 0);
  if (s.phase === "showdown" && s.results) {
    s.results.pots.forEach((p) =>
      (p.winners || []).forEach((w) => {
        a.winners[w] = (a.winners[w] || 0) + p.amount_each;
      }));
  }
  PP.anim = a;
  if (window.PPSFX) {
    if (a.dealHoles) PPSFX.play("deal");          // board flips play per-card in renderBoard
    if (a.flipReveal) PPSFX.play("win");
    const mine = s.you && s.to_act === s.you.id, left = s.turn_seconds_left;
    if (mine && left != null && left <= 5 && (PP._prevLeft == null || PP._prevLeft > 5)) PPSFX.play("timeout");
    PP._prevLeft = mine ? left : null;
  }
  PP.prevBoardLen = s.board.length;
  PP.prevRunsDone = runsDone;
  PP.prevRabbitLen = (s.rabbit || []).length;
  if (window.detectFlashes) window.detectFlashes(s);
  PP.prevHandNo = s.hand_no;
  PP.prevPhase = s.phase;
  PP.prevPot = s.pot;
}

function renderBoard() {
  const s = PP.state;
  const board = $("board");
  board.innerHTML = "";
  if (!PP.shownCells) PP.shownCells = new Set();

  if (s.run_count > 1) {
    renderStackedBoard(board, s);
  } else {
    // Normal single board: flip in the freshly-dealt street(s). Empty slots
    // are filled by RABBIT cards (the would-be runout) when revealed -- shown
    // dimmed, right in the board row (never below it).
    const rabbit = s.rabbit || [];
    const baseLen = s.board.length;
    for (let i = 0; i < 5; i++) {
      if (s.board[i]) {
        if (i >= PP.anim.boardFrom) {
          const step = i - PP.anim.boardFrom;
          // PokerNow: card lands face-down, holds ~0.12s, then a quick flip.
          board.append(flipCardEl(s.board[i], false, 0.12 + step * 0.13));
          if (window.PPSFX) setTimeout(() => PPSFX.play("deal"), 120 + step * 130);
        } else {
          board.append(cardEl(s.board[i]));
        }
      } else if (rabbit[i - baseLen]) {
        const ri = i - baseLen;
        let rc;
        if (ri >= (PP.anim.rabbitFrom || 0)) {
          // Freshly revealed -> flip it in like a real street.
          const step = ri - (PP.anim.rabbitFrom || 0);
          rc = flipCardEl(rabbit[ri], false, 0.12 + step * 0.13);
          if (window.PPSFX) setTimeout(() => PPSFX.play("deal"), 120 + step * 130);
        } else {
          rc = cardEl(rabbit[ri]);
        }
        rc.classList.add("rabbit-card");        // dimmed -> "would have been"
        board.append(rc);
      } else {
        board.append(placeholderCard());
      }
    }
  }
}

// Run-it-twice layout: the shared flop stays on one row; each run's NEW
// cards (turn, river) stack vertically under the previous run's turn/river
// -- so the board grows DOWN a column, not sideways. Only freshly-dealt
// cards flip in (tracked in PP.shownCells); already-shown cards stay put.
function renderStackedBoard(board, s) {
  let boards, base;
  if (s.phase === "showdown" && s.results && s.results.runs) {
    boards = s.results.runs.map((r) => r.board);
    base = commonPrefixLen(boards);
  } else {
    boards = [...(s.run_boards || [])];   // completed runs (full)
    boards.push(s.board);                 // current run being dealt (partial)
    base = s.run_base || 0;
  }
  let newCells = 0;
  const cell = (code, col, ri) => {
    const key = col + ":" + ri;
    if (col < base || PP.shownCells.has(key)) return cardEl(code);
    PP.shownCells.add(key);
    const step = newCells++;
    if (window.PPSFX) setTimeout(() => PPSFX.play("deal"), 120 + step * 130);
    return flipCardEl(code, false, 0.12 + step * 0.13);
  };
  for (let col = 0; col < 5; col++) {
    const colEl = document.createElement("div");
    colEl.className = "board-col";
    if (col < base) {
      colEl.append(cell(boards[0][col], col, 0));   // shared flop/turn: once
    } else {
      const cards = [];
      boards.forEach((b, ri) => {
        if (b[col]) cards.push(cell(b[col], col, ri));
        else if (ri === boards.length - 1) cards.push(placeholderCard());
      });
      // Dim the older cards that are overlapped -- only the newest real card
      // in the column stays full opacity.
      let lastReal = -1;
      cards.forEach((el, i) => { if (!el.classList.contains("placeholder")) lastReal = i; });
      cards.forEach((el, i) => {
        if (i < lastReal && !el.classList.contains("placeholder")) el.classList.add("covered");
        colEl.append(el);
      });
    }
    board.append(colEl);
  }
}

// Leading cards identical across every board (the shared flop/turn).
function commonPrefixLen(boards) {
  if (!boards.length) return 0;
  const first = boards[0];
  let k = 0;
  for (; k < first.length; k++) {
    if (!boards.every((b) => b[k] === first[k])) break;
  }
  return k;
}
window.commonPrefixLen = commonPrefixLen;

function renderSeats() {
  const s = PP.state;
  const felt = $("felt");
  felt.querySelectorAll(".seat").forEach((e) => e.remove());

  const bySeat = {};
  s.players.forEach((p) => { bySeat[p.seat] = p; });

  const n = s.seat_count;
  const mySeat = s.you.seat;
  const iAmSeated = mySeat != null;   // seated players don't need empty seats
  const portrait = window.matchMedia("(max-width: 700px) and (orientation: portrait)").matches;
  for (let visual = 0; visual < n; visual++) {
    const seatNum = mySeat != null ? (mySeat + visual) % n : visual;
    let x, y;
    if (portrait) {
      [x, y] = portraitSeat(visual, n);     // PokerNow column layout
    } else {
      [x, y] = desktopSeat(visual, n);      // PokerNow racetrack layout
    }
    const occupant = bySeat[seatNum];
    if (occupant) felt.append(seatEl(occupant, x, y));
    else if (!iAmSeated) felt.append(openSeatEl(seatNum, x, y));   // hide SIT once you're seated
  }
}

// Which side of the pod the hole cards sit on (they face the table center,
// like PokerNow): bottom -> above, top -> below, sides -> toward center.
// On the racetrack the caps reach high/low, so x-extremes are ALWAYS a side
// (left/right) regardless of y; only the flat rails use the y bands.
function seatZone(x, y) {
  if (x <= 15) return "left";
  if (x >= 85) return "right";
  if (y >= 65) return "bottom";
  if (y <= 28) return "top";
  return x < 50 ? "left" : "right";
}

// PokerNow DESKTOP racetrack (stadium): flat top & bottom rails + full
// semicircle caps left & right. Layout is LEFT-RIGHT SYMMETRIC with NO seat
// at dead-center (so the Start button never overlaps a pod). Hero sits at
// bottom-RIGHT with a mirror partner bottom-left; 2 on each rail, 3 on each
// cap. Seats run clockwise from the hero.
function desktopSeat(v, n) {
  if (n === 10) {
    const slots = [
      [62, 103],   // 0 hero    -- bottom-right (center is left empty)
      [97, 78],    // 1 right cap, lower
      [101, 50],   // 2 right cap, middle
      [97, 22],    // 3 right cap, upper
      [62, -4],    // 4 top-right rail
      [38, -4],    // 5 top-left rail
      [3, 22],     // 6 left cap, upper
      [-1, 50],    // 7 left cap, middle
      [3, 78],     // 8 left cap, lower
      [38, 103],   // 9 bottom-left rail (mirror of hero)
    ];
    return slots[v];
  }
  const rx = 52, ry = 46;              // fallback ellipse for non-10 tables
  const angle = Math.PI / 2 + (v * 2 * Math.PI) / n;
  return [50 + rx * Math.cos(angle), 50 + ry * Math.sin(angle)];
}

// PokerNow portrait layout. For 8-max we replicate PokerNow's exact visual
// slots: an asymmetric tall oval where NO side seat sits on the board's row
// (so pods never overlap the community cards). Hero bottom, one seat top.
function portraitSeat(v, n) {
  if (n === 8) {
    const slots = [
      [50, 90],            // 0 hero, bottom-center
      [12, 75], [12, 56], [12, 35],   // 1-3 left column (bottom -> top)
      [50, 12],            // 4 top-center
      [88, 22], [88, 42], [88, 62],   // 5-7 right column (top -> bottom)
    ];
    return slots[v];
  }
  // Generic fallback for other table sizes (hero bottom, one top, columns).
  if (v === 0) return [50, 90];
  const topIndex = Math.round(n / 2);
  if (v === topIndex) return [50, 12];
  const X_L = 12, X_R = 88, Y_HI = 22, Y_LO = 78;
  if (v < topIndex) {                            // left column: bottom -> top
    const k = topIndex - 1, i = v - 1;
    const frac = k > 1 ? i / (k - 1) : 0.5;
    return [X_L, Y_LO - frac * (Y_LO - Y_HI)];
  }
  const k = n - 1 - topIndex, j = v - topIndex - 1;   // right column: top -> bottom
  const frac = k > 1 ? j / (k - 1) : 0.5;
  return [X_R, Y_HI + frac * (Y_LO - Y_HI)];
}

function seatEl(p, xPct, yPct) {
  const s = PP.state;
  const wrap = document.createElement("div");
  wrap.className = "seat";
  if (p.id === PP.pid) wrap.classList.add("you");
  if (p.is_turn) wrap.classList.add("turn");
  if (p.status === "folded") wrap.classList.add("folded");
  if (p.away) wrap.classList.add("away");
  // Zone drives where the hole cards sit (PokerNow: cards face the table center).
  wrap.classList.add("zone-" + seatZone(xPct, yPct));
  const winAmount = PP.anim.winners[p.id];
  if (winAmount != null) wrap.classList.add("winner");
  wrap.style.left = xPct + "%";
  wrap.style.top = yPct + "%";

  const cards = document.createElement("div");
  cards.className = "cards";
  const shownIdx = p.shown || [];
  (p.hole || []).forEach((c, i) => {
    let el;
    if (PP.anim.dealHoles && c !== "back") {
      el = flipCardEl(c, true, i * 0.08);
    } else if (PP.anim.flipReveal && p.id !== PP.pid && c !== "back") {
      el = flipCardEl(c, true, i * 0.1);
    } else {
      el = cardEl(c, true);
    }
    // A voluntarily-shown card is visible to everyone -> keep it FULL opacity
    // even when the seat is folded/ghosted.
    if (shownIdx.includes(i) && c !== "back") el.classList.add("shown-card");
    cards.append(el);
  });

  const pod = document.createElement("div");
  pod.className = "pod relative";
  const disc = p.connected ? "" : '<span class="disconnected-dot" title="disconnected"></span>';
  const crown = p.is_owner ? " \u2605" : "";
  const topup = p.pending_topup ? ` <span class="text-emerald-400">(+${p.pending_topup})</span>` : "";
  const awayTag = p.away ? ' <span class="away-tag">AWAY</span>' : "";
  const winPlus = winAmount != null ? ` <span class="win-plus">+${winAmount}</span>` : "";
  const initial = (p.name || "?").trim().charAt(0).toUpperCase() || "?";
  pod.innerHTML =
    `<div class="avatar">${escapeHtml(initial)}</div>` +
    `<div class="pod-text">` +
    `<div class="name">${escapeHtml(p.name)}${crown}${disc}${awayTag}</div>` +
    `<div class="stack">${p.stack}${topup}${winPlus}</div>` +
    `</div>`;
  if (p.is_button) {
    const b = document.createElement("div");
    b.className = "badge";
    b.textContent = "D";
    pod.append(b);
  }
  if ((s.voice || []).some((v) => v.id === p.id)) {
    const mic = document.createElement("div");
    mic.className = "seat-mic";
    mic.dataset.mic = p.id;
    mic.innerHTML = MIC_SVG;
    pod.append(mic);
  }
  if (p.is_turn && s.action_timeout > 0 && s.turn_seconds_left != null) {
    const bar = document.createElement("div");
    bar.className = "pod-timer";
    const fill = document.createElement("div");
    fill.className = "pod-timer-fill";
    const pct = Math.max(0, Math.min(100, (s.turn_seconds_left / s.action_timeout) * 100));
    fill.style.width = pct + "%";
    bar.append(fill);
    pod.append(bar);
  }
  if (s.you.is_owner) {
    pod.classList.add("host-editable");
    pod.dataset.hostMenu = p.id;
    pod.title = "Host: click to manage chips";
  }

  wrap.append(cards, pod);
  const fl = PP.flash && PP.flash[p.id];
  if (fl && fl.until > Date.now()) {
    const f = document.createElement("div");
    f.className = "action-flash";
    f.textContent = fl.text;
    f.dataset.until = fl.until;
    if (fl.shown) f.classList.add("no-anim");   // only animate the FIRST time
    fl.shown = true;
    wrap.append(f);
  }
  if (p.win_pct != null) {
    const eq = document.createElement("div");
    eq.className = "win-pct";
    eq.textContent = p.win_pct + "%";
    pod.append(eq);                 // anchored to the name pod (top-right)
  }
  if (p.hand_name) {
    const hn = document.createElement("div");
    hn.className = "hand-name";
    hn.textContent = p.hand_name;
    pod.append(hn);                 // anchored to the name pod (bottom-right)
  }
  if (p.round_bet > 0) {
    const bet = document.createElement("div");
    bet.className = "bet-chip";
    bet.textContent = "Bet: " + p.round_bet;
    // Push the chip from the seat TOWARD the pot, far enough to clear the
    // player's hole cards and land on open felt. Scaled to the table size so
    // it works on any screen.
    const felt = $("felt");
    const fw = felt.clientWidth || 900, fh = felt.clientHeight || 430;
    const ang = Math.atan2(50 - yPct, 50 - xPct);
    const dx = Math.cos(ang) * fw * 0.085, dy = Math.sin(ang) * fh * 0.17;
    bet.style.transform = `translate(-50%, -50%) translate(${dx}px, ${dy}px)`;
    wrap.append(bet);
  }
  const bubble = PP.bubbles && PP.bubbles[p.id];
  if (bubble && performance.now() < bubble.until) {
    const b = document.createElement("div");
    b.className = "chat-bubble";
    b.dataset.until = bubble.until;
    b.textContent = bubble.text;
    if (bubble.shown) b.classList.add("no-anim");   // only animate the FIRST time
    bubble.shown = true;
    wrap.append(b);
  }
  return wrap;
}

function openSeatEl(seatNum, xPct, yPct) {
  const s = PP.state;
  const wrap = document.createElement("div");
  wrap.className = "seat open";
  wrap.style.left = xPct + "%";
  wrap.style.top = yPct + "%";
  const canSit = !s.you.seated;
  const box = document.createElement("div");
  box.className = "sit-box";
  box.innerHTML = `<span class="sit-num">${seatNum + 1}</span>` +
    `<span class="sit-text">SIT</span>`;
  if (canSit) box.dataset.sitSeat = seatNum;
  wrap.append(box);
  return wrap;
}

function renderActionBar() {
  const s = PP.state;
  const you = s.you;
  const isBetting = ["preflop", "flop", "turn", "river"].includes(s.phase);
  const myTurn = s.to_act === PP.pid && isBetting;
  const inPlay = you.seated && you.in_hand && !you.away && isBetting;
  const bar = $("actionBar");
  // PokerNow-style bar stays visible the whole betting round; only the
  // FOLD / CALL / RAISE triggers light up on your turn -- otherwise the
  // auto-action checkboxes (premoves) are the live controls.
  bar.classList.toggle("hidden", !(myTurn || inPlay));
  bar.classList.toggle("myturn", myTurn);
  document.body.classList.toggle("bar-open", myTurn || inPlay);

  renderHeroHand();                       // hole cards + name + stack (left)

  // Checkboxes reflect the queued premove / auto-check-fold.
  const me = s.players.find((p) => p.id === PP.pid) || {};
  const callAmt = Math.min(me.stack || 0, Math.max(0, s.current_bet - (me.round_bet || 0)));
  const facing = callAmt > 0;
  const pm = you.premove;
  $("optFoldAny").checked   = pm === "fold";
  $("optCheckFold").checked = you.auto_check_fold || pm === "checkfold" || pm === "check";
  $("optCallAny").checked   = pm === "call";

  const fold = $("btnFold"), call = $("btnCall"), check = $("btnCheck"), raise = $("btnRaise");
  const callSub = $("callSub"), raiseSub = $("raiseSub");
  const all = [fold, call, check, raise];

  if (!myTurn) {
    // Not my turn: the SAME four triggers, GHOSTED -> click to arm a premove.
    PP.raiseBounds = null;
    all.forEach((b) => { b.classList.remove("pressed"); delete b.dataset.pm; });
    setLabel(call, "Call");   callSub.textContent = facing ? `call ${callAmt}` : "";
    setLabel(check, facing ? "Check / Fold" : "Check");
    setLabel(raise, "Bet / Raise"); raiseSub.textContent = "";
    fold.dataset.pm = "fold";
    if (facing) call.dataset.pm = "call";
    check.dataset.pm = facing ? "checkfold" : "check";
    fold.disabled = false; call.disabled = !facing; check.disabled = false; raise.disabled = true;
    all.forEach((b) => {
      const armed = b.dataset.pm != null && b.dataset.pm === pm;
      b.classList.toggle("armed", armed);
      b.classList.toggle("ghost", !armed);
    });
    setSizingDisabled(true);
    updateTimer();
    return;
  }

  // My turn: clear premove ghosting; triggers act immediately.
  all.forEach((b) => { b.classList.remove("ghost", "armed", "pressed"); delete b.dataset.pm; });
  const minTo = Math.max(you.min_raise_to, s.current_bet + 1);
  const maxRaiseTo = (s.current_bet - you.to_call) + you.stack;
  const canRaise = minTo <= maxRaiseTo;
  PP.raiseBounds = canRaise ? { min: minTo, max: maxRaiseTo } : null;
  setSizingDisabled(!canRaise);
  fold.disabled = false;

  // CHECK: only legal when there's nothing to call.
  setLabel(check, "Check"); check.disabled = !you.can_check;

  // CALL: facing a bet -> Call N; everyone checking -> a one-tap MIN BET.
  delete call.dataset.betmin;
  if (you.to_call > 0) {
    setLabel(call, "Call"); callSub.textContent = `call ${you.to_call}`;
    call.disabled = false;
  } else {
    setLabel(call, "Bet"); callSub.textContent = canRaise ? `${minTo}` : "";
    call.disabled = !canRaise;
    if (canRaise) call.dataset.betmin = String(minTo);
  }

  // BET / RAISE: uses the slider/input amount.
  setLabel(raise, you.to_call === 0 ? "Bet" : "Raise");
  raise.disabled = !canRaise;

  if (canRaise) {
    const slider = $("raiseSlider"), amount = $("raiseAmount");
    slider.min = minTo; slider.max = maxRaiseTo; slider.step = 1;
    amount.min = minTo; amount.max = maxRaiseTo;
    if (!amount.value || +amount.value < minTo || +amount.value > maxRaiseTo) setRaiseValue(minTo);
    else updateBetDisplay();
  } else {
    raiseSub.textContent = "";
  }
  updateTimer();
}

// Set a trigger button's main label without clobbering its .sub span.
function setLabel(btn, text) {
  if (btn.firstChild && btn.firstChild.nodeType === 3) btn.firstChild.nodeValue = text;
  else btn.insertBefore(document.createTextNode(text), btn.firstChild);
}

function setSizingDisabled(off) {
  $("raiseSlider").disabled = off;
  $("raiseAmount").disabled = off;
  document.querySelectorAll("#actionBar .qbtn").forEach((b) => { b.disabled = off; });
}

// Hero hole cards + name + stack shown on the left of the action bar.
function renderHeroHand() {
  const s = PP.state;
  const me = s.players.find((p) => p.id === PP.pid);
  const cards = $("heroCards");
  cards.innerHTML = "";
  ((me && me.hole) || []).forEach((c) => cards.append(cardEl(c)));
  $("heroName").textContent = (me && me.name) || PP.name || "You";
  $("heroStack").textContent = me ? me.stack : "";
}

// Update the raise button's sub-label ("to N" / "all-in") from the input.
function updateBetDisplay() {
  const v = parseInt($("raiseAmount").value, 10) || 0;
  const sub = $("raiseSub"), b = PP.raiseBounds;
  if (sub) sub.textContent = (b && v >= b.max) ? "all-in" : (v ? `to ${v}` : "");
}
PP.updateBetDisplay = updateBetDisplay;

function quickRaiseTo(kind) {
  const s = PP.state, you = s.you, b = PP.raiseBounds;
  if (!b) return null;
  const call = you.to_call;
  const potAfterCall = s.pot + call;
  const bb = (s.settings && s.settings.big_blind) || 1;
  let target;
  if (kind === "min") target = b.min;
  else if (kind === "all" || kind === "allin") target = b.max;
  else if (kind === "2x" || kind === "3x") {
    // Multiple of the current bet (or BB if nobody has bet yet).
    const mult = kind === "2x" ? 2 : 3;
    target = (s.current_bet > 0 ? s.current_bet : bb) * mult;
  } else {
    const frac = kind === "half" ? 0.5 : kind === "twothirds" ? 2 / 3 : 1;  // "pot"
    target = s.current_bet + call + Math.round(frac * potAfterCall);
  }
  return Math.max(b.min, Math.min(b.max, target));
}

function setRaiseValue(v) {
  if (v == null) return;
  $("raiseSlider").value = v;
  $("raiseAmount").value = v;
  if (PP.updateBetDisplay) PP.updateBetDisplay();
}

// Hotkey 'R': focus + select the bet amount for direct typing.
function focusRaise() {
  if (!PP.raiseBounds) return false;
  const amt = $("raiseAmount");
  if (amt.disabled) return false;
  if (!amt.value) setRaiseValue(PP.raiseBounds.min);
  amt.focus(); amt.select();
  return true;
}
PP.focusRaise = focusRaise;

function doFold() {
  const you = PP.state && PP.state.you;
  if (you && you.can_check &&
      !confirm("You can check for free \u2014 fold anyway?")) return;
  send({ type: "action", action: "fold" });
}

function submitRaise() {
  const b = PP.raiseBounds;
  if (!b) return;
  let v = parseInt($("raiseAmount").value, 10);
  if (isNaN(v)) return;
  v = Math.max(b.min, Math.min(b.max, v));   // clamp to legal range
  setRaiseValue(v);
  $("raiseAmount").blur();
  send({ type: "action", action: "raise", amount: v });
}

const BUBBLE_MS = 5000;
function onStateChat() {
  const log = (PP.state && PP.state.chat_log) || [];
  if (PP.lastChatN === undefined) {
    PP.lastChatN = log.reduce((m, x) => Math.max(m, x.n || 0), 0);
    return;
  }
  PP.bubbles = PP.bubbles || {};
  log.forEach((m) => {
    if ((m.n || 0) > PP.lastChatN) {
      PP.bubbles[m.id] = { text: m.text, until: performance.now() + BUBBLE_MS };
      PP.lastChatN = m.n;
    }
  });
}

function pruneBubbles() {
  const now = performance.now();
  document.querySelectorAll(".chat-bubble").forEach((el) => {
    if (+el.dataset.until < now) el.remove();
  });
  if (PP.bubbles) {
    for (const pid in PP.bubbles) {
      if (PP.bubbles[pid].until < now) delete PP.bubbles[pid];
    }
  }
  // Action flashes use a wall-clock 'until' (Date.now); pop once then vanish.
  const wnow = Date.now();
  document.querySelectorAll(".action-flash").forEach((el) => {
    if (+el.dataset.until < wnow) el.remove();
  });
  if (PP.flash) {
    for (const pid in PP.flash) {
      if (PP.flash[pid].until < wnow) delete PP.flash[pid];
    }
  }
}

function onStateTimer() {
  const s = PP.state;
  if (s && s.turn_seconds_left != null && s.action_timeout > 0) {
    PP.timer = { left: s.turn_seconds_left, total: s.action_timeout,
                 at: performance.now() };
  } else {
    PP.timer = null;
  }
}

function updateTimer() {
  const wrap = $("timerWrap"), barEl = $("timerBar");
  if (!PP.timer) { wrap.classList.add("hidden"); return; }
  const elapsed = (performance.now() - PP.timer.at) / 1000;
  const left = Math.max(0, PP.timer.left - elapsed);
  const pct = Math.max(0, Math.min(100, (left / PP.timer.total) * 100));
  const myTurn = PP.state && PP.state.to_act === PP.pid &&
    !$("actionBar").classList.contains("hidden");
  wrap.classList.toggle("hidden", !myTurn);
  barEl.style.width = pct + "%";
  barEl.style.background = left < 5 ? "#ef4444" : left < 10 ? "#f59e0b" : "#34d399";
  const podFill = document.querySelector(".seat.turn .pod-timer-fill");
  if (podFill) podFill.style.width = pct + "%";
}

function renderResult() {
  const s = PP.state;
  const banner = $("resultBanner");
  if (s.phase === "showdown" && s.results) {
    const rc = s.results.run_count;
    const head = rc && rc > 1 ? `Ran it ${rc}\u00d7 \u2014 ` : "";
    banner.textContent = head + s.results.pots.map((r) => {
      const hand = r.hand_name ? ` with ${r.hand_name}` : "";
      return `${r.winner_names.join(", ")} wins ${r.amount}${hand}`;
    }).join(" \u2022 ");
  } else {
    banner.textContent = "";
  }
}

// Run-it-twice vote bar + stacked run boards live in panels.js.

function wireCore() {
  $("joinBtn").onclick = () => {
    const name = ($("nameInput").value || "").trim();
    if (!name) {                       // a name is required to enter
      const inp = $("nameInput");
      inp.classList.add("input-error");
      inp.focus();
      toast("Please enter a name to join.");
      return;
    }
    PP.name = name.slice(0, 20);
    localStorage.setItem(nameKey, PP.name);
    $("nameModal").classList.add("hidden");
    connect();
  };
  $("nameInput").addEventListener("input", () => $("nameInput").classList.remove("input-error"));
  $("nameInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("joinBtn").click();
  });

  $("shareBtn").onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); toast("Invite link copied!"); }
    catch (e) { prompt("Copy this link:", location.href); }
  };

  // Main triggers. On your turn they act immediately; otherwise they arm a
  // premove (toggle off if you click the one already armed).
  const premoveMode = () => !$("actionBar").classList.contains("myturn");
  const armPremove = (btn) => {
    const mv = btn.dataset.pm || null;
    if (!mv) return;
    const cur = PP.state.you.premove;
    send({ type: "premove", move: mv === cur ? null : mv });
  };
  $("btnFold").onclick = () => {
    if ($("btnFold").disabled) return;
    if (premoveMode()) { armPremove($("btnFold")); return; }
    $("btnFold").classList.add("pressed"); doFold();
  };
  $("btnCall").onclick = () => {
    const b = $("btnCall");
    if (b.disabled) return;
    if (premoveMode()) { armPremove(b); return; }
    b.classList.add("pressed");
    // Everyone checking -> Call doubles as a quick MIN BET (PokerNow).
    if (b.dataset.betmin) { send({ type: "action", action: "raise", amount: +b.dataset.betmin }); return; }
    send({ type: "action", action: "call" });
  };
  $("btnCheck").onclick = () => {
    const b = $("btnCheck");
    if (b.disabled) return;
    if (premoveMode()) { armPremove(b); return; }
    b.classList.add("pressed");
    send({ type: "action", action: "check" });
  };
  $("btnRaise").onclick = () => {
    if ($("btnRaise").disabled) return;       // disabled while pre-acting
    $("btnRaise").classList.add("pressed");
    submitRaise();
  };

  // Bet sizing: slider <-> number input stay in sync.
  $("raiseSlider").oninput = () => setRaiseValue(+$("raiseSlider").value);
  $("raiseAmount").oninput = () => {
    $("raiseSlider").value = $("raiseAmount").value;
    if (PP.updateBetDisplay) PP.updateBetDisplay();
  };
  $("raiseAmount").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitRaise(); }
  });

  // Quick-size buttons (Min / 2x / 3x / Pot / All-In).
  document.querySelectorAll("#actionBar .qbtn").forEach((btn) => {
    btn.onclick = () => {
      const v = quickRaiseTo(btn.dataset.q);
      if (v == null) return;
      setRaiseValue(v);          // set the amount; confirm with the BET/RAISE button
    };
  });

  // Auto-action checkboxes -> premove / auto-check-fold (PokerNow style).
  $("optFoldAny").onchange = (e) =>
    send({ type: "premove", move: e.target.checked ? "fold" : null });
  $("optCallAny").onchange = (e) =>
    send({ type: "premove", move: e.target.checked ? "call" : null });
  $("optCheckFold").onchange = (e) =>
    send({ type: "auto_check_fold", value: e.target.checked });

  $("felt").addEventListener("click", (e) => {
    const sit = e.target.closest("[data-sit-seat]");
    if (sit) { window.openSitModal(+sit.dataset.sitSeat); return; }
    const host = e.target.closest("[data-host-menu]");
    if (host) { e.stopPropagation(); window.openHostMenu(host.dataset.hostMenu, e); }
  });

  wireHotkeys();
  $("board").addEventListener("click", tryRabbit);

  // Smooth timer + bubble loop: updateTimer() must run every frame so the
  // action-bar bar AND the active pod's timer bar deplete smoothly between
  // server snapshots (not just when a new state message arrives).
  function tick() {
    if (PP.state) { updateTimer(); pruneBubbles(); }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// Reposition seats when the phone rotates / the window resizes.
window.addEventListener("resize", () => { if (PP.state) renderSeats(); });

function tryRabbit() {
  const s = PP.state;
  if (!s || s.phase !== "showdown") return;
  if ((s.board || []).length >= 5) return;
  if (!s.settings.rabbit_hunting) { toast("Rabbit hunting is off (host setting)"); return; }
  send({ type: "rabbit" });
}

(async function main() {
  await ensurePid();
  await loadTableInfo();
  wireCore();
  if (window.wirePanels) window.wirePanels();
  if (window.wireHotkeys) window.wireHotkeys();
  $("nameInput").value = PP.name;
  $("nameModal").classList.remove("hidden");
  $("nameInput").focus();
})();
