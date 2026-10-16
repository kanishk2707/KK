const {
  app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut,
  dialog, shell, powerMonitor, Notification, session, desktopCapturer, clipboard,
} = require('electron');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const servers = require('./servers');
const { Agent } = require('./agent');
const SpriteData = require('./sprite-data');
const tools = require('./tools');
const phone = require('./phone');
const groq = require('./groq');
const { Chip } = require('./chip');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.setAppUserModelId('Kanishk.DesktopBuddy');

let cfg = config.load();
let win = null;
let tray = null;
let agent = null;
let ready = false;
let present = false;      // Kanishk's chip is plugged in (he only shows up then)
let chip = null;

const LOG = path.join(config.ROOT, 'runtime', 'kanishk.log');
try { if (fs.statSync(LOG).size > 5e6) fs.renameSync(LOG, LOG + '.old'); } catch {}
function log(tag, msg) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${tag}: ${String(msg).trimEnd()}\n`);
  } catch {}
}

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

// ---------- window ----------

const WIN_W = 540;
let winSize = [WIN_W, 780];
function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const h = Math.min(780, workArea.height - 10);
  winSize = [WIN_W, h];
  win = new BrowserWindow({
    width: WIN_W, height: h,
    x: workArea.x + workArea.width - WIN_W, y: workArea.y + workArea.height - h,
    transparent: true, frame: false, resizable: false, maximizable: false, minimizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',   // the mic/audio must start from a global hotkey too
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // Windows can silently drop the topmost flag after focus changes, leaving him buried under other
  // windows; re-assert it regularly (this never steals focus).
  // (Electron skips the call if it thinks the flag is already set, so toggle it; moveTop() would clear it.)
  const keepOnTop = () => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    win.setAlwaysOnTop(false);
    win.setAlwaysOnTop(true, 'screen-saver');
  };
  setInterval(keepOnTop, 3000);
  win.on('blur', () => setTimeout(keepOnTop, 200));
  win.setVisibleOnAllWorkspaces(true);
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // back where you left him last time (if that spot still exists on screen)
  if (Array.isArray(cfg.winPos)) placeWindow(cfg.winPos[0], cfg.winPos[1]);
  // not shown yet: he appears when his chip is plugged in
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return;            // our own page reloading
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  win.webContents.on('console-message', (e, ...old) => {
    const level = e.level ?? old[0];
    const message = e.message ?? old[1];
    if ((level === 'warning' || level === 'error' || level >= 2) && !/ScriptProcessorNode is deprecated/.test(message)) log('renderer', message);
  });
  win.webContents.on('render-process-gone', (_e, d) => { log('renderer', `crashed: ${d.reason}`); win.reload(); });
}

// ---------- tray + menu ----------

function trayIcon() {
  const head = SpriteData.composeHead('normal');
  const size = 32, scale = 2, off = 1;
  const buf = Buffer.alloc(size * size * 4);
  head.grid.forEach((row, y) => row.forEach((c, x) => {
    if (!c) return;
    const hex = SpriteData.PALETTE[c];
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const k = (((y * scale + dy + off) * size) + (x * scale + dx + off)) * 4;
      buf[k] = b; buf[k + 1] = g; buf[k + 2] = r; buf[k + 3] = 255; // BGRA
    }
  }));
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function setCfg(patch) {
  cfg = { ...cfg, ...patch };
  config.save(cfg);
  if (agent) agent.cfg = cfg;
  send('config', cfg);
  buildMenus();
}

function menuTemplate() {
  const mode = cfg.permissionMode;
  return [
    { label: present ? `Kanishk is here (chip on ${chip?.info?.port || 'USB'})` : "Plug in Kanishk's chip to see him", enabled: false },
    { type: 'separator' },
    { label: 'Talk to Kanishk', accelerator: cfg.hotkeys.talk, enabled: present, click: () => send('hotkey:talk') },
    { label: 'Type to Kanishk', accelerator: cfg.hotkeys.type, enabled: present, click: () => { win.focus(); send('hotkey:type'); } },
    { label: 'Help with what I copied', accelerator: cfg.hotkeys.clipboard, click: () => clipboardHelp() },
    { label: 'Look at my screen', accelerator: cfg.hotkeys.screen, click: () => send('hotkey:screen') },
    { label: 'Smart screenshot (grab & read)', accelerator: cfg.hotkeys.snip || 'Control+Alt+X', click: () => startSnip() },
    { label: 'Recap my day', click: () => send('ask', { text: 'Recap my day' }) },
    { type: 'separator' },
    {
      label: 'Mode', submenu: [
        ...Object.entries(MODES),
      ].map(([id, label]) => ({ label, type: 'radio', checked: (cfg.personality || 'buddy') === id, click: () => setCfg({ personality: id }) })),
    },
    {
      label: 'Voice', submenu: [
        { label: 'Speak replies out loud', type: 'checkbox', checked: cfg.voice.enabled, click: (i) => setCfg({ voice: { ...cfg.voice, enabled: i.checked } }) },
        { label: 'Listen for "Hey Kanishk"', type: 'checkbox', checked: cfg.voice.wakeWord, click: (i) => setCfg({ voice: { ...cfg.voice, wakeWord: i.checked } }) },
        { label: 'Keep listening after I answer', type: 'checkbox', checked: cfg.voice.followUp, click: (i) => setCfg({ voice: { ...cfg.voice, followUp: i.checked } }) },
        { label: 'Fix my microphone', click: async () => send('mic:fixed', { result: await tools.audio('mic-fix') }) },
      ],
    },
    {
      label: 'Permissions', submenu: [
        { label: 'Ask before risky actions', type: 'radio', checked: mode === 'confirm-risky', click: () => setCfg({ permissionMode: 'confirm-risky' }) },
        { label: 'Full control (never ask)', type: 'radio', checked: mode === 'full', click: () => setCfg({ permissionMode: 'full' }) },
        { label: 'Ask before every action', type: 'radio', checked: mode === 'confirm-all', click: () => setCfg({ permissionMode: 'confirm-all' }) },
      ],
    },
    {
      label: 'Size', submenu: [3, 4, 5, 6].map((s) => ({
        label: `${s}x`, type: 'radio', checked: cfg.scale === s, click: () => setCfg({ scale: s }),
      })),
    },
    {
      label: 'Phone notifications', submenu: [
        { label: phone.settings(cfg).topic ? 'Show phone setup (QR code)' : 'Set up on my phone…', click: () => phoneSetup() },
        { label: 'On', type: 'checkbox', enabled: !!phone.settings(cfg).topic, checked: phone.settings(cfg).enabled, click: (i) => setPhone({ enabled: i.checked }) },
        { label: 'Send a test notification', enabled: phone.settings(cfg).enabled, click: () => phoneTest() },
        { type: 'separator' },
        ...[['reminders', 'Reminders'], ['timers', 'Timers & focus sessions'], ['briefing', 'Morning briefing'], ['recap', 'Evening recap'], ['tasks', 'Long tasks finished while I\'m away']]
          .map(([k, label]) => ({ label, type: 'checkbox', checked: phone.settings(cfg).notify[k] !== false, click: (i) => setPhone({ notify: { ...phone.settings(cfg).notify, [k]: i.checked } }) })),
        { type: 'separator' },
        { label: 'New private channel (stops the old one)', enabled: !!phone.settings(cfg).topic, click: () => { setPhone({ topic: phone.newTopic() }); phoneSetup(); } },
      ],
    },
    { label: 'Show last output', click: () => send('panel:show') },
    { label: 'Forget this conversation', click: () => { agent?.reset(); send('agent:reset'); } },
    { type: 'separator' },
    {
      label: 'Start with Windows', type: 'checkbox', checked: cfg.startWithWindows, click: (i) => setAutostart(i.checked),
    },
    { label: 'Settings (config.json)', click: () => shell.openPath(config.CONFIG_PATH) },
    { label: 'Move back to corner', click: () => { dock(); setCfg({ winPos: null }); } },
    { label: win?.isVisible() ? 'Hide' : 'Show', enabled: present, click: () => (win?.isVisible() ? toggleVisible() : showAgain()) },
    { type: 'separator' },
    {
      label: 'Play catch-the-bug', click: () => send('game:start'),
    },
    {
      label: 'Do a trick', submenu: [['backflip', 'Backflip'], ['swing', 'Web swing'], ['climb', 'Climb the screen'], ['webart', 'Spin a web'], ['peekaboo', 'Peek-a-boo'], ['yoyo', 'Web yo-yo'], ['dance', 'Dance'], ['sit', 'Sit and chill']]
        .map(([name, label]) => ({ label, click: () => send('move', { name }) })),
    },
    {
      label: 'Snooze (hide for a while)', submenu: [[15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [180, '3 hours'], [0, 'Until I bring him back']]
        .map(([m, label]) => ({ label, click: () => hideFor(m) })),
    },
    resting
      ? { label: 'Wake up', enabled: present, click: () => wake() }
      : { label: 'Take a nap (stop listening)', enabled: present, click: () => rest() },
    { label: 'Quit Kanishk', click: () => quitSpidey() },
  ];
}

function buildMenus() {
  if (!tray) {
    tray = new Tray(trayIcon());
    tray.on('click', () => { if (present) toggleVisible(); });
  }
  tray.setToolTip(present ? 'Kanishk' : "Kanishk (plug in his chip)");
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

function toggleVisible() {
  if (!win || !present) return;
  if (win.isVisible()) win.hide(); else win.showInactive();
  buildMenus();
}

function dock() {
  const { workArea } = screen.getPrimaryDisplay();
  win.setBounds({ x: workArea.x + workArea.width - winSize[0], y: workArea.y + workArea.height - winSize[1], width: winSize[0], height: winSize[1] });
  sendVisible();
}

// ---------- keeping him on screen ----------
// Spidey lives in the bottom-right of his (mostly empty) window. The window's right and bottom edges
// never leave the screen, and at least MIN_VISIBLE px of it always shows, so he can sit anywhere
// (even near the top of the screen) while the empty part of his window hangs off the edge.
const MIN_VISIBLE = 300;

function clampPos(x, y) {
  const [w, h] = winSize;
  const wa = screen.getDisplayNearestPoint({ x: Math.round(x + w - 80), y: Math.round(y + h - 80) }).workArea;
  return [
    Math.round(Math.min(Math.max(x, wa.x + MIN_VISIBLE - w), wa.x + wa.width - w)),
    Math.round(Math.min(Math.max(y, wa.y + MIN_VISIBLE - h), wa.y + wa.height - h)),
  ];
}

/** Tell the page which part of the window is actually on screen (window-relative px). */
function sendVisible() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const wa = screen.getDisplayNearestPoint({ x: b.x + b.width - 80, y: b.y + b.height - 80 }).workArea;
  send('visible', {
    left: Math.max(0, wa.x - b.x),
    top: Math.max(0, wa.y - b.y),
    right: Math.min(b.width, wa.x + wa.width - b.x),
    bottom: Math.min(b.height, wa.y + wa.height - b.y),
  });
}

function placeWindow(x, y) {
  const [cx, cy] = clampPos(x, y);
  // position and size together: when part of the window hangs off screen, Windows' display-scaling
  // logic can otherwise stretch it
  win.setBounds({ x: cx, y: cy, width: winSize[0], height: winSize[1] });
  const [w, h] = win.getSize();
  if (w !== winSize[0] || h !== winSize[1]) win.setBounds({ x: cx, y: cy, width: winSize[0], height: winSize[1] });
  sendVisible();
}

// ---------- helpers handed to the tools ----------

async function screenshot({ jpeg = false, maxWidth } = {}) {
  const d = screen.getPrimaryDisplay();
  const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = sources.find((s) => s.display_id === String(d.id)) || sources[0];
  if (!src) return null;
  let img = src.thumbnail;
  if (maxWidth && img.getSize().width > maxWidth) img = img.resize({ width: maxWidth, quality: 'good' });
  return jpeg ? img.toJPEG(82) : img.toPNG();
}

async function releaseFocus() {
  send('composer:close');
  if (win?.isFocused()) win.blur();
  await new Promise((r) => setTimeout(r, 250));
}

// ---------- phone notifications (outbound only, see phone.js) ----------

let askStartedAt = 0;
function emitAndNotify(channel, payload) {
  send(channel, payload);
  if (channel === 'outfit:wear') setCfg({ wearing: payload.spec ? payload.spec.id : null });
  if (channel === 'agent:final' && afterReply) { const fn = afterReply; afterReply = null; setTimeout(fn, 2500); }
  if (channel !== 'agent:final' || !askStartedAt || payload.aborted) return;
  const took = Date.now() - askStartedAt;
  askStartedAt = 0;
  // only when it took a while and nobody has touched the PC for a minute (i.e. you walked away)
  if (took > 45000 && powerMonitor.getSystemIdleTime() > 60) {
    const speech = String(payload.text || '').replace(/^\s*\[[a-z]+\]\s*/i, '').replace(/<output[\s\S]*?(<\/output>|$)/i, '').trim();
    phone.push(cfg, { title: payload.error ? 'Kanishk hit a problem' : 'Kanishk finished your task', message: speech || 'Done!', tags: payload.error ? 'warning' : 'white_check_mark', kind: 'tasks' });
  }
}

function setPhone(patch) { setCfg({ phone: { ...phone.settings(cfg), ...patch } }); }

async function phoneSetup() {
  if (!phone.settings(cfg).topic) setPhone({ topic: phone.newTopic(), enabled: true });
  const s = phone.settings(cfg);
  const url = phone.topicUrl(cfg);
  const QR = require('qrcode');
  const qr = await QR.toDataURL(url, { margin: 1, scale: 6 });
  // official ntfy app pages (developer: Philipp C. Heckel)
  const android = await QR.toDataURL('https://play.google.com/store/apps/details?id=io.heckel.ntfy', { margin: 1, scale: 4 });
  const iphone = await QR.toDataURL('https://apps.apple.com/app/ntfy/id1625396347', { margin: 1, scale: 4 });
  send('agent:output', {
    title: 'Kanishk on your phone',
    content: [
      'Get Kanishk\'s reminders, timers, briefings, recaps, finished tasks and anything you ask him to "send to my phone".',
      '',
      '**1. Install the free ntfy app.** Point your phone camera at the code for your phone, tap the link, then tap *Install*.',
      '',
      '| Android (Google Play) | iPhone (App Store) |',
      '|:---:|:---:|',
      `| ![Get ntfy on Google Play](${android}) | ![Get ntfy on the App Store](${iphone}) |`,
      '',
      `**2. Connect it to Kanishk.** Scan this code and tap *Subscribe*, or in the app tap **+** and enter the topic **\`${s.topic}\`** (server: ntfy.sh).`,
      '',
      `![QR code for your Kanishk channel](${qr})`,
      '',
      '**3.** Right-click Kanishk > Phone notifications > **Send a test notification**.',
      '',
      '---',
      `*Private:* the topic name works like a password, so keep it to yourself. Messages go out through the ntfy.sh service; nothing on the phone can control this laptop. Don't send passwords through it. Turn it off any time from the same menu, or make a new channel if the name ever leaks.`,
    ].join('\n'),
  });
}

