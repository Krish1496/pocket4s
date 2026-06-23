// Puppy Poker - core client. WebSocket + table/seat/action rendering.

const SUIT = {
  c: { sym: "\u2663", color: "black" },
  d: { sym: "\u2666", color: "red" },
  h: { sym: "\u2665", color: "red" },
  s: { sym: "\u2660", color: "black" },
};
const RANK_LABEL = { T: "10" };

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
}

function computeAnims(s) {
  const a = { boardFrom: s.board.length, dealHoles: false,
              flipReveal: false, potBump: false, winners: {} };
  const newHand = s.hand_no !== PP.prevHandNo;
  if (newHand) { PP.prevBoardLen = 0; PP.prevRunsDone = 0; PP.shownCells = new Set(); }
  a.boardFrom = PP.prevBoardLen || 0;
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
    // Normal single board: flip in the freshly-dealt street(s).
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
      } else {
        board.append(placeholderCard());
      }
    }
  }
  const rabbit = $("rabbitRow");
  rabbit.innerHTML = "";
  (s.rabbit || []).forEach((c) => rabbit.append(cardEl(c, true)));
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
  // On a tall portrait phone the felt is narrow, so pull the side seats in
  // (smaller horizontal radius) and spread them vertically.
  const portrait = window.matchMedia("(max-width: 700px) and (orientation: portrait)").matches;
  const rx = portrait ? 43 : 46;
  const ry = portrait ? 45 : 44;
  for (let visual = 0; visual < n; visual++) {
    const seatNum = mySeat != null ? (mySeat + visual) % n : visual;
    const angle = Math.PI / 2 + (visual * 2 * Math.PI) / n;
    const x = 50 + rx * Math.cos(angle);
    const y = 50 + ry * Math.sin(angle);
    const occupant = bySeat[seatNum];
    if (occupant) felt.append(seatEl(occupant, x, y));
    else if (!iAmSeated) felt.append(openSeatEl(seatNum, x, y));
  }
}

