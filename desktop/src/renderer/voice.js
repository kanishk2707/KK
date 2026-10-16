// Ears: one shared mic pipeline with voice-activity detection, used two ways:
//   listen()    -> capture one command (push-to-talk, follow-up)
//   startWake() -> always-on: every utterance is handed over to be checked for "Hey Kanishk"
// Mouth: text-to-speech with a Windows SAPI fallback.
(function () {
  const RATE = 16000;
  const CHUNK = 2048;                 // 128 ms
  const CHUNK_SEC = CHUNK / RATE;

  function encodeWav(chunks) {
    const n = chunks.reduce((s, c) => s + c.length, 0);
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    let o = 44;
    for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, c[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  }

  /** Splits a stream of chunks into utterances using an adaptive noise floor. */
  class Segmenter {
    /** overlap: seconds carried into the next segment when one is cut at maxLen (so a phrase is never split). */
    constructor({ endSilence = 1.1, maxLen = 30, preroll = 10, overlap = 0 } = {}) {
      Object.assign(this, { endSilence, maxLen, prerollN: preroll, overlapN: Math.round(overlap / CHUNK_SEC) });
      this.floor = 0.004;
      this.reset();
    }
    reset() { this.speaking = false; this.chunks = []; this.pre = []; this.hits = []; this.quiet = 0; this.len = 0; this.peak = 0; this.carry = null; }
    /** Background level = 20th percentile of the last ~8 s, so it holds steady whether or not someone talks. */
    track(rms) {
      this.hist = this.hist || [];
      this.hist.push(rms);
      if (this.hist.length > 64) this.hist.shift();
      if (this.hist.length >= 8) {
        const sorted = this.hist.slice().sort((a, b) => a - b);
        this.floor = sorted[Math.floor(sorted.length * 0.2)];
      }
    }
    /** Returns 'start', 'end' (with this.take() ready) or null. */
    push(data, rms) {
      this.track(rms);
      if (!this.speaking) {
        const start = Math.max(0.008, this.floor * 2.5);
        this.pre.push(data);
        if (this.pre.length > Math.max(this.prerollN, this.preMax || 0)) this.pre.shift();
        this.hits.push(rms > start);
        if (this.hits.length > 3) this.hits.shift();
        if (this.hits.filter(Boolean).length >= 2) {
          this.speaking = true;
          this.chunks = this.pre.slice();
          this.pre = [];
          this.preMax = 0;
          this.len = this.chunks.length * CHUNK_SEC;
          return 'start';
        }
        return null;
      }
      this.chunks.push(data);
      this.len += CHUNK_SEC;
      this.peak = Math.max(this.peak, rms);
      // "quiet" is relative to how loud this speaker is, so steady room noise can't hold the phrase open
      const stop = Math.max(0.006, this.floor * 1.8, this.peak * 0.22);
      this.quiet = rms < stop ? this.quiet + CHUNK_SEC : 0;
      if (this.quiet >= this.endSilence) return 'end';
      if (this.len >= this.maxLen) {
        if (this.overlapN) this.carry = this.chunks.slice(-this.overlapN);
        return 'end';
      }
      return null;
    }
    take() {
      const c = this.chunks, carry = this.carry;
      this.reset();
      if (carry) { this.pre = carry; this.preMax = carry.length; }
      return c;
    }
  }

  class Ears {
    constructor() {
      this.active = false;     // capturing a command
      this.wakeOn = false;
      this.paused = false;     // e.g. while Spidey is speaking
      this.ready = null;
    }

    async open() {
      if (this.ready) return this.ready;
      this.ready = (async () => {
        this.stream = await navigator.mediaDevices.getUserMedia({
          // raw audio: whisper copes with noise far better than Chromium's suppressor (which garbles words);
          // echo cancellation isn't needed because listening pauses while Spidey talks
          audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
        });
        this.ctx = new AudioContext({ sampleRate: RATE });
        await this.ctx.resume();
        this.src = this.ctx.createMediaStreamSource(this.stream);
        // voice detection listens through a speech-band filter (cuts fan rumble and hiss);
        // the raw signal is what gets recorded and transcribed
        const hp = this.ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 300;
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 3400;
        this.band = this.ctx.createAnalyser();
        this.band.fftSize = CHUNK;
        this.bandBuf = new Float32Array(CHUNK);
        this.src.connect(hp); hp.connect(lp); lp.connect(this.band);
        this.proc = this.ctx.createScriptProcessor(CHUNK, 1, 1);
        this.proc.onaudioprocess = (e) => this.onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
        this.src.connect(this.proc);
        this.proc.connect(this.ctx.destination);
        this.stream.getAudioTracks()[0].onended = () => this.close();
      })();
      try { await this.ready; } catch (e) { this.ready = null; throw e; }
      return this.ready;
    }

    close() {
      try { this.proc?.disconnect(); this.src?.disconnect(); } catch {}
      this.stream?.getTracks().forEach((t) => t.stop());
      this.ctx?.close().catch(() => {});
      this.ready = null;
    }

    onChunk(data) {
      let sum = 0;
      let level = data;
      if (this.band) { this.band.getFloatTimeDomainData(this.bandBuf); level = this.bandBuf; }
      for (let i = 0; i < level.length; i++) sum += level[i] * level[i];
      const rms = Math.sqrt(sum / level.length);
      // rolling ~4 s of audio, so a command spoken right after "Hey Spidey" isn't lost while we transcribe
      this.count = (this.count || 0) + 1;
      this.recent = this.recent || [];
      this.recent.push({ i: this.count, data, rms });
      if (this.recent.length > 32) this.recent.shift();
      if (this.cmd) return this.cmd(data, rms);
      if (this.wakeOn && !this.paused) this.wakeChunk(data, rms);
    }

    /**
     * Capture one command. Resolves { wav } when the speaker pauses, { wav: null } if nobody spoke,
     * or { silentDevice: true } if the mic delivers pure zeros (muted at the OS level).
     */
    async listen({ onLevel, startTimeout = 8, endSilence = 1.2, fromChunk = null } = {}) {
      if (this.active) return { wav: null };
      await this.open();
      this.active = true;
      const seg = new Segmenter({ endSilence, maxLen: 30 });
      if (this.wakeSeg?.hist) { seg.hist = this.wakeSeg.hist.slice(); seg.floor = this.wakeSeg.floor; }
      let waited = 0, peak = 0;
      return new Promise((resolve) => {
        const finish = (result) => {
          if (!this.active) return;
          this.active = false;
          this.cmd = null;
          this.stopNow = null;
          if (!this.wakeOn) this.close();
          resolve(result);
        };
        this.stopNow = (keep = true) => finish({ wav: keep && seg.speaking && seg.chunks.length > 3 ? encodeWav(seg.take()) : null });
        this.cmd = (data, rms) => {
          peak = Math.max(peak, rms);
          onLevel?.(Math.min(1, rms * 12));
          const ev = seg.push(data, rms);
          if (!seg.speaking) {
            waited += CHUNK_SEC;
            if (waited > 1.2 && peak === 0) return finish({ wav: null, silentDevice: true });
            if (waited > startTimeout) return finish({ wav: null });
            return;
          }
          if (ev === 'end') finish({ wav: encodeWav(seg.take()) });
        };
        // replay what was said since the wake phrase ended
        if (fromChunk !== null) for (const c of (this.recent || []).filter((r) => r.i > fromChunk)) this.cmd(c.data, c.rms);
      });
    }

    stop(keep = true) { this.stopNow?.(keep); }

    /** Always-on listening. onUtterance(wav) gets every finished phrase (0.4 s - 10 s). */
    async startWake(onUtterance) {
      this.wakeOn = true;
      this.onUtterance = onUtterance;
      this.wakeSeg = new Segmenter({ endSilence: 0.8, maxLen: 6, overlap: 2 });
      await this.open();
    }
    wakeChunk(data, rms) {
      const seg = this.wakeSeg;
      const ev = seg.push(data, rms);
      if (ev === 'end') {
        const loud = seg.peak > Math.max(0.015, seg.floor * 4);   // skip murmurs: not worth a transcription
        const chunks = seg.take();
        if (loud && chunks.length * CHUNK_SEC >= 0.5) this.onUtterance?.(encodeWav(chunks), this.count);
      }
    }
    stopWake() {
      this.wakeOn = false;
      this.wakeSeg?.reset();
      if (!this.active) this.close();
    }
    pause(on) {
      this.paused = on;
      if (on) this.wakeSeg?.reset();
    }
  }

  // ---------- mouth ----------
  const PREFERRED = [/guy/i, /ryan/i, /christopher/i, /eric/i, /mark/i, /david/i, /james/i, /george/i];

  class Mouth {
    constructor() {
      this.voices = [];
      this.speaking = false;
      const load = () => { this.voices = speechSynthesis.getVoices(); };
      load();
      speechSynthesis.onvoiceschanged = load;
    }
    pick(name) {
      const en = this.voices.filter((v) => /^en/i.test(v.lang));
      if (name) {
        const hit = this.voices.find((v) => v.name.toLowerCase().includes(name.toLowerCase()));
        if (hit) return hit;
      }
      for (const re of PREFERRED) {
        const hit = en.find((v) => re.test(v.name));
        if (hit) return hit;
      }
      return en[0] || this.voices[0] || null;
    }
    static clean(text) {
      return String(text)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/https?:\/\/\S+/g, 'a link')
        .replace(/[*_`#>~|]/g, '')
        .replace(/\p{Extended_Pictographic}/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    /** Resolves when speech ends. Falls back to Windows SAPI via the main process. */
    speak(text, opts = {}) {
      const clean = Mouth.clean(text);
      if (!clean) return Promise.resolve();
      this.cancel();
      this.onStart?.();
      const done = () => { this.speaking = false; this.onEnd?.(); };
      const voice = this.pick(opts.voiceName);
      if (!voice) {
        return new Promise((resolve) => {
          this.speaking = true;
          let finished = false;
          const end = () => { if (finished) return; finished = true; off(); done(); resolve(); };
          const off = window.spidey.onTtsDone(end);
          window.spidey.ttsFallback(clean);
          setTimeout(end, 4000 + clean.length * 90);
        });
      }
      return new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(clean);
        u.voice = voice;
        u.rate = opts.rate ?? 1.08;
        u.pitch = opts.pitch ?? 1.15;
        u.volume = opts.volume ?? 1;
        this.speaking = true;
        let finished = false;
        const end = () => { if (finished) return; finished = true; done(); resolve(); };
        u.onend = end;
        u.onerror = end;
        speechSynthesis.speak(u);
        setTimeout(end, 6000 + clean.length * 120);   // never hang if the engine drops the event
      });
    }
    cancel() {
      if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
      if (this.speaking) { this.speaking = false; this.onEnd?.(); }
    }
  }

  window.Ears = Ears;
  window.Mouth = Mouth;
})();
