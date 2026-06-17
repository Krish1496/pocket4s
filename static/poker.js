// Puppy Poker - core client. WebSocket + table/seat/action rendering.
// Shared state is exposed on window.PP so panels.js can build on it.

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

// --- card / toast helpers ----------------------------------------------
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

// --- bootstrap ----------------------------------------------------------
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
    PP.reconnectAttempts = 0;            // reset backoff on success
    $("connDot").textContent = "connected";
    $("connDot").className = "text-xs text-emerald-400";
    startHeartbeat();
  };

  PP.ws.onclose = (ev) => {
    stopHeartbeat();
    console.warn("WebSocket closed", { code: ev && ev.code, reason: ev && ev.reason });
    // 4404 = the server has no such table (it restarted and lost it, or the
    // link is wrong). Don't loop forever -- tell the player plainly.
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

// Keep the socket warm so idle proxies / VPNs don't silently kill it.
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

// --- rendering ----------------------------------------------------------
function render() {
  const s = PP.state;
  if (!s) return;
  computeAnims(s);
  $("potLabel").textContent = `Pot: ${s.pot}`;
  if (PP.anim.potBump) {
    const pl = $("potLabel");
    pl.classList.remove("bump"); void pl.offsetWidth; pl.classList.add("bump");
  }
  $("phaseLabel").textContent = s.phase === "waiting" ? "Waiting for players" : s.phase;
  $("blindsInfo").textContent =
    `Blinds ${s.settings.small_blind}/${s.settings.big_blind}` +
    (s.settings.ante ? ` \u2022 ante ${s.settings.ante}` : "") +
    ` \u2022 buy-in ${s.settings.min_buyin}-${s.settings.max_buyin}`;

  renderBoard();
  renderSeats();
  renderActionBar();
  renderResult();
  if (window.renderPanels) window.renderPanels(s);
}

// Work out which one-shot animations this snapshot should trigger.
function computeAnims(s) {
  const a = { boardFrom: s.board.length, dealHoles: false,
              flipReveal: false, potBump: false, winners: {} };
  const newHand = s.hand_no !== PP.prevHandNo;
  if (newHand) { PP.prevBoardLen = 0; }
  a.boardFrom = PP.prevBoardLen || 0;
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
  PP.prevBoardLen = s.board.length;
  PP.prevHandNo = s.hand_no;
  PP.prevPhase = s.phase;
  PP.prevPot = s.pot;
}

function renderBoard() {
  const s = PP.state;
  const board = $("board");
  board.innerHTML = "";
  for (let i = 0; i < 5; i++) {
    if (s.board[i]) {
      const el = cardEl(s.board[i]);
      if (i >= PP.anim.boardFrom) {           // newly dealt -> animate in
        el.classList.add("deal-in");
        el.style.animationDelay = ((i - PP.anim.boardFrom) * 0.09) + "s";
      }
      board.append(el);
    } else {
      board.append(placeholderCard());
    }
  }
  const rabbit = $("rabbitRow");
  rabbit.innerHTML = "";
  (s.rabbit || []).forEach((c) => rabbit.append(cardEl(c, true)));
}

function renderSeats() {
  const s = PP.state;
  const felt = $("felt");
  felt.querySelectorAll(".seat").forEach((e) => e.remove());

  const bySeat = {};
  s.players.forEach((p) => { bySeat[p.seat] = p; });

  // Order seats so I'm at the bottom. Build a circular seat list.
  const n = s.seat_count;
  const mySeat = s.you.seat;
  for (let visual = 0; visual < n; visual++) {
    const seatNum = mySeat != null ? (mySeat + visual) % n : visual;
    const angle = Math.PI / 2 + (visual * 2 * Math.PI) / n;
    const x = 50 + 46 * Math.cos(angle);
    const y = 50 + 44 * Math.sin(angle);
    const occupant = bySeat[seatNum];
    felt.append(occupant ? seatEl(occupant, x, y) : openSeatEl(seatNum, x, y));
  }
}

function seatEl(p, xPct, yPct) {
  const s = PP.state;
  const wrap = document.createElement("div");
  wrap.className = "seat";
  if (p.id === PP.pid) wrap.classList.add("you");
  if (p.is_turn) wrap.classList.add("turn");
  if (p.status === "folded") wrap.classList.add("folded");
  const winAmount = PP.anim.winners[p.id];
  if (winAmount != null) wrap.classList.add("winner");
  wrap.style.left = xPct + "%";
  wrap.style.top = yPct + "%";

  const cards = document.createElement("div");
  cards.className = "cards";
  (p.hole || []).forEach((c, i) => {
    const el = cardEl(c, true);
    if (PP.anim.dealHoles) {
      el.classList.add("deal-in");
      el.style.animationDelay = (i * 0.07) + "s";
    } else if (PP.anim.flipReveal && p.id !== PP.pid && c !== "back") {
      el.classList.add("flip-in");          // opponent cards reveal at showdown
      el.style.animationDelay = (i * 0.08) + "s";
    }
    cards.append(el);
  });

  const pod = document.createElement("div");
  pod.className = "pod relative";
  const disc = p.connected ? "" : '<span class="disconnected-dot" title="disconnected"></span>';
  const crown = p.is_owner ? " \u2605" : "";
  const topup = p.pending_topup ? ` <span class="text-emerald-400">(+${p.pending_topup})</span>` : "";
  pod.innerHTML =
    `<div class="name">${escapeHtml(p.name)}${crown}${disc}</div>` +
    `<div class="stack">${p.stack} chips${topup}</div>`;
  if (p.is_button) {
    const b = document.createElement("div");
    b.className = "badge";
    b.textContent = "D";
    pod.append(b);
  }
  // Live countdown ring on whoever must act.
  if (p.is_turn && s.action_timeout > 0 && s.turn_seconds_left != null) {
    const t = document.createElement("div");
    t.className = "seat-timer";
    t.textContent = Math.ceil(s.turn_seconds_left);
    pod.append(t);
  }
  // Host can edit any seated stack between hands.
  if (s.you.is_owner) {
    const edit = document.createElement("button");
    edit.className = "absolute -bottom-2 -right-2 bg-slate-700 hover:bg-slate-600 text-[10px] px-1.5 py-0.5 rounded";
    edit.textContent = "edit";
    edit.dataset.editStack = p.id;
    pod.append(edit);
  }

  wrap.append(cards, pod);
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
  // Transient chat bubble above this seat.
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
  const bar = $("actionBar");
  bar.classList.toggle("hidden", !myTurn);
  if (!myTurn) { PP.raiseBounds = null; return; }

  const callBtn = bar.querySelector('[data-act="call"]');
  const checkBtn = bar.querySelector('[data-act="check"]');
  checkBtn.classList.toggle("hidden", !you.can_check);
  callBtn.classList.toggle("hidden", you.can_check);
  checkBtn.textContent = "Check (K)";
  callBtn.textContent = you.to_call > 0 ? `Call ${you.to_call} (C)` : "Call (C)";

  const minTo = Math.max(you.min_raise_to, s.current_bet + 1);
  const maxRaiseTo = (s.current_bet - you.to_call) + you.stack; // round_bet + stack
  const canRaise = minTo <= maxRaiseTo;
  PP.raiseBounds = canRaise ? { min: minTo, max: maxRaiseTo } : null;
  $("raiseTools").classList.toggle("hidden", !canRaise);
  bar.querySelector('[data-act="raise"]').classList.toggle("hidden", !canRaise);
  if (canRaise) {
    const slider = $("raiseSlider"), amount = $("raiseAmount");
    slider.min = minTo; slider.max = maxRaiseTo;
    if (!amount.value || +amount.value < minTo || +amount.value > maxRaiseTo) {
      slider.value = minTo; amount.value = minTo;
    }
    bar.querySelector('[data-act="raise"]').textContent =
      (you.to_call === 0) ? "Bet (R)" : "Raise (R)";
  }
  updateTimer();
}

// Quick-bet sizing. `kind` is min / half / twothirds / pot / allin.
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
}

