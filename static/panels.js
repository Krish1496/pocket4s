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
    // Next hand lives on the felt (below the board) and only when auto-deal is OFF.
    show($("nextBtn"), owner && s.phase === "showdown" && !s.settings.auto_deal);
    renderShowCards(s);
    const pause = $("pauseBtn");
    show(pause, owner);
    pause.textContent = s.paused ? "\u25B6 Resume" : "\u23F8 Pause";
    pause.classList.toggle("btn-primary", s.paused);
    pause.classList.toggle("btn-muted", !s.paused);
    const banner = $("pausedBanner");
    if (banner) show(banner, !!s.paused);
    show($("topupBtn"), s.you.seated);
    show($("standBtn"), s.you.seated && !isBetting);
    show($("settingsBtn"), owner);

    // Away + persistent check/fold toggles (your own seat).
    const away = $("awayBtn");
    show(away, s.you.seated);
    away.textContent = s.you.away ? "\u23F8 Away (tap to return)" : "Away";
    away.classList.toggle("btn-primary", s.you.away);
    away.classList.toggle("btn-muted", !s.you.away);
    const acf = $("acfBtn");
    show(acf, s.you.seated);
    acf.textContent = s.you.auto_check_fold ? "Check/Fold: ON" : "Check/Fold mode";
    acf.classList.toggle("btn-primary", s.you.auto_check_fold);
    acf.classList.toggle("btn-muted", !s.you.auto_check_fold);

    $("startBtn").disabled = !s.can_start;
    const msg = $("waitMsg");
    if (s.phase === "waiting") {
      if (!s.you.seated) msg.textContent = "Pick an open seat to buy in and join.";
      else if (!s.can_start) msg.textContent = "Need 2+ players with chips to start.";
      else if (!owner) msg.textContent = "Waiting for the host to start the hand.";
      else msg.textContent = "";
    } else { msg.textContent = ""; }
  }

  // Show-your-cards controls (only at showdown, when you still hold cards).
  // A card already shown can't be un-shown, so its button greys out.
  function renderShowCards(s) {
    const bar = $("showCardsBar");
    const can = !!(s.you && s.you.can_show);
    show(bar, can);
    if (!can) return;
    const shown = s.you.shown || [];
    const b1 = $("show1Btn"), b2 = $("show2Btn"), bb = $("showBothBtn");
    b1.disabled = shown.includes(0);
    b2.disabled = shown.includes(1);
    bb.disabled = shown.includes(0) && shown.includes(1);
  }
  window.canShowCards = (s) => !!(s && s.you && s.you.can_show);
  // Send a show-cards request for the given hole-card indices, skipping any
  // already shown so we don't spam the table log.
  window.showCards = function (which) {
    const s = PP.state;
    if (!canShowCards(s)) return;
    const shown = (s.you.shown || []);
    const todo = which.filter((i) => !shown.includes(i));
    if (todo.length) PP.send({ type: "show_cards", which: todo });
  };

  // ---- pre-move bar (LEGACY) ------------------------------------------
  // Pre-moves are now armed via the main action buttons in their ghosted
  // state (see renderActionBar). Keep the old bar permanently hidden.
  function renderPremove(s) {
    const bar = $("premoveBar");
    if (bar) bar.classList.add("hidden");
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

  // ---- re-buy prompt: auto-asks a busted player to buy in again -------
  // Fires once the hand has reset and you're sitting out with 0 chips (so it
  // never pops mid-runout). Resolves when you buy in (-> request) or stand up.
  function renderRebuy(s) {
    const you = s.you;
    const me = s.players.find((p) => p.id === PP.pid);
    // Hand is over (showdown settled, or waiting) and you have no chips left.
    // Guard against mid-runout so it never pops while cards are still coming.
    const handOver = (s.phase === "showdown" || s.phase === "waiting") && !s.running_out;
    const busted = !!(me && you.seated && me.stack === 0 && !me.pending_topup && handOver);
    const hasReq = (s.requests || []).some((r) => r.id === PP.pid);
    const wantAsk = busted && !hasReq;
    const modal = $("rebuyModal");
    const open = !modal.classList.contains("hidden");
    if (wantAsk && !open) {
      const def = s.settings.default_buyin, min = s.settings.min_buyin, max = s.settings.max_buyin;
      $("rebuyHint").textContent = you.is_owner
        ? `Buy in ${min}-${max} to keep playing, or stand up.`
        : `Buy in ${min}-${max} (host approves), or stand up to leave.`;
      const a = $("rebuyAmount"), sl = $("rebuySlider");
      sl.min = min; sl.max = max; sl.value = def; a.value = def;
      show(modal, true);
    } else if (!wantAsk && open) {
      show(modal, false);   // got chips / left / request pending -> close it
    }
  }

  // ---- host buy-in request POPUP (auto-shows on new requests) ---------
  function renderReqPopup(s) {
    const pop = $("reqPopup"), list = $("reqPopupList");
    const on = s.you.is_owner && (s.requests || []).length > 0;
    show(pop, on);
    if (!on) { list.innerHTML = ""; return; }
    list.innerHTML = "";
    s.requests.forEach((r) => {
      const row = document.createElement("div");
      row.className = "req-popup-row";
      const label = r.kind === "sit"
        ? `${PP.escapeHtml(r.name)} \u2192 seat ${r.seat + 1}, ${r.amount}`
        : `${PP.escapeHtml(r.name)} top-up ${r.amount}`;
      const txt = document.createElement("span");
      txt.className = "req-popup-label"; txt.textContent = label;
      const btns = document.createElement("div");
      btns.className = "req-popup-btns";
      btns.append(
        mkBtn("Approve", "req-ok", () => PP.send({ type: "approve", target: r.id })),
        mkBtn("Deny", "req-no", () => PP.send({ type: "deny", target: r.id })));
      row.append(txt, btns);
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
    const mini = $("miniChatMsgs");
    chat.innerHTML = "";
    if (mini) mini.innerHTML = "";
    (s.chat_log || []).forEach((m) => {
      const build = () => {
        const div = document.createElement("div");
        const nameSpan = document.createElement("span");
        nameSpan.className = "font-semibold";
        nameSpan.style.color = chatColor(m.id);
        nameSpan.textContent = m.name + ": ";
        const textSpan = document.createElement("span");
        textSpan.className = "text-slate-200";
        textSpan.textContent = m.text;
        div.append(nameSpan, textSpan);
        return div;
      };
      chat.append(build());
      if (mini) mini.append(build());
    });
    $("tabChat").scrollTop = $("tabChat").scrollHeight;
    if (mini) mini.scrollTop = mini.scrollHeight;

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

  // Host chip-management popover -- replaces the old per-seat 'edit' button.
  function openHostMenu(pid, ev) {
    const p = PP.state.players.find((x) => x.id === pid);
    if (!p) return;
    const m = $("hostMenu");
    const bb = PP.state.settings.big_blind || 1;
    m.innerHTML =
      `<div class="hm-title">${escapeHtml(p.name)} \u2014 ${p.stack} chips</div>` +
      `<div class="hm-row">` +
      [-10 * bb, -bb, bb, 10 * bb].map((d) =>
        `<button class="hm-q" data-d="${d}">${d > 0 ? "+" : ""}${d}</button>`).join("") +
      `</div>` +
      `<div class="hm-row">` +
      `<input id="hmAmount" type="number" min="0" value="${p.stack}" class="hm-input" />` +
      `<button id="hmSet" class="hm-set">Set</button>` +
      `</div>`;
    const x = Math.min((ev && ev.clientX) || 80, window.innerWidth - 210);
    const y = Math.min((ev && ev.clientY) || 80, window.innerHeight - 150);
    m.style.left = x + "px";
    m.style.top = y + "px";
    m.classList.remove("hidden");
    const setStack = (n) => {
      if (!isNaN(n)) PP.send({ type: "set_stack", target: pid, amount: Math.max(0, n) });
      closeHostMenu();
    };
    m.querySelectorAll(".hm-q").forEach((b) =>
      b.onclick = () => setStack(p.stack + parseInt(b.dataset.d, 10)));
    $("hmSet").onclick = () => setStack(parseInt($("hmAmount").value, 10));
    $("hmAmount").onkeydown = (e) => { if (e.key === "Enter") $("hmSet").click(); };
  }
  function closeHostMenu() { $("hostMenu").classList.add("hidden"); }
  window.openHostMenu = openHostMenu;
  window.closeHostMenu = closeHostMenu;

  function fillSettings(s) {
    const g = s.settings;
    $("setSb").value = g.small_blind; $("setBb").value = g.big_blind;
    $("setAnte").value = g.ante; $("setDefault").value = g.default_buyin;
    $("setMin").value = g.min_buyin; $("setMax").value = g.max_buyin;
    $("setBountyAmt").value = g.bounty_72_amount;
    $("setTimeout").value = g.action_timeout;
    $("setRabbit").checked = g.rabbit_hunting;
    $("setRunTwice").checked = g.run_it_twice;
    $("setBounty").checked = g.bounty_72;
    $("setStraddle").checked = g.straddle;
    $("setAutoDeal").checked = g.auto_deal;
  }

  // ---- wiring ---------------------------------------------------------
  function wirePanels() {
    document.querySelectorAll(".tab-btn").forEach((b) =>
      b.onclick = () => switchTab(b.dataset.tab));
    switchTab("hand");

    // Close the host chip menu when clicking anywhere outside it.
    document.addEventListener("click", (e) => {
      const m = $("hostMenu");
      if (m.classList.contains("hidden")) return;
      if (!m.contains(e.target) && !e.target.closest("[data-host-menu]")) closeHostMenu();
    });

    // Drawer toggles -- the panel is hidden until you click one of these.
    $("btnLog").onclick = () => openDrawer("hand");
    $("btnLedger").onclick = () => openDrawer("ledger");
    $("requestsBtn").onclick = () => openDrawer("hand");
    $("drawerClose").onclick = closeDrawer;
    $("drawerScrim").onclick = closeDrawer;

    // Slide-out table menu (secondary controls).
    const sideMenu = $("sideMenu"), menuScrim = $("menuScrim");
    const setMenu = (open) => {
      sideMenu.classList.toggle("open", open);
      show(menuScrim, open);
      sideMenu.setAttribute("aria-hidden", open ? "false" : "true");
      $("menuToggle").setAttribute("aria-expanded", open ? "true" : "false");
    };
    window.closeSideMenu = () => setMenu(false);
    $("menuToggle").onclick = () => setMenu(!sideMenu.classList.contains("open"));
    menuScrim.onclick = () => setMenu(false);

    $("startBtn").onclick = () => PP.send({ type: "start" });
    $("nextBtn").onclick = () => PP.send({ type: "next_hand" });
    $("show1Btn").onclick = () => window.showCards([0]);
    $("show2Btn").onclick = () => window.showCards([1]);
    $("showBothBtn").onclick = () => window.showCards([0, 1]);
    $("standBtn").onclick = () => { if (window.closeSideMenu) window.closeSideMenu(); if (confirm("Stand up and cash out?")) PP.send({ type: "stand_up" }); };

    $("awayBtn").onclick = () =>
      PP.send({ type: "away", value: !PP.state.you.away });
    $("acfBtn").onclick = () =>
      PP.send({ type: "auto_check_fold", value: !PP.state.you.auto_check_fold });
    $("pauseBtn").onclick = () =>
      PP.send({ type: "pause", value: !PP.state.paused });
    const sBtn = $("soundBtn");
    if (sBtn && window.PPSFX) {
      PPSFX.enabled = localStorage.getItem("pp_sound") !== "off";
      const paint = () => sBtn.textContent = (PPSFX.enabled ? "\u{1F50A}" : "\u{1F507}") + " Sound";
      paint();
      sBtn.onclick = () => {
        PPSFX.enabled = !PPSFX.enabled;
        localStorage.setItem("pp_sound", PPSFX.enabled ? "on" : "off");
        paint();
        if (PPSFX.enabled) PPSFX.play("call");   // little confirmation blip
      };
    }
    document.querySelectorAll(".pm").forEach((b) =>
      b.onclick = () => {
        const mv = b.dataset.pm || null;
        // Toggle off if you click the one that's already armed.
        const cur = PP.state.you.premove;
        PP.send({ type: "premove", move: (mv && mv === cur) ? null : mv });
      });

    $("topupBtn").onclick = () => {
      if (window.closeSideMenu) window.closeSideMenu();
      $("topupAmount").value = PP.state.settings.default_buyin;
      show($("topupModal"), true);
    };
    $("topupCancel").onclick = () => show($("topupModal"), false);
    $("topupConfirm").onclick = () => {
      PP.send({ type: "topup", amount: +$("topupAmount").value });
      show($("topupModal"), false);
    };

    // Re-buy (busted) modal: slider<->input sync; buy in (topup) or stand up.
    $("rebuySlider").oninput = () => { $("rebuyAmount").value = $("rebuySlider").value; };
    $("rebuyAmount").oninput = () => { $("rebuySlider").value = $("rebuyAmount").value; };
    $("rebuyConfirm").onclick = () => {
      PP.send({ type: "topup", amount: +$("rebuyAmount").value });
      show($("rebuyModal"), false);   // re-opens later only if the host denies
    };
    $("rebuyDecline").onclick = () => {
      show($("rebuyModal"), false);
      if (confirm("Stand up and leave the table?")) PP.send({ type: "stand_up" });
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
      run_it_twice: $("setRunTwice").checked,
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

    // Always-on bottom-left mini chat.
    $("miniChatForm").onsubmit = (e) => {
      e.preventDefault();
      const inp = $("miniChatInput");
      const text = inp.value.trim();
      if (text) { PP.send({ type: "chat", text }); inp.value = ""; }
    };
    $("miniChatInput").addEventListener("keydown", (e) => {
      if (e.key === "Escape") e.target.blur();
    });
    // Mobile: toggle the mini chat open/closed (it's hidden by default there).
    const mcToggle = $("miniChatToggle");
    if (mcToggle) mcToggle.onclick = () => {
      const mc = $("miniChat");
      const open = mc.classList.toggle("open");
      if (open) { const i = $("miniChatInput"); if (i) i.focus(); }
    };
  }
  window.wirePanels = wirePanels;

  // Run-it-twice vote bar: pick how many times to run the all-in board.
  window.renderRunVote = function () {
    const s = PP.state;
    const bar = $("runVoteBar");
    const rv = s.run_vote;
    if (!rv) { bar.classList.add("hidden"); return; }
    bar.classList.remove("hidden");
    // Don't reveal anyone's pick -- just who has locked in (\u2713) vs thinking.
    const tally = rv.voters.map((v) => {
      const mark = v.done ? "\u2713" : "\u2026";
      const me = v.you && rv.your_vote ? ` (you: ${rv.your_vote}\u00d7)` : (v.you ? " (you)" : "");
      return `${escapeHtml(v.name)} ${mark}${me}`;
    }).join("  \u2022  ");
    if (rv.your_turn) {
      let btns = "";
      for (let i = 1; i <= rv.max; i++) btns += `<button class="rv" data-times="${i}">${i}\u00d7</button>`;
      const clk = rv.seconds_left != null ? ` <span class="rv-clock">${rv.seconds_left}s</span>` : "";
      bar.innerHTML = `<div class="rv-title">\u2665 All in! How many times to run the board?${clk}</div>` +
        `<div class="rv-row">${btns}</div><div class="rv-tally">${tally}</div>`;
      bar.querySelectorAll(".rv").forEach((b) =>
        b.onclick = () => PP.send({ type: "run_vote", times: +b.dataset.times }));
    } else {
      const mine = rv.your_vote ? ` (you: ${rv.your_vote}\u00d7)` : "";
      bar.innerHTML = `<div class="rv-title">Waiting for everyone to choose\u2026${mine}</div>` +
        `<div class="rv-tally">${tally}</div>`;
    }
  };

  // Stacked boards: completed runs (during the live runout) + winners (showdown).
  window.renderRuns = function () {
    // The run boards are now drawn ON the main board (shared flop once, then
    // each run's turn/river stacked beneath -- see renderStackedBoard). Here
    // we only show the little 'running it Nx' progress note while dealing.
    const s = PP.state;
    const row = $("runsRow");
    row.innerHTML = "";
    if (!(s.run_count > 1)) return;
    if (s.running_out && (s.run_boards || []).length < s.run_count) {
      const tag = document.createElement("div");
      tag.className = "run-current";
      tag.textContent = `Running it ${s.run_count}\u00d7 \u2014 run ${(s.run_boards || []).length + 1} of ${s.run_count}\u2026`;
      row.append(tag);
    }
  };

  // Keyboard shortcuts: C call, K check, R raise/X check-fold, F fold, H rabbit,
  // M chat. On your turn -> live actions; while waiting -> pre-moves.
  window.wireHotkeys = function () {
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target;
      const tag = (el.tagName || "").toLowerCase();
      const typing = tag === "input" || tag === "textarea" || el.isContentEditable;
      const key = e.key.toLowerCase();
      if (key === "m" && !typing) {
        e.preventDefault();
        const c = $("miniChatInput"); if (c) c.focus();
        return;
      }
      if (key === "escape") {
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        if (window.closeSideMenu) window.closeSideMenu();
        if (window.closeDrawer) window.closeDrawer();
        return;
      }
      if (typing) return;
      // Show-your-cards at showdown: 1 = first card, 2 = second, 3 = both.
      if ((key === "1" || key === "2" || key === "3") && canShowCards(PP.state)) {
        e.preventDefault();
        window.showCards(key === "1" ? [0] : key === "2" ? [1] : [0, 1]);
        return;
      }
      if (key === "h") { e.preventDefault(); tryRabbit(); return; }
      const bar = $("actionBar");
      if (bar.classList.contains("hidden")) return;
      const fire = (sel) => {
        const b = bar.querySelector(sel);
        if (b && !b.disabled && !b.classList.contains("hidden")) { e.preventDefault(); b.click(); }
      };
      // C -> Call (a quick MIN BET when everyone's checking); K -> Check;
      // F -> Fold; R -> focus the bet amount.
      if (key === "c") fire('#btnCall');
      else if (key === "k") fire('#btnCheck');
      else if (key === "r") { e.preventDefault(); focusRaise(); }
      else if (key === "f") fire('#btnFold');
    });
  };

  // Pop a short action bubble (CHECK / CALL 4 / FOLD ...) above a seat when a
  // new hand-log line appears -- the visible 'they moved' cool-down cue.
  const FLASH_VERBS = { checks: "CHECK", calls: "CALL", folds: "FOLD", bets: "BET", raises: "RAISE" };
  window.detectFlashes = function (s) {
    PP.flash = PP.flash || {};
    const log = s.hand_log || [];
    if (PP._logLen == null || s.hand_no !== PP.prevHandNo) PP._logLen = log.length;
    const fresh = log.slice(PP._logLen);
    PP._logLen = log.length;
    if (!fresh.length) return;
    const byName = {};
    s.players.forEach((p) => { byName[p.name] = p.id; });
    fresh.forEach((line) => {
      for (const nm in byName) {
        if (!line.startsWith(nm + " ")) continue;
        const rest = line.slice(nm.length + 1);
        const verb = FLASH_VERBS[rest.split(" ")[0]];
        if (!verb) break;
        const amt = rest.match(/\d+/);
        PP.flash[byName[nm]] = { text: verb + (amt ? " " + amt[0] : ""),
                                started: Date.now(), until: Date.now() + 1400 };
        if (window.PPSFX) {
          const k = rest.split(" ")[0];
          PPSFX.play(k === "bets" ? "raise" : (k === "raises" ? "raise" :
                     k === "calls" ? "call" : k === "checks" ? "check" : "fold"));
        }
        break;
      }
    });
  };

  window.renderPanels = function (s) {
    renderControls(s);
    renderPremove(s);
    renderRequests(s);
    renderReqPopup(s);
    renderRebuy(s);
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
