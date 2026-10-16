// Wires Kanishk's body, voice and UI to his brain in the main process.
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.spidey;
  const MOODS = 'happy|excited|proud|thinking|cool|love|surprised|sad|oops|sleepy';

  const canvas = $('stage');
  const body = new window.Spidey(canvas);
  window.spideyBody = body;   // handy from DevTools: spideyBody.react('love'), spideyBody.zipUp()
  const ears = new window.Ears();
  window.spideyEars = ears;   // DevTools: spideyEars.wakeOn, spideyEars.paused
  const mouth = new window.Mouth();

  let cfg = { voice: { enabled: true }, scale: 4 };
  let booted = false;
  let busy = false;
  let streamText = '';
  let lastWrite = null;           // content of the last write_file, shown if the reply has no output block
  let turnFiles = [];             // files saved during the current request
  let panelFromStream = false;    // the panel was opened by the reply being streamed right now
  let voiceTurn = false;          // current request came from the mic (enables follow-up listening)
  let micFixTried = false;
  // the part of the window that's on screen (main process keeps Spidey's corner on screen)
  let visible = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  let currentOutput = null;       // { title, content, file? }
  const outputs = [];
  const chat = [];

  // ---------- pixel icons ----------
  const ICONS = {
    mic:   ['..XX..', '.XXXX.', '.XXXX.', '.XXXX.', 'X.XX.X', 'X....X', '.XXXX.', '..XX..', '.XXXX.'],
    send:  ['X.....', 'XXX...', 'XXXXX.', 'XXXXXX', 'XXXXX.', 'XXX...', 'X.....'],
    stop:  ['XXXXXX', 'XXXXXX', 'XXXXXX', 'XXXXXX', 'XXXXXX', 'XXXXXX'],
    copy:  ['XXXX..', 'X..X..', 'X.XXXX', 'X.X..X', 'XXX..X', '..X..X', '..XXXX'],
    save:  ['XXXXX.', 'X.X.XX', 'X.X..X', 'X....X', 'X.XX.X', 'X.XX.X', 'XXXXXX'],
    close: ['X....X', '.X..X.', '..XX..', '..XX..', '.X..X.', 'X....X'],
    clip:  ['..XXX.', '.X...X', '.X.X.X', '.X.X.X', '.X.X.X', '.X.X.X', '.X...X', '..XXX.'],
  };
  function icon(name) {
    const rows = ICONS[name];
    const w = rows[0].length, h = rows.length;
    let rects = '';
    rows.forEach((r, y) => [...r].forEach((c, x) => { if (c === 'X') rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`; }));
    return `<svg viewBox="-1 -1 ${w + 2} ${h + 2}" fill="currentColor" aria-hidden="true">${rects}</svg>`;
  }
  document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
  // panel logo = tiny Spidey head
  (function paintLogo() {
    const head = window.SpriteData.composeHead('normal');
    const c = document.createElement('canvas');
    c.width = head.w; c.height = head.h;
    const x = c.getContext('2d');
    head.grid.forEach((row, y) => row.forEach((ch, i) => { if (ch) { x.fillStyle = window.SpriteData.PALETTE[ch]; x.fillRect(i, y, 1, 1); } }));
    const logo = document.querySelector('.panel-logo');
    logo.style.background = `url(${c.toDataURL()}) center/contain no-repeat`;
    logo.style.boxShadow = 'none';
  })();

  // ---------- reply parsing ----------
  function parseReply(text) {
    let t = String(text || '');
    let mood = null;
    const m = t.match(new RegExp(`^\\s*\\[(${MOODS})\\]\\s*`, 'i'));
    if (m) { mood = m[1].toLowerCase(); t = t.slice(m[0].length); }
    else {
      const odd = t.match(/^\s*\[[a-z ]{2,14}\]\s*/i);   // a made-up mood like "[milk]": hide it, act happy
      if (odd) { mood = 'happy'; t = t.slice(odd[0].length); }
    }
    t = t.replace(/^\s*\[[a-z]{0,10}$/i, '');                       // half-streamed tag
    t = t.replace(new RegExp(`\\[(${MOODS})\\]`, 'gi'), '');
    let output = null;
    const o = t.match(/<output(?:\s+title\s*=\s*["“]([^"”]*)["”])?\s*>([\s\S]*?)(<\/output>|$)/i);
    let speech = t;
    if (o) {
      output = { title: (o[1] || 'Output').trim(), content: o[2].replace(/^\n+/, ''), open: !o[3] };
      speech = `${t.slice(0, o.index)} ${t.slice(o.index + o[0].length)}`.replace(/\s+/g, ' ');
    }
    speech = speech.replace(/<\/?output[^>]*>?/gi, '').replace(/<[a-z]*$/i, '').replace(/\[[a-z ]{2,14}\]/gi, ' ').trim();
    // after a tool call the model sometimes says the same line twice: keep each sentence once
    const seen = new Set();
    speech = speech.split(/(?<=[.!?])\s+/).filter((x) => {
      const k = x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    }).join(' ');
    return { mood, speech, output };
  }

  function splitLong(speech) {
    const longish = speech.length > 280 || /```|\n\s*([-*•]|\d+[.)])\s|\n#{1,4}\s|\|.*\|/.test(speech) || speech.split('\n').length > 4;
    if (!longish) return { speech, output: null };
    const first = speech.split(/(?<=[.!?])\s+|\n/)[0].slice(0, 160);
    return { speech: first.length > 8 ? first : 'Here you go!', output: { title: 'Kanishk says', content: speech } };
  }

  // ---------- markdown ----------
  window.marked.setOptions({ gfm: true, breaks: false });
  // math ($x^2$, $$\frac{a}{b}$$, \( \), \[ \]) is pulled out before markdown and typeset with KaTeX afterwards;
  // code is left alone, and "$5 and $10" stays money because inline math can't start or end with a space
  const MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g;
  function renderMarkdown(el, md) {
    const maths = [];
    const src = String(md || '').split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/).map((part, i) => (i % 2 ? part : part.replace(MATH, (m, d1, d2, i1, i2) => {
      maths.push({ tex: d1 ?? d2 ?? i1 ?? i2, display: d1 != null || d2 != null });
      return `@@MATH${maths.length - 1}@@`;
    }))).join('');
    let html = window.DOMPurify.sanitize(window.marked.parse(src), { ADD_ATTR: ['target'] });
    if (maths.length && window.katex) {
      html = html.replace(/@@MATH(\d+)@@/g, (m, n) => {
        const x = maths[Number(n)];
        try { return window.katex.renderToString(x.tex, { displayMode: x.display, throwOnError: false, trust: false }); } catch { return m; }
      });
    }
    el.innerHTML = html;
    el.querySelectorAll('pre').forEach((pre) => {
      const b = document.createElement('button');
      b.className = 'copy-code';
      b.textContent = 'copy';
      b.onclick = () => { navigator.clipboard.writeText(pre.innerText.replace(/copy$/, '').trim()); b.textContent = 'copied!'; setTimeout(() => (b.textContent = 'copy'), 1200); };
      pre.appendChild(b);
    });
  }

  // ---------- panel ----------
  const panel = $('panel');
  let renderTimer = null;
  function showPanel(out, { live = false } = {}) {
    currentOutput = out;
    $('panel-title').textContent = out.title || 'Output';
    selectTab('output');
    if (panel.hidden) { panel.hidden = false; panel.classList.remove('leaving'); }
    body.noHang = true;
    if (!renderTimer) {
      renderTimer = setTimeout(() => {
        renderTimer = null;
        const el = $('panel-output');
        const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        renderMarkdown(el, currentOutput.content);
        if (live && stick) el.scrollTop = el.scrollHeight;
      }, live ? 90 : 0);
    }
    const plain = out.content.replace(/\(data:[^)]+\)/g, '');
    const words = (plain.match(/\S+/g) || []).length;
    const foot = $('panel-foot');
    foot.innerHTML = live ? '<span class="live">writing…</span>' : `<span>${words} words</span><span>·</span><span>${plain.length} chars</span>`;
    if (!live && out.file) {
      const name = document.createElement('span');
      name.className = 'file';
      name.textContent = `saved: ${out.file}`;
      name.title = out.file;
      foot.append(name, fileButton('Open', () => api.openFile(out.file)), fileButton('Show in folder', () => api.revealFile(out.file)));
    }
  }
  function fileButton(label, onClick) {
    const b = document.createElement('button');
    b.className = 'foot-btn';
    b.textContent = label;
    b.onclick = onClick;
    return b;
  }
  function hidePanel() {
    if (panel.hidden) return;
    panel.classList.add('leaving');
    setTimeout(() => { panel.hidden = true; panel.classList.remove('leaving'); body.noHang = false; }, 160);
  }
  function selectTab(tab) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    $('panel-output').hidden = tab !== 'output';
    $('panel-chat').hidden = tab !== 'chat';
    if (tab === 'chat') renderChat();
  }
  document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => selectTab(t.dataset.tab)));
  $('btn-close').onclick = hidePanel;
  $('btn-copy').onclick = () => {
    if (!currentOutput) return;
    navigator.clipboard.writeText(currentOutput.content);
    say('Copied to your clipboard!', { mood: 'happy', speak: false, ms: 1800 });
  };
  $('btn-save').onclick = async () => {
    if (!currentOutput) return;
    const p = await api.saveOutput(currentOutput.title, currentOutput.content);
    if (p) say(`Saved it to ${p.split(/[\\/]/).pop()}!`, { mood: 'proud', speak: false, ms: 2500 });
  };
  $('panel-output').addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (a) { e.preventDefault(); api.openExternal(a.href); }
  });

  function renderChat() {
    const el = $('panel-chat');
    if (!chat.length) { el.innerHTML = '<div class="empty">No messages yet. Say hi!</div>'; return; }
    el.innerHTML = '';
    for (const m of chat) {
      const d = document.createElement('div');
      d.className = `msg ${m.who}`;
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = m.who === 'you' ? (cfg.userName || 'You') : 'Kanishk';
      d.append(who, document.createTextNode(m.text));
      if (m.output) {
        const o = document.createElement('span');
        o.className = 'open-out';
        o.textContent = `▸ ${m.output.title}`;
        o.onclick = () => showPanel(m.output);
        d.append(document.createElement('br'), o);
      }
      el.appendChild(d);
    }
    el.scrollTop = el.scrollHeight;
  }

  // ---------- bubble ----------
  const bubble = $('bubble');
  let bubbleTimer = null;
  let typeTimer = null;
  let bubbleSticky = false;

  function placeBubble() {
    if (bubble.hidden) return;
    const a = body.anchor();
    const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    const v = visible;
    let left = Math.round(a.x - bw + 34);
    left = Math.max(v.left + 10, Math.min(v.right - bw - 10, left));
    let top = Math.round(a.y - bh - 20);
    if (top < v.top + 8) top = v.top + 8;
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
    const tail = Math.max(10, Math.min(bw - 24, a.x - left - 14));
    bubble.style.setProperty('--tail-x', `${tail}px`);
  }

  function hideBubble() {
    clearTimeout(bubbleTimer); clearInterval(typeTimer);
    if (bubble.hidden || bubbleSticky) return;
    bubble.classList.add('leaving');
    setTimeout(() => { bubble.hidden = true; bubble.classList.remove('leaving'); if (body.activity === 'talking') body.setActivity(null); body.clearMood(); }, 150);
  }

  /** Show text in the bubble with a typewriter effect, optionally speak it. */
  function say(text, { mood = null, speak = true, ms = null, kind = '', actions = null, detail = null, sticky = false, onDone = null } = {}) {
    clearTimeout(bubbleTimer); clearInterval(typeTimer);
    bubbleSticky = sticky;
    bubble.className = `bubble interactive ${kind}`;
    bubble.hidden = false;
    const textEl = $('bubble-text');
    const act = $('bubble-actions');
    act.innerHTML = '';
    if (detail) {
      const pre = document.createElement('div');
      pre.className = 'bubble-detail';
      pre.textContent = detail.length > 600 ? detail.slice(0, 600) + '…' : detail;
      act.before(pre);
      bubble._detail = pre;
    } else if (bubble._detail) { bubble._detail.remove(); bubble._detail = null; }
    for (const a of actions || []) {
      const b = document.createElement('button');
      b.className = `btn ${a.cls || ''}`;
      b.textContent = a.label;
      b.onclick = a.onClick;
      act.appendChild(b);
    }
    if (mood) body.react(mood);
    if (kind !== 'status') body.setActivity(body.activity === 'sleeping' ? null : 'talking');

    const full = String(text);
    if (kind === 'status') { textEl.textContent = full; placeBubble(); return; }
    let i = 0;
    textEl.textContent = '';
    const caret = document.createElement('span');
    caret.className = 'caret';
    typeTimer = setInterval(() => {
      i = Math.min(full.length, i + 2);
      textEl.textContent = full.slice(0, i);
      if (i < full.length) textEl.appendChild(caret);
      placeBubble();
      if (i >= full.length) clearInterval(typeTimer);
    }, 22);

    const readMs = ms ?? Math.max(4200, full.split(/\s+/).length * 380 + 1800);
    const shownAt = Date.now();
    const token = (say.token = (say.token || 0) + 1);
    if (speak && cfg.voice?.enabled && cfg.personality !== 'quiet') {
      mouth.speak(full, cfg.voice).then(() => {
        if (say.token !== token) return;           // a newer message took over the bubble
        if (body.activity === 'talking') body.setActivity(null);
        if (!bubbleSticky) bubbleTimer = setTimeout(hideBubble, Math.max(actions ? 9000 : 1600, readMs * 0.6 - (Date.now() - shownAt)));
        onDone?.();
      });
    } else {
      if (!sticky) bubbleTimer = setTimeout(() => { if (body.activity === 'talking') body.setActivity(null); hideBubble(); }, actions ? Math.max(readMs, 9000) : readMs);
      if (onDone) setTimeout(onDone, Math.min(readMs, 1500));
    }
  }

  function status(text) { say(text, { kind: 'status', speak: false }); }

  bubble.addEventListener('mouseenter', () => clearTimeout(bubbleTimer));
  bubble.addEventListener('mouseleave', () => { if (!bubbleSticky && !mouth.speaking && body.activity !== 'thinking') bubbleTimer = setTimeout(hideBubble, 2500); });

  // ---------- composer ----------
  const composer = $('composer');
  const input = $('input');
  const meter = $('meter');
  const sendBtn = $('btn-send');
  const micBtn = $('btn-mic');

  function layoutComposer() {
    const b = body.box();
    composer.style.width = `${Math.max(220, b.left - 26 - visible.left)}px`;
  }
  function openComposer(focus = true) {
    layoutComposer();
    composer.hidden = false;
    body.pinned = true;
    body.comeHome();
    if (focus) { api.focus(); setTimeout(() => input.focus(), 30); }
  }
  function closeComposer(force = false) {
    if (!force && (ears.active || busy)) return;
    composer.hidden = true;
    body.pinned = false;
    input.blur();
  }
  function setBusy(on) {
    busy = on;
    sendBtn.classList.toggle('stop', on);
    sendBtn.innerHTML = icon(on ? 'stop' : 'send');
    sendBtn.title = on ? 'Stop' : 'Send (Enter)';
  }

  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy && !input.value.trim()) { api.stop(); return; }
    send(input.value);
  });
  api.onComposerClose(() => closeComposer(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; closeComposer(); }
  });
  micBtn.onclick = () => captureCommand();

  // ---------- attachments (paperclip, or drop files on the chat box / Spidey) ----------
  let attached = [];
  const attBox = $('attachments');
  function renderAttachments() {
    attBox.hidden = !attached.length;
    attBox.innerHTML = '';
    for (const p of attached) {
      const chip = document.createElement('span');
      chip.className = 'att';
      const name = document.createElement('span');
      name.textContent = p.split(/[\\/]/).pop();
      name.title = p;
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = 'x';
      x.title = 'Remove';
      x.onclick = () => { attached = attached.filter((q) => q !== p); renderAttachments(); };
      chip.append(name, x);
      attBox.appendChild(chip);
    }
    if (attached.length && !input.value) input.placeholder = 'What should I do with these? (Enter = explain them)';
    else input.placeholder = 'Talk to Kanishk…';
  }
  function attach(paths) {
    const fresh = paths.filter((p) => p && !attached.includes(p));
    if (!fresh.length) return;
    attached = [...attached, ...fresh].slice(0, 8);
    renderAttachments();
    openComposer(true);
    body.react('surprised', 700);
    const got = `Got ${fresh.length === 1 ? fresh[0].split(/[\\/]/).pop() : `${fresh.length} files`}!`;
    // a lecture (slides, PDF, recording): offer the study pack in one click
    const lecture = fresh.find((p) => /\.(pptx|pdf|docx|mp3|wav|m4a|aac|ogg|opus|flac|wma|webm|mp4|mkv|mov|avi|m4v)$/i.test(p));
    if (lecture) {
      const isMedia = !/\.(pptx|pdf|docx)$/i.test(lecture);
      say(`${got} ${isMedia ? 'A lecture recording? ' : ''}Want notes, a summary, flashcards and a quiz from it?`, {
        mood: 'happy', speak: false, sticky: true,
        actions: [
          { label: '📚 Make study pack', cls: 'go', onClick: () => { bubbleSticky = false; attached = attached.filter((q) => q !== lecture); renderAttachments(); send(`Make a study pack (notes, one-page summary, flashcards and a quiz) from this lecture.\n[Attached files: ${lecture}]`, { label: `📚 Study pack from ${lecture.split(/[\\/]/).pop()}` }); } },
          { label: 'Something else', cls: '', onClick: () => { bubbleSticky = false; hideBubble(); input.focus(); } },
        ],
      });
      return;
    }
    say(`${got} What should I do with ${fresh.length === 1 ? 'it' : 'them'}?`, { mood: 'happy', speak: false, ms: 3500 });
  }
  /** Spidey webs the file in from (x, y), then it lands in the chat box once the reel finishes. */
  function catchAndAttach(paths, x, y) {
    paths = paths.filter(Boolean);
    if (!paths.length) return;
    body.catchFile(x, y, paths.length);
    setTimeout(() => attach(paths), 950);
  }

  $('btn-attach').innerHTML = icon('clip');
  $('btn-attach').onclick = async () => {
    const r = $('btn-attach').getBoundingClientRect();
    catchAndAttach(await api.pickFiles(), r.left + r.width / 2, r.top);
  };

  // dropping works on Spidey himself, his chat box or the panel
  document.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    composer.classList.add('drop');
    body.readyToCatch();
  });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) composer.classList.remove('drop'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    composer.classList.remove('drop');
    const paths = [...(e.dataTransfer?.files || [])].map((f) => { try { return api.pathForFile(f); } catch { return ''; } });
    catchAndAttach(paths, e.clientX, e.clientY);
  });
  window.addEventListener('blur', () => { setTimeout(() => { if (!input.value.trim() && !document.hasFocus()) closeComposer(); }, 1200); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.activeElement !== input) { hidePanel(); hideBubble(); } });

  /** label: what the chat log shows instead of the full prompt (e.g. for hotkey requests) */
  function send(text, { voice = false, label = null } = {}) {
    let msg = String(text || '').trim();
    if (!msg && !attached.length) return;
    if (attached.length) {
      if (!msg) msg = 'Look at these and tell me what they are, then help me with them.';
      label = label || `${msg}  📎 ${attached.map((p) => p.split(/[\\/]/).pop()).join(', ')}`;
      msg += `\n[Attached files: ${attached.join(' ; ')}]`;
      attached = [];
      renderAttachments();
    }
    input.value = '';
    mouth.cancel();
    if (ears.active) ears.stop(false);
    voiceTurn = voice;
    chat.push({ who: 'you', text: label || msg });
    if (!$('panel-chat').hidden) renderChat();
    lastWrite = null;
    turnFiles = [];
    panelFromStream = false;
    setBusy(true);
    body.setActivity('thinking');
    status('Hmm, let me think');
    api.ask(msg);
  }

  // ---------- listening ----------
  const bars = [...meter.querySelectorAll('i')];
  // "Hey Kanishk …" anywhere in a phrase, or "Kanishk …" at its start. Returns the command after it ('' if none), or null.
  // Whisper is told the name, but a real voice can still come out as "Kunishk", "Konnisk", "Kanish"...: match those too.
  const WAKE_RE = /(^|\W)((?:hey|hi|hello|ok|okay|yo|oh)\W+)?(?:kanishk|[kcgq][aouyei]{1,3}n{1,2}[aeiouy]{0,3}(?:schk|shk|chk|sch|sh|ch|sk|sz)a?)\b\W*(.*)$/i;
  function matchWake(text) {
    text = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');   // "Konieśk" -> "Koniesk"
    const m = text.match(WAKE_RE);
    if (!m) return null;
    const before = text.slice(0, m.index).replace(/\b(um+|uh+|so|and|okay|ok)\b|\W/gi, '');
    if (!m[2] && before) return null;
    return m[3].replace(/[.!?\s]+$/, '').trim();
  }
  const STOP_WORDS = /^(stop|cancel|shut up|quiet|be quiet|never ?mind|that'?s all|nothing)\W*$/i;

  function setMicUi(on) {
    micBtn.classList.toggle('live', on);
    meter.hidden = !on;
  }
  const showLevel = (lvl) => bars.forEach((b, i) => {
    const k = Math.max(0, lvl * (1 - Math.abs(i - 4) / 6) + (Math.random() - 0.5) * 0.12);
    b.style.height = `${4 + Math.round(k * 22 / 3) * 3}px`;
  });

  async function fixMic(reason) {
    const r = String(await api.micFix());
    api.log('mic', `${reason}: ${r}`);
    return /unmuted|raised/.test(r) ? r : null;
  }

  /** Capture one spoken command (push-to-talk, wake word, or follow-up) and send it. */
  async function captureCommand({ followUp = false, fromChunk = null } = {}) {
    if (ears.active) { ears.stop(true); return; }
    if (!booted) { say("My ears aren't on yet, one sec!", { mood: 'sleepy', speak: false }); return; }
    mouth.cancel();
    openComposer(false);
    setMicUi(true);
    body.setActivity('listening');
    status(followUp ? "Anything else? I'm listening…" : fromChunk !== null ? 'Yeah? I\'m listening…' : "I'm listening…");
    let r;
    try {
      r = await ears.listen({ onLevel: showLevel, startTimeout: followUp ? 5 : 8, fromChunk });
      if (r.silentDevice && !micFixTried) {
        micFixTried = true;
        if (await fixMic('silent mic')) {
          status('Your mic was muted in Windows. Unmuted it! Say that again?');
          r = await ears.listen({ onLevel: showLevel, startTimeout: 8 });
        }
      }
    } catch (e) {
      setMicUi(false);
      body.setActivity(null);
      api.log('mic', e.message);
      say(`I can't open your microphone (${e.name}). Check that one is connected and allowed for desktop apps.`, {
        mood: 'oops', speak: false, actions: [{ label: 'Mic privacy settings', onClick: () => api.openExternal('ms-settings:privacy-microphone') }],
      });
      return;
    }
    setMicUi(false);
    body.setActivity(null);
    if (r.silentDevice) {
      say('Your microphone is sending pure silence. It may be muted with a keyboard key or switched off in Sound settings.', {
        mood: 'oops', speak: true, actions: [{ label: 'Sound settings', onClick: () => api.openExternal('ms-settings:sound') }],
      });
      return;
    }
    if (!r.wav) {
      if (followUp) { hideBubble(); setTimeout(() => { if (!busy && !ears.active && !input.value) closeComposer(); }, 800); }
      else if (!busy) say("Didn't catch that. Try again?", { mood: 'oops', speak: false, ms: 2500 });
      return;
    }
    status('Got it…');
    body.setActivity('thinking');
    const t = await api.transcribe(r.wav);
    body.setActivity(null);
    if (t.error) { say(`My ears glitched: ${t.error}`, { mood: 'oops', speak: false }); return; }
    let text = (t.text || '').trim();
    const w = matchWake(text);
    if (w !== null) text = w;                     // "hey kanishk, open chrome" -> "open chrome"
    text = text.replace(/^[,.!?\s]+/, '');
    if (!text || STOP_WORDS.test(text)) {
      if (followUp || STOP_WORDS.test(text)) { hideBubble(); closeComposer(); }
      else say("Didn't catch that. Try again?", { mood: 'oops', speak: false, ms: 2500 });
      return;
    }
    input.value = text;
    setTimeout(() => send(text, { voice: true }), 300);
  }

  // Always-on "Hey Kanishk": each phrase heard is transcribed locally and checked for the wake word.
  let wakeBusy = false;
  let wakePending = null;          // newest phrase that arrived while the previous one was being transcribed
  async function onUtterance(wav, endChunk) {
    if (ears.active || mouth.speaking) return;
    if (wakeBusy) { wakePending = { wav, end: endChunk }; return; }
    wakeBusy = true;
    try {
      const r = await api.transcribe(wav);
      const cmd = matchWake(r.text);
      if (cmd === null) return;
      api.log('wake', `heard: "${r.text}"`);
      if (STOP_WORDS.test(cmd)) { mouth.cancel(); if (busy) api.stop(); hideBubble(); return; }
      if (busy) return;
      body.setActivity(null);
      body.react('surprised', 700);
      if (cmd.split(/\s+/).length >= 2 || cmd.length > 7) {
        openComposer(false);
        input.value = cmd;
        send(cmd, { voice: true });
      } else {
        // just "Hey Kanishk": listen for the command, starting from right after the wake words
        wakePending = null;
        captureCommand({ fromChunk: endChunk });
      }
    } catch (e) {
      api.log('wake', e.message);
    } finally {
      wakeBusy = false;
      const next = wakePending;
      wakePending = null;
      // after a trigger the queued phrase is just the overlap of the same words, so drop it
      if (next && !busy && !ears.active) onUtterance(next.wav, next.end);
    }
  }

  async function syncWake() {
    const want = booted && cfg.voice?.wakeWord;
    if (want && !ears.wakeOn) {
      try {
        if (!micFixTried) {
          micFixTried = true;
          if (await fixMic('wake start')) say('I unmuted your microphone so I can hear "Hey Kanishk".', { mood: 'happy', speak: false, ms: 4500 });
        }
        await ears.startWake(onUtterance);
      } catch (e) { api.log('wake', `could not start: ${e.message}`); }
    } else if (!want && ears.wakeOn) ears.stopWake();
  }

  // don't listen to ourselves
  mouth.onStart = () => ears.pause(true);
  mouth.onEnd = () => setTimeout(() => { if (!mouth.speaking) ears.pause(false); }, 600);

  // ---------- brain events ----------
  api.onStreamStart(() => { streamText = ''; });

  // The brain rejected a reply that claimed to act without acting; it is retrying for real.
  api.onRetract(() => {
    streamText = '';
    if (panelFromStream) { hidePanel(); panelFromStream = false; }
    body.setActivity('working');
    status('On it…');
  });

  api.onFile(({ path, content }) => {
    turnFiles.push(path);
    const name = path.split(/[\\/]/).pop();
    if (content) {
      const ext = (name.match(/\.(\w+)$/) || [])[1] || '';
      // markdown renders as-is; plain text keeps its line breaks; anything else shows as code
      const shown = /^md$/i.test(ext) ? content : /^txt$/i.test(ext) ? content.replace(/\n/g, '  \n') : '```' + ext + '\n' + content + '\n```';
      lastWrite = { title: name, content: shown, file: path };
      showPanel(lastWrite);
    } else {
      showPanel({ title: name, content: `Saved **${name}**`, file: path });
    }
  });

  api.onDelta((d) => {
    if (d.reasoning) { if (body.activity !== 'thinking') body.setActivity('thinking'); return; }
    if (!d.content) return;
    streamText += d.content;
    const p = parseReply(streamText);
    if (p.output && p.output.content.trim()) {
      body.setActivity('working');
      panelFromStream = true;
      showPanel({ title: p.output.title, content: p.output.content }, { live: true });
    }
  });

  api.onTool((t) => {
    body.setActivity('working');
    status(t.label);
    if (t.name === 'keyboard' && String(t.args?.text || '').length > 120) {
      lastWrite = { title: `Typed into ${t.args.window || 'the app'}`, content: String(t.args.text) };
    }
    if (t.name === 'write_file' && t.args?.content) {
      lastWrite = { title: String(t.args.path || 'File').split(/[\\/]/).pop(), content: /\.(md|txt)$/i.test(t.args.path || '') ? t.args.content : '```\n' + t.args.content + '\n```' };
    }
  });

  api.onOutput((o) => { outputs.push(o); showPanel(o); });

  api.onFinal((f) => {
    setBusy(false);
    body.setActivity(null);
    let { mood, speech, output } = parseReply(f.text);
    // a file written this turn (e.g. a study pack) beats moving a long reply into the panel,
    // and beats a short <output> that only talks about that file
    if (lastWrite?.file && output && output.content.length < 700 && lastWrite.content.length > output.content.length) {
      if (!speech) speech = output.content.replace(/[`*_#>-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 220);
      output = null;
    }
    if (!output && lastWrite) output = lastWrite;
    if (!output) { const s = splitLong(speech); speech = s.speech; output = s.output; }
    const file = turnFiles[turnFiles.length - 1] || null;
    let out = null;
    if (output && output.content.trim()) {
      out = { title: output.title, content: output.content, file: output.file || file };
      outputs.push(out);
      showPanel(out);
    }
    if (!speech) speech = out ? 'Here you go!' : 'Done!';
    chat.push({ who: 'spidey', text: speech, output: out });
    if (!$('panel-chat').hidden) renderChat();
    const actions = [];
    if (file) {
      actions.push({ label: 'Open file', cls: 'go', onClick: () => api.openFile(file) });
      actions.push({ label: 'Show in folder', onClick: () => api.revealFile(file) });
    }
    if (out && !file) actions.push({ label: 'Copy it', cls: 'blue', onClick: () => { navigator.clipboard.writeText(out.content); status('Copied!'); } });
    const followUp = voiceTurn && cfg.voice?.followUp && cfg.personality !== 'quiet' && !f.error && !f.aborted;
    say(speech, {
      mood: mood || (f.error ? 'oops' : 'happy'), speak: !f.aborted, actions: actions.length ? actions : null,
      onDone: followUp ? () => { if (!busy && !ears.active) captureCommand({ followUp: true }); } : null,
    });
    if (!input.value && document.activeElement !== input) setTimeout(() => { if (!busy && !ears.active && !input.value) closeComposer(); }, 6000);
  });

  api.onReset(() => { chat.length = 0; renderChat(); say('Fresh start! What are we doing?', { mood: 'happy', speak: false, ms: 2500 }); });

  api.onConfirm(({ id, title, detail }) => {
    const answer = (ok) => { api.confirmReply(id, ok); bubbleSticky = false; body.setActivity(ok ? 'working' : null); status(ok ? 'On it' : 'Okay, skipping that'); };
    say(title, {
      kind: 'alert', speak: true, sticky: true, detail,
      actions: [{ label: 'Allow', cls: 'go', onClick: () => answer(true) }, { label: 'Deny', onClick: () => answer(false) }],
    });
    body.setActivity('confirm');
  });
  api.onConfirmCancel(() => { bubbleSticky = false; hideBubble(); });

  api.onHotkeyTalk(() => captureCommand());
  api.onMicFixed(({ result }) => say(/unmuted|raised/.test(result) ? 'Fixed! Your mic was muted or too quiet. I can hear you now.' : 'Your mic already looks fine to me.', { mood: 'happy', speak: false }));
  api.onHotkeyType(() => { openComposer(true); });

  // "help with what I copied"
  const CLIP_ACTIONS = [
    ['Explain', 'Explain this simply. If it is an error message, say what causes it and exactly how to fix it'],
    ['Fix', 'Fix this. If it is code, return the corrected code and list what you changed; if it is text, fix the grammar and wording'],
    ['Summarize', 'Summarize this in a few bullet points'],
    ['Translate', 'Translate this into English; if it is already English, translate it into Hindi'],
    ['Reply', 'Write a good reply I can send to this message (friendly and natural, ready to copy)'],
  ];
  function handleClip({ text, image } = {}) {
    mouth.cancel();
    if (image) { send(`What is in this picture I copied? Explain it and help me with it.\n[Attached files: ${image}]`, { label: '📋 Help with the picture I copied' }); return; }
    if (!text) { say('Your clipboard is empty. Copy some text or a screenshot first, then press Ctrl+Alt+C!', { mood: 'oops', speak: false, ms: 4500 }); return; }
    const preview = text.length > 110 ? `${text.slice(0, 110)}…` : text;
    say('What should I do with what you copied?', {
      mood: 'thinking', speak: false, sticky: true, detail: preview,
      actions: [...CLIP_ACTIONS.map(([label, prompt]) => ({
        label, cls: label === 'Explain' ? 'go' : '',
        onClick: () => { bubbleSticky = false; send(`${prompt}:\n\n"""\n${text}\n"""`, { label: `📋 ${label}: ${preview}` }); },
      })), { label: 'Cancel', onClick: () => { bubbleSticky = false; hideBubble(); } }],
    });
  }
  api.onHotkeyClip(handleClip);

  // "look at my screen", no typing needed
  function handleScreen() {
    mouth.cancel();
    send("Look at my screen and help me with whatever I'm doing: explain anything confusing, and if there's an error, say exactly how to fix it.",
      { label: '👀 Look at my screen' });
  }
  api.onHotkeyScreen(handleScreen);
  window.spideyActions = { handleClip, handleScreen, catchAndAttach };   // handy from DevTools

  api.onAsk(({ text }) => send(text));
  api.onPanelShow((req) => {
    const o = outputs[outputs.length - 1];
    if (o && req?.tab !== 'chat') showPanel(o);
    else { panel.hidden = false; selectTab('chat'); }
  });

  api.onCheckin(({ text }) => {
    if (busy || ears.active || body.activity === 'sleeping') return;
    const { mood, speech } = parseReply(text);
    chat.push({ who: 'spidey', text: speech });
    body.wave();
    setTimeout(() => say(speech, { mood: mood || 'happy' }), 400);
  });
  api.onPresence(({ state }) => {
    if (state === 'away' && !busy) { hideBubble(); body.setActivity('sleeping'); }
    if (state === 'back' && body.activity === 'sleeping') { body.setActivity(null); body.react('surprised', 900); setTimeout(() => body.wave(), 900); }
  });
  // ---------- music: headphones on, dance to the beat ----------
  // The main process sends the PC's output loudness every 400 ms (never the audio itself).
  const levels = [];
  let musicOn = false, quietSince = 0;
  api.onSense(({ level }) => {
    if (mouth.speaking) return;                       // that's just him talking
    levels.push(level);
    if (levels.length > 10) levels.shift();
    body.beatLevel = level;
    const loud = levels.filter((l) => l > 0.02).length;
    if (!musicOn && levels.length >= 8 && loud >= 7) { musicOn = true; updateOutfit(); }
    if (musicOn) {
      const recentLoud = levels.slice(-4).filter((l) => l > 0.02).length;   // last ~1.6 s
      if (!recentLoud) { quietSince = quietSince || Date.now(); if (Date.now() - quietSince > 1500) { musicOn = false; quietSince = 0; updateOutfit(); } }
      else quietSince = 0;
    }
    body.dancing = musicOn && cfg.danceToMusic !== false;
  });

  // ---------- outfits for the moment ----------
  function isBirthday() {
    const d = new Date();
    return cfg.birthday && cfg.birthday === `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function updateOutfit() {
    const d = new Date(), h = d.getHours(), m = d.getMonth() + 1, day = d.getDate();
    body.outfit = musicOn && cfg.danceToMusic !== false ? 'headphones'
      : body.activity === 'sleeping' || h >= 23 || h < 5 ? 'nightcap'
      : isBirthday() || (m === 1 && day === 1) ? 'party'
      : m === 12 && day >= 15 ? 'santa'
      : null;
  }
  setInterval(updateOutfit, 5000);
  updateOutfit();

  // ---------- battery buddy ----------
  (async function batteryBuddy() {
    if (!navigator.getBattery) return;
    const bat = await navigator.getBattery();
    let warned = 101, fullSaid = false, lastPlug = 0;
    const check = () => {
      if (!booted) return;
      const pct = Math.round(bat.level * 100);
      if (!bat.charging) {
        fullSaid = false;
        const band = pct <= 5 ? 5 : pct <= 10 ? 10 : pct <= 20 ? 20 : 101;
        if (band < warned) {
          warned = band;
          body.react(band <= 10 ? 'surprised' : 'oops', 2500);
          say(band <= 10 ? `Battery at ${pct}%! Plug in NOW or we're both going dark!` : `Heads up, battery's at ${pct}%. Plug in before I run out of web fluid!`, { kind: 'alert', ms: 9000 });
        }
      } else {
        warned = 101;
        if (pct >= 100 && !fullSaid) { fullSaid = true; say("Fully charged! You can unplug to keep the battery healthy.", { mood: 'proud', ms: 6000 }); }
      }
    };
    bat.addEventListener('levelchange', check);
    bat.addEventListener('chargingchange', () => {
      if (bat.charging && Date.now() - lastPlug > 10 * 60000 && booted && !busy) {
        lastPlug = Date.now();
        body.react('happy', 1500);
        say(['Ahh, power! Thanks for plugging me in.', 'Charging up! I feel my spider-sense tingling.', 'Juice incoming. Ahhh.'][Math.floor(Math.random() * 3)], { speak: false, ms: 3500 });
      }
      check();
    });
    setInterval(check, 60000);
  })();

  // ---------- focus guard ----------
  // ---------- tricks on request ----------
  api.onMove(({ name }) => {
    setTimeout(() => {              // let the reply bubble show first
      if (busy || body.activity === 'talking') body.setActivity(null);
      if (body.startMove(name) === false) say("Not enough room for that one here. Drag me somewhere roomier!", { mood: 'oops', speak: false, ms: 3500 });
    }, body.activity === 'talking' ? 1200 : 0);
  });

  // ---------- rest mode: the AI is unloaded so games get the GPU ----------
  api.onRest(({ on }) => {
    body.resting = on;
    if (on) {
      ears.stopWake();
      say('Taking a little nap. Click me when you want me back!', { mood: 'sleepy', speak: false, ms: 6000 });
      body.setActivity('sleeping');   // after the bubble, which would otherwise make him "talk" awake
      body.outfit = 'nightcap';
    } else {
      booted = false;
      status('Waking up my brain…');
    }
  });

  // ---------- leaving and coming back ----------
  api.onGoodbye(({ kind, minutes }) => {
    mouth.cancel();
    hideBubble();
    closeComposer(true);
    hidePanel();
    body.wave();
    const n = cfg.userName || 'love';
    say(kind === 'quit' ? `Bye ${n}! I'll miss you.` : kind === 'unplug' ? `Bye ${n}! Plug me in again soon.` : `See you in ${minutes || 'a bit'}${minutes ? ' minutes' : ''}!`, { mood: kind === 'unplug' ? 'love' : 'happy', speak: kind === 'quit', ms: 2500 });
    setTimeout(() => { hideBubble(); body.leave(); }, 900);
  });
  api.onReturn(() => { body.setActivity(null); body.comeBack(); setTimeout(() => say(`I'm back, ${cfg.userName || 'love'}! Did you miss me?`, { mood: 'love', speak: false, ms: 3500 }), 2600); });

  // ---------- spider-sense ----------
  api.onSenseWarn(({ text }) => {
    if (busy) return;
    body.react('surprised', 2000);
    body.spawn('bang');
    say(text, { kind: 'alert', ms: 14000 });
  });

  // ---------- wardrobe ----------
  api.onOutfitWear(({ spec, fresh, quiet }) => {
    body.setOutfitSpec(spec);
    if (quiet || !spec) return;
    const url = body.portrait(8);
    const parts = [spec.hat && `**Hat:** ${spec.hat.template || 'drawn by Kanishk'}`, spec.item && `**In hand:** ${spec.item.template || 'drawn by Kanishk'}`,
      spec.emblem && `**Chest:** ${spec.emblem.template === 'number' ? `number ${spec.emblem.text}` : spec.emblem.template}`].filter(Boolean);
    showPanel({ title: `Wardrobe: ${spec.name}`, content: `![Kanishk wearing ${spec.name}](${url})\n\n${parts.join('  \n') || 'A new suit colour scheme.'}\n\n*${fresh ? 'Designed just now and saved to the wardrobe.' : 'From the wardrobe.'} Say "take it off" for the classic suit.*` });
  });

  // ---------- catch-the-bug ----------
  const game = new window.BugGame({
    canvas: $('game'), hud: $('game-hud'), body,
    area: () => visible,
    hooks: {
      onEnd: (score, best, isBest, caught, quit) => {
        body.pinned = false;
        setInteractive(false);
        if (quit && !score) { say('Game over. Come back for a rematch!', { mood: 'happy', speak: false, ms: 2500 }); return; }
        body.react(isBest ? 'excited' : 'happy', 2500);
        if (isBest) for (let i = 0; i < 6; i++) setTimeout(() => body.spawn(i % 2 ? 'spark' : 'tiny'), i * 120);
        say(`${isBest ? 'NEW HIGH SCORE! ' : ''}You scored ${score} (${caught} bugs caught). Best: ${best}.`, {
          mood: null, speak: true, ms: 9000,
          actions: [{ label: 'Play again', cls: 'go', onClick: () => startGame() }, { label: 'Done', onClick: () => hideBubble() }],
        });
        chat.push({ who: 'spidey', text: `Catch-the-bug: ${score} points${isBest ? ' (new high score!)' : ''}` });
      },
    },
  });
  function startGame() {
    if (busy) return;
    hideBubble(); hidePanel(); closeComposer(true);
    body.comeHome();
    body.pinned = true;                       // he stays in his spot and shoots from there
    say('Catch the bugs! Click them and I\'ll web them. 45 seconds, go!', { mood: 'excited', speak: false, ms: 2200 });
    setTimeout(() => game.start(), 1200);
  }
  api.onGameStart(() => startGame());
  window.spideyActions = Object.assign(window.spideyActions || {}, { startGame });
  window.spideyGame = game;   // DevTools

  // ---------- smart screenshot ----------
  api.onSnipReading(() => { body.setActivity('thinking'); status('Reading what you grabbed…'); });
  api.onSnipResult(({ path, text }) => {
    body.setActivity(null);
    const noText = !text || /^No text:/i.test(text);
    const quoted = (t) => `\n"""\n${t}\n"""`;
    showPanel({ title: 'Screenshot', content: noText ? (text || 'I could not read that one.') : '```text\n' + text + '\n```', file: path });
    const act = (label, cls, fn) => ({ label, cls, onClick: () => { bubbleSticky = false; fn(); } });
    say(noText ? 'No text in there. Want me to explain the picture?' : 'Got it! What should I do with it?', {
      mood: 'happy', speak: false, sticky: true,
      actions: [
        ...(noText ? [] : [act('Copy text', 'go', () => { navigator.clipboard.writeText(text); status('Copied!'); setTimeout(hideBubble, 1200); })]),
        ...(noText ? [] : [act('Translate', '', () => send(`Translate this into English (or into Hindi if it is already English):${quoted(text)}`, { label: '📸 Translate the screenshot' }))]),
        act(noText ? 'Explain it' : 'Solve / explain', '', () => send(`Solve or explain this step by step. If it is a question or problem, give the answer.${noText ? '' : `\nText:${quoted(text)}`}\n[Attached files: ${path}]`, { label: '📸 Solve / explain the screenshot' })),
        ...(noText ? [] : [act('Save to notes', '', async () => { await api.addNote(text); status('Saved to your notes!'); setTimeout(hideBubble, 1500); })]),
        act('Close', '', () => hideBubble()),
      ],
    });
  });

  api.onFocusNudge(({ app, minutesLeft }) => {
    if (busy) return;
    body.react('oops', 2500);
    say(`Hey ${cfg.userName || 'buddy'}, it's focus time! ${minutesLeft} more minute${minutesLeft === 1 ? '' : 's'}. ${app} can wait, you've got this!`, { kind: 'alert', ms: 8000 });
  });

  // ---------- timers & focus sessions ----------
  const chip = $('chip');
  let timers = [];
  function tickTimers() {
    const now = Date.now();
    timers = timers.filter((t) => t.endsAt > now - 500);
    body.focusMode = timers.some((t) => t.focus);
    if (!timers.length) { chip.hidden = true; return; }
    const t = timers.reduce((a, b) => (a.endsAt < b.endsAt ? a : b));
    const left = Math.max(0, Math.round((t.endsAt - now) / 1000));
    const mm = String(Math.floor(left / 60)).padStart(2, '0'), ss = String(left % 60).padStart(2, '0');
    const pct = Math.max(0, Math.min(100, 100 - (100 * (t.endsAt - now)) / (t.endsAt - t.start)));
    chip.className = 'chip timer';
    chip.innerHTML = `<span>${t.focus ? 'Focus' : '⏱'}</span><span class="t">${mm}:${ss}</span><span class="bar"><i style="width:${pct}%"></i></span>`;
    chip.title = t.label;
    chip.hidden = false;
    const b = body.box();
    chip.style.left = `${Math.max(visible.left + 8, b.left + b.width / 2 - chip.offsetWidth / 2)}px`;
    chip.style.top = `${Math.max(visible.top + 8, b.top - 34)}px`;
  }
  setInterval(tickTimers, 500);
  api.onTimer(({ label, focus, endsAt }) => {
    timers.push({ label, focus, endsAt, start: Date.now() });
    if (focus) body.react('cool', 1500);
    tickTimers();
  });
  api.onTimerDone(({ label, focus, minutes }) => {
    body.react('excited', 3000);
    say(focus ? `Focus session done! ${minutes} minute${minutes === 1 ? "" : "s"} of solid work. Take a five-minute break, you earned it.` : `Time's up! ${label}`,
      { kind: 'alert', mood: null, ms: 12000, actions: focus ? [{ label: 'Play catch-the-bug', cls: 'go', onClick: () => startGame() }] : null });
    chat.push({ who: 'spidey', text: focus ? 'Focus session done!' : `Timer done: ${label}` });
    tickTimers();
  });

  api.onReminder(({ message }) => {
    body.setActivity(null);
    body.react('surprised');
    say(`⏰ Reminder: ${message}`, { kind: 'alert', mood: null, ms: 15000 });
    chat.push({ who: 'spidey', text: `Reminder: ${message}` });
  });

  api.onVisible((v) => {
    visible = v;
    const root = document.documentElement.style;
    root.setProperty('--vis-l', `${v.left}px`);
    root.setProperty('--vis-t', `${v.top}px`);
    root.setProperty('--vis-r', `${innerWidth - v.right}px`);
    root.setProperty('--vis-b', `${innerHeight - v.bottom}px`);
    body.setVisible(v);
    layoutComposer();
    placeBubble();
  });

  api.onConfig((c) => {
    const scaleChanged = cfg.scale !== c.scale;
    cfg = c;
    if (scaleChanged) body.setScale(c.scale);
    body.calm = c.personality === 'focus' || c.personality === 'quiet';   // he stays put instead of wandering and swinging
    syncWake();
  });

  // ---------- boot ----------
  status('Waking up');
  body.setActivity('sleeping');
  const greet = () => {
    const h = new Date().getHours();
    const part = h < 5 ? "Burning the midnight oil" : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const name = cfg.userName ? `, ${cfg.userName}` : '';
    const key = String(cfg.hotkeys?.talk || 'Control+Alt+Space').replace(/Control/g, 'Ctrl');
    return `${part}${name}! Your Kanishk is here, and I missed you. Click me or press ${key} to talk.`;
  };
  api.onBoot((b) => {
    if (b.stage === 'loading') status('Loading my brain…');
    if (b.stage === 'ready') {
      booted = true;
      syncWake();
      body.setActivity(null);
      body.react('surprised', 700);
      setTimeout(() => body.drop(), 650);
      setTimeout(() => {
        body.wave();
        if (isBirthday()) {
          updateOutfit();
          body.react('excited', 3000);
          for (let i = 0; i < 8; i++) setTimeout(() => body.spawn(i % 2 ? 'spark' : 'heart'), i * 150);
          say(`Happy birthday, ${cfg.userName || 'buddy'}! The whole web is celebrating you today!`, { mood: null });
        } else say(greet(), { mood: 'happy' });
      }, 1500);
    }
    if (b.stage === 'error') {
      body.setActivity(null);
      body.drop();
      say(`I couldn't load my brain: ${b.message}`, { mood: 'oops', speak: false, sticky: true, actions: [{ label: 'OK', onClick: () => { bubbleSticky = false; hideBubble(); } }] });
    }
    if (b.stage === 'ears' && b.ok === false) console.warn('speech recognition unavailable:', b.message);
  });

  // ---------- pointer: click-through, drag, click ----------
  const hit = $('hit');
  let interactive = false;
  function setInteractive(on) { if (on !== interactive) { interactive = on; api.setInteractive(on); } }
  document.addEventListener('mousemove', (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    setInteractive(!!(el && el.closest('.interactive')) || dragging);
  });
  document.addEventListener('mouseleave', () => { if (!dragging) setInteractive(false); });

  let dragging = false, downAt = null, moved = false;
  hit.addEventListener('mouseenter', () => body.hoverHello());

  // petting: rub the pointer back and forth over him
  let rubDir = 0, rubX = null, rubTurns = [], lastPet = 0;
  hit.addEventListener('mousemove', (e) => {
    if (dragging || downAt) return;
    if (rubX !== null) {
      const dir = Math.sign(e.clientX - rubX);
      if (dir && rubDir && dir !== rubDir) rubTurns.push(Date.now());
      if (dir) rubDir = dir;
    }
    rubX = e.clientX;
    rubTurns = rubTurns.filter((t) => Date.now() - t < 1500);
    if (rubTurns.length >= 6 && Date.now() - lastPet > 8000 && !busy) {
      lastPet = Date.now();
      rubTurns = [];
      body.react('love', 2200);
      if (body.activity === 'sleeping') body.setActivity(null);
      say(['Hehe, that tickles!', 'Aww, head pats! Best day ever.', "Okay okay, I'm ticklish! Haha!", "Purr... wait, spiders don't purr. Do they?"][Math.floor(Math.random() * 4)], { speak: false, ms: 2600 });
    }
  });
  hit.addEventListener('mouseleave', () => { rubX = null; rubDir = 0; });
  hit.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    downAt = { x: e.screenX, y: e.screenY, src: 'spidey' };
    moved = false;
  });
  window.addEventListener('mousemove', (e) => {
    if (!downAt) return;
    if (!moved && Math.hypot(e.screenX - downAt.x, e.screenY - downAt.y) > 5) {
      moved = true; dragging = true;
      hit.classList.add('dragging');
      api.dragStart();
      body.setCarried(true);
    }
    if (dragging) api.drag();
  });
  window.addEventListener('mouseup', () => {
    if (!downAt) return;
    const { src } = downAt;
    downAt = null;
    if (dragging) { dragging = false; hit.classList.remove('dragging'); api.dragEnd(); body.setCarried(false); return; }
    if (src === 'spidey') onSpideyClick();
  });
  hit.addEventListener('contextmenu', (e) => { e.preventDefault(); api.showMenu(); });
  hit.addEventListener('dblclick', () => captureCommand());

  // panel drag by its title bar moves the whole window too
  $('panel-bar').addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    downAt = { x: e.screenX, y: e.screenY, src: 'panel' }; moved = false;
  });

  function onSpideyClick() {
    if (body.resting) { api.wake(); status('Waking up my brain…'); return; }
    if (body.activity === 'sleeping') { body.setActivity(null); body.react('surprised', 800); setTimeout(() => say("Huh?! I'm awake! What's up?", { mood: 'happy' }), 500); return; }
    if (composer.hidden) { openComposer(true); if (bubble.hidden) say(['Need something?', 'Hey! What can I do for you?', 'Your friendly neighborhood assistant, at your service!', "What's the mission?"][Math.floor(Math.random() * 4)], { mood: 'happy', speak: false, ms: 2600 }); }
    else if (!busy) closeComposer();
  }

  // ---------- main loop ----------
  window.addEventListener('resize', () => { body.resize(); layoutComposer(); });
  function loop() {
    body.tick();
    const b = body.box();
    hit.style.left = `${b.left}px`; hit.style.top = `${b.top}px`;
    hit.style.width = `${b.width}px`; hit.style.height = `${b.height}px`;
    placeBubble();
    requestAnimationFrame(loop);
  }
  api.getConfig().then((c) => { cfg = c; body.setScale(c.scale || 4); });
  requestAnimationFrame(loop);
})();