// Open the raise tools and put the cursor in the amount box (R hotkey).
function focusRaise() {
  const b = PP.raiseBounds;
  if (!b) return false;                      // can't raise right now
  $("raiseTools").classList.remove("hidden");
  const amt = $("raiseAmount");
  amt.focus();
  amt.select();
  return true;
}

// Commit the raise, clamped to the legal min/max (Enter in the amount box).
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

// --- chat bubbles -------------------------------------------------------
// Pop the newest chat line above the speaker's seat for a few seconds.
const BUBBLE_MS = 5000;
function onStateChat() {
  const log = (PP.state && PP.state.chat_log) || [];
  if (PP.lastChatN === undefined) {
    // First snapshot: don't pop historical messages, just remember the max.
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

// --- action timer -------------------------------------------------------
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
  // Per-seat countdown number on whoever is to act.
  const seatTimer = document.querySelector(".seat.turn .seat-timer");
  if (seatTimer) seatTimer.textContent = Math.ceil(left);
}

function renderResult() {
  const s = PP.state;
  const banner = $("resultBanner");
  if (s.phase === "showdown" && s.results) {
    banner.textContent = s.results.pots.map((r) => {
      const hand = r.hand_name ? ` with ${r.hand_name}` : "";
      return `${r.winner_names.join(", ")} wins ${r.amount}${hand}`;
    }).join(" \u2022 ");
  } else {
    banner.textContent = "";
  }
}

// --- core event wiring --------------------------------------------------
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

  document.querySelectorAll(".act-btn").forEach((btn) => {
    btn.onclick = () => {
      const act = btn.dataset.act;
      if (act === "raise") send({ type: "action", action: "raise", amount: +$("raiseAmount").value });
      else send({ type: "action", action: act });
    };
  });
  $("raiseSlider").oninput = () => { $("raiseAmount").value = $("raiseSlider").value; };
  $("raiseAmount").oninput = () => { $("raiseSlider").value = $("raiseAmount").value; };
  // Enter in the amount box commits the raise.
  $("raiseAmount").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitRaise(); }
  });

  // Quick-bet chips set the raise amount; All-in fires immediately.
  document.querySelectorAll(".quick").forEach((btn) => {
    btn.onclick = () => {
      const v = quickRaiseTo(btn.dataset.quick);
      if (v == null) return;
      setRaiseValue(v);
      if (btn.dataset.quick === "allin") {
        send({ type: "action", action: "raise", amount: v });
      }
    };
  });

  // Delegated clicks on the felt: sit on open seat, or host edit stack.
  $("felt").addEventListener("click", (e) => {
    const sit = e.target.closest("[data-sit-seat]");
    if (sit) { window.openSitModal(+sit.dataset.sitSeat); return; }
    const edit = e.target.closest("[data-edit-stack]");
    if (edit) { window.editStack(edit.dataset.editStack); }
  });

  wireHotkeys();
}

