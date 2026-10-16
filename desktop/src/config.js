// Settings live in config.json next to package.json so they are easy to hand-edit.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const MEMORY_PATH = path.join(ROOT, 'memory.json');
const SECRETS_PATH = path.join(ROOT, 'secrets.json');   // Groq API keys (never shown in config.json)

const DEFAULTS = {
  name: 'Kanishk',           // who he is
  userName: 'Varuna',        // who he loves
  // 'confirm-risky': asks before deleting/formatting/shutting down etc.
  // 'full':          runs everything without asking.
  // 'confirm-all':   asks before every command or file write.
  permissionMode: 'confirm-risky',
  // wakeWord: always listening for "Hey Kanishk" (processed locally, nothing leaves the PC)
  // followUp: after answering a voice request, listen a few seconds for a follow-up
  voice: { enabled: true, wakeWord: true, followUp: true, voiceName: '', rate: 1.08, pitch: 1.15, volume: 1 },
  checkInMinutes: 45,
  morningBriefing: true,     // weather, reminders, to-do and headlines the first time you're on in the morning
  dailyRecap: true,          // an evening summary of your day
  recapTime: '21:30',
  // Kanishk -> phone notifications via the free ntfy app (outbound only). Set up from the tray menu.
  phone: { enabled: false, server: 'https://ntfy.sh', topic: '', notify: { reminders: true, timers: true, briefing: true, recap: true, tasks: true } },
  spideySense: true,        // warn when an app hogs memory/CPU or the disk is almost full
  danceToMusic: true,       // headphones on and dancing while the PC plays music (reads only the volume level)
  focusGuard: true,         // during focus sessions, nudge you if YouTube/Instagram/... comes to the front
  birthday: '',             // "MM-DD": party hat and a surprise on your birthday
  personality: 'buddy',      // buddy | quiet (no voice, no chatter) | focus (short answers) | chatty | study (teaches and quizzes)
  city: '',                  // for weather; empty = detect from your connection
  scale: 4,
  // his brain: Groq when the PC is online (keys in secrets.json; each model+key pair is a separate rate limit),
  // the ESP32 chip brain when it's offline
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', models: ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b'], visionModel: 'qwen/qwen3.8-27b' },
  sampling: { temperature: 0.8, top_p: 0.95 },
  whisperPort: 8763,         // his own speech recognizer (Spidey uses 8743), so both can run at once
  // different keys from Spidey's, so both can run at once.
  // talk/type: start talking or typing; clipboard: help with what you copied; screen: he looks at your screen; snip: grab & read
  hotkeys: { talk: 'Control+Alt+Space', type: 'Control+Alt+K', clipboard: 'Control+Alt+B', screen: 'Control+Alt+L', snip: 'Control+Alt+N' },
  startWithWindows: true,    // starts hidden at login and shows himself when his chip is plugged in
};

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object'
      ? merge(base[k], v) : v;
  }
  return out;
}

function load() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  const cfg = merge(DEFAULTS, user);
  if (!fs.existsSync(CONFIG_PATH)) save(cfg);
  return cfg;
}

function save(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function loadMemory() {
  try { return JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8')); } catch { return []; }
}

function addMemory(fact) {
  const mem = loadMemory();
  mem.push({ fact, at: new Date().toISOString() });
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(mem.slice(-200), null, 2));
  return mem.length;
}

function loadSecrets() {
  try { return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8')); } catch { return {}; }
}

module.exports = { ROOT, CONFIG_PATH, load, save, loadMemory, addMemory, loadSecrets };