async function phoneTest() {
  const r = await phone.push(cfg, { title: 'Kanishk is connected!', message: `Hi ${cfg.userName || 'there'}! Notifications from your Kanishk will show up here.`, tags: 'heart,tada' });
  send('agent:final', { text: `[${/Sent/.test(r) ? 'excited' : 'oops'}] ${r === 'Sent to the phone.' ? 'Test sent! Check your phone.' : r}` });
}

// "help with what I copied": text goes straight to the renderer's action picker; a copied
// picture (e.g. a Snipping Tool screenshot) is saved to a temp file Spidey can look at.
// ---------- smart screenshot: drag a box anywhere, Spidey reads it ----------

let snipWin = null, snipShot = null;

async function startSnip() {
  if (snipWin || !present) return;
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = sources.find((s) => s.display_id === String(d.id)) || sources[0];
  if (!src) return;
  snipShot = { image: src.thumbnail, display: d };
  snipWin = new BrowserWindow({
    ...d.bounds, frame: false, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, show: false,
    fullscreenable: false, backgroundColor: '#000000',
    webPreferences: { preload: path.join(__dirname, 'snip', 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  snipWin.setAlwaysOnTop(true, 'screen-saver');
  snipWin.loadFile(path.join(__dirname, 'snip', 'snip.html'));
  snipWin.webContents.once('did-finish-load', () => {
    snipWin.webContents.send('snip:image', snipShot.image.toDataURL());
    snipWin.setBounds(d.bounds);
    snipWin.show();
    snipWin.focus();
  });
  snipWin.on('closed', () => { snipWin = null; });
}

function endSnip() { if (snipWin && !snipWin.isDestroyed()) snipWin.close(); snipWin = null; }

ipcMain.on('snip:cancel', () => { endSnip(); snipShot = null; });
ipcMain.on('snip:done', async (_e, box) => {
  const shot = snipShot;
  endSnip();
  snipShot = null;
  if (!shot) return;
  const k = shot.image.getSize().width / shot.display.bounds.width;   // CSS px -> screenshot px
  const rect = { x: Math.round(box.x * k), y: Math.round(box.y * k), width: Math.round(box.w * k), height: Math.round(box.h * k) };
  const crop = shot.image.crop(rect);
  const dir = path.join(config.ROOT, 'runtime', 'clips');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `snip-${Date.now()}.png`);
  fs.writeFileSync(file, crop.toPNG());
  if (!present) return;
  if (!win.isVisible()) win.showInactive();
  send('snip:reading', { path: file });
  let text = '';
  if (ready) {
    const r = await tools.execute('look_at_image', { path: file, question: 'Transcribe ALL the text in this image exactly, keeping line breaks. Output only the text. If there is no text at all, describe the image in one sentence starting with "No text:".' }, { cfg, vision: agent?.toolCtx?.vision });
    text = String(r).replace(/^About [^:]+:\n/, '').trim();
  }
  send('snip:result', { path: file, text });
});
ipcMain.handle('notes:add', (_e, text) => tools.execute('notes', { action: 'add', text: String(text).slice(0, 4000) }, { cfg }));

function clipboardHelp() {
  if (!present) return;
  if (!win.isVisible()) win.showInactive();
  const text = clipboard.readText().trim();
  if (text) return send('hotkey:clip', { text: text.slice(0, 20000) });
  const img = clipboard.readImage();
  if (!img.isEmpty()) {
    const dir = path.join(config.ROOT, 'runtime', 'clips');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {   // keep the last few only
      const p = path.join(dir, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 864e5) fs.rmSync(p, { force: true });
    }
    const file = path.join(dir, `clip-${Date.now()}.png`);
    fs.writeFileSync(file, img.toPNG());
    return send('hotkey:clip', { image: file });
  }
  send('hotkey:clip', {});
}

// ---------- confirmations ----------

const pending = new Map();
let confirmSeq = 0;
function confirm(title, detail) {
  const id = ++confirmSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(false); send('confirm:cancel', { id }); }, 120000);
    pending.set(id, (ok) => { clearTimeout(timer); resolve(ok); });
    send('confirm:ask', { id, title, detail });
  });
}

