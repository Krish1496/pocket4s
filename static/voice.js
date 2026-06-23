// Puppy Poker - voice chat (WebRTC mesh + speaking detection + bottom-right dock).
// Signaling rides the existing game WebSocket via {type:"signal", to, kind, data}.
// Speaking is detected locally per-stream (Web Audio RMS) -- no server needed.
(function () {
  const PP = window.PP;
  const $ = PP.$;

  const V = {
    on: false,
    localStream: null,
    audioCtx: null,
    peers: {},        // pid -> { pc, audioEl, pendingIce: [] }
    analysers: {},    // pid -> AnalyserNode (includes self)
    speaking: {},     // pid -> bool
    meter: null,
  };
  window.PPVoice = V;

  const me = () => PP.pid;
  const roster = () => (PP.state && PP.state.voice) || [];   // [{id, name}]
  const idsInVoice = () => roster().map((v) => v.id);

  // ---- mic + Web Audio analyser (speaking meter) ----------------------
  function ensureCtx() {
    if (!V.audioCtx) V.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (V.audioCtx.state === "suspended") V.audioCtx.resume();
    return V.audioCtx;
  }
  function addAnalyser(pid, stream) {
    try {
      const ctx = ensureCtx();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      V.analysers[pid] = an;
    } catch (e) { /* analyser is best-effort */ }
  }
  function levelOf(an) {
    const buf = new Uint8Array(an.fftSize);
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    return Math.sqrt(sum / buf.length);
  }
  function startMeter() {
    if (V.meter) return;
    const tick = () => {
      let changed = false;
      for (const pid in V.analysers) {
        const sp = levelOf(V.analysers[pid]) > 0.045;   // speaking threshold
        if (!!V.speaking[pid] !== sp) { V.speaking[pid] = sp; changed = true; }
      }
      if (changed) renderDock();
      V.meter = requestAnimationFrame(tick);
    };
    V.meter = requestAnimationFrame(tick);
  }

  // ---- peer connections (mesh) ---------------------------------------
  function makePeer(pid) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    const peer = { pc, audioEl: null, pendingIce: [] };
    V.peers[pid] = peer;
    if (V.localStream) V.localStream.getTracks().forEach((t) => pc.addTrack(t, V.localStream));
    pc.onicecandidate = (e) => {
      if (e.candidate) PP.send({ type: "signal", to: pid, kind: "ice", data: e.candidate });
    };
    pc.ontrack = (e) => {
      let el = peer.audioEl;
      if (!el) {
        el = document.createElement("audio");
        el.autoplay = true; el.playsInline = true;
        document.body.appendChild(el);
        peer.audioEl = el;
      }
      el.srcObject = e.streams[0];
      addAnalyser(pid, e.streams[0]);     // detect THEIR speaking
    };
    return pc;
  }
  function closePeer(pid) {
    const peer = V.peers[pid];
    if (!peer) return;
    try { peer.pc.close(); } catch (e) {}
    if (peer.audioEl) peer.audioEl.remove();
    delete V.peers[pid];
    delete V.analysers[pid];
    delete V.speaking[pid];
  }

  // Glare-free: the peer with the smaller id sends the offer.
  async function connectTo(pid) {
    if (V.peers[pid]) return;
    const pc = makePeer(pid);
    if (me() < pid) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        PP.send({ type: "signal", to: pid, kind: "offer", data: pc.localDescription });
      } catch (e) { /* will retry on next roster tick */ }
    }
  }

  async function onSignal(msg) {
    const from = msg.from;
    if (!V.on) return;                  // not in voice -> ignore
    const pc = V.peers[from] ? V.peers[from].pc : makePeer(from);
    try {
      if (msg.kind === "offer") {
        await pc.setRemoteDescription(msg.data);
        await flushIce(from);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        PP.send({ type: "signal", to: from, kind: "answer", data: pc.localDescription });
      } else if (msg.kind === "answer") {
        await pc.setRemoteDescription(msg.data);
        await flushIce(from);
      } else if (msg.kind === "ice") {
        if (pc.remoteDescription && pc.remoteDescription.type) await pc.addIceCandidate(msg.data);
        else V.peers[from].pendingIce.push(msg.data);   // buffer until SDP set
      }
    } catch (e) { console.warn("voice signal error", e); }
  }
  async function flushIce(pid) {
    const peer = V.peers[pid];
    if (!peer) return;
    while (peer.pendingIce.length) {
      try { await peer.pc.addIceCandidate(peer.pendingIce.shift()); } catch (e) {}
    }
  }
  V.onSignal = onSignal;

  // ---- join / leave ---------------------------------------------------
  async function join() {
    if (V.on) return;
    try {
      V.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (e) {
      PP.toast("Mic unavailable. Voice needs HTTPS (or localhost) + mic permission.");
      return;
    }
    V.on = true;
    addAnalyser(me(), V.localStream);     // detect MY speaking
    PP.send({ type: "voice_join" });
    idsInVoice().forEach((pid) => { if (pid !== me()) connectTo(pid); });
    startMeter();
    paintToggle();
    renderDock();
  }
  function leave() {
    if (!V.on) return;
    V.on = false;
    PP.send({ type: "voice_leave" });
    Object.keys(V.peers).forEach(closePeer);
    if (V.localStream) { V.localStream.getTracks().forEach((t) => t.stop()); V.localStream = null; }
    delete V.analysers[me()];
    V.speaking = {};
    paintToggle();
    renderDock();
  }

  // ---- called on every game-state update ------------------------------
  V.onState = function () {
    if (V.on) {
      const live = new Set(idsInVoice());
      live.forEach((pid) => { if (pid !== me() && !V.peers[pid]) connectTo(pid); });
      Object.keys(V.peers).forEach((pid) => { if (!live.has(pid)) closePeer(pid); });
    }
    renderDock();
  };

  // ---- UI: bottom-right dock -----------------------------------------
  function paintToggle() {
    const b = $("voiceToggle");
    if (!b) return;
    b.classList.toggle("on", V.on);
    b.textContent = V.on ? "Leave voice" : "Voice chat";
  }
  function renderDock() {
    const list = $("voiceList");
    if (!list) return;
    const r = roster();
    list.innerHTML = r.map((v) => {
      const speaking = !!V.speaking[v.id];
      const mine = v.id === me();
      return `<div class="voice-chip${speaking ? " speaking" : ""}">
        <span class="voice-bars" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="voice-name">${PP.escapeHtml(v.name)}${mine ? " (you)" : ""}</span>
      </div>`;
    }).join("");
    list.classList.toggle("hidden", r.length === 0);
  }

  function wire() {
    const b = $("voiceToggle");
    if (b) b.onclick = () => (V.on ? leave() : join());
    paintToggle();
    renderDock();
  }
  if (document.readyState !== "loading") wire();
  else document.addEventListener("DOMContentLoaded", wire);
})();
