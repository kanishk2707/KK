// Catch-the-bug: pixel flies buzz around Spidey's corner; click one and he webs it.
// 45-second rounds, golden bugs worth 5, combos for quick catches, high score kept on this PC.
(function () {
  const FLY = [
    ['..W.W..', '.WWKWW.', 'KKKKKKK', '.KKKKK.', '..K.K..'],   // wings up
    ['.......', 'WW.K.WW', 'KKKKKKK', '.KKKKK.', '..K.K..'],   // wings down
  ];
  const COLORS = { K: '#1d1b26', W: 'rgba(233,238,248,.9)', G: '#ffd84a', g: '#b8860b' };
  const ROUND = 45000;
  const rand = (a, b) => a + Math.random() * (b - a);
  const now = () => performance.now();

  function sprite(rows, gold) {
    const c = document.createElement('canvas');
    c.width = rows[0].length; c.height = rows.length;
    const x = c.getContext('2d');
    rows.forEach((r, y) => [...r].forEach((ch, i) => {
      if (ch === '.') return;
      x.fillStyle = gold && ch === 'K' ? (y === 2 ? COLORS.g : COLORS.G) : COLORS[ch];
      x.fillRect(i, y, 1, 1);
    }));
    return c;
  }

  class BugGame {
    /** body: the Spidey sprite; area(): on-screen box in CSS px; hooks: { onEnd(score, best, isBest) } */
    constructor({ canvas, hud, body, area, hooks }) {
      Object.assign(this, { canvas, hud, body, area, hooks });
      this.ctx = canvas.getContext('2d');
      this.frames = { plain: FLY.map((r) => sprite(r, false)), gold: FLY.map((r) => sprite(r, true)) };
      this.running = false;
      this.onClick = (e) => this.shoot(e.clientX, e.clientY);
      this.onKey = (e) => { if (e.key === 'Escape') this.stop(true); };
    }

    get best() { try { return Number(localStorage.getItem('spidey.bugHigh')) || 0; } catch { return 0; } }
    set best(v) { try { localStorage.setItem('spidey.bugHigh', String(v)); } catch {} }

    start() {
      if (this.running) return;
      const dpr = window.devicePixelRatio || 1;
      this.dpr = dpr;
      this.canvas.width = Math.round(innerWidth * dpr);
      this.canvas.height = Math.round(innerHeight * dpr);
      this.canvas.hidden = false;
      this.hud.hidden = false;
      this.bugs = []; this.pops = []; this.score = 0; this.caught = 0; this.combo = 0; this.lastCatch = 0;
      this.t0 = now(); this.nextSpawn = this.t0 + 400;
      this.running = true;
      this.canvas.addEventListener('mousedown', this.onClick);
      window.addEventListener('keydown', this.onKey);
      this.loop();
    }

    stop(quit = false) {
      if (!this.running) return;
      this.running = false;
      this.canvas.removeEventListener('mousedown', this.onClick);
      window.removeEventListener('keydown', this.onKey);
      this.canvas.hidden = true;
      this.hud.hidden = true;
      const best = this.best, isBest = this.score > best;
      if (isBest) this.best = this.score;
      this.hooks.onEnd?.(this.score, Math.max(best, this.score), isBest, this.caught, quit);
    }

    spawn() {
      const a = this.area();
      const gold = Math.random() < 0.12;
      const fromLeft = Math.random() < 0.5;
      this.bugs.push({
        x: fromLeft ? a.left + 10 : a.right - 10, y: rand(a.top + 30, a.bottom - 170),
        vx: (fromLeft ? 1 : -1) * rand(40, 90) * (gold ? 1.8 : 1), vy: rand(-25, 25),
        wob: rand(0, 6), gold, born: now(), life: gold ? rand(2600, 3600) : rand(4000, 6500), caught: null,
      });
    }

    /** Spidey shoots a web at (x, y) CSS px; a bug within reach gets wrapped and reeled in. */
    shoot(x, y) {
      const b = this.body, d = this.dpr, P = b.P;
      const hand = { x: b.x + 28 * P, y: b.y + 16 * P };
      b.webs.push({ x1: hand.x, y1: hand.y, x2: x * d, y2: y * d, t0: now(), grow: 110, life: 380 });
      b.reaction = { armR: 'out', eyes: 'focus', until: now() + 350, start: now() };
      const hit = this.bugs.filter((g) => !g.caught).map((g) => ({ g, dist: Math.hypot(g.x - x, g.y - y) }))
        .filter((o) => o.dist < 22).sort((p, q) => p.dist - q.dist)[0];
      if (!hit) { this.combo = 0; this.pops.push({ x, y, text: 'miss', t0: now(), color: '#9aa1cf' }); return; }
      const t = now();
      this.combo = t - this.lastCatch < 1600 ? Math.min(5, this.combo + 1) : 1;
      this.lastCatch = t;
      const pts = (hit.g.gold ? 5 : 1) * this.combo;
      this.score += pts;
      this.caught++;
      hit.g.caught = { t0: t, from: { x: hit.g.x, y: hit.g.y }, to: { x: hand.x / d, y: hand.y / d } };
      this.pops.push({ x, y: y - 10, text: `+${pts}${this.combo > 1 ? ` x${this.combo}` : ''}`, t0: t, color: hit.g.gold ? '#ffd84a' : '#ffffff' });
      b.react(hit.g.gold ? 'excited' : 'happy', 700);
    }

    loop() {
      if (!this.running) return;
      const t = now();
      const left = ROUND - (t - this.t0);
      if (left <= 0) return this.stop(false);
      const dt = Math.min(0.05, (t - (this.last || t)) / 1000);
      this.last = t;
      const a = this.area();
      if (t > this.nextSpawn && this.bugs.filter((g) => !g.caught).length < 6) { this.spawn(); this.nextSpawn = t + rand(550, 1100) * (left < 15000 ? 0.7 : 1); }

      for (const g of this.bugs) {
        if (g.caught) continue;
        g.wob += dt * 6;
        g.x += g.vx * dt + Math.sin(g.wob) * 0.6;
        g.y += g.vy * dt + Math.cos(g.wob * 1.3) * 0.8;
        if (g.y < a.top + 20 || g.y > a.bottom - 150) g.vy *= -1;
        if (t - g.born > g.life) g.vx *= 1.04;          // getting bored: zooming off
      }
      this.bugs = this.bugs.filter((g) => (g.caught ? t - g.caught.t0 < 450 : g.x > a.left - 40 && g.x < a.right + 40));

      // draw
      const ctx = this.ctx, d = this.dpr, s = Math.max(3, Math.round(4 * d));
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.fillStyle = 'rgba(18,20,39,.18)';                 // a light tint so you can see the play area
      ctx.fillRect(a.left * d, a.top * d, (a.right - a.left) * d, (a.bottom - a.top) * d);
      for (const g of this.bugs) {
        let x = g.x, y = g.y;
        if (g.caught) {                                      // wrapped in silk, reeled in to Spidey
          const k = Math.min(1, (t - g.caught.t0) / 450);
          x = g.caught.from.x + (g.caught.to.x - g.caught.from.x) * k;
          y = g.caught.from.y + (g.caught.to.y - g.caught.from.y) * k;
          ctx.fillStyle = '#160f1d'; ctx.fillRect(x * d - 2 * s - 1, y * d - 2 * s - 1, 4 * s + 2, 4 * s + 2);
          ctx.fillStyle = '#e9eef8'; ctx.fillRect(x * d - 2 * s, y * d - 2 * s, 4 * s, 4 * s);
          ctx.fillStyle = '#b9c2d6'; ctx.fillRect(x * d - 2 * s, y * d - s / 2, 4 * s, Math.max(1, s / 2));
          continue;
        }
        const img = (g.gold ? this.frames.gold : this.frames.plain)[Math.floor(t / 70) % 2];
        ctx.drawImage(img, Math.round(x * d - (img.width * s) / 2), Math.round(y * d - (img.height * s) / 2), img.width * s, img.height * s);
      }
      ctx.font = `600 ${Math.round(14 * d)}px "Pixelify Sans", sans-serif`;
      ctx.textAlign = 'center';
      this.pops = this.pops.filter((p) => t - p.t0 < 800);
      for (const p of this.pops) {
        const k = (t - p.t0) / 800;
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = '#160f1d'; ctx.fillText(p.text, p.x * d + 2, (p.y - k * 24) * d + 2);
        ctx.fillStyle = p.color; ctx.fillText(p.text, p.x * d, (p.y - k * 24) * d);
      }
      ctx.globalAlpha = 1;

      const secs = Math.ceil(left / 1000);
      this.hud.innerHTML = `<b>Bugs ${this.score}</b><span>${this.combo > 1 ? `combo x${this.combo}` : 'click a bug!'}</span><span class="${secs <= 10 ? 'hurry' : ''}">${secs}s</span><span class="best">best ${Math.max(this.best, this.score)}</span><span class="esc">Esc to stop</span>`;
      requestAnimationFrame(() => this.loop());
    }
  }

  window.BugGame = BugGame;
})();