// Keyboard shortcuts: C call, K check, R raise, M chat. Ignored while typing.
function wireHotkeys() {
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target;
    const tag = (el.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea" || el.isContentEditable;
    const key = e.key.toLowerCase();

    if (key === "m" && !typing) {                 // open chat + focus input
      e.preventDefault();
      if (window.openDrawer) window.openDrawer("chat");
      setTimeout(() => { const c = $("chatInput"); if (c) c.focus(); }, 60);
      return;
    }
    if (key === "escape") { if (window.closeDrawer) window.closeDrawer(); return; }
    if (typing) return;

    const bar = $("actionBar");
    if (bar.classList.contains("hidden")) return;  // only on your turn
    const fire = (sel) => {
      const b = bar.querySelector(sel);
      if (b && !b.classList.contains("hidden")) { e.preventDefault(); b.click(); }
    };
    if (key === "c") fire('[data-act="call"]');
    else if (key === "k") fire('[data-act="check"]');
    else if (key === "r") { e.preventDefault(); focusRaise(); }  // type amount, Enter to confirm
    else if (key === "f") fire('[data-act="fold"]');
  });
}

(async function main() {
  await ensurePid();
  await loadTableInfo();
  wireCore();
  if (window.wirePanels) window.wirePanels();
  // Smooth client-side countdown between server snapshots.
  setInterval(() => { updateTimer(); pruneBubbles(); }, 250);
  $("nameInput").value = PP.name;
  $("nameModal").classList.remove("hidden");
  $("nameInput").focus();
})();