// ---------- reminders ----------

// Saved to disk so they still fire after a restart (or right away if their time passed while he was off).
const REMINDERS_PATH = path.join(config.ROOT, 'reminders.json');
let reminders = [];
try { reminders = JSON.parse(fs.readFileSync(REMINDERS_PATH, 'utf8')); } catch {}
const saveReminders = () => { try { fs.writeFileSync(REMINDERS_PATH, JSON.stringify(reminders, null, 2)); } catch {} };

function armReminder(r) {
  r.timer = setTimeout(() => {
    reminders = reminders.filter((x) => x.id !== r.id);
    saveReminders();
    send('reminder', { message: r.message });
    phone.push(cfg, { title: 'Reminder', message: r.message, tags: 'alarm_clock', priority: 4, kind: 'reminders' });
    if (Notification.isSupported()) new Notification({ title: 'Kanishk', body: `Reminder: ${r.message}`, icon: trayIcon() }).show();
  }, Math.max(1000, r.due - Date.now()));
}

function reminder(minutes, message) {
  const r = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, due: Date.now() + minutes * 60000, message };
  reminders.push(r);
  saveReminders();
  armReminder(r);
}

const listReminders = () => reminders.map(({ due, message }) => ({ due, message })).sort((a, b) => a.due - b.due);

