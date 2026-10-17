// The link to Kanishk's chip over USB. Watches for it being plugged in or out, checks it really is
// Kanishk's chip (it answers "hello" with its name), and passes commands to it in order.
// Events: 'connected' ({ port, name, fw, model }), 'disconnected'.
const { spawn } = require('child_process');
const EventEmitter = require('events');
const path = require('path');

const PS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'];

class Chip extends EventEmitter {
  constructor(log = () => {}) {
    super();
    this.log = log;
    this.watcher = null;
    this.bridge = null;
    this.port = null;
    this.info = null;
    this.rx = '';
    this.queue = [];          // waiting for replies; each is matched by the id the chip echoes back
    this.nextId = 1;
    this.chain = Promise.resolve();
    this.notKanishk = new Set();   // ports with some other board on them (skip until replugged)
    this.ports = [];
  }

  connected() { return !!this.info; }

  start() {
    if (this.watcher) return;
    this.watcher = spawn('powershell.exe', [...PS, path.join(__dirname, 'chip-watch.ps1')], { windowsHide: true });
    let buf = '';
    this.watcher.stdout.setEncoding('utf8');
    this.watcher.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line.startsWith('PORTS')) this.onPorts(line.slice(5).trim().split(',').filter(Boolean));
      }
    });
    this.watcher.on('exit', () => { this.watcher = null; if (!this.stopped) setTimeout(() => this.start(), 2000); });   // keep watching
  }

  stop() {
    this.stopped = true;
    try { this.watcher?.kill(); } catch {}
    this.closeBridge();
  }

  onPorts(ports) {
    this.ports = ports;
    for (const p of [...this.notKanishk]) if (!ports.includes(p)) this.notKanishk.delete(p);   // replugged: try again later
    if (this.port && !ports.includes(this.port)) { this.log('chip', `${this.port} unplugged`); this.closeBridge(); }
    if (!this.bridge) {
      const next = ports.find((p) => !this.notKanishk.has(p));
      if (next) this.openBridge(next);
    }
  }

  openBridge(port) {
    this.port = port;
    this.rx = '';
    this.log('chip', `trying ${port}`);
    const b = spawn('powershell.exe', [...PS, path.join(__dirname, 'serial-bridge.ps1'), port], { windowsHide: true });
    this.bridge = b;
    b.stdout.setEncoding('utf8');
    b.stdout.on('data', (d) => {
      this.rx += d;
      let i;
      while ((i = this.rx.indexOf('\n')) >= 0) {
        const line = this.rx.slice(0, i).replace(/\r$/, ''); this.rx = this.rx.slice(i + 1);
        this.onLine(line);
      }
    });
    b.stderr.on('data', (d) => { const s = String(d).trim(); if (s) this.log('chip', s); });
    // the link dropped: if the chip is still plugged in (a hiccup, not an unplug), connect again
    b.on('exit', () => { if (this.bridge === b) { this.closeBridge(); setTimeout(() => this.onPorts(this.ports), 1500); } });
    this.handshake(b, 0);
  }

  // say hello until the chip answers (it may be rebooting because opening the port resets it)
  async handshake(b, tries) {
    if (this.bridge !== b || this.info) return;
    try {
      const r = await this.send({ cmd: 'hello', now: Math.floor(Date.now() / 1000), tz: -new Date().getTimezoneOffset() }, 2500);
      if (this.bridge !== b) return;
      if (r && r.name === 'Kanishk') {
        this.info = { port: this.port, name: r.name, fw: r.fw, model: r.model };
        this.log('chip', `Kanishk's chip on ${this.port} (fw ${r.fw})`);
        this.keys = await this.readKeys().catch(() => []);
        if (this.bridge !== b) return;
        this.emit('connected', this.info);
        return;
      }
      // some other device answered something else
      if (r) { this.log('chip', `${this.port} is not Kanishk's chip`); this.notKanishk.add(this.port); this.closeBridge(); this.onPorts(this.ports); return; }
    } catch {}
    if (tries < 8) setTimeout(() => this.handshake(b, tries + 1), 600);
    else { this.log('chip', `${this.port} never answered`); this.notKanishk.add(this.port); this.closeBridge(); this.onPorts(this.ports); }
  }

  // His chip carries his Groq keys, so a computer that has never met him gets his cloud brain too.
  async readKeys() {
    const r = await this.send({ cmd: 'keys' }, 2500);
    const keys = r && Array.isArray(r.keys) ? r.keys : [];
    this.log('chip', `his chip carries ${keys.length} Groq key(s)`);
    return keys;
  }

  closeBridge() {
    const was = !!this.info;
    const b = this.bridge;
    this.bridge = null;
    this.info = null;
    this.port = null;
    if (b) { try { b.stdin.end(); } catch {} setTimeout(() => { try { b.kill(); } catch {} }, 400); }
    while (this.queue.length) this.queue.shift().reject(new Error('chip disconnected'));
    if (was) this.emit('disconnected');
  }

  onLine(line) {
    if (!line.startsWith('@K')) return;           // boot logs, "@bridge open"
    if (line === '@Kready') { if (!this.info && this.bridge) this.handshake(this.bridge, 0); return; }
    let msg;
    try { msg = JSON.parse(line.slice(2)); } catch { return; }
    // match by id, so a late answer to a request that already timed out (say, an extra "hello"
    // while the chip was rebooting) can't be mistaken for the answer to the next one
    const k = msg.id != null ? this.queue.findIndex((q) => q.id === msg.id) : 0;
    if (k < 0) return;
    const [w] = this.queue.splice(k, 1);
    if (w) w.resolve(msg);
  }

  /** Send one command; resolves with the chip's reply. Commands go one at a time. */
  send(cmd, timeoutMs = 15000) {
    const run = () => new Promise((resolve, reject) => {
      const b = this.bridge;
      if (!b) return reject(new Error('no chip'));
      const w = { id: this.nextId++ };
      const t = setTimeout(() => { const k = this.queue.indexOf(w); if (k >= 0) this.queue.splice(k, 1); reject(new Error('chip timeout')); }, timeoutMs);
      w.resolve = (v) => { clearTimeout(t); resolve(v); };
      w.reject = (e) => { clearTimeout(t); reject(e); };
      this.queue.push(w);
      try { b.stdin.write(JSON.stringify({ ...cmd, id: w.id }) + '\n'); } catch (e) { w.reject(e); }
    });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  /** Offline brain: { mood, say, show?, title?, tool?, args?, showResult?, story? } */
  think(text, name = 'Varuna') {
    return this.send({ cmd: 'think', text, name, now: Math.floor(Date.now() / 1000), tz: -new Date().getTimezoneOffset() });
  }

  /** Bedtime story from the on-chip model; onPiece gets new text as it is written. Resolves with the whole story. */
  async story(about, onPiece) {
    let shown = 0;
    const NAMES = [[/\b(Lily|Sue|Sara|Sarah|Mia|Amy|Anna|Lucy|Jane|Kitty|Emma)\b/g, 'Varuna'], [/\b(Tim|Ben|Tom|Max|Jack|Sam|Timmy|Bob|Joe|John|Spot)\b/g, 'Kanishk']];
    const pretty = (t) => NAMES.reduce((s, [re, n]) => s.replace(re, n), t);
    let s = await this.send({ cmd: 'story', start: true, about: about || '' });
    for (let i = 0; i < 400 && !s.done; i++) {
      await new Promise((r) => setTimeout(r, 400));
      s = await this.send({ cmd: 'story' });
      const text = pretty(s.text || '');
      // only send whole words, so renamed names never flicker
      const safe = s.done ? text.length : Math.max(shown, text.lastIndexOf(' '));
      if (safe > shown) { onPiece?.(text.slice(shown, safe)); shown = safe; }
    }
    let text = pretty(s.text || '');
    const cut = text.search(/[.!?"](?=[^.!?"]*$)/);          // end on the last full sentence
    if (cut > 40) text = text.slice(0, cut + 1);
    if (text.length > shown) onPiece?.(text.slice(shown));
    return text;
  }
}

module.exports = { Chip };
