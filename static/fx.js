// Puppy Poker - lightweight visual FX (confetti + chip-fly). No deps, canvas
// drawn on demand, auto-cleans up. Respects prefers-reduced-motion.
(function () {
  const reduce = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const COLORS = ["#fbbf24", "#f87171", "#34d399", "#60a5fa",
                  "#c084fc", "#f472b6", "#facc15", "#ffffff"];

  function makeCanvas() {
    const c = document.createElement("canvas");
    c.style.cssText =
      "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:60";
    c.width = window.innerWidth;
    c.height = window.innerHeight;
    document.body.appendChild(c);
    return c;
  }

  function confetti() {
    if (reduce) return;
    const c = makeCanvas();
    const ctx = c.getContext("2d");
    const N = Math.min(160, Math.round(c.width / 9));
    const parts = [];
    for (let i = 0; i < N; i++) {
      parts.push({
        x: c.width * (0.2 + Math.random() * 0.6),
        y: c.height * 0.32 + Math.random() * 40,
        vx: (Math.random() - 0.5) * 9,
        vy: -6 - Math.random() * 9,
        g: 0.22 + Math.random() * 0.12,
        s: 5 + Math.random() * 7,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.4,
        col: COLORS[(Math.random() * COLORS.length) | 0],
        life: 1,
      });
    }
    const start = performance.now();
    function frame(now) {
      const t = now - start;
      ctx.clearRect(0, 0, c.width, c.height);
      let alive = 0;
      for (const p of parts) {
        p.vy += p.g;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        if (t > 1600) p.life -= 0.02;
        if (p.life > 0 && p.y < c.height + 30) {
          alive++;
          ctx.save();
          ctx.globalAlpha = Math.max(0, p.life);
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.col;
          ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
          ctx.restore();
        }
      }
      if (alive > 0 && t < 4000) requestAnimationFrame(frame);
      else c.remove();
    }
    requestAnimationFrame(frame);
  }

  window.PPFX = { confetti };
})();