// countdown timers / focus sessions (not saved: they belong to the current sitting)
function timer(minutes, label, focus) {
  const endsAt = Date.now() + minutes * 60000;
  if (focus) focusUntil = Math.max(focusUntil, endsAt);
  send('timer', { label, focus, endsAt });
  setTimeout(() => {
    send('timer:done', { label, focus, minutes });
    phone.push(cfg, { title: focus ? 'Focus session done!' : "Time's up!", message: focus ? `${minutes} min of focus done. Take a break!` : label, tags: focus ? 'brain,tada' : 'stopwatch', priority: 4, kind: 'timers' });
    if (Notification.isSupported()) new Notification({ title: focus ? 'Focus session done' : 'Timer done', body: label, icon: trayIcon() }).show();
  }, minutes * 60000);
}

// ---------- senses: music level + focus guard (see monitor.ps1) ----------

let monitor = null;
let focusUntil = 0;
let lastNudge = 0;
const DISTRACTING = /youtube|instagram|netflix|reddit|facebook|tiktok|twitter|\bx\.com|prime video|hotstar|jiocinema|twitch|snapchat|9gag|primevideo/i;

function startMonitor() {
  if (monitor) return;
  monitor = require('child_process').spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'monitor.ps1')], { windowsHide: true });
  let buf = '';
  monitor.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith('level ')) { if (cfg.danceToMusic !== false) send('sense', { level: Number(line.slice(6)) || 0 }); }
      else if (line.startsWith('fg ')) focusGuard(line.slice(3));
    }
  });
  monitor.on('exit', () => { monitor = null; if (!app.isQuitting && present) setTimeout(startMonitor, 5000); });
}

