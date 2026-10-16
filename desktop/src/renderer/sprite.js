// Spidey's body: animation state machine, idle behaviors, web-slinging, particles.
// All positions are in device pixels and snapped to the art's pixel grid when drawn.
(function () {
  const SD = window.SpriteData;

  const REACTIONS = {
    happy:     { eyes: 'happy', wave: true, hop: 1, fx: ['tiny', 'tiny'] },
    excited:   { eyes: 'happy', armL: 'up', armR: 'up', hop: 2, fx: ['spark', 'spark', 'tiny', 'tiny', 'tiny'] },
    proud:     { eyes: 'happy', armL: 'hips', armR: 'hips', fx: ['spark'] },
    cool:      { eyes: 'cool', armL: 'hips', armR: 'hips', fx: ['tiny'] },
    thinking:  { eyes: 'focus', armR: 'chin', fx: ['q'] },
    love:      { eyes: 'love', armL: 'clasp', armR: 'clasp', hop: 1, fx: ['heart', 'heart', 'heart'] },
    surprised: { eyes: 'wide', armL: 'shrug', armR: 'shrug', hop: 1, fx: ['bang'] },
    sad:       { eyes: 'sad', headDy: 1, fx: ['sweat'] },
    oops:      { eyes: 'sad', armL: 'shrug', armR: 'shrug', fx: ['sweat'] },
    sleepy:    { eyes: 'sleepy', headDy: 1, fx: ['z'] },
    wave:      { eyes: 'happy', wave: true },
    stretch:   { eyes: 'happy', armL: 'up', armR: 'up' },
    look:      { eyes: 'look' },
  };
  // eyes kept while talking after a mood tag
  const TALK_EYES = { happy: 'normal', excited: 'happy', proud: 'normal', cool: 'cool', thinking: 'focus', love: 'love',
    surprised: 'wide', sad: 'sad', oops: 'sad', sleepy: 'sleepy' };

  const rand = (a, b) => a + Math.random() * (b - a);
  const now = () => performance.now();

  class Spidey {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.frames = new Map();
      this.fxCache = new Map();
      this.particles = [];
      this.webs = [];
      this.scale = 4;
      this.activity = null;   // thinking | working | listening | talking | sleeping | confirm
      this.reaction = null;
      this.talkMood = null;
      this.pinned = false;    // stay at home (composer/bubble open)
      this.noHang = false;    // panel open: don't swing up into it
      this.carried = false;
      this.flip = false;
      this.mode = 'hang';
      this.vy = 0;
      this.tween = null;
      this.blinkUntil = 0;
      this.nextBlink = now() + 2500;
      this.nextIdle = now() + 9000;
      this.nextFx = 0;
      this.landUntil = 0;
      this.last = now();
      this.lastDraw = 0;
      this.hoverWaveAt = 0;
      this.resize();
      this.x = this.homeX;
      this.y = -this.h;
      this.hangY = Math.round(this.canvas.height * 0.42);
      this.descend(this.hangY, 2200);
    }

    // ---------- geometry ----------
    resize() {
      const dpr = window.devicePixelRatio || 1;
      this.dpr = dpr;
      this.canvas.width = Math.round(innerWidth * dpr);
      this.canvas.height = Math.round(innerHeight * dpr);
      this.P = Math.max(2, Math.round(this.scale * dpr));
      this.w = SD.W * this.P;
      this.h = SD.H * this.P;
      // everything stays inside the part of the window that is actually on screen
      const v = this.visible || { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      this.visTop = Math.round(v.top * dpr);
      this.groundY = Math.round(Math.min(innerHeight, v.bottom) * dpr) - this.h - Math.round(4 * dpr);
      this.homeX = Math.round(Math.min(innerWidth, v.right) * dpr) - this.w - Math.round(4 * dpr);
      this.minX = Math.min(this.homeX, Math.round(Math.max(150, v.left + 8) * dpr));
      if (this.mode === 'ground' || this.mode === 'walk') this.y = this.groundY;
      if (this.mode === 'walk') this.target = Math.max(this.minX, Math.min(this.homeX, this.target));
      this.x = Math.max(this.minX, Math.min(this.x ?? this.homeX, this.homeX));
      if (this.mode === 'hang' && this.y < this.visTop + 40 * dpr) this.drop();
    }
    setScale(s) { this.scale = s; this.resize(); this.x = this.homeX; }
    /** Window-relative CSS-px box of the on-screen part of the window. */
    setVisible(v) {
      this.visible = v;
      this.resize();
      // the boot-time drop-in on a web also has to stop below the top of the screen
      if (this.mode === 'descend' && this.tween) this.tween.to = Math.max(this.tween.to, this.visTop + 80 * this.dpr);
    }

    /** CSS-pixel boxes for the DOM layer. */
    box() {
      const d = this.dpr, P = this.P;
      const sx = this.snap(this.x), sy = this.snap(this.y);
      return { left: (sx + 8 * P) / d, top: (sy + P) / d, width: 17 * P / d, height: 29 * P / d };
    }
    anchor() {
      const d = this.dpr, P = this.P;
      const sx = this.snap(this.x), sy = this.snap(this.y);
      const top = this.flip ? sy + 3 * P : sy + P;
      return { x: (sx + 16.5 * P) / d, y: top / d, grounded: this.mode === 'ground' || this.mode === 'walk' };
    }
    snap(v) { return Math.round(v / this.P) * this.P; }
    head() { // device px center of the head
      const P = this.P;
      return { x: this.x + 16.5 * P, y: this.flip ? this.y + this.h - 9 * P : this.y + 9 * P };
    }

    // ---------- public actions ----------
    setActivity(a) {
      if (this.activity === a) return;
      this.activity = a;
      if (a === 'sleeping') this.nextFx = 0;
      if (a && a !== 'sleeping') this.comeHome();
    }
    react(name, ms = 2600) {
      const def = REACTIONS[name];
      if (!def) return;
      this.reaction = { ...def, name, until: now() + ms, start: now() };
      if (TALK_EYES[name]) this.talkMood = TALK_EYES[name];
      (def.fx || []).forEach((k, i) => setTimeout(() => this.spawn(k), i * 140));
      if (def.hop && (this.mode === 'ground')) this.hop(def.hop);
    }
    clearMood() { this.talkMood = null; }
    wave() { this.react('wave', 1600); }
    comeHome() {
      if (this.mode === 'move') this.endMove(true);
      if (this.mode === 'hang' || this.mode === 'zip') this.drop();
      else if (this.mode === 'ground' && Math.abs(this.x - this.homeX) > this.P) this.walkTo(this.homeX);
      else if (this.mode === 'walk') this.target = this.homeX;
    }
    hop(n = 1) {
      if (this.mode !== 'ground' && this.mode !== 'walk') return;
      this.mode = 'air';
      this.vy = -260 * this.dpr;
      this.hopsLeft = n - 1;
    }
    walkTo(x) {
      if (this.mode !== 'ground' && this.mode !== 'walk') return;
      this.target = Math.max(this.minX, Math.min(this.homeX, x));
      this.mode = 'walk';
    }
    zipUp() {
      if (this.mode !== 'ground') return;
      this.mode = 'zip';
      const P = this.P;
      const hx = this.x + 26 * P, hy = this.y + 11 * P;
      this.zipWeb = { x1: hx, y1: hy, x2: hx, y2: hy, t0: now() };
      // swing up, but never above the top of the screen
      const top = Math.max(this.canvas.height * 0.18, this.visTop + 70 * this.dpr);
      const low = this.groundY - 150 * this.dpr;
      if (low <= top) { this.mode = 'ground'; this.zipWeb = null; this.thwip(); return; }   // no room: just shoot a web
      this.hangY = Math.round(rand(top, low));
      this.hangUntil = now() + rand(6000, 11000);
    }
    drop() {
      if (this.mode === 'hang' || this.mode === 'zip' || this.mode === 'descend') {
        this.mode = 'air';
        this.vy = 40 * this.dpr;
        this.tween = null;
        this.zipWeb = null;
        this.flip = false;
        this.hopsLeft = 0;
        this.spawnWebBreak();
      }
    }
    descend(toY, ms) {
      this.mode = 'descend';
      this.flip = true;
      this.tween = { from: this.y, to: toY, t0: now(), ms };
    }
    thwip() {
      if (this.mode !== 'ground') return;
      const P = this.P;
      // shoot from the left hand toward the open space on the left
      const hx = this.x + 4 * P, hy = this.y + 16 * P;
      const tx = rand(Math.max(this.minX * 0.4, (this.visible?.left || 0) * this.dpr + 20 * this.dpr), this.x - 60 * this.dpr);
      const ty = rand(Math.max(this.canvas.height * 0.15, (this.visTop || 0) + 30 * this.dpr), this.groundY - 40 * this.dpr);
      this.reaction = { armL: 'out', armR: 'hips', eyes: 'focus', until: now() + 900, start: now() };
      this.webs.push({ x1: hx, y1: hy, x2: tx, y2: ty, t0: now(), grow: 140, life: 1500 });
      setTimeout(() => this.spawn('web', tx, ty, { vx: 0, vy: 0, life: 1400 }), 140);
    }
    /** A file is being dragged over him: eyes wide, arms up, ready to catch. Call repeatedly while dragging. */
    readyToCatch() {
      this.readyAt = now();
      if (this.mode === 'hang' || this.mode === 'zip') this.drop();
    }

    /**
     * Web-catch a dropped file: shoot a web from the nearest hand to (cssX, cssY), stick,
     * reel the file back in, then celebrate. count = how many files (shown as a little stack).
     */
    catchFile(cssX, cssY, count = 1) {
      if (this.mode === 'hang' || this.mode === 'zip' || this.mode === 'descend') this.drop();
      const P = this.P, d = this.dpr;
      const tx = cssX * d, ty = cssY * d;
      const left = tx < this.x + 16 * P;
      const hand = () => ({ x: this.x + (left ? 5 : 28) * P, y: this.y + 16 * P });
      this.readyAt = 0;
      this.catches = this.catches || [];
      this.catches.push({ tx, ty, hand, left, count: Math.max(1, Math.min(3, count)), t0: now() });
      this.reaction = { eyes: 'focus', [left ? 'armL' : 'armR']: 'out', [left ? 'armR' : 'armL']: 'hips', until: now() + 900, start: now() };
    }

    setCarried(on) {
      this.carried = on;
      if (on) this.react('surprised', 99999); else { this.reaction = null; this.react('happy', 1200); }
    }
    hoverHello() {
      if (now() - this.hoverWaveAt < 12000 || this.activity) return;
      this.hoverWaveAt = now();
      if (this.mode === 'ground') this.react('wave', 1400);
    }

    // ---------- particles ----------
    spawn(kind, x, y, opt = {}) {
      const h = this.head();
      const P = this.P;
      const p = {
        kind, x: x ?? h.x + rand(-8, 8) * P, y: y ?? h.y - rand(9, 13) * P,
        vx: opt.vx ?? rand(-14, 14) * this.dpr, vy: opt.vy ?? rand(-48, -26) * this.dpr,
        life: opt.life ?? 1600, t0: now(), wob: rand(0, 6),
      };
      if (kind === 'sweat') { p.x = h.x + 7 * P; p.y = h.y - 6 * P; p.vx = 0; p.vy = 18 * this.dpr; p.life = 1300; }
      if (kind === 'z') { p.x = h.x + 7 * P; p.y = h.y - 9 * P; p.vx = 16 * this.dpr; p.vy = -20 * this.dpr; p.life = 2400; }
      if (kind === 'bang' || kind === 'q') { p.x = h.x + 8 * P; p.y = h.y - 14 * P; p.vx = 0; p.vy = -6 * this.dpr; p.life = 1500; }
      if (kind === 'spark' || kind === 'tiny') { p.x = h.x + rand(-14, 14) * P; p.y = h.y + rand(-14, 4) * P; p.vy = -10 * this.dpr; p.life = 900; }
      if (this.flip && x === undefined) {
        // upside down: the head is at the bottom, so keep effects beside it instead of at his feet
        p.x = h.x + (Math.random() < 0.5 ? -1 : 1) * rand(9, 14) * P;
        p.y = h.y + rand(-3, 3) * P;
      }
      this.particles.push(p);
    }
    spawnWebBreak() {
      const h = this.head();
      for (let i = 0; i < 3; i++) this.spawn('tiny', h.x + rand(-3, 3) * this.P, this.y - 2 * this.P);
    }

    // ---------- simulation ----------
    update() {
      const t = now();
      const dt = Math.min(0.05, (t - this.last) / 1000);
      this.last = t;
      const g = 1500 * this.dpr;

      if (this.reaction && t > this.reaction.until) this.reaction = null;
      if (t > this.nextBlink) { this.blinkUntil = t + 130; this.nextBlink = t + rand(1800, 5200); }

      switch (this.mode) {
        case 'descend': {
          const k = Math.min(1, (t - this.tween.t0) / this.tween.ms);
          const e = 1 - Math.pow(1 - k, 3);
          this.y = this.tween.from + (this.tween.to - this.tween.from) * e;
          if (k >= 1) { this.mode = 'hang'; this.tween = null; this.hangUntil = Infinity; }
          break;
        }
        case 'zip': {
          const zw = this.zipWeb;
          const shoot = Math.min(1, (t - zw.t0) / 170);
          zw.y2 = zw.y1 - (zw.y1 - (this.visTop || 0) + this.P) * shoot;   // anchors at the top of the screen
          if (shoot >= 1) {
            if (!this.tween) this.tween = { from: this.y, to: this.hangY, t0: t, ms: 520 };
            const k = Math.min(1, (t - this.tween.t0) / this.tween.ms);
            const e = k * k * (3 - 2 * k);
            this.y = this.tween.from + (this.tween.to - this.tween.from) * e;
            zw.y1 = this.y + 11 * this.P;
            if (k >= 1) { this.mode = 'hang'; this.flip = true; this.tween = null; this.zipWeb = null; }
          }
          break;
        }
        case 'hang':
          if (t > this.hangUntil || this.pinned || this.noHang && this.hangUntil !== Infinity) this.drop();
          break;
        case 'air':
          this.vy += g * dt;
          this.y += this.vy * dt;
          if (this.y >= this.groundY) {
            this.y = this.groundY;
            if (this.hopsLeft > 0) { this.hopsLeft--; this.vy = -230 * this.dpr; }
            else {
              const hard = this.vy > 400 * this.dpr;
              this.vy = 0;
              this.mode = 'ground';
              this.landUntil = t + (hard ? 180 : 90);
              if (hard) { this.spawn('tiny', this.x + 10 * this.P, this.y + 28 * this.P, { vy: -20 * this.dpr, vx: -30 * this.dpr, life: 500 });
                this.spawn('tiny', this.x + 23 * this.P, this.y + 28 * this.P, { vy: -20 * this.dpr, vx: 30 * this.dpr, life: 500 }); }
            }
          }
          break;
        case 'walk': {
          const speed = 46 * this.dpr;
          const dir = Math.sign(this.target - this.x);
          this.x += dir * speed * dt;
          if ((dir > 0 && this.x >= this.target) || (dir < 0 && this.x <= this.target) || dir === 0) {
            this.x = this.target;
            this.mode = 'ground';
          }
          break;
        }
        case 'leave': {
          const k = Math.min(1, (t - this.leaveT0) / 750);
          this.y = this.leaveFrom - (this.leaveFrom - ((this.visTop || 0) - this.h * 1.3)) * (k < 0.25 ? 0 : (k - 0.25) / 0.75);
          break;
        }
        case 'move':
          if (this.activity || this.pinned) this.endMove(true);
          else this.updateMove(t);
          break;
        case 'ground':
          if ((this.pinned || this.focusMode) && Math.abs(this.x - this.homeX) > this.P && !this.carried) this.walkTo(this.homeX);
          else if (!this.activity && !this.carried && !this.focusMode && !this.calm && t > this.nextIdle) this.idleBehavior();
          break;
      }

      // ambient effects
      if (this.activity === 'sleeping' && t > this.nextFx) { this.spawn('z'); this.nextFx = t + 1500; }
      if (this.dancing && !this.activity && !this.calm && t > (this.nextNote || 0)) { this.spawn('note'); this.nextNote = t + 1300 + Math.random() * 900; }

      this.particles = this.particles.filter((p) => t - p.t0 < p.life);
      for (const p of this.particles) {
        if (p.kind === 'heart') p.x += Math.sin((t - p.t0) / 180 + p.wob) * 0.6 * this.dpr;
        p.x += p.vx * dt; p.y += p.vy * dt;
      }
      this.webs = this.webs.filter((w) => t - w.t0 < w.life);
    }

    idleBehavior() {
      this.nextIdle = now() + rand(7000, 15000);
      const away = Math.abs(this.x - this.homeX) > this.P;
      if (this.pinned) { if (Math.random() < 0.5) this.react('look', 1400); return; }
      if (away && Math.random() < 0.4) return this.walkTo(this.homeX);
      const h = new Date().getHours();
      const late = h >= 23 || h < 5;
      // weighted menu of things to do while you work
      const menu = [
        [late ? 4 : 20, () => this.walkTo(rand(this.minX, this.homeX - 40 * this.dpr))],
        [this.noHang ? 0 : 9, () => this.zipUp()],
        [this.noHang ? 0 : 8, () => this.startMove('swing')],
        [6, () => this.startMove('backflip')],
        [6, () => this.startMove('climb')],
        [6, () => this.startMove('webart')],
        [6, () => this.startMove('peekaboo')],
        [6, () => this.startMove('yoyo')],
        [late ? 20 : 7, () => this.startMove('sit')],
        [6, () => this.wave()],
        [6, () => this.thwip()],
        [5, () => this.react('look', 1500)],
        [late ? 8 : 3, () => this.react(late ? 'sleepy' : 'stretch', 1400)],
        [3, () => this.hop(1)],
      ];
      let r = Math.random() * menu.reduce((s, [w]) => s + w, 0);
      for (const [w, fn] of menu) { if ((r -= w) <= 0) { if (fn() === false) this.wave(); return; } }
    }

    // ---------- moves ----------
    // Each move runs in mode 'move' with its own timeline; endMove() puts him back on the ground.
    static MOVES = ['backflip', 'swing', 'climb', 'webart', 'peekaboo', 'yoyo', 'sit', 'dance', 'wave', 'zip'];

    /** Returns false if the move can't run right now (busy, in the air, no room). */
    startMove(name) {
      if (name === 'wave') { this.wave(); return true; }
      if (name === 'zip') { this.zipUp(); return this.mode === 'zip'; }
      if (name === 'dance') { this.danceUntil = now() + 6000; return true; }
      if (this.mode !== 'ground' || this.activity || this.carried) return false;
      const P = this.P, d = this.dpr, t = now();
      const m = { name, t0: t, x0: this.x, y0: this.y };
      switch (name) {
        case 'backflip': m.dur = 1150; break;
        case 'climb': {
          m.top = Math.max(this.visTop + 40 * d, this.groundY - 260 * d);
          if (this.groundY - m.top < 60 * d) return false;
          if (Math.abs(this.x - this.homeX) > P) { this.walkTo(this.homeX); return true; }   // climb at the screen edge
          m.dur = 2400 + 1300 + 550;
          break;
        }
        case 'swing': {
          // pendulum: web to an anchor up and to the left, swing across, let go at the bottom
          const room = this.x - this.minX;
          if (room < 90 * d) return false;
          const th = 0.6;
          let L = Math.min(room * 0.9, 240 * d);
          const hand = { x: this.x + 25 * P, y: this.groundY + 10 * P };
          if (hand.y - L < this.visTop + 20 * d) L = hand.y - this.visTop - 20 * d;
          if (L < 80 * d) return false;
          m.L = L; m.th0 = th;
          m.ax = hand.x - L * Math.sin(th);
          m.ay = hand.y - L;
          m.shoot = 220; m.half = 900; m.dur = m.shoot + m.half * 1.5;
          break;
        }
        case 'webart': {
          const R = 13 * P;
          m.cx = Math.max(this.minX + R, this.x - 14 * P);
          m.cy = Math.max(this.visTop + R + 10 * d, this.y - 2 * P);
          m.dur = 1900;
          this.webArt = { cx: m.cx, cy: m.cy, R, t0: t, build: 1700, life: 9000 };
          break;
        }
        case 'peekaboo': m.dur = 450 + 900 + 1100 + 200; break;
        case 'yoyo': m.dur = 3600; break;
        case 'sit': m.dur = rand(5500, 9000); m.yawnAt = new Date().getHours() >= 22 || new Date().getHours() < 6 ? rand(1500, 3000) : -1; break;
        default: return false;
      }
      this.move = m;
      this.mode = 'move';
      return true;
    }

    /** Goodbye: shoot a web up and zip off the top of the screen. */
    leave() {
      if (this.move) this.endMove(true);
      if (this.mode === 'hang') { this.flip = false; }
      this.mode = 'leave';
      this.leaveT0 = now();
      this.leaveFrom = this.y;
    }

    /** Hello again: drop in on a web from above, then land and wave. */
    comeBack() {
      this.flip = true;
      this.y = (this.visTop || 0) - this.h;
      this.x = this.homeX;
      this.descend(Math.max(this.visTop + 80 * this.dpr, this.groundY - 180 * this.dpr), 1300);
      setTimeout(() => { this.drop(); setTimeout(() => this.wave(), 700); }, 1900);
    }

    endMove(abort = false) {
      const m = this.move;
      this.move = null;
      if (!m) return;
      this.x = Math.max(this.minX, Math.min(this.homeX, this.x));
      if (this.y < this.groundY - this.P) { this.mode = 'air'; this.vy = 0; }
      else { this.y = this.groundY; this.mode = 'ground'; if (!abort) this.landUntil = now() + 140; }
      if (abort) return;
      if (m.name === 'peekaboo') { this.react('surprised', 900); this.spawn('bang'); }
      if (m.name === 'backflip' || m.name === 'swing') this.react('excited', 1200);
      if (m.name === 'webart') this.react('proud', 1600);
    }

    updateMove(t) {
      const m = this.move;
      const age = t - m.t0, P = this.P, d = this.dpr;
      if (age >= m.dur) return this.endMove();
      const ease = (k) => k * k * (3 - 2 * k);
      switch (m.name) {
        case 'backflip': {
          const k = Math.min(1, Math.max(0, (age - 180) / 720));     // airborne part
          this.y = m.y0 - Math.sin(Math.PI * k) * 70 * d;
          m.angle = k > 0 && k < 1 ? -2 * Math.PI * ease(k) : 0;
          break;
        }
        case 'climb': {
          const up = 2400, hold = 1300;
          if (age < up) this.y = m.y0 - (m.y0 - m.top) * (age / up);
          else if (age < up + hold) this.y = m.top;
          else this.y = m.top + (m.y0 - m.top) * ease((age - up - hold) / 550);
          if (age > up && age < up + 300 && !m.waved) { m.waved = true; this.react('wave', 1000); }
          break;
        }
        case 'swing': {
          if (age < m.shoot) { m.tip = age / m.shoot; this.y = m.y0 - (1 - Math.cos(m.th0)) * m.L * (age / m.shoot); m.hand = null; }
          else {
            const s = (age - m.shoot) / m.half;                       // 0 .. 1.5 half-swings
            const amp = m.th0 * (1 - 0.2 * s / 1.5);
            const th = amp * Math.cos(Math.PI * s);
            const hx = m.ax + m.L * Math.sin(th), hy = m.ay + m.L * Math.cos(th);
            this.x = hx - 25 * P; this.y = hy - 10 * P;
            m.tip = 1;
          }
          break;
        }
        case 'peekaboo': {
          const sink = 450, hidden = 900, peek = 1100;
          const deep = this.h * 0.85, peekY = this.h * 0.56;
          if (age < sink) this.y = m.y0 + deep * ease(age / sink);
          else if (age < sink + hidden) this.y = m.y0 + deep;
          else if (age < sink + hidden + peek) this.y = m.y0 + peekY;
          else this.y = m.y0 + peekY * (1 - (age - sink - hidden - peek) / 200);
          break;
        }
        default: break;
      }
    }

    /** Pose overrides while a move runs. */
    movePose(t, p) {
      const m = this.move;
      const age = t - m.t0;
      switch (m.name) {
        case 'backflip':
          if (age < 180 || age > 900) { p.legs = 'tuck'; p.bob = 1; p.eyes = 'focus'; }
          else { p.legs = 'tuck'; p.armL = 'up'; p.armR = 'up'; p.eyes = 'happy'; }
          break;
        case 'climb': {
          const step = Math.floor(age / 190) % 2;
          if (age < 2400) { p.armL = step ? 'up' : 'down'; p.armR = step ? 'down' : 'up'; p.legs = step ? 'walkA' : 'walkB'; p.eyes = 'focus'; }
          else if (age < 3700) { p.eyes = 'look'; }
          else { p.armL = 'up'; p.armR = 'up'; p.legs = 'tuck'; p.eyes = 'happy'; }
          break;
        }
        case 'swing': p.armR = 'up'; p.armL = 'swing'; p.legs = age > m.shoot ? 'tuck' : 'stand'; p.eyes = 'happy'; break;
        case 'webart': p.armL = 'out'; p.armR = Math.floor(age / 200) % 2 ? 'hips' : 'down'; p.eyes = 'focus'; break;
        case 'peekaboo': p.eyes = age > 1350 ? 'look' : 'happy'; p.armL = 'clasp'; p.armR = 'clasp'; break;
        case 'yoyo': p.armR = 'out'; p.eyes = 'happy'; break;
        case 'sit': {
          p.legs = Math.floor(age / 650) % 4 === 1 ? 'sitKick' : 'sit'; p.bob = 3;   // sitting, swinging a foot now and then
          p.armL = 'clasp'; p.armR = 'clasp';
          if (m.yawnAt > 0 && age > m.yawnAt && age < m.yawnAt + 1400) { p.eyes = 'sleepy'; p.armL = 'up'; p.armR = 'up'; if (!m.yawned) { m.yawned = true; this.spawn('z'); } }
          else p.eyes = Math.floor(age / 2600) % 3 === 2 ? 'look' : 'normal';
          break;
        }
      }
      return p;
    }

    /** Extra drawing for moves: the swing rope, the yo-yo, the web art. */
    drawMoveExtras(t, sx, sy, ws, silk, ink) {
      const ctx = this.ctx, P = this.P;
      const m = this.move;
      if (m && m.name === 'swing') {
        const hx = this.x + 25 * P, hy = this.y + 10 * P;
        const k = m.tip ?? 0;
        this.pixelLine(hx, hy, hx + (m.ax - hx) * k, hy + (m.ay - hy) * k, ws, silk, ink);
        if (k >= 1 && !m.splat) { m.splat = true; this.spawn('splat', m.ax, m.ay - 2 * P, { vx: 0, vy: 0, life: 900 }); }
      }
      if (m && m.name === 'yoyo') {
        const age = t - m.t0;
        const hx = sx + 28 * P, hy = sy + 17 * P;
        const depth = Math.abs(Math.sin(Math.PI * age / 700)) * 16 * P;
        this.pixelLine(hx, hy, hx, hy + depth, ws, silk, ink);
        const b = Math.round(1.5 * P);
        ctx.fillStyle = '#160f1d'; ctx.fillRect(hx - b - 1, hy + depth - 1, 2 * b + 2, 2 * b + 2);
        ctx.fillStyle = '#e3263b'; ctx.fillRect(hx - b, hy + depth, 2 * b, 2 * b);
        ctx.fillStyle = '#ff7a7a'; ctx.fillRect(hx - b, hy + depth, b, b);
      }
      const w = this.webArt;
      if (w) {
        const age = t - w.t0;
        if (age > w.life) { this.webArt = null; return; }
        ctx.globalAlpha = Math.min(1, (w.life - age) / 1500) * 0.95;
        const k = Math.min(1, age / w.build);
        const spokes = 8, rings = 4;
        const thin = Math.max(1, Math.round(ws / 2));
        const sp = Math.min(1, k / 0.4);                       // spokes first, then the spiral
        for (let i = 0; i < spokes; i++) {
          const a = (i / spokes) * Math.PI * 2;
          this.pixelLine(w.cx, w.cy, w.cx + Math.cos(a) * w.R * sp, w.cy + Math.sin(a) * w.R * sp, thin, silk);
        }
        const rk = Math.max(0, (k - 0.4) / 0.6) * rings * spokes;
        for (let j = 0; j < rk; j++) {
          const ring = Math.floor(j / spokes) + 1, i = j % spokes;
          const r = (w.R * ring) / (rings + 0.4);
          const a1 = (i / spokes) * Math.PI * 2, a2 = ((i + 1) / spokes) * Math.PI * 2;
          this.pixelLine(w.cx + Math.cos(a1) * r, w.cy + Math.sin(a1) * r, w.cx + Math.cos(a2) * r, w.cy + Math.sin(a2) * r, thin, silk);
        }
        ctx.globalAlpha = 1;
      }
    }

    // ---------- pose ----------
    pose() {
      const t = now();
      let eyes = 'normal', armL = 'down', armR = 'down', legs = 'stand', headDy = 0, bob = 0;

      switch (this.mode) {
        case 'walk': legs = Math.floor(t / 150) % 2 ? 'walkA' : 'walkB'; bob = Math.floor(t / 150) % 2; break;
        case 'air': legs = 'tuck'; armL = 'swing'; armR = 'swing'; break;
        case 'zip': legs = 'tuck'; armR = 'up'; break;
        case 'hang': case 'descend': armL = 'up'; armR = 'up'; break;
        case 'leave': armR = 'up'; armL = 'wave1'; legs = 'tuck'; eyes = 'happy'; break;
        default:
          if (t < this.landUntil) { legs = 'tuck'; bob = 1; }
          else if (!this.activity) bob = Math.floor(t / 750) % 2;
      }

      // focus session: he works at his holo screen whenever he isn't doing something else
      const act = this.activity || (this.focusMode && this.mode === 'ground' ? 'working' : null);
      switch (act) {
        case 'thinking': eyes = 'focus'; armR = 'chin'; break;
        case 'working': eyes = 'focus'; armL = 'out'; armR = Math.floor(t / 260) % 2 ? 'type1' : 'type2'; break;
        case 'listening': eyes = 'wide'; armL = 'clasp'; armR = 'clasp'; bob = Math.floor(t / 400) % 2; break;
        case 'talking': {
          eyes = this.talkMood || 'normal';
          headDy = Math.floor(t / 170) % 3 === 0 ? 1 : 0;
          const g = Math.floor(t / 1300) % 4;
          armR = g === 1 ? 'shrug' : g === 3 ? 'out' : 'down';
          break;
        }
        case 'sleeping': eyes = 'blink'; headDy = 1; bob = 0; break;
        case 'confirm': eyes = 'wide'; armL = 'shrug'; armR = 'shrug'; break;
      }
      // music is playing and he's free: dance to the beat
      if ((this.dancing || t < (this.danceUntil || 0)) && !this.activity && this.mode === 'ground' && !this.calm) {
        const beat = Math.floor(t / 330) % 4;
        eyes = 'happy';
        armL = beat === 0 ? 'up' : beat === 2 ? 'shrug' : 'down';
        armR = beat === 2 ? 'up' : beat === 0 ? 'shrug' : 'down';
        legs = beat % 2 ? 'walkA' : 'walkB';
        bob = this.beatLevel > 0.25 ? beat % 2 : 0;
      }
      if (this.mode === 'hang' || this.mode === 'descend') { armL = 'up'; armR = 'up'; }

      const r = this.reaction;
      if (r) {
        if (r.eyes) eyes = r.eyes;
        if (r.armL) armL = r.armL;
        if (r.armR) armR = r.armR;
        if (r.headDy) headDy = r.headDy;
        if (r.wave) armR = Math.floor((t - r.start) / 220) % 2 ? 'wave2' : 'wave1';
      }
      // a file is being dragged over him: ready to catch
      if (t - (this.readyAt || 0) < 350 && (this.mode === 'ground' || this.mode === 'walk')) {
        eyes = 'wide'; armL = 'up'; armR = 'up';
        bob = Math.floor(t / 180) % 2;
      }
      if (this.mode === 'move' && this.move) ({ eyes, armL, armR, legs, headDy, bob } = this.movePose(t, { eyes, armL, armR, legs, headDy, bob }));
      if (t < this.blinkUntil && ['normal', 'look', 'wide', 'focus', 'happy'].includes(eyes) && this.activity !== 'sleeping') eyes = 'blink';
      if (this.mode !== 'ground' && this.mode !== 'walk') bob = 0;
      return { eyes, armL, armR, legs, headDy, bob };
    }

    accessory(name) {
      this.accCache = this.accCache || new Map();
      if (!this.accCache.has(name)) {
        const a = SD.composeAccessory(name);
        let entry = null;
        if (a) {
          const c = document.createElement('canvas');
          c.width = a.w; c.height = a.h;
          const x = c.getContext('2d');
          a.grid.forEach((row, y) => row.forEach((ch, i) => { if (ch) { x.fillStyle = SD.PALETTE[ch]; x.fillRect(i, y, 1, 1); } }));
          entry = { canvas: c, x: a.x, y: a.y };
        }
        this.accCache.set(name, entry);
      }
      return this.accCache.get(name);
    }

    frame(p) {
      const pal = this.wear?.palette || {};
      const key = `${this.wear?.id || ''}|${p.eyes}|${p.armL}|${p.armR}|${p.legs}|${p.headDy}`;
      let c = this.frames.get(key);
      if (!c) {
        const f = SD.composeFrame(p);
        c = document.createElement('canvas');
        c.width = f.w; c.height = f.h;
        const x = c.getContext('2d');
        f.grid.forEach((row, y) => row.forEach((ch, i) => { if (ch) { x.fillStyle = pal[ch] || SD.PALETTE[ch]; x.fillRect(i, y, 1, 1); } }));
        this.frames.set(key, c);
        if (this.frames.size > 400) this.frames.delete(this.frames.keys().next().value);
      }
      return c;
    }

    // ---------- outfits (see outfits.js) ----------
    /** Wear an outfit spec (or null for the classic suit). */
    setOutfitSpec(spec) {
      // saved outfits are already normalised (parts are objects); fresh model output isn't
      const L = spec ? window.Outfits.build(spec.id && typeof spec.hat !== 'string' ? spec : window.Outfits.normalize(spec)) : null;
      const toCanvas = (grid) => {
        const c = document.createElement('canvas');
        c.width = grid[0].length; c.height = grid.length;
        const x = c.getContext('2d');
        grid.forEach((row, y) => row.forEach((hex, i) => { if (hex) { x.fillStyle = hex; x.fillRect(i, y, 1, 1); } }));
        return c;
      };
      this.wear = L && {
        id: L.id, name: L.name, palette: L.palette,
        hat: L.hat && { canvas: toCanvas(L.hat.grid), x: L.hat.x, y: L.hat.y },
        item: L.item && { canvas: toCanvas(L.item.grid), grip: L.item.grip },
        emblem: L.emblem && { canvas: toCanvas(L.emblem.grid), x: L.emblem.x, y: L.emblem.y },
      };
      if (this.wear) { this.react('proud', 1600); for (let i = 0; i < 5; i++) setTimeout(() => this.spawn(i % 2 ? 'spark' : 'tiny'), i * 120); }
    }

    /** Draw the outfit layers around a frame drawn at (sx, by). behind=true: the held item only. */
    drawWear(p, sx, by, behind) {
      const w = this.wear, ctx = this.ctx, P = this.P;
      if (!w) return;
      if (behind) {
        if (!w.item) return;
        const [hx, hy] = window.Outfits.handAt(p.armR, SD.ARMS);
        ctx.drawImage(w.item.canvas, sx + Math.round(hx - w.item.grip[0]) * P, by + Math.round(hy - w.item.grip[1]) * P, w.item.canvas.width * P, w.item.canvas.height * P);
        return;
      }
      if (w.emblem) {
        ctx.fillStyle = w.palette.R || SD.PALETTE.R;   // cover the spider emblem first
        ctx.fillRect(sx + 15 * P, by + 17 * P, 3 * P, 3 * P);
        ctx.drawImage(w.emblem.canvas, sx + w.emblem.x * P, by + w.emblem.y * P, w.emblem.canvas.width * P, w.emblem.canvas.height * P);
      }
      if (w.hat) ctx.drawImage(w.hat.canvas, sx + w.hat.x * P, by + (w.hat.y + p.headDy) * P, w.hat.canvas.width * P, w.hat.canvas.height * P);
    }
    fx(kind) {
      let c = this.fxCache.get(kind);
      if (!c) {
        const f = SD.composeParticle(kind);
        c = document.createElement('canvas');
        c.width = f.w; c.height = f.h;
        const x = c.getContext('2d');
        f.grid.forEach((row, y) => row.forEach((ch, i) => { if (ch) { x.fillStyle = SD.PALETTE[ch]; x.fillRect(i, y, 1, 1); } }));
        this.fxCache.set(kind, c);
      }
      return c;
    }

    // ---------- drawing ----------
    pixelLine(x1, y1, x2, y2, size, color, outline) {
      const ctx = this.ctx;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) / size));
      const o = outline ? Math.max(1, Math.round(this.dpr)) : 0;
      ctx.fillStyle = outline || color;
      if (outline) for (let i = 0; i <= steps; i++) {
        const x = Math.round((x1 + (x2 - x1) * i / steps) / size) * size, y = Math.round((y1 + (y2 - y1) * i / steps) / size) * size;
        ctx.fillRect(x - o, y - o, size + 2 * o, size + 2 * o);
      }
      ctx.fillStyle = color;
      for (let i = 0; i <= steps; i++) {
        const x = Math.round((x1 + (x2 - x1) * i / steps) / size) * size, y = Math.round((y1 + (y2 - y1) * i / steps) / size) * size;
        ctx.fillRect(x, y, size, size);
      }
    }

    draw() {
      const t = now();
      const ctx = this.ctx, P = this.P;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      const silk = '#eef2fb', ink = 'rgba(22,15,29,.85)';
      const ws = Math.max(2, Math.round(P / 2));

      let sx = this.snap(this.x), sy = this.snap(this.y);
      let sway = 0;
      if (this.mode === 'hang') sway = Math.round(Math.sin(t / 650) * 1.4) * P;
      sx += sway;

      // web strand while hanging / descending / zipping
      if (this.mode === 'hang' || this.mode === 'descend') {
        this.pixelLine(this.snap(this.x) + 16 * P, this.visTop || 0, sx + 16 * P, sy + 2 * P, ws, silk, ink);
      }
      if (this.mode === 'leave') this.pixelLine(sx + 25 * P, sy + 10 * P, sx + 25 * P, this.visTop || 0, ws, silk, ink);
      if (this.zipWeb) this.pixelLine(this.zipWeb.x1, this.zipWeb.y1, this.zipWeb.x2, this.zipWeb.y2, ws, silk, ink);
      if (this.catches?.length) this.drawCatches(t, ws, silk, ink);
      for (const w of this.webs) {
        const k = Math.min(1, (t - w.t0) / w.grow);
        ctx.globalAlpha = Math.min(1, (w.life - (t - w.t0)) / 400);
        this.pixelLine(w.x1, w.y1, w.x1 + (w.x2 - w.x1) * k, w.y1 + (w.y2 - w.y1) * k, ws, silk, ink);
        ctx.globalAlpha = 1;
      }

      this.drawMoveExtras(t, sx, sy, ws, silk, ink);

      // working: holo screen to his left
      if ((this.activity === 'working' || (!this.activity && this.focusMode)) && this.mode === 'ground') this.drawHolo(sx, sy, t);

      // body
      const p = this.pose();
      const img = this.frame(p);
      const by = sy + p.bob * P;
      if (this.flip) {
        ctx.save();
        ctx.translate(0, by + this.h);
        ctx.scale(1, -1);
        ctx.drawImage(img, sx, 0, this.w, this.h);
        ctx.restore();
      } else if (this.move?.angle) {
        // backflip: spin around his middle
        ctx.save();
        ctx.translate(sx + this.w / 2, by + this.h / 2);
        ctx.rotate(this.move.angle);
        ctx.drawImage(img, -this.w / 2, -this.h / 2, this.w, this.h);
        ctx.restore();
      } else {
        this.drawWear(p, sx, by, true);
        ctx.drawImage(img, sx, by, this.w, this.h);
        this.drawWear(p, sx, by, false);
        // automatic outfits (headphones, nightcap, santa, party) unless he's wearing his own hat
        const acc = this.outfit && !this.wear?.hat && this.accessory(this.outfit);
        if (acc) ctx.drawImage(acc.canvas, sx + acc.x * P, by + (acc.y + p.headDy) * P, acc.canvas.width * P, acc.canvas.height * P);
      }

      // thinking dots
      if (this.activity === 'thinking') {
        const n = Math.floor(t / 280) % 4;
        for (let i = 0; i < 3; i++) {
          const dx = sx + 22 * P + i * 3 * P, dy = by - (i * 2 + 1) * P;
          ctx.fillStyle = i < n ? '#ffffff' : 'rgba(255,255,255,.25)';
          ctx.fillRect(dx - Math.round(this.dpr), dy - Math.round(this.dpr), 2 * P + 2 * Math.round(this.dpr), 2 * P + 2 * Math.round(this.dpr));
          ctx.fillStyle = i < n ? '#160f1d' : 'rgba(22,15,29,.35)';
          ctx.fillRect(dx, dy, 2 * P, 2 * P);
          ctx.fillStyle = i < n ? '#ffffff' : 'rgba(255,255,255,.5)';
          ctx.fillRect(dx + Math.round(P / 2), dy + Math.round(P / 2), P, P);
        }
      }

      // particles
      for (const q of this.particles) {
        const age = t - q.t0;
        const c = this.fx(q.kind);
        const fade = Math.min(1, (q.life - age) / (q.life * 0.35));
        const pop = q.kind === 'spark' || q.kind === 'tiny' ? Math.min(1, age / 120) : 1;
        const ps = Math.max(2, Math.round(P * (q.kind === 'tiny' ? 0.75 : 0.85) * pop));
        ctx.globalAlpha = Math.max(0, fade);
        ctx.drawImage(c, Math.round(q.x / ps) * ps - (c.width * ps) / 2, Math.round(q.y / ps) * ps, c.width * ps, c.height * ps);
      }
      ctx.globalAlpha = 1;
    }

    drawHolo(sx, sy, t) {
      const ctx = this.ctx, P = this.P;
      const x = sx - 12 * P, y = sy + 6 * P, w = 15 * P, h = 10 * P;
      const flick = 0.85 + Math.sin(t / 90) * 0.05;
      ctx.save();
      ctx.globalAlpha = flick;
      ctx.shadowColor = 'rgba(95,242,255,.8)';
      ctx.shadowBlur = 10 * this.dpr;
      ctx.fillStyle = 'rgba(31,143,176,.30)';
      ctx.fillRect(x, y, w, h);
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#5ff2ff';
      ctx.fillRect(x, y, w, Math.round(P / 2));
      ctx.fillRect(x, y + h - Math.round(P / 2), w, Math.round(P / 2));
      ctx.fillRect(x, y, Math.round(P / 2), h);
      ctx.fillRect(x + w - Math.round(P / 2), y, Math.round(P / 2), h);
      // scrolling "code" lines
      const rows = 5, seed = Math.floor(t / 160);
      for (let i = 0; i < rows; i++) {
        const len = 3 + ((seed + i * 7) * 9301 + 49297) % 233280 % 9;
        ctx.fillStyle = i === rows - 1 ? '#ffffff' : 'rgba(95,242,255,.85)';
        ctx.fillRect(x + 2 * P, y + 2 * P + i * Math.round(1.5 * P), len * P, Math.max(1, Math.round(P * 0.6)));
      }
      if (Math.floor(t / 400) % 2) { ctx.fillStyle = '#ffffff'; ctx.fillRect(x + w - 3 * P, y + h - 3 * P, P, P); }
      ctx.restore();
    }

    /** Web-catch timeline: shoot (0-180 ms), stick (180-320), reel the file in (320-900), then celebrate. */
    drawCatches(t, ws, silk, ink) {
      const ctx = this.ctx, P = this.P;
      const SHOOT = 180, STICK = 320, REEL = 900;
      const icon = this.fx('file');
      const ps = Math.max(2, Math.round(P * 0.8));
      for (const c of this.catches) {
        const age = t - c.t0;
        const h = c.hand();
        let tipX, tipY, carrying = false;
        if (age < SHOOT) {
          const k = age / SHOOT;
          tipX = h.x + (c.tx - h.x) * k; tipY = h.y + (c.ty - h.y) * k;
        } else if (age < STICK) {
          tipX = c.tx; tipY = c.ty; carrying = true;
          if (!c.splat) { c.splat = true; this.spawn('splat', c.tx, c.ty - 3 * P, { vx: 0, vy: 0, life: 420 }); }
        } else {
          const k = Math.min(1, (age - STICK) / (REEL - STICK));
          const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;   // ease in-out
          tipX = c.tx + (h.x - c.tx) * e; tipY = c.ty + (h.y - c.ty) * e - Math.sin(k * Math.PI) * 18 * this.dpr;
          carrying = true;
        }
        this.pixelLine(h.x, h.y, tipX, tipY, ws, silk, ink);
        if (carrying) {
          for (let i = c.count - 1; i >= 0; i--) {   // a little stack when several files were dropped
            const ox = i * 3 * ps, oy = -i * 3 * ps;
            ctx.drawImage(icon, Math.round((tipX - (icon.width * ps) / 2 + ox) / ps) * ps, Math.round((tipY - (icon.height * ps) / 2 + oy) / ps) * ps, icon.width * ps, icon.height * ps);
          }
        }
        if (age >= REEL && !c.done) {
          c.done = true;
          this.react('excited', 1600);
          for (let i = 0; i < 4; i++) setTimeout(() => this.spawn('tiny', h.x + (Math.random() - 0.5) * 10 * P, h.y - 4 * P), i * 70);
        }
      }
      this.catches = this.catches.filter((c) => !c.done);
    }

    /** Snapshot of Spidey in his current outfit as a PNG data URL (for the wardrobe panel). */
    portrait(scale = 8) {
      const pad = 10;
      const c = document.createElement('canvas');
      c.width = (SD.W + pad * 2) * scale; c.height = (SD.H + pad * 2) * scale;
      const saved = { ctx: this.ctx, P: this.P };
      this.ctx = c.getContext('2d');
      this.ctx.imageSmoothingEnabled = false;
      this.P = scale;
      const p = { eyes: 'happy', armL: 'down', armR: 'down', legs: 'stand', headDy: 0, bob: 0 };
      const ox = pad * scale, oy = pad * scale;
      this.drawWear(p, ox, oy, true);
      this.ctx.drawImage(this.frame(p), ox, oy, SD.W * scale, SD.H * scale);
      this.drawWear(p, ox, oy, false);
      const url = c.toDataURL('image/png');
      Object.assign(this, saved);
      return url;
    }

    tick() {
      this.update();
      const t = now();
      if (t - this.lastDraw >= 30) { this.draw(); this.lastDraw = t; }
    }
  }

  window.Spidey = Spidey;
})();
