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
    $("connDot").textContent = "connected";
    $("connDot").className = "text-xs text-emerald-400";
  };
  PP.ws.onclose = () => {
    $("connDot").textContent = "reconnecting...";
    $("connDot").className = "text-xs text-amber-400";
    setTimeout(connect, 1500);
  };
  PP.ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === "state") { PP.state = data; onStateTimer(); render(); }
    else if (data.type === "error") { toast(data.message); }
  };
}

function send(obj) {
  if (PP.ws && PP.ws.readyState === WebSocket.OPEN) PP.ws.send(JSON.stringify(obj));
}

// --- rendering ----------------------------------------------------------
function render() {
  const s = PP.state;
  if (!s) return;
  $("potLabel").textContent = `Pot: ${s.pot}`;
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

function renderBoard() {
  const s = PP.state;
  const board = $("board");
  board.innerHTML = "";
  for (let i = 0; i < 5; i++) {
    board.append(s.board[i] ? cardEl(s.board[i]) : placeholderCard());
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
  wrap.style.left = xPct + "%";
  wrap.style.top = yPct + "%";

  const cards = document.createElement("div");
  cards.className = "cards";
  (p.hole || []).forEach((c) => cards.append(cardEl(c, true)));

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
  callBtn.textContent = you.to_call > 0 ? `Call ${you.to_call}` : "Call";

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
      (you.to_call === 0) ? "Bet" : "Raise";
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
}

(async function main() {
  await ensurePid();
  await loadTableInfo();
  wireCore();
  if (window.wirePanels) window.wirePanels();
  // Smooth client-side countdown between server snapshots.
  setInterval(updateTimer, 250);
  $("nameInput").value = PP.name;
  $("nameModal").classList.remove("hidden");
  $("nameInput").focus();
})();