/** During a focus session, a gentle nudge if a distracting site or app comes to the front. */
function focusGuard(title) {
  if (cfg.focusGuard === false || Date.now() > focusUntil || Date.now() - lastNudge < 3 * 60000) return;
  const hit = title.match(DISTRACTING);
  if (!hit) return;
  lastNudge = Date.now();
  const left = Math.max(1, Math.round((focusUntil - Date.now()) / 60000));
  const name = hit[0].replace(/\./g, '').replace(/^\w/, (c) => c.toUpperCase());
  send('focus:nudge', { app: name, minutesLeft: left });
}

// ---------- check-ins & presence ----------

let activeMinutes = 0;
let away = false;
let awaySince = 0;
let lastLateNight = '';

function startPresenceLoop() {
  setInterval(async () => {
    if (!present) return;
    const idle = powerMonitor.getSystemIdleTime();
    if (idle >= 300) {
      if (!away) { away = true; awaySince = Date.now() - idle * 1000; send('presence', { state: 'away' }); }
      activeMinutes = 0;
      return;
    }
    if (away) {
      away = false;
      const mins = Math.round((Date.now() - awaySince) / 60000);
      send('presence', { state: 'back', minutes: mins });
      if (mins >= 15 && ready) {
        const line = await agent.quickLine(`The user just came back to the computer after about ${mins} minutes away. Welcome them back.`);
        if (line) send('checkin', { text: line });
      }
    }
    activeMinutes++;
    const now = new Date();
    const key = now.toDateString();
    // once a day, the first time the user is at the PC in the morning
    if (ready && cfg.morningBriefing && now.getHours() >= 5 && now.getHours() < 12 && cfg.lastBriefing !== key && !agent.busy) {
      setCfg({ lastBriefing: key });
      const info = await tools.execute('briefing', {}, { cfg, listReminders }).catch(() => '');
      if (info) {
        if (cfg.personality !== 'quiet') send('agent:output', { title: 'Good morning briefing', content: info.replace(/^(\w[\w -]*):/gm, '**$1:**') });
        phone.push(cfg, { title: 'Good morning!', message: info.replace(/^(\w[\w -]*):/gm, '**$1:**'), tags: 'sunrise', kind: 'briefing' });
        const line = await agent.quickLine(`It's the user's first time at the PC this morning. Greet them and sum up this briefing in two short sentences:\n${info}`);
        if (line) send('checkin', { text: line });
      }
      return;
    }
    if (ready && now.getHours() >= 1 && now.getHours() < 4 && lastLateNight !== key) {
      lastLateNight = key;
      const line = await agent.quickLine(`It is ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} at night and the user is still on the computer. Gently, playfully nudge them toward sleep.`);
      if (line) send('checkin', { text: line });
      return;
    }
    // evening recap, once a day
    const [rh, rm] = String(cfg.recapTime || '21:30').split(':').map(Number);
    if (ready && cfg.dailyRecap && cfg.lastRecap !== key && now.getHours() * 60 + now.getMinutes() >= rh * 60 + (rm || 0) && !agent.busy) {
      setCfg({ lastRecap: key });
      const data = await tools.execute('daily_recap', {}, { cfg, listReminders });
      if (/Requests today \((?!0\))/.test(data)) {   // only when he actually helped today
        const line = await agent.quickLine(`It's evening. Give a warm two-sentence wrap-up of the user's day from this recap:\n${data}`);
        if (cfg.personality !== 'quiet') send('agent:output', { title: 'Your day with Kanishk', content: data.replace(/^(\w[\w ()0-9-]*):/gm, '**$1:**') });
        phone.push(cfg, { title: 'Your day with Kanishk', message: data.replace(/^(\w[\w ()0-9-]*):/gm, '**$1:**'), tags: 'crescent_moon', kind: 'recap' });
        if (line) send('checkin', { text: line });
      }
      return;
    }
    const every = cfg.personality === 'focus' || cfg.personality === 'quiet' ? 0 : cfg.personality === 'chatty' ? Math.min(30, cfg.checkInMinutes || 30) : cfg.checkInMinutes;
    if (ready && every > 0 && activeMinutes >= every) {
      activeMinutes = 0;
      const ideas = ['suggest a quick stretch', 'remind them to drink water', 'ask how their work is going and offer help',
        'suggest resting their eyes for 20 seconds', 'cheer them on', 'ask if they want you to take something off their plate'];
      const idea = ideas[Math.floor(Math.random() * ideas.length)];
      const line = await agent.quickLine(`The user has been working for about ${every} minutes straight. Check up on them: ${idea}.`);
      if (line) send('checkin', { text: line });
    }
  }, 60000);
}

// ---------- IPC ----------

