// Puppy Poker - client. Talks to the server over a WebSocket and renders
// the table. Kept dependency-free on purpose (just the browser + Tailwind).

const SUIT = {
  c: { sym: "\u2663", color: "black" }, // clubs
  d: { sym: "\u2666", color: "red" },   // diamonds
  h: { sym: "\u2665", color: "red" },   // hearts
  s: { sym: "\u2660", color: "black" }, // spades
};
const RANK_LABEL = { T: "10" };

const tableId = location.pathname.split("/").pop();
const pidKey = `pp_pid_${tableId}`;
const nameKey = "pp_name";

let pid = localStorage.getItem(pidKey);
let myName = localStorage.getItem(nameKey) || "";
let ws = null;
let state = null;

// --- DOM helpers --------------------------------------------------------
const $ = (id) => document.getElementById(id);

function cardEl(code, small) {
  const div = document.createElement("div");
  if (code === "back") {
    div.className = "card back" + (small ? " small" : "");
    return div;
  }
  const rank = code[0];
  const suit = code[1];
  const info = SUIT[suit] || { sym: "?", color: "black" };
  div.className = `card ${info.color}` + (small ? " small" : "");
  const r = document.createElement("span");
  r.className = "rank";
  r.textContent = RANK_LABEL[rank] || rank;
  const s = document.createElement("span");
  s.className = "suit";
  s.textContent = info.sym;
  div.append(r, s);
  return div;
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
  toast._t = setTimeout(() => t.classList.add("hidden"), 2600);
}

// --- bootstrap ----------------------------------------------------------
async function ensurePid() {
  if (!pid) {
    const r = await fetch("/api/new_pid");
    pid = (await r.json()).pid;
    localStorage.setItem(pidKey, pid);
  }
}

async function loadTableInfo() {
  try {
    const r = await fetch(`/api/table/${tableId}`);
    if (!r.ok) return;
    const info = await r.json();
    $("tableName").textContent = info.name;
    $("blindsInfo").textContent =
      `Blinds ${info.blinds.sb}/${info.blinds.bb} \u2022 Stack ${info.stack}`;
  } catch (e) { /* ignore */ }
}

function showNameModal() {
  $("nameInput").value = myName;
  $("nameModal").classList.remove("hidden");
  $("nameInput").focus();
}

