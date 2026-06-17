// Puppy Poker - panels: host controls, buy-in/top-up/settings modals,
// requests queue, tabbed hand-log / chat / ledger. Builds on window.PP.

(function () {
  const PP = window.PP;
  const $ = PP.$;
  let activeTab = "hand";

  // ---- control bar (start / next / top-up / stand) --------------------
  function renderControls(s) {
    const isBetting = ["preflop", "flop", "turn", "river"].includes(s.phase);
    const owner = s.you.is_owner;
    show($("startBtn"), owner && s.phase === "waiting");
    show($("nextBtn"), owner && s.phase === "showdown");
    show($("topupBtn"), s.you.seated);
    show($("standBtn"), s.you.seated && !isBetting);
    show($("settingsBtn"), owner);

    $("startBtn").disabled = !s.can_start;
    const msg = $("waitMsg");
    if (s.phase === "waiting") {
      if (!s.you.seated) msg.textContent = "Pick an open seat to buy in and join.";
      else if (!s.can_start) msg.textContent = "Need 2+ players with chips to start.";
      else if (!owner) msg.textContent = "Waiting for the host to start the hand.";
      else msg.textContent = "";
    } else { msg.textContent = ""; }
  }

  // ---- buy-in requests (host) -----------------------------------------
  function renderRequests(s) {
    const panel = $("requestsPanel");
    const list = $("requestsList");
    const showPanel = s.you.is_owner && s.requests.length > 0;
    const reqBtn = $("requestsBtn");
    show(reqBtn, showPanel);
    if (showPanel) {
      reqBtn.innerHTML = "Requests " +
        '<span class="req-badge">' + s.requests.length + "</span>";
    }
    show(panel, showPanel);
    if (!showPanel) { list.innerHTML = ""; return; }
    list.innerHTML = "";
    s.requests.forEach((r) => {
      const row = document.createElement("div");
      row.className = "flex items-center justify-between gap-2 bg-slate-900 rounded-lg p-2";
      const label = r.kind === "sit"
        ? `${PP.escapeHtml(r.name)} \u2192 seat ${r.seat + 1}, ${r.amount}`
        : `${PP.escapeHtml(r.name)} top-up ${r.amount}`;
      row.innerHTML = `<span class="text-sm">${label}</span>`;
      const btns = document.createElement("div");
      btns.className = "flex gap-1";
      btns.append(
        mkBtn("OK", "bg-emerald-500 text-slate-900", () =>
          PP.send({ type: "approve", target: r.id })),
        mkBtn("No", "bg-rose-600", () =>
          PP.send({ type: "deny", target: r.id })));
      row.append(btns);
      list.append(row);
    });
  }

  // ---- tabs: hand log / chat / ledger ---------------------------------
  function renderTabs(s) {
    $("tabHand").innerHTML = "";
    (s.hand_log || []).forEach((line) => {
      const div = document.createElement("div");
      if (line.startsWith("---")) div.className = "text-slate-500 font-semibold";
      else if (line.startsWith("BOUNTY")) div.className = "text-amber-300 font-semibold";
      else if (line.startsWith("Rabbit")) div.className = "text-fuchsia-300";
      div.textContent = line;
      $("tabHand").append(div);
    });
    $("tabHand").scrollTop = $("tabHand").scrollHeight;

    const chat = $("chatMsgs");
    chat.innerHTML = "";
    (s.chat_log || []).forEach((m) => {
      const div = document.createElement("div");
      const nameSpan = document.createElement("span");
      nameSpan.className = "font-semibold";
      nameSpan.style.color = chatColor(m.id);
      nameSpan.textContent = m.name + ": ";
      const textSpan = document.createElement("span");
      textSpan.className = "text-slate-200";
      textSpan.textContent = m.text;
      div.append(nameSpan, textSpan);
      chat.append(div);
    });
    $("tabChat").scrollTop = $("tabChat").scrollHeight;

    renderLedger(s);
  }

  function renderLedger(s) {
    const el = $("tabLedger");
    if (!s.ledger || s.ledger.length === 0) {
      el.innerHTML = '<p class="text-slate-500">No buy-ins yet.</p>';
      return;
    }
    let rows = s.ledger.map((r) => {
      const net = r.net >= 0 ? `+${r.net}` : `${r.net}`;
      const color = r.net > 0 ? "text-emerald-400" : r.net < 0 ? "text-rose-400" : "text-slate-300";
      const seated = r.seated ? "" : ' <span class="text-slate-500">(left)</span>';
      return `<tr class="border-b border-slate-700/50">
        <td class="py-1 pr-2">${PP.escapeHtml(r.name)}${seated}</td>
        <td class="py-1 px-2 text-right">${r.bought_in}</td>
        <td class="py-1 px-2 text-right">${r.stack}</td>
        <td class="py-1 pl-2 text-right font-semibold ${color}">${net}</td></tr>`;
    }).join("");
    el.innerHTML = `<table class="w-full text-sm">
      <thead><tr class="text-slate-400 text-xs uppercase">
        <th class="text-left py-1 pr-2">Player</th>
        <th class="text-right py-1 px-2">Bought in</th>
        <th class="text-right py-1 px-2">Stack</th>
        <th class="text-right py-1 pl-2">Net</th>
      </tr></thead><tbody>${rows}</tbody></table>`;
  }

  function switchTab(tab) {
    activeTab = tab;
    [["hand", "tabHand"], ["chat", "tabChat"], ["ledger", "tabLedger"]].forEach(
      ([name, id]) => show($(id), name === tab));
    document.querySelectorAll(".tab-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === tab));
    show($("chatForm"), tab === "chat");
  }

  // ---- drawer (Log / Chat / Ledger) -----------------------------------
  function openDrawer(tab) {
    if (tab) switchTab(tab);
    show($("drawer"), true);
    document.body.classList.add("drawer-open");
    // Dim the table only on narrow screens; on desktop keep it visible.
    show($("drawerScrim"), window.innerWidth <= 700);
  }
  function closeDrawer() {
    show($("drawer"), false);
    show($("drawerScrim"), false);
    document.body.classList.remove("drawer-open");
  }
  window.openDrawer = openDrawer;
  window.closeDrawer = closeDrawer;

  // ---- modals ---------------------------------------------------------
  function openSitModal(seat) {
    const s = PP.state;
    $("sitSeatNo").textContent = seat + 1;
    $("sitModal").dataset.seat = seat;
    const def = s.settings.default_buyin, min = s.settings.min_buyin, max = s.settings.max_buyin;
    $("sitHint").textContent = s.you.is_owner
      ? `Buy-in ${min}-${max}. As host you sit instantly.`
      : `Buy-in ${min}-${max}. The host approves your request.`;
    const amt = $("sitAmount"), sl = $("sitSlider");
    sl.min = min; sl.max = max; sl.value = def; amt.value = def;
    show($("sitModal"), true);
  }
  window.openSitModal = openSitModal;

  function editStack(pid) {
    const p = PP.state.players.find((x) => x.id === pid);
    if (!p) return;
    const val = prompt(`Set ${p.name}'s stack to:`, p.stack);
    if (val === null) return;
    const n = parseInt(val, 10);
    if (!isNaN(n)) PP.send({ type: "set_stack", target: pid, amount: n });
  }
  window.editStack = editStack;

  function fillSettings(s) {
    const g = s.settings;
    $("setSb").value = g.small_blind; $("setBb").value = g.big_blind;
    $("setAnte").value = g.ante; $("setDefault").value = g.default_buyin;
    $("setMin").value = g.min_buyin; $("setMax").value = g.max_buyin;
    $("setBountyAmt").value = g.bounty_72_amount;
    $("setTimeout").value = g.action_timeout;
    $("setRabbit").checked = g.rabbit_hunting;
    $("setBounty").checked = g.bounty_72;
    $("setStraddle").checked = g.straddle;
    $("setAutoDeal").checked = g.auto_deal;
  }

  // ---- wiring ---------------------------------------------------------
  function wirePanels() {
    document.querySelectorAll(".tab-btn").forEach((b) =>
      b.onclick = () => switchTab(b.dataset.tab));
    switchTab("hand");

    // Drawer toggles -- the panel is hidden until you click one of these.
    $("btnLog").onclick = () => openDrawer("hand");
    $("btnChat").onclick = () => openDrawer("chat");
    $("btnLedger").onclick = () => openDrawer("ledger");
    $("requestsBtn").onclick = () => openDrawer("hand");
    $("drawerClose").onclick = closeDrawer;
    $("drawerScrim").onclick = closeDrawer;

    $("startBtn").onclick = () => PP.send({ type: "start" });
    $("nextBtn").onclick = () => PP.send({ type: "next_hand" });
    $("standBtn").onclick = () => { if (confirm("Stand up and cash out?")) PP.send({ type: "stand_up" }); };

    $("topupBtn").onclick = () => {
      $("topupAmount").value = PP.state.settings.default_buyin;
      show($("topupModal"), true);
    };
    $("topupCancel").onclick = () => show($("topupModal"), false);
    $("topupConfirm").onclick = () => {
      PP.send({ type: "topup", amount: +$("topupAmount").value });
      show($("topupModal"), false);
    };

    $("sitCancel").onclick = () => show($("sitModal"), false);
    $("sitSlider").oninput = () => { $("sitAmount").value = $("sitSlider").value; };
    $("sitAmount").oninput = () => { $("sitSlider").value = $("sitAmount").value; };
    $("sitConfirm").onclick = () => {
      PP.send({ type: "sit", seat: +$("sitModal").dataset.seat, amount: +$("sitAmount").value });
      show($("sitModal"), false);
    };

    $("settingsBtn").onclick = () => { fillSettings(PP.state); show($("settingsModal"), true); };
    $("settingsCancel").onclick = () => show($("settingsModal"), false);
    $("settingsSave").onclick = () => {
      PP.send({ type: "settings", changes: {
        small_blind: +$("setSb").value, big_blind: +$("setBb").value,
        ante: +$("setAnte").value, default_buyin: +$("setDefault").value,
        min_buyin: +$("setMin").value, max_buyin: +$("setMax").value,
        bounty_72_amount: +$("setBountyAmt").value,
        action_timeout: +$("setTimeout").value,
        rabbit_hunting: $("setRabbit").checked,
        bounty_72: $("setBounty").checked, straddle: $("setStraddle").checked,
        auto_deal: $("setAutoDeal").checked,
      }});
      show($("settingsModal"), false);
    };

    $("chatForm").onsubmit = (e) => {
      e.preventDefault();
      const text = $("chatInput").value.trim();
      if (text) { PP.send({ type: "chat", text }); $("chatInput").value = ""; }
    };
  }
  window.wirePanels = wirePanels;

  window.renderPanels = function (s) {
    renderControls(s);
    renderRequests(s);
    renderTabs(s);
  };

  // ---- tiny helpers ---------------------------------------------------
  // Stable bright colour per player id, picked from a readable palette.
  const CHAT_PALETTE = [
    "#f87171", "#fb923c", "#fbbf24", "#a3e635", "#34d399",
    "#22d3ee", "#60a5fa", "#a78bfa", "#f472b6", "#e879f9",
  ];
  function chatColor(id) {
    let h = 0;
    const s = id || "";
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return CHAT_PALETTE[Math.abs(h) % CHAT_PALETTE.length];
  }
  function show(el, on) { el.classList.toggle("hidden", !on); }
  function mkBtn(label, cls, onClick) {
    const b = document.createElement("button");
    b.className = `text-xs font-bold px-2 py-1 rounded ${cls}`;
    b.textContent = label;
    b.onclick = onClick;
    return b;
  }
})();
