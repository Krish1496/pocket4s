// Tiny Web-Audio sound effects -- no asset files, just synthesized blips.
// Browsers block audio until a user gesture, so we lazily create + resume
// the AudioContext on the first click/keydown. Toggle with the speaker button.
(function () {
  let ctx = null;
  const PPS = (window.PPSFX = { enabled: true });

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) ctx = new AC();
    }
    if (ctx && ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  // One tone: freq sweep from f0->f1 over `dur`, with a soft attack/decay.
  function tone(f0, f1, dur, type, gain) {
    const a = ac();
    if (!a) return;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type || "sine";
    osc.frequency.setValueAtTime(f0, a.currentTime);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), a.currentTime + dur);
    g.gain.setValueAtTime(0.0001, a.currentTime);
    g.gain.exponentialRampToValueAtTime(gain || 0.18, a.currentTime + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    osc.connect(g).connect(a.destination);
    osc.start();
    osc.stop(a.currentTime + dur + 0.02);
  }

  // Short filtered-noise burst -- used for the card flip "fwip".
  function noise(dur, freq, gain) {
    const a = ac();
    if (!a) return;
    const n = Math.floor(a.sampleRate * dur);
    const buf = a.createBuffer(1, n, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = a.createBufferSource();
    src.buffer = buf;
    const bp = a.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = freq || 1800;
    const g = a.createGain();
    g.gain.value = gain || 0.25;
    src.connect(bp).connect(g).connect(a.destination);
    src.start();
  }

  // Real recorded-style card flip (a WAV sample). Cloned each play so rapid
  // flop flips overlap naturally instead of cutting each other off.
  const flipSrc = "/static/snd/flip.wav?v=17";
  let flipReady = null;
  function playFlip() {
    try {
      const a = (flipReady ? flipReady.cloneNode() : (flipReady = new Audio(flipSrc)));
      a.volume = 0.55;
      a.play().catch(() => {});
    } catch (e) { noise(0.12, 2200, 0.3); }   // fall back to synth
  }

  const SOUNDS = {
    deal: playFlip,                                     // real card-flip sample
    check: () => tone(220, 180, 0.12, "sine", 0.16),    // soft knock
    call: () => tone(440, 540, 0.12, "triangle", 0.18), // chip plink
    raise: () => { tone(520, 720, 0.1, "sawtooth", 0.16);
                   setTimeout(() => tone(720, 920, 0.12, "sawtooth", 0.16), 90); },
    fold: () => tone(300, 160, 0.16, "sine", 0.12),
    timeout: () => { tone(880, 880, 0.1, "square", 0.14);
                     setTimeout(() => tone(880, 880, 0.1, "square", 0.14), 160); },
    win: () => { [523, 659, 784].forEach((f, i) =>
                   setTimeout(() => tone(f, f, 0.16, "triangle", 0.16), i * 110)); },
  };

  PPS.play = function (name) {
    if (!PPS.enabled) return;
    const fn = SOUNDS[name];
    if (fn) try { fn(); } catch (e) { /* audio not ready -- ignore */ }
  };

  // Unlock audio on the first user gesture (Chrome/Safari autoplay policy).
  function unlock() { ac(); window.removeEventListener("pointerdown", unlock);
                      window.removeEventListener("keydown", unlock); }
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
})();