function hideNameModal() {
  $("nameModal").classList.add("hidden");
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws/${tableId}` +
    `?pid=${encodeURIComponent(pid)}&name=${encodeURIComponent(myName)}`;
  ws = new WebSocket(url);
  ws.onopen = () => { $("connDot").textContent = "connected"; $("connDot").className = "text-xs text-emerald-400"; };
  ws.onclose = () => {
    $("connDot").textContent = "reconnecting...";
    $("connDot").className = "text-xs text-amber-400";
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === "state") { state = data; render(); }
    else if (data.type === "error") { toast(data.message); }
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// --- rendering ----------------------------------------------------------
function render() {
  if (!state) return;
  $("potLabel").textContent = `Pot: ${state.pot}`;
  $("phaseLabel").textContent = state.phase === "waiting" ? "Waiting for players" : state.phase;

  renderBoard();
  renderSeats();
  renderControls();
  renderLog();
  renderResult();
}

function renderBoard() {
  const board = $("board");
  board.innerHTML = "";
  for (let i = 0; i < 5; i++) {
    board.append(state.board[i] ? cardEl(state.board[i]) : placeholderCard());
  }
}

function renderSeats() {
  const felt = $("felt");
  felt.querySelectorAll(".seat").forEach((e) => e.remove());

  const players = [...state.players].sort((a, b) => a.seat - b.seat);
  const meIdx = players.findIndex((p) => p.id === pid);
  // Rotate so I'm always at the bottom (index 0).
  const ordered = meIdx >= 0
    ? players.slice(meIdx).concat(players.slice(0, meIdx))
    : players;

  const n = Math.max(ordered.length, 1);
  ordered.forEach((p, k) => {
    const angle = Math.PI / 2 + (k * 2 * Math.PI) / n;
    const x = 50 + 46 * Math.cos(angle);
    const y = 50 + 44 * Math.sin(angle);
    felt.append(seatEl(p, x, y));
  });
}

function seatEl(p, xPct, yPct) {
  const wrap = document.createElement("div");
  wrap.className = "seat";
  if (p.id === pid) wrap.classList.add("you");
  if (p.is_turn) wrap.classList.add("turn");
  if (p.status === "folded") wrap.classList.add("folded");
  wrap.style.left = xPct + "%";
  wrap.style.top = yPct + "%";

  const cards = document.createElement("div");
  cards.className = "cards";
  if (p.hole && p.hole.length) {
    p.hole.forEach((c) => cards.append(cardEl(c, true)));
  }

  const pod = document.createElement("div");
  pod.className = "pod relative";
  const disc = p.connected ? "" : '<span class="disconnected-dot" title="disconnected"></span>';
  pod.innerHTML =
    `<div class="name">${escapeHtml(p.name)}${disc}</div>` +
    `<div class="stack">${p.stack} chips</div>`;
  if (p.is_button) {
    const b = document.createElement("div");
    b.className = "badge";
    b.textContent = "D";
    pod.append(b);
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

function renderControls() {
  const actionBar = $("actionBar");
  const startBar = $("startBar");
  const you = state.you;
  const isBetting = ["preflop", "flop", "turn", "river"].includes(state.phase);
  const myTurn = state.to_act === pid && isBetting;

  // Start / next-hand controls.
  startBar.classList.toggle("hidden", isBetting);
  if (!isBetting) {
    const showStart = state.phase === "waiting";
    const showNext = state.phase === "showdown";
    $("startBtn").classList.toggle("hidden", !showStart);
    $("nextBtn").classList.toggle("hidden", !showNext);
    $("startBtn").disabled = !state.can_start;
    $("waitMsg").textContent = showStart && !state.can_start
      ? "Need at least 2 players with chips to start." : "";
  }

  actionBar.classList.toggle("hidden", !myTurn);
  if (!myTurn) return;

  const callBtn = actionBar.querySelector('[data-act="call"]');
  const checkBtn = actionBar.querySelector('[data-act="check"]');
  checkBtn.classList.toggle("hidden", !you.can_check);
  callBtn.classList.toggle("hidden", you.can_check);
  callBtn.textContent = `Call ${you.to_call}`;

  // Raise slider bounds. Max raise-to = my chips already in this round
  // plus my remaining stack. min_raise_to comes from the server.
  const minTo = Math.max(you.min_raise_to, state.current_bet + 1);
  const myContribution = state.current_bet - you.to_call; // == my round_bet
  const maxRaiseTo = myContribution + you.stack;

  const slider = $("raiseSlider");
  const amount = $("raiseAmount");
  const raiseBtn = actionBar.querySelector('[data-act="raise"]');
  if (minTo > maxRaiseTo) {
    // Can't make a legal raise (not enough chips) -> hide raise controls.
    slider.classList.add("hidden");
    amount.classList.add("hidden");
    raiseBtn.classList.add("hidden");
  } else {
    slider.classList.remove("hidden");
    amount.classList.remove("hidden");
    raiseBtn.classList.remove("hidden");
    slider.min = minTo; slider.max = maxRaiseTo;
    if (!amount.value || +amount.value < minTo || +amount.value > maxRaiseTo) {
      slider.value = minTo; amount.value = minTo;
    }
    raiseBtn.textContent = (you.to_call === 0) ? "Bet" : "Raise";
  }
}

function renderLog() {
  const log = $("log");
  log.innerHTML = "";
  (state.log || []).forEach((line) => {
    const div = document.createElement("div");
    if (line.startsWith("[chat]")) {
      div.className = "text-sky-300";
      div.textContent = line.replace("[chat] ", "");
    } else if (line.startsWith("---")) {
      div.className = "text-slate-500 font-semibold";
      div.textContent = line;
    } else {
      div.textContent = line;
    }
    log.append(div);
  });
  log.scrollTop = log.scrollHeight;
}

function renderResult() {
  const banner = $("resultBanner");
  if (state.phase === "showdown" && state.results) {
    const parts = state.results.pots.map((r) => {
      const who = r.winner_names.join(", ");
      const hand = r.hand_name ? ` with ${r.hand_name}` : "";
      return `${who} wins ${r.amount}${hand}`;
    });
    banner.textContent = parts.join(" \u2022 ");
  } else {
    banner.textContent = "";
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- event wiring -------------------------------------------------------
function wireEvents() {
  $("joinBtn").onclick = () => {
    const v = $("nameInput").value.trim() || "Player";
    myName = v.slice(0, 20);
    localStorage.setItem(nameKey, myName);
    hideNameModal();
    connect();
  };
  $("nameInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("joinBtn").click();
  });

  $("shareBtn").onclick = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast("Invite link copied!");
    } catch (e) {
      prompt("Copy this link:", location.href);
    }
  };

  document.querySelectorAll(".act-btn").forEach((btn) => {
    btn.onclick = () => {
      const act = btn.dataset.act;
      if (act === "raise") {
        send({ type: "action", action: "raise", amount: +$("raiseAmount").value });
      } else {
        send({ type: "action", action: act });
      }
    };
  });

  $("raiseSlider").oninput = () => { $("raiseAmount").value = $("raiseSlider").value; };
  $("raiseAmount").oninput = () => { $("raiseSlider").value = $("raiseAmount").value; };

  $("startBtn").onclick = () => send({ type: "start" });
  $("nextBtn").onclick = () => send({ type: "next_hand" });

  $("chatForm").onsubmit = (e) => {
    e.preventDefault();
    const text = $("chatInput").value.trim();
    if (text) { send({ type: "chat", text }); $("chatInput").value = ""; }
  };
}

// --- go -----------------------------------------------------------------
(async function main() {
  await ensurePid();
  await loadTableInfo();
  wireEvents();
  if (myName) {
    // Returning player: still confirm the name (pre-filled) for clarity.
    showNameModal();
  } else {
    showNameModal();
  }
})();