let drag = null;
ipcMain.on('mouse:interactive', (_e, on) => win?.setIgnoreMouseEvents(!on, { forward: true }));
ipcMain.on('win:focus', () => { win?.focus(); });
ipcMain.on('win:drag-start', () => {
  drag = { cursor: screen.getCursorScreenPoint(), pos: win.getPosition() };
});
ipcMain.on('win:drag', () => {
  if (!drag) return;
  const c = screen.getCursorScreenPoint();
  placeWindow(drag.pos[0] + c.x - drag.cursor.x, drag.pos[1] + c.y - drag.cursor.y);
});
ipcMain.on('win:drag-end', () => {
  if (!drag) return;
  drag = null;
  setCfg({ winPos: win.getPosition() });   // he stays where you put him, even after a restart
});
ipcMain.on('menu:show', () => Menu.buildFromTemplate(menuTemplate()).popup({ window: win }));

ipcMain.handle('config:get', () => cfg);
ipcMain.on('agent:ask', (_e, text) => {
  if (resting) { send('agent:final', { text: '[sleepy] Yawn... I was napping. Say that again?' }); wake(); return; }
  if (!ready) { send('agent:final', { text: "[sleepy] Gimme a sec, I'm still waking up!" }); return; }
  askStartedAt = Date.now();
  agent.ask(String(text));
});
ipcMain.on('agent:stop', () => agent?.stop());
ipcMain.on('wake', () => wake());
ipcMain.on('show:again', () => showAgain());
ipcMain.on('confirm:reply', (_e, { id, ok }) => { pending.get(id)?.(ok); pending.delete(id); });
ipcMain.handle('stt:transcribe', async (_e, wav) => {
  try { return { text: await servers.transcribe(wav, `Hey ${cfg.name || 'Kanishk'}. ${cfg.name || 'Kanishk'}, ${cfg.userName || 'Varuna'}.`) }; } catch (e) { log('stt', e.message); return { error: e.message }; }
});
ipcMain.on('open:external', (_e, url) => { if (/^(https?:|mailto:|ms-settings:)/i.test(url)) shell.openExternal(url); });
ipcMain.handle('mic:fix', () => tools.audio('mic-fix'));
ipcMain.handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Give Kanishk some files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images, documents and code', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'pdf', 'docx', 'pptx', 'xlsx', 'txt', 'md', 'csv', 'json', 'log', 'py', 'js', 'ts', 'html', 'css', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'php', 'rb', 'sql', 'xml', 'yaml', 'yml', 'ini', 'ps1', 'bat', 'sh'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('file:open', (_e, p) => (fs.existsSync(p) ? shell.openPath(p) : 'missing'));
ipcMain.on('file:reveal', (_e, p) => { if (fs.existsSync(p)) shell.showItemInFolder(p); });
ipcMain.on('log', (_e, tag, msg) => log(`ui:${tag}`, msg));
ipcMain.handle('output:save', async (_e, { title, content }) => {
  const safe = String(title || 'kanishk-output').replace(/[<>:"/\\|?*]+/g, '').slice(0, 60) || 'kanishk-output';
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('desktop'), `${safe}.md`),
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, content, 'utf8');
  return r.filePath;
});
ipcMain.on('tts:fallback', (_e, text) => {
  const safe = String(text).replace(/'/g, "''").slice(0, 600);
  tools.powershell(`Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 1; $s.Speak('${safe}')`)
    .then(() => send('tts:done'));
});

// ---------- boot ----------

async function boot() {
  send('boot', { stage: 'loading', message: 'Waking up…' });
  const chipBrain = {
    connected: () => !!chip?.connected(),
    think: (text) => chip.think(text, cfg.userName || 'Varuna'),
    story: (about, onPiece) => chip.story(about, onPiece),
  };
  agent = new Agent({ cfg, emit: emitAndNotify, confirm, reminder, log, toolCtx: { screenshot, releaseFocus, timer, listReminders, self: selfControl, chip: chipBrain } });
  await servers.cleanupStale();
  reminders.forEach(armReminder);   // restore reminders saved before the last shutdown
  await startBrain();
}

/** His brain is Groq (online) or the chip (offline), so there's nothing heavy to load: just his ears. */
async function startBrain() {
  const ears = servers.startWhisper(cfg, log)
    .then(() => send('boot', { stage: 'ears', ok: true }))
    .catch((e) => { log('whisper', e.message); send('boot', { stage: 'ears', ok: false, message: e.message }); });
  // ready right away (each message picks Groq or the chip itself); the internet check is just for the log
  ready = true;
  resting = false;
  send('boot', { stage: 'ready' });
  groq.online().then((online) => log('brain', online ? 'online: Groq answers, the chip is the fallback' : 'offline: the chip brain answers'));
  await ears;
}

// ---------- his chip: plug it in and he appears, unplug it and he leaves ----------

let greetedOnce = false;
let spideyPresent = false;
/** Is Spidey (the other companion) on screen? Then Kanishk sits beside him instead of on top of him. */
function checkSpidey() {
  return new Promise((resolve) => {
    require('child_process').execFile('powershell.exe', ['-NoProfile', '-Command',
      "@(Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'Spidey' }).Count"],
    { windowsHide: true, timeout: 8000 }, (err, out) => resolve(!err && Number(String(out).trim()) > 0));
  });
}
async function arrive(info) {
  present = true;
  log('chip', `connected on ${info.port} (fw ${info.fw})`);
  if (!Array.isArray(cfg.winPos)) {
    spideyPresent = await checkSpidey();
    const { workArea } = screen.getPrimaryDisplay();
    if (spideyPresent) placeWindow(workArea.x + workArea.width - 2 * winSize[0], workArea.y + workArea.height - winSize[1]);
    else dock();
  }
  win.showInactive();
  buildMenus();
  startMonitor();
  startGuardian();
  if (!greetedOnce) {
    greetedOnce = true;
    if (!agent) await bootOnce();       // first arrival: boot (the page greets on 'ready')
    else if (!ready) await startBrain();
    else send('boot', { stage: 'ready' });
  } else {
    if (!ready && !resting) await startBrain();
    send('return');
  }
}
function leave() {
  present = false;
  log('chip', 'unplugged: Kanishk leaves');
  send('goodbye', { kind: 'unplug' });
  agent?.stop();
  setTimeout(() => { if (!present) { win.hide(); buildMenus(); } }, 1800);
  // nothing to listen with while he's away
  ready = false;
  servers.stopAll();
  try { monitor?.kill(); } catch {}
  buildMenus();
}

// ---------- spider-sense: warns when something is hogging the PC ----------

const GUARD_PS = `
$os = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$c = Get-PSDrive C -ErrorAction SilentlyContinue
$skip = @('llama-server','whisper-server','electron','Idle','System','Memory Compression','Registry','vmmem','powershell')
$procs = Get-Process | Where-Object { $skip -notcontains $_.ProcessName } | Group-Object ProcessName | ForEach-Object {
  [pscustomobject]@{ n = $_.Name; mb = [math]::Round(($_.Group | Measure-Object WorkingSet64 -Sum).Sum / 1MB); cpu = [math]::Round(($_.Group | Measure-Object CPU -Sum).Sum, 1) } }
[pscustomobject]@{
  mem = [math]::Round((1 - $os.FreePhysicalMemory / $os.TotalVisibleMemorySize) * 100)
  totalGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
  cpu = $cpu
  freeGb = $(if ($c) { [math]::Round($c.Free / 1GB, 1) } else { -1 })
  procs = @($procs | Sort-Object cpu -Descending | Select-Object -First 25) + @($procs | Sort-Object mb -Descending | Select-Object -First 5)
} | ConvertTo-Json -Compress -Depth 3`;

const guard = { memHigh: 0, cpuHigh: 0, lastCpu: {}, warned: {} };

let guardianStarted = false;
function startGuardian() {
  if (guardianStarted) return;
  guardianStarted = true;
  const tick = async () => {
    if (cfg.spideySense === false || !present) return;
    const r = await tools.powershell(GUARD_PS, { timeoutMs: 60000 });
    let d;
    try { d = JSON.parse(r.output); } catch { return; }
    const procs = Array.isArray(d.procs) ? d.procs : [d.procs].filter(Boolean);
    // CPU: who burned the most CPU time since the last check
    const deltas = procs.map((p) => ({ n: p.n, dt: guard.lastCpu[p.n] != null ? p.cpu - guard.lastCpu[p.n] : 0 }));
    for (const p of procs) guard.lastCpu[p.n] = p.cpu;
    const cpuHog = deltas.sort((a, b) => b.dt - a.dt)[0];
    const memHog = [...procs].sort((a, b) => b.mb - a.mb)[0];
    const can = (k, minutes) => Date.now() - (guard.warned[k] || 0) > minutes * 60000 && ((guard.warned[k] = Date.now()), true);
    const pretty = (n) => (n || 'an app').replace(/^msedge$/i, 'Edge').replace(/^chrome$/i, 'Chrome').replace(/^Code$/, 'VS Code');

    guard.memHigh = d.mem >= 97 ? guard.memHigh + 1 : 0;   // 90-95% is normal on this laptop (Windows compresses memory)
    guard.cpuHigh = d.cpu >= 85 ? guard.cpuHigh + 1 : 0;
    if (guard.memHigh >= 2 && memHog && can('mem', 120)) {
      send('sense:warn', { text: `Spider-sense tingling! Memory is ${d.mem}% full. ${pretty(memHog.n)} is using ${(memHog.mb / 1024).toFixed(1)} GB. Want me to close it?` });
    } else if (guard.cpuHigh >= 3 && cpuHog?.dt > 30 && can('cpu', 45)) {
      send('sense:warn', { text: `Spider-sense tingling! Your CPU has been above 85% for a few minutes, mostly ${pretty(cpuHog.n)}. Want me to close it?` });
    } else if (d.freeGb >= 0 && d.freeGb < 3 && can('disk', d.freeGb < 1 ? 60 : 12 * 60)) {
      send('sense:warn', { text: `Spider-sense tingling! Only ${d.freeGb} GB left on drive C. Want me to find big files you could delete or empty the Recycle Bin?` });
    }
  };
  setTimeout(tick, 30000);
  setInterval(tick, 2 * 60000);
}

// ---------- controlling Kanishk himself (tray, or by asking him) ----------

let resting = false;
let bootOnce = null;
let afterReply = null;   // something to do once the current reply has been shown/spoken

/** Nap: he stops listening and sleeps in his corner; click him to wake. */
function rest() {
  if (resting) return;
  resting = true;
  ready = false;
  servers.stopAll();
  send('rest', { on: true });
  buildMenus();
}
async function wake() {
  if (!resting) return;
  send('rest', { on: false });
  buildMenus();
  await startBrain();
  buildMenus();
}

function hideFor(minutes) {
  if (!present) return;
  send('goodbye', { kind: 'hide', minutes });
  setTimeout(() => { win.hide(); buildMenus(); }, 1700);
  if (minutes > 0) setTimeout(() => showAgain(), minutes * 60000);
}
function showAgain() {
  if (!present) return;
  if (!win.isVisible()) win.showInactive();
  send('return');
  buildMenus();
}
function quitSpidey() {
  send('goodbye', { kind: 'quit' });
  setTimeout(() => app.quit(), 2200);
}

function setAutostart(on) {
  // starts hidden in the tray at login, then shows himself the moment his chip is plugged in
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: [path.resolve(config.ROOT), '--hidden'], name: 'Kanishk' });
  setCfg({ startWithWindows: on });
}