function seatEl(p, xPct, yPct) {
  const s = PP.state;
  const wrap = document.createElement("div");
  wrap.className = "seat";
  if (p.id === PP.pid) wrap.classList.add("you");
  if (p.is_turn) wrap.classList.add("turn");
  if (p.status === "folded") wrap.classList.add("folded");
  if (p.away) wrap.classList.add("away");
  const winAmount = PP.anim.winners[p.id];
  if (winAmount != null) wrap.classList.add("winner");
  wrap.style.left = xPct + "%";
  wrap.style.top = yPct + "%";

  const cards = document.createElement("div");
  cards.className = "cards";
  (p.hole || []).forEach((c, i) => {
    if (PP.anim.dealHoles && c !== "back") {
      cards.append(flipCardEl(c, true, i * 0.08));
    } else if (PP.anim.flipReveal && p.id !== PP.pid && c !== "back") {
      cards.append(flipCardEl(c, true, i * 0.1));
    } else {
      cards.append(cardEl(c, true));
    }
  });

  const pod = document.createElement("div");
  pod.className = "pod relative";
  const disc = p.connected ? "" : '<span class="disconnected-dot" title="disconnected"></span>';
  const crown = p.is_owner ? " \u2605" : "";
  const topup = p.pending_topup ? ` <span class="text-emerald-400">(+${p.pending_topup})</span>` : "";
  const awayTag = p.away ? ' <span class="away-tag">AWAY</span>' : "";
  pod.innerHTML =
    `<div class="name">${escapeHtml(p.name)}${crown}${disc}${awayTag}</div>` +
    `<div class="stack">${p.stack}${topup}</div>`;
  if (p.is_button) {
    const b = document.createElement("div");
    b.className = "badge";
    b.textContent = "D";
    pod.append(b);
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
    wrap.append(f);
  }
  if (p.win_pct != null) {
    const eq = document.createElement("div");
    eq.className = "win-pct";
    eq.textContent = p.win_pct + "%";
    wrap.append(eq);
  }
  if (p.hand_name) {
    const hn = document.createElement("div");
    hn.className = "hand-name";
    hn.textContent = p.hand_name;
    wrap.append(hn);
  }
  if (p.round_bet > 0) {
    const bet = document.createElement("div");
    bet.className = "bet-chip";
    bet.textContent = p.round_bet;
    wrap.append(bet);
  }
  if (winAmount != null) {
    const tag = document.createElement("div");
    tag.className = "win-tag";
    tag.textContent = "WON +" + winAmount;
    wrap.append(tag);
  }
  const bubble = PP.bubbles && PP.bubbles[p.id];
  if (bubble && performance.now() < bubble.until) {
    const b = document.createElement("div");
    b.className = "chat-bubble";
    b.dataset.until = bubble.until;
    b.textContent = bubble.text;
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
  const pod = document.createElement("div");
  pod.className = "pod";
  const canSit = !s.you.seated;
  pod.innerHTML = `<div class="name text-slate-400">Seat ${seatNum + 1}</div>` +
    `<div class="stack text-slate-500">${canSit ? "Sit here" : "open"}</div>`;
  if (canSit) pod.dataset.sitSeat = seatNum;
  wrap.append(pod);
  return wrap;
}

function renderActionBar() {
  const s = PP.state;
  const you = s.you;
  const isBetting = ["preflop", "flop", "turn", "river"].includes(s.phase);
  const myTurn = s.to_act === PP.pid && isBetting;
  const premoveMode = !myTurn && isBetting && you.in_hand && !you.away &&
    s.to_act && s.to_act !== PP.pid;
  const bar = $("actionBar");
  bar.classList.toggle("hidden", !(myTurn || premoveMode));
  bar.classList.toggle("premove", premoveMode);

  const callBtn = bar.querySelector('[data-act="call"]');
  const checkBtn = bar.querySelector('[data-act="check"]');
  const foldBtn = bar.querySelector('[data-act="fold"]');
  const raiseBtn = bar.querySelector('[data-act="raise"]');
  const all = [callBtn, checkBtn, foldBtn, raiseBtn];
  all.forEach((b) => { b.classList.remove("armed", "pressed"); b.disabled = false; });

  // Whenever it's not our turn (or fresh render) the bet panel resets.
  if (!myTurn) { $("raisePanel").classList.add("hidden"); $("mainRow").classList.remove("hidden"); }

  if (premoveMode) {
    PP.raiseBounds = null;
    const me = s.players.find((p) => p.id === PP.pid) || {};
    const callAmt = Math.min(me.stack || 0, Math.max(0, s.current_bet - (me.round_bet || 0)));
    const facing = callAmt > 0;
    raiseBtn.classList.add("hidden");                 // no pre-raise
    foldBtn.classList.remove("hidden"); foldBtn.textContent = "Fold"; foldBtn.dataset.pm = "fold";
    checkBtn.classList.remove("hidden");
    checkBtn.textContent = facing ? "Check/Fold" : "Check";
    checkBtn.dataset.pm = facing ? "checkfold" : "check";
    callBtn.classList.toggle("hidden", !facing);
    callBtn.textContent = facing ? `Call ${callAmt}` : "Call";
    callBtn.dataset.pm = "call";
    const pm = you.premove;
    foldBtn.classList.toggle("armed", pm === "fold");
    checkBtn.classList.toggle("armed", pm === "check" || pm === "checkfold");
    callBtn.classList.toggle("armed", pm === "call");
    updateTimer();
    return;
  }

  if (!myTurn) { PP.raiseBounds = null; return; }

  // My turn: show ALL four buttons, greying out the inapplicable one.
  all.forEach((b) => b.classList.remove("hidden"));
  foldBtn.textContent = "Fold (F)";
  const minTo = Math.max(you.min_raise_to, s.current_bet + 1);
  const maxRaiseTo = (s.current_bet - you.to_call) + you.stack;
  const canRaise = minTo <= maxRaiseTo;
  PP.raiseBounds = canRaise ? { min: minTo, max: maxRaiseTo } : null;
  delete callBtn.dataset.betmin;
  if (you.can_check) {
    checkBtn.textContent = "Check (K)"; checkBtn.disabled = false;
    // Nothing to call -> CALL becomes a quick MIN-BET button (PokerNow style).
    callBtn.textContent = canRaise ? `Bet ${minTo} (C)` : "Bet";
    callBtn.disabled = !canRaise;
    if (canRaise) callBtn.dataset.betmin = String(minTo);
  } else {
    checkBtn.textContent = "Check (K)"; checkBtn.disabled = true;
    callBtn.textContent = you.to_call > 0 ? `Call ${you.to_call} (C)` : "Call (C)";
    callBtn.disabled = false;
  }
  raiseBtn.disabled = !canRaise;
  raiseBtn.textContent = (you.to_call === 0) ? "Bet (R)" : "Raise (R)";
  if (canRaise) {
    const slider = $("raiseSlider"), amount = $("raiseAmount");
    slider.min = minTo; slider.max = maxRaiseTo;
    if (!amount.value || +amount.value < minTo || +amount.value > maxRaiseTo) {
      setRaiseValue(minTo);
    }
  }
  updateTimer();
}

// Update the "Your bet" readout (amount + big-blind multiple) in the panel.
function updateBetDisplay() {
  const v = parseInt($("raiseAmount").value, 10) || 0;
  const bb = (PP.state && PP.state.settings.big_blind) || 1;
  const amtEl = $("yourBetAmt"), bbEl = $("yourBetBB");
  if (amtEl) amtEl.textContent = v;
  if (bbEl) bbEl.textContent = bb ? `${(v / bb).toFixed(1).replace(/\.0$/, "")} BB` : "";
}
PP.updateBetDisplay = updateBetDisplay;

function quickRaiseTo(kind) {
  const s = PP.state, you = s.you, b = PP.raiseBounds;
  if (!b) return null;
  const call = you.to_call;
  const potAfterCall = s.pot + call;
  let target;
  if (kind === "min") target = b.min;
  else if (kind === "allin") target = b.max;
  else {
    const frac = kind === "half" ? 0.5 : kind === "twothirds" ? 2 / 3 : 1;
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

// Two-step raise: open the bet panel (presets + slider) in place of the main row.
function openRaisePanel(focusInput) {
  const b = PP.raiseBounds;
  if (!b) return false;
  setRaiseValue(b.min);                 // always start at the MINIMUM raise
  $("mainRow").classList.add("hidden");
  $("raisePanel").classList.remove("hidden");
  if (focusInput) {
    const amt = $("raiseAmount");
    amt.focus(); amt.select();          // R -> amount pre-selected for direct typing
  }
  return true;
}
function closeRaisePanel() {
  $("raisePanel").classList.add("hidden");
  $("mainRow").classList.remove("hidden");
}
PP.openRaisePanel = openRaisePanel;
PP.closeRaisePanel = closeRaisePanel;

function focusRaise() {
  return openRaisePanel(true);      // hotkey 'R': open the bet panel + select the amount
}

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
  closeRaisePanel();
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
    PP.name = ($("nameInput").value.trim() || "Player").slice(0, 20);
    localStorage.setItem(nameKey, PP.name);
    $("nameModal").classList.add("hidden");
    connect();
  };
  $("nameInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("joinBtn").click();
  });

  $("shareBtn").onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); toast("Invite link copied!"); }
    catch (e) { prompt("Copy this link:", location.href); }
  };

  document.querySelectorAll("#mainRow .act-btn").forEach((btn) => {
    btn.onclick = () => {
      // Pre-move mode: arm/disarm a queued action instead of acting now.
      if ($("actionBar").classList.contains("premove")) {
        const mv = btn.dataset.pm || null;
        if (!mv) return;
        const cur = PP.state.you.premove;
        send({ type: "premove", move: (mv === cur) ? null : mv });
        return;
      }
      if (btn.disabled) return;
      const act = btn.dataset.act;
      if (act === "raise") { openRaisePanel(); return; }   // two-step: open bet panel
      if (act === "call" && btn.dataset.betmin) {          // CALL acting as a min-bet
        btn.classList.add("pressed");
        send({ type: "action", action: "raise", amount: +btn.dataset.betmin });
        return;
      }
      btn.classList.add("pressed");                          // flood solid until next state
      if (act === "fold") { doFold(); return; }
      send({ type: "action", action: act });
    };
  });

  // Raise (bet) panel controls.
  $("raiseConfirm").onclick = () => submitRaise();
  $("raiseBack").onclick = () => closeRaisePanel();
  const stepBy = (d) => {
    const b = PP.raiseBounds; if (!b) return;
    const bb = (PP.state && PP.state.settings.big_blind) || 1;
    let v = (parseInt($("raiseAmount").value, 10) || b.min) + d * bb;
    setRaiseValue(Math.max(b.min, Math.min(b.max, v)));
  };
  $("raiseMinus").onclick = () => stepBy(-1);
  $("raisePlus").onclick = () => stepBy(1);
  $("raiseSlider").oninput = () => setRaiseValue(+$("raiseSlider").value);
  $("raiseAmount").oninput = () => {
    $("raiseSlider").value = $("raiseAmount").value;
    if (PP.updateBetDisplay) PP.updateBetDisplay();
  };
  $("raiseAmount").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitRaise(); }
  });

  document.querySelectorAll(".quick").forEach((btn) => {
    btn.onclick = () => {
      const v = quickRaiseTo(btn.dataset.quick);
      if (v == null) return;
      setRaiseValue(v);          // set the amount; confirm with the RAISE button
    };
  });

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