const MODES = { buddy: 'Buddy (default)', quiet: 'Quiet: no voice, no chatter', focus: 'Focus: short answers, no jokes', chatty: 'Chatty: extra fun', study: 'Study buddy: teaches and quizzes' };

/** Called by the 'kanishk' tool. Things that would interrupt the reply wait until it's done. */
function selfControl(action, value) {
  const v = String(value || '').toLowerCase().trim();
  switch (action) {
    case 'mode': {
      const id = Object.keys(MODES).find((k) => v.includes(k)) || (/normal|default|regular/.test(v) ? 'buddy' : /silent|shh|mute/.test(v) ? 'quiet' : null);
      if (!id) return `Unknown mode "${value}". Modes: ${Object.keys(MODES).join(', ')}.`;
      setCfg({ personality: id });
      return `Mode is now ${id}.`;
    }
    case 'move': send('move', { name: v || 'backflip' }); return `Doing: ${v || 'backflip'}.`;
    case 'hide': { const m = Math.max(1, Math.min(600, parseInt(v, 10) || 30)); afterReply = () => hideFor(m); return `Hiding for ${m} minute${m === 1 ? "" : "s"} (the tray icon brings me back sooner).`; }
    case 'corner': dock(); setCfg({ winPos: null }); return 'Back in my corner.';
    case 'chat': send('panel:show', { tab: 'chat' }); return 'Opened our chat history in my panel.';
    case 'panel': send('panel:show'); return 'Showing the last output in my panel.';
    case 'game': afterReply = () => send('game:start'); return 'Starting catch-the-bug after this message: she clicks bugs, Kanishk webs them, 45 seconds.';
    case 'voice_on': setCfg({ voice: { ...cfg.voice, enabled: true } }); return 'Voice on.';
    case 'voice_off': setCfg({ voice: { ...cfg.voice, enabled: false } }); return 'Voice off; I will only show text.';
    case 'rest': afterReply = () => rest(); return 'Taking a little nap after this message. Click me to wake me up.';
    case 'autostart_on': setAutostart(true); return 'I will start automatically when Windows starts.';
    case 'autostart_off': setAutostart(false); return 'I will not start with Windows anymore.';
    case 'quit': afterReply = () => quitSpidey(); return 'Turning myself off after this message. I come back by myself the next time Windows starts.';
    default: return `Unknown action ${action}.`;
  }
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'microphone', 'audioCapture', 'clipboard-sanitized-write'].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => ['media', 'microphone', 'audioCapture'].includes(perm));
  createWindow();
  buildMenus();
  // always start with Windows (hidden), so plugging in the chip is all it takes
  if (cfg.startWithWindows !== false) setAutostart(true);
  try {
    const keys = [
      [cfg.hotkeys.talk, () => { if (!present) return; if (!win.isVisible()) win.showInactive(); send('hotkey:talk'); }],
      [cfg.hotkeys.type, () => { if (!present) return; if (!win.isVisible()) win.showInactive(); win.focus(); send('hotkey:type'); }],
      [cfg.hotkeys.clipboard, () => clipboardHelp()],
      [cfg.hotkeys.screen, () => { if (!present) return; if (!win.isVisible()) win.showInactive(); send('hotkey:screen'); }],
      [cfg.hotkeys.snip, () => startSnip()],
    ];
    for (const [key, fn] of keys) if (key && !globalShortcut.register(key, fn)) log('hotkey', `${key} is taken by another app`);
  } catch (e) { log('hotkey', e.message); }
  let booting = null;
  win.webContents.on('did-finish-load', () => {
    send('config', cfg);
    sendVisible();
    // back in whatever he was wearing last time
    if (cfg.wearing) { const spec = tools.savedOutfits().find((o) => o.id === cfg.wearing); if (spec) send('outfit:wear', { spec, quiet: true }); }
    pageLoaded = true;
    if (booting && ready && present) send('boot', { stage: 'ready' });   // page reloaded after boot
  });
  // the page must exist before he can arrive; then watch the USB ports for his chip
  let pageLoaded = false;
  bootOnce = () => { if (!booting) booting = boot(); return booting; };
  const startWatching = () => {
    if (!pageLoaded) return setTimeout(startWatching, 200);
    chip = new Chip(log);
    chip.on('connected', (info) => arrive(info).catch((e) => log('chip', e.stack || String(e))));
    chip.on('disconnected', () => leave());
    chip.start();
  };
  startWatching();
  startPresenceLoop();
  // a resolution change, a monitor unplugged or the taskbar moving: pull him back on screen
  const recheck = () => { const [x, y] = win.getPosition(); placeWindow(x, y); };
  screen.on('display-metrics-changed', recheck);
  screen.on('display-removed', recheck);
  screen.on('display-added', recheck);
});

app.on('second-instance', () => {
  if (win && present) { win.showInactive(); send('agent:final', { text: "[happy] I'm already here, right in the corner!" }); }
  else if (Notification.isSupported()) new Notification({ title: 'Kanishk', body: "I'm ready! Plug in my chip and I'll pop right up.", icon: trayIcon() }).show();
});
app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); servers.stopAll(); try { monitor?.kill(); } catch {} try { chip?.stop(); } catch {} });
app.on('window-all-closed', (e) => e.preventDefault?.());   // he lives in the tray between visits
process.on('exit', () => servers.stopAll());
