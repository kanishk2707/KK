// Everything Kanishk can do on the computer. Each tool has an OpenAI-style schema
// (sent to the model) and an implementation that runs here in the main process.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shell, clipboard, nativeImage } = require('electron');
const config = require('./config');
const groq = require('./groq');
const phone = require('./phone');

const HOME = os.homedir();
const DESKTOP = path.join(HOME, 'Desktop');
const MAX_OUT = 8000;
const AUDIO_PS = path.join(__dirname, 'audio.ps1');

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

const SCHEMAS = [
  fn('open',
    'Open an app (e.g. "chrome", "spotify", "vs code", "whatsapp", "calculator", "settings"), a website/URL, a file or a folder ' +
    '(e.g. "Downloads", "Desktop", "Documents"). Use this whenever the user says open/launch/start/go to.',
    {
      target: { type: 'string', description: 'App name, URL, or a file/folder path or just its name (it is searched for)' },
      app: { type: 'string', description: 'Open the file WITH this app, e.g. "vs code", "notepad", "chrome"' },
      new_window: { type: 'boolean', description: 'VS Code: open in a new window' },
    }, ['target']),
  fn('close_app', 'Close a running app or window by name (e.g. "notepad", "chrome", "calculator", "spotify").',
    {
      name: { type: 'string' },
      force: { type: 'boolean', description: 'Kill it even if it is asking to save (may lose unsaved work)' },
    }, ['name']),
  fn('play_music', 'PLAY a song, artist or video and confirm it is playing. app = where the user wants it: "spotify", "apple music", "youtube music" or "youtube" (default when no app is named). For "something trending / any new song" pass query "trending". To just open an app, use open instead.',
    { query: { type: 'string', description: 'Song (and artist) to play, or "trending"' }, app: { type: 'string', enum: ['youtube', 'spotify', 'apple music', 'youtube music'] } }, ['query']),
  fn('run_command',
    'Run a PowerShell command on the user\'s Windows PC and get its output. Use for anything without a dedicated tool: ' +
    'files and folders (create/move/rename/delete), installing apps (winget), python/git/node, processes, network, settings.',
    {
      command: { type: 'string', description: 'PowerShell code to run' },
      cwd: { type: 'string', description: 'Working directory (default: user home)' },
      timeout_seconds: { type: 'number', description: 'Max seconds to wait (default 60, max 600)' },
      elevated: { type: 'boolean', description: 'Run as Administrator (Windows shows a UAC prompt)' },
    }, ['command']),
  fn('write_file',
    'Create or overwrite a file (code, essays, notes, letters, html, scripts...). Use when the user wants something saved or created as a file. Parent folders are created automatically.',
    {
      path: { type: 'string', description: 'Absolute path, or relative to the user home, e.g. "Desktop/notes.md"' },
      content: { type: 'string', description: 'The FULL file content' },
      append: { type: 'boolean', description: 'Append instead of overwrite' },
    }, ['path', 'content']),
  fn('read_file', 'Read a file: text, code, PDF, Word (.docx), PowerPoint (.pptx) or Excel (.xlsx). For pictures use look_at_image.', { path: { type: 'string' } }, ['path']),
  fn('look_at_image', 'Look at an image file (photo, screenshot, diagram, scanned page) and answer a question about it.',
    { path: { type: 'string' }, question: { type: 'string' } }, ['path']),
  fn('send_to_phone', "Send text (notes, code, a list, a summary) or a file to the user's phone as a notification.",
    {
      text: { type: 'string', description: 'What to send (markdown ok)' },
      title: { type: 'string' },
      path: { type: 'string', description: 'A file to send instead (max 15 MB)' },
    }),
  fn('kanishk', "Control Kanishk himself (you): change mode, do a move/trick, open our chat history (chat) or the last output (panel), hide for a while, go back to the corner, mute/unmute his voice, rest (a little nap), start-with-Windows on/off, or turn off.",
    {
      action: { type: 'string', enum: ['mode', 'move', 'hide', 'corner', 'voice_on', 'voice_off', 'rest', 'autostart_on', 'autostart_off', 'quit', 'game', 'chat', 'panel'] },
      value: { type: 'string', description: 'mode: buddy | quiet | focus | chatty | study. move: backflip | swing | climb | webart | peekaboo | yoyo | sit | dance | wave. hide: minutes (default 30).' },
    }, ['action']),
  fn('outfit', 'Dress Kanishk up: design (draw) and wear any outfit or costume the user describes, wear a saved one, take it off, or list the wardrobe.',
    {
      action: { type: 'string', enum: ['wear', 'remove', 'list', 'redesign'] },
      description: { type: 'string', description: 'What to wear, e.g. "cricket kit", "wizard", "Iron Man colours with a shield"' },
    }, ['action']),
  fn('save_routine', 'Save a routine: a phrase that runs a list of steps later (e.g. "work mode" = open VS Code, open Spotify, start a 50 minute focus session).',
    { name: { type: 'string', description: 'The trigger phrase' }, steps: { type: 'string', description: 'The steps, one per line' } }, ['name', 'steps']),
  fn('run_routine', 'Run a saved routine by name. Returns its steps; then carry them all out with tools.', { name: { type: 'string' } }, ['name']),
  fn('list_routines', 'List saved routines (or delete one with delete=name).', { delete: { type: 'string' } }),
  fn('daily_recap', "Gather today's activity (what the user asked, what got done), open to-dos and upcoming reminders for a recap of the day."),
  fn('list_dir', 'List the files and folders in a directory.', { path: { type: 'string' } }, ['path']),
  fn('show_output',
    'Show long content to the user in the output panel (documents, code, tables, lists, results). The user sees it immediately.',
    { title: { type: 'string' }, content: { type: 'string', description: 'Markdown' } }, ['title', 'content']),
  fn('web_search', 'Search the web for current information (news, facts, prices, how-tos). Returns titles, links and snippets.',
    { query: { type: 'string' } }, ['query']),
  fn('fetch_url', 'Download a web page or API and return its readable text. Weather: https://wttr.in/CITY?format=3',
    { url: { type: 'string' } }, ['url']),
  fn('system_info', 'Get battery, CPU, memory, disk space, Wi-Fi, IP address, uptime and the heaviest running apps.'),
  fn('system_control', 'Control the PC: set volume, mute, brightness, lock, sleep, shutdown, restart, take a screenshot, empty the recycle bin.',
    {
      action: { type: 'string', enum: ['volume_up', 'volume_down', 'volume', 'mute', 'unmute', 'brightness', 'lock', 'sleep', 'shutdown', 'restart', 'screenshot', 'empty_recycle_bin'] },
      value: { type: 'number', description: 'Percent for volume/brightness (0-100); step size for volume_up/down (default 10)' },
    }, ['action']),
  fn('media_control', 'Play/pause, next or previous track for whatever music or video is playing.',
    { action: { type: 'string', enum: ['play_pause', 'next', 'previous'] } }, ['action']),
  fn('keyboard', 'Type text or press keys in another app (e.g. type a message into Notepad, press ctrl+s, enter, alt+tab).',
    {
      window: { type: 'string', description: 'Window/app to switch to first, e.g. "notepad" (optional)' },
      text: { type: 'string', description: 'Text to type' },
      keys: { type: 'string', description: 'Keys to press after typing, e.g. "enter", "ctrl+s", "ctrl+a", "alt+f4", "tab"' },
    }),
  fn('look_at_screen', 'Take a screenshot and look at it to answer a question about what is on the user\'s screen (read text, explain an error, describe).',
    { question: { type: 'string' } }, ['question']),
  fn('set_reminder', 'Remind the user about something, after some minutes or at a clock time. Reminders survive restarts.',
    {
      minutes: { type: 'number', description: 'Minutes from now' },
      at: { type: 'string', description: 'Clock time like "18:30" or "7:15 am" (today, or tomorrow if already past)' },
      message: { type: 'string' },
    }, ['message']),
  fn('timer', 'Start a countdown timer (e.g. "5 minute timer", "pomodoro"). focus=true starts a focus session: Kanishk works next to her and cheers at the end.',
    {
      minutes: { type: 'number' },
      label: { type: 'string' },
      focus: { type: 'boolean', description: 'Focus/pomodoro session' },
    }, ['minutes']),
  fn('search', 'Open search results for something on a site or app: google, youtube, amazon, flipkart, wikipedia, maps, images, news, ' +
    'github, reddit, stackoverflow, spotify, youtube music, linkedin, bing, duckduckgo, chatgpt, perplexity, or any website domain.',
    { where: { type: 'string', description: 'Site or app (default google)' }, query: { type: 'string' }, browser: { type: 'string', description: 'Show it in this browser when the user names one: "chrome", "edge", "firefox"' } }, ['query']),
  fn('study_pack', 'Make a full STUDY PACK file (notes + one-page summary + 15 flashcards + 10-question quiz) from a lecture recording (mp3/m4a/wav/mp4...), slides, PDF, Word or a photo of notes. Use it ONLY when the user asks for a study pack / notes and flashcards, or gives a lecture recording. For a few quiz questions, a summary or an explanation of slides, use read_file and answer yourself. Takes minutes for long recordings.',
    { path: { type: 'string', description: 'The lecture file' }, title: { type: 'string', description: 'Only if the user named the subject, e.g. "Flip-flops"; otherwise leave it out' } }, ['path']),
  fn('search_in_files', 'Search INSIDE the user\'s files (text, code, notes, PDF, Word, PowerPoint, Excel) for words or a topic, e.g. "where did I write the flip-flop code". Returns files with matching lines. Give several spellings/keywords.',
    { query: { type: 'string', description: 'Keywords, e.g. "flip-flop flipflop JK"' }, folder: { type: 'string', description: 'Optional folder to limit the search' } }, ['query']),
  fn('organize_folder', 'Tidy a folder (e.g. Downloads): FIRST call without apply to get a plan (type folders, duplicates, big old files) and show it; only after the user agrees call again with apply=true. Never deletes anything.',
    { path: { type: 'string' }, apply: { type: 'boolean' } }, ['path']),
  fn('undo_organize', 'Undo the last folder tidy-up: put every moved file back.'),
  fn('find_files', 'Find files or folders on this PC by (part of) their name, newest first.',
    {
      name: { type: 'string' },
      folder: { type: 'string', description: 'Where to look (default: Desktop, Documents, Downloads, Pictures, Videos, Music, OneDrive)' },
    }, ['name']),
  fn('todo', "Manage the user's to-do / shopping list.",
    { action: { type: 'string', enum: ['add', 'list', 'done', 'remove', 'clear'] }, item: { type: 'string' } }, ['action']),
  fn('notes', 'Quick notes journal: add a note, or find/list past notes (dated).',
    { action: { type: 'string', enum: ['add', 'find', 'list'] }, text: { type: 'string', description: 'Note text, or words to find' } }, ['action']),
  fn('window', 'Tidy windows: minimize_all (show desktop), or minimize / maximize / restore a named app window.',
    { action: { type: 'string', enum: ['minimize_all', 'minimize', 'maximize', 'restore'] }, name: { type: 'string' } }, ['action']),
  fn('briefing', 'Daily briefing: date, weather, reminders, to-do list and a few headlines.',
    { city: { type: 'string', description: 'City for weather (optional)' } }),
  fn('clipboard', 'Read or write the clipboard.',
    { action: { type: 'string', enum: ['read', 'write'] }, text: { type: 'string' } }, ['action']),
  fn('remember', 'Save a NEW personal fact the user shares or asks you to remember (preferences, projects, people, routines). Never for greetings or small talk.',
    { fact: { type: 'string' } }, ['fact']),
];

// Commands that can destroy data or take the machine down.
const RISKY = [
  /\b(remove-item|rm|rmdir|rd|del|erase)\b/i,
  /\b(format(-volume)?|diskpart|clear-disk|initialize-disk|remove-partition)\b/i,
  /\b(stop-computer|restart-computer|shutdown|logoff)\b/i,
  /\breg(\.exe)?\s+(delete|add)\b|\bremove-itemproperty\b|\bset-itemproperty\b.*\bhklm\b/i,
  /\b(bcdedit|cipher\s+\/w|takeown|icacls|vssadmin)\b/i,
  /\b(net\s+user|set-executionpolicy|disable-|uninstall-|winget\s+uninstall)\b/i,
  /\bclear-(content|recyclebin)\b|\bset-content\b/i,
  /\bstop-process\b.*-name\s+\*|\btaskkill\b.*\/im\s+\*/i,
];

function isRisky(command) {
  return RISKY.some((re) => re.test(command));
}

const KNOWN_FOLDERS = {
  desktop: DESKTOP, downloads: path.join(HOME, 'Downloads'), documents: path.join(HOME, 'Documents'),
  pictures: path.join(HOME, 'Pictures'), music: path.join(HOME, 'Music'), videos: path.join(HOME, 'Videos'),
  home: HOME, 'user folder': HOME,
};

function expand(p) {
  if (!p) return HOME;
  let s = String(p).trim().replace(/^["']|["']$/g, '');
  s = s.replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`);
  s = s.replace(/\$env:(\w+)/gi, (_, v) => process.env[v] ?? '');
  s = s.replace(/^~(?=$|[\\/])/, HOME);
  const known = KNOWN_FOLDERS[s.toLowerCase().replace(/^(my|the)\s+/, '').replace(/\s+folder$/, '')];
  if (known) return known;
  if (!path.isAbsolute(s)) {
    // "Desktop/x.txt", "downloads\\y" -> resolve against the real known folder
    const first = s.split(/[\\/]/)[0].toLowerCase();
    if (KNOWN_FOLDERS[first]) return path.normalize(path.join(KNOWN_FOLDERS[first], s.slice(first.length)));
    s = path.join(HOME, s);
  }
  return path.normalize(s);
}

function clip(text, max = MAX_OUT) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  return `${s.slice(0, head)}\n…[${s.length - max} chars cut]…\n${s.slice(-(max - head))}`;
}

function powershell(command, { cwd, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const prefix = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference="SilentlyContinue"; ';
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prefix + command],
      { cwd: cwd || HOME, windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { out += `\n[timed out after ${timeoutMs / 1000}s]`; child.kill(); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { out += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, output: String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output: out.trim() }); });
  });
}

function audio(action, value) {
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', AUDIO_PS, action];
    if (value !== undefined) args.push(String(Math.round(value)));
    const child = spawn('powershell.exe', args, { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', () => resolve(out.trim()));
    child.on('error', (e) => resolve(`error: ${e.message}`));
  });
}

async function runElevated(command, cwd, timeoutMs) {
  const id = Date.now();
  const script = path.join(os.tmpdir(), `spidey-admin-${id}.ps1`);
  const outFile = path.join(os.tmpdir(), `spidey-admin-${id}.txt`);
  fs.writeFileSync(script, `Set-Location -LiteralPath '${(cwd || HOME).replace(/'/g, "''")}'\r\n& {\r\n${command}\r\n} *> '${outFile}'\r\n`, 'utf8');
  const launch = `Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','"${script}"'`;
  const r = await powershell(launch, { timeoutMs });
  let output = r.output;
  try { output = (output ? output + '\n' : '') + fs.readFileSync(outFile, 'utf8'); } catch {}
  fs.rmSync(script, { force: true });
  fs.rmSync(outFile, { force: true });
  return { code: r.code, output: output.trim() };
}

// ---------- open ----------

// Common names that don't match a Start-menu shortcut by themselves.
const ALIASES = {
  youtube: 'https://www.youtube.com', google: 'https://www.google.com', gmail: 'https://mail.google.com',
  instagram: 'https://www.instagram.com', facebook: 'https://www.facebook.com', twitter: 'https://x.com', x: 'https://x.com',
  netflix: 'https://www.netflix.com', 'chat gpt': 'https://chatgpt.com', chatgpt: 'https://chatgpt.com', github: 'https://github.com',
  linkedin: 'https://www.linkedin.com', reddit: 'https://www.reddit.com', amazon: 'https://www.amazon.in', maps: 'https://maps.google.com',
  'google maps': 'https://maps.google.com', 'whatsapp web': 'https://web.whatsapp.com', 'youtube music': 'https://music.youtube.com',
  settings: 'ms-settings:', 'control panel': 'control', 'task manager': 'taskmgr', 'file explorer': 'explorer', explorer: 'explorer',
  'this pc': 'explorer', notepad: 'notepad', paint: 'mspaint', cmd: 'cmd', 'command prompt': 'cmd', terminal: 'wt', powershell: 'powershell',
  calculator: 'calc', calc: 'calc', camera: 'microsoft.windows.camera:', store: 'ms-windows-store:', 'microsoft store': 'ms-windows-store:',
  'vs code': 'code', vscode: 'code', 'visual studio code': 'code', word: 'winword', excel: 'excel', powerpoint: 'powerpnt',
  edge: 'msedge', 'microsoft edge': 'msedge', chrome: 'chrome', 'google chrome': 'chrome', 'snipping tool': 'snippingtool',
  'recycle bin': 'shell:RecycleBinFolder', 'wifi settings': 'ms-settings:network-wifi', 'bluetooth settings': 'ms-settings:bluetooth',
  'sound settings': 'ms-settings:sound', 'display settings': 'ms-settings:display',
};

const looksLikeUrl = (t) => /^(https?:|mailto:|ms-settings:|ms-windows-store:|microsoft\.windows\.camera:|spotify:|steam:|discord:|whatsapp:|shell:)/i.test(t) ||
  (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(t) && !/\.(exe|txt|md|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|mp3|mp4|lnk|bat|ps1|py|js|html?|css|json|zip)$/i.test(t));

function findShortcut(name) {
  const dirs = [
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft\\Windows\\Start Menu\\Programs'),
    path.join(process.env.APPDATA || '', 'Microsoft\\Windows\\Start Menu\\Programs'),
    DESKTOP,
    'C:\\Users\\Public\\Desktop',
  ];
  const want = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!want) return null;
  const hits = [];
  const walk = (d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth > 0) walk(p, depth - 1);
      else if (/\.(lnk|url|appref-ms)$/i.test(e.name)) {
        const base = e.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (base === want) hits.push({ p, score: 0 });
        else if (base.includes(want)) hits.push({ p, score: base.length - want.length + (/uninstall|help|readme|documentation|website/.test(base) ? 100 : 0) });
      }
    }
  };
  dirs.forEach((d) => walk(d, 3));
  hits.sort((a, b) => a.score - b.score);
  return hits[0]?.p || null;
}

// files that RUN when "opened" by Windows: opening one means showing its code, never running it
const SCRIPT_EXT = /\.(py|pyw|js|mjs|cjs|ts|ps1|psm1|bat|cmd|vbs|sh|rb|pl|php|jar|java|c|cpp|cs|go|rs|v|sv|vhd|vhdl|ipynb)$/i;
const EDITORS = { 'vs code': 'code', vscode: 'code', 'visual studio code': 'code', code: 'code', notepad: 'notepad', 'notepad++': 'notepad++', cursor: 'cursor', word: 'winword', excel: 'excel', chrome: 'chrome', 'google chrome': 'chrome', edge: 'msedge', 'microsoft edge': 'msedge' };

/** Find a file the user named without a path ("fibonacci_search code file") in their usual folders; newest match first. */
function locateFile(name) {
  const want = String(name).toLowerCase().replace(/\s+(code )?file$/, '').trim();
  const stem = want.replace(/\.[a-z0-9]{1,5}$/, '');
  const norm = (s) => s.toLowerCase().replace(/[\s_-]+/g, '');
  const hits = [];
  let seen = 0;
  const SKIP = /^(node_modules|\.git|appdata|\$recycle\.bin|venv|\.venv|__pycache__|site-packages|\.cache|\.vscode|dist|build)$/i;
  const walk = (d, depth) => {
    if (depth < 0 || seen > 60000) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      seen++;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP.test(e.name) && !e.name.startsWith('.')) walk(p, depth - 1); continue; }
      const n = e.name.toLowerCase();
      if (n === want || norm(n.replace(/\.[^.]+$/, '')) === norm(stem)) {
        try { hits.push({ p, t: fs.statSync(p).mtimeMs }); } catch {}
      }
    }
  };
  for (const r of ['Desktop', 'Documents', 'Downloads', 'OneDrive'].map((f) => path.join(HOME, f))) walk(r, 7);
  walk(HOME, 3);   // ~/projects/abi/x.py and similar
  const uniq = [...new Map(hits.map((h) => [h.p.toLowerCase(), h])).values()];
  return uniq.sort((a, b) => b.t - a.t).map((h) => h.p);
}

async function openWith(app, file, newWindow) {
  const exe = EDITORS[String(app).toLowerCase()] || app;
  const args = [...(exe === 'code' && newWindow ? ['-n'] : []), `"${file}"`].map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
  const r = await powershell(`Start-Process '${exe.replace(/'/g, "''")}' -ArgumentList ${args} -ErrorAction Stop; "OK"`, { timeoutMs: 20000 });
  return r.output.trim().endsWith('OK');
}

async function openTarget(target, opts = {}) {
  let t = String(target).trim().replace(/^(the|my)\s+/i, '').replace(/\s+(app|application)$/i, '');
  // "x.py in vs code" written into the target itself
  let app = opts.app;
  const inApp = t.match(/^(.+?)\s+(?:in|with|using)\s+(vs ?code|visual studio code|notepad\+\+|notepad|cursor|word|excel|chrome|google chrome|edge|microsoft edge)$/i);
  if (inApp) { t = inApp[1].trim(); app = app || inApp[2]; }
  // a site in a particular browser: "open youtube in chrome"
  const urlish = looksLikeUrl(t) ? t : (ALIASES[t.toLowerCase()] && /^https?:/.test(ALIASES[t.toLowerCase()]) ? ALIASES[t.toLowerCase()] : null);
  if (app && urlish && /chrome|edge|firefox|brave|opera/i.test(app)) {
    const url = /^[a-z][\w+.-]*:/i.test(urlish) ? urlish : `https://${urlish}`;
    return (await openWith(app, url)) ? `Opened ${url} in ${app}.` : `FAILED to open ${url} in ${app}.`;
  }
  const fileLike = !looksLikeUrl(t) && (/\.[a-z0-9]{1,5}$/i.test(t) || /\s(code )?file$|\sscript$/i.test(t));
  if (app || fileLike) {
    let file = fs.existsSync(expand(t)) && /[\\/:]/.test(t) ? expand(t) : null;
    let others = [];
    if (!file) { const found = locateFile(path.basename(t)); file = found[0]; others = found.slice(1, 4); }
    if (file) {
      const useApp = app || (SCRIPT_EXT.test(file) ? (findShortcut('Visual Studio Code') ? 'code' : 'notepad') : null);
      if (useApp) {
        if (!(await openWith(useApp, file, opts.newWindow))) return `FAILED to open ${file} in ${useApp}.`;
        return `Opened ${file} in ${useApp === 'code' ? 'VS Code' : useApp}${opts.newWindow ? ' (new window)' : ''}.${others.length ? ` Other files with that name: ${others.join(' ; ')}` : ''}`;
      }
      const err = await shell.openPath(file);
      return err ? `FAILED: ${err}` : `Opened ${file}.`;
    }
    if (fileLike) return `FAILED: no file called "${t}" in Desktop, Documents, Downloads, OneDrive or the home folder. Ask the user where it is, or use find_files / search_in_files.`;
    if (app) return openTarget(app);
  }
  const alias = ALIASES[t.toLowerCase()];
  if (looksLikeUrl(t) || (alias && looksLikeUrl(alias))) {
    const raw = alias && looksLikeUrl(alias) ? alias : t;
    const url = /^[a-z][\w+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    if (/^shell:/i.test(url)) { await powershell(`Start-Process explorer.exe '${url}'`); return `Opened ${t}`; }
    await shell.openExternal(url);
    return `Opened ${url}`;
  }
  const asPath = expand(t);
  if (fs.existsSync(asPath) && (/[\\/:]/.test(t) || KNOWN_FOLDERS[t.toLowerCase().replace(/\s+folder$/, '')] || fs.existsSync(path.join(HOME, t)))) {
    const err = await shell.openPath(asPath);
    return err ? `Failed: ${err}` : `Opened ${asPath}`;
  }
  const lnk = findShortcut(t);
  if (lnk) {
    const err = await shell.openPath(lnk);
    if (!err) return `Opened ${path.basename(lnk).replace(/\.[^.]+$/, '')}`;
  }
  // Store / UWP apps (WhatsApp, Spotify from the Store, Calculator...)
  const q = t.replace(/'/g, "''");
  const uwp = await powershell(`$a = Get-StartApps | Where-Object { $_.Name -like '*${q}*' } | Sort-Object { $_.Name.Length } | Select-Object -First 1; if ($a) { Start-Process ("shell:AppsFolder\\" + $a.AppID); "OK " + $a.Name }`);
  if (uwp.output.startsWith('OK ')) return `Opened ${uwp.output.slice(3)}`;
  const exe = alias || t;
  // last resort only for program names: never hand a file name to Start-Process (a .py would RUN)
  if (!/\.(?!exe$)[a-z0-9]{1,5}$/i.test(exe)) {
    const direct = await powershell(`Start-Process '${exe.replace(/'/g, "''")}' -ErrorAction Stop; "OK"`, { timeoutMs: 15000 });
    if (direct.output.trim().endsWith('OK')) return `Started ${t}`;
  }
  return `FAILED: couldn't find an app, folder or file called "${t}". Try another name, a URL, or search with run_command (Get-StartApps).`;
}

// ---------- web ----------

function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h\d|li|tr|br|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36';

async function webSearch(query) {
  const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  const html = await r.text();
  const results = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < 6) {
    let link = m[1];
    const u = link.match(/uddg=([^&]+)/);
    if (u) link = decodeURIComponent(u[1]);
    results.push(`- ${htmlToText(m[2])}\n  ${link}\n  ${htmlToText(m[3])}`);
  }
  return results.length ? results.join('\n') : 'No results found.';
}

async function playYoutube(query) {
  const search = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  try {
    const html = await (await fetch(search, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(12000) })).text();
    const m = html.match(/"videoId":"([\w-]{11})"/);
    const title = html.match(/"title":\{"runs":\[\{"text":"([^"]+)"/);
    if (m) {
      await shell.openExternal(`https://www.youtube.com/watch?v=${m[1]}`);
      return `Playing "${title ? title[1] : query}" on YouTube.`;
    }
  } catch {}
  await shell.openExternal(search);
  return `Opened YouTube search results for "${query}".`;
}

// ---------- music: really play it, in the app the user named ----------

const MUSIC_PS = path.join(__dirname, 'music.ps1');
// the Apple Music / iTunes store region. Windows' region and locale are often left on "US",
// so the time zone is the better clue (Asia/Kolkata -> in); config.country overrides it.
const TZ_COUNTRY = { 'Asia/Kolkata': 'in', 'Asia/Calcutta': 'in', 'Europe/London': 'gb', 'Asia/Dubai': 'ae', 'Asia/Singapore': 'sg', 'Australia/Sydney': 'au', 'Asia/Tokyo': 'jp', 'Europe/Berlin': 'de', 'Europe/Paris': 'fr', 'America/Toronto': 'ca', 'Asia/Karachi': 'pk', 'Asia/Dhaka': 'bd', 'Asia/Kathmandu': 'np', 'Asia/Colombo': 'lk' };
const STORE = (config.load().country || TZ_COUNTRY[Intl.DateTimeFormat().resolvedOptions().timeZone] || Intl.DateTimeFormat().resolvedOptions().locale.split('-')[1] || 'us').toLowerCase();
const VAGUE_SONG = /^(any|some|a|the)?\s*(new|latest|trending|popular|top|hit|beautiful|good|nice|random|viral|best)?\s*(new |latest |trending |popular |beautiful |viral )*(songs?|music|tracks?|hits?|tunes?)( right now| now| today| these days)?( on \w+( music)?)?$|trending|top (songs|hits|charts?)|what'?s hot/i;

function musicApp(app) {
  const a = String(app || '').toLowerCase();
  if (/apple|itunes/.test(a)) return 'apple';
  if (/spotify/.test(a)) return 'spotify';
  if (/youtube music|yt music/.test(a)) return 'youtube music';
  return 'youtube';
}

/** A song that is trending right now (Apple's public charts for this country). */
async function trendingSong() {
  const get = async (u) => (await fetch(u, { signal: AbortSignal.timeout(10000) })).json();
  let list = [];
  try { list = ((await get(`https://itunes.apple.com/${STORE}/rss/topsongs/limit=25/json`)).feed?.entry || []).map((e) => [e['im:name']?.label, e['im:artist']?.label]); } catch {}
  if (!list.length) list = ((await get(`https://rss.marketingtools.apple.com/api/v2/${STORE}/music/most-played/25/songs.json`)).feed?.results || []).map((s) => [s.name, s.artistName]);
  // skip remix/"version" duplicates so the pick is the real song
  list = list.filter(([n, a]) => n && a && !/\((acoustic|piano|instrumental|slowed|sped up|remix)[^)]*\)/i.test(n));
  if (!list.length) throw new Error('no chart');
  const [name, artist] = list[Math.floor(Math.random() * Math.min(10, list.length))];
  return `${name.replace(/\s*[([].*$/, '')} ${artist.split(/,|&/)[0].trim()}`;
}

async function itunesSong(query) {
  const u = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&country=${STORE}&limit=15`;
  const res = (await (await fetch(u, { signal: AbortSignal.timeout(10000) })).json()).results || [];
  if (!res.length) return null;
  // iTunes' own order often puts covers first, so rank: exact title (or title + artist named), an artist who
  // shows up many times (the famous version), never remixes/covers/live unless asked, singles a bit over compilations
  const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const variant = /\b(remix|slowed|reverb|sped up|lofi|lo fi|cover|karaoke|instrumental|acoustic|live|version|ao vivo|en vivo|8d|nightcore|tribute)\b/i;
  const q = norm(query), wantVariant = variant.test(query);
  const freq = {};
  for (const r of res) freq[r.artistName] = (freq[r.artistName] || 0) + 1;
  const score = (r, i) => {
    const t = norm(r.trackName), base = norm(r.trackName.replace(/\s*[([].*$/, '')), artist = norm(r.artistName);
    let s = 0;
    if (t === q || base === q) s += 6;
    else if (q.startsWith(base) && q.includes(artist.split(' ')[0])) s += 7;   // "swim bts"
    else if (t.includes(q) || q.includes(base)) s += 2;
    else return -99;                                                           // the title doesn't match at all
    if (q.includes(artist)) s += 3;
    s += Math.min(3, (freq[r.artistName] - 1) * 1.5);
    if (!wantVariant && (variant.test(r.trackName) || variant.test(r.collectionName))) s -= 10;
    if (r.trackCount === 1) s += 0.5;
    return s - i * 0.05;
  };
  const best = res.map((r, i) => ({ r, s: score(r, i) })).sort((a, b) => b.s - a.s)[0];
  if (best.s > -50) return best.r;
  // "play arijit singh": just an artist, so their top hit (iTunes lists the most popular first)
  return res.find((r) => norm(r.artistName).includes(q) && !variant.test(r.trackName)) || null;
}

async function playMusic(args) {
  const app = musicApp(args.app);
  let query = String(args.query || '').trim();
  let picked = '';
  if (!query || VAGUE_SONG.test(query)) {
    try { query = await trendingSong(); picked = ` (picked from today's top chart: ${query})`; } catch { if (!query) query = 'top hits'; }
  }
  if (app === 'youtube') return (await playYoutube(query)) + picked;
  if (app === 'youtube music') {
    await shell.openExternal(`https://music.youtube.com/search?q=${encodeURIComponent(query)}`);
    return `Opened YouTube Music search for "${query}"${picked}. It does NOT auto-play there: tell the user to click the top result (or offer YouTube, which plays automatically).`;
  }
  const ps = (extra) => new Promise((resolve) => require('child_process').execFile('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', MUSIC_PS, ...extra], { windowsHide: true, timeout: 60000 },
    (err, stdout) => resolve(String(stdout || (err && err.message) || '').trim().split('\n').pop())));

  if (app === 'spotify') {
    const r = await ps(['-App', 'spotify', '-Uri', `spotify:search:${encodeURIComponent(query)}`, '-Query', query]);
    if (/^PLAYING/.test(r)) return `Now playing in Spotify: ${r.slice(8)}${picked}. (Confirmed: Spotify shows it playing.)`;
    return `Opened Spotify search for "${query}" but could NOT start playback (${r.replace(/^FAIL\s*/, '')}). Tell the user honestly; they can click the top result.`;
  }

  // Apple Music: find the exact song in Apple's catalogue, open its page in the app, press play
  const song = await itunesSong(query).catch(() => null);
  if (!song) {
    await shell.openExternal(`music://music.apple.com/${STORE}/search?term=${encodeURIComponent(query)}`);
    return `Couldn't find "${query}" in the Apple Music catalogue. Opened Apple Music search; nothing is playing.`;
  }
  const r = await ps(['-App', 'apple', '-Uri', song.trackViewUrl.replace(/^https:/, 'music:'), '-Track', song.trackName, '-Collection', song.collectionName]);
  if (/^PLAYING/.test(r)) return `Now playing in Apple Music: "${song.trackName}" by ${song.artistName}${picked}. (Confirmed: Apple Music shows it playing.)`;
  return `Opened "${song.trackName}" by ${song.artistName}${picked} in Apple Music but could NOT start playback (${r.replace(/^FAIL\s*/, '')}). Tell the user honestly; they can press Play.`;
}

// ---------- apps / windows / system ----------

async function closeApp(name, force) {
  const n = String(name).trim().replace(/^(the|my)\s+/i, '').replace(/'/g, "''");
  const procAlias = {
    calculator: 'CalculatorApp', calc: 'CalculatorApp', 'vs code': 'Code', vscode: 'Code', 'visual studio code': 'Code', edge: 'msedge', 'microsoft edge': 'msedge',
    'google chrome': 'chrome', word: 'WINWORD', 'microsoft word': 'WINWORD', excel: 'EXCEL', powerpoint: 'POWERPNT', paint: 'mspaint', 'file explorer': 'explorer',
    'apple music': 'AppleMusic', itunes: 'AppleMusic', whatsapp: 'WhatsApp', 'task manager': 'Taskmgr', settings: 'SystemSettings', teams: 'ms-teams',
  }[n.toLowerCase()] || n;
  // window titles hide zero-width characters ("Microsoft​ Edge"), so they are stripped before comparing
  const ps = `
$n = '${procAlias}'; $t = '${n}'
$self = @('electron','llama-server','whisper-server','powershell')
$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $self -notcontains $_.ProcessName -and ($_.ProcessName -like "*$n*" -or ($_.MainWindowTitle -replace '[\\u200b-\\u200f\\ufeff]', '') -like "*$t*") }
if (-not $p) { "NOT_RUNNING"; return }
$names = ($p | Select-Object -ExpandProperty ProcessName -Unique) -join ', '
${force ? '$p | Stop-Process -Force' : '$p | ForEach-Object { [void]$_.CloseMainWindow() }; Start-Sleep -Milliseconds 1500'}
$left = $p | Where-Object { -not $_.HasExited }
if ($left) { "STILL_OPEN $names" } else { "CLOSED $names" }`;
  const r = await powershell(ps, { timeoutMs: 20000 });
  if (r.output.includes('NOT_RUNNING')) return `No open window matching "${name}" was found.`;
  if (r.output.includes('STILL_OPEN')) return `Asked ${r.output.replace(/.*STILL_OPEN\s*/s, '')} to close, but it's still open (probably asking to save). Call again with force=true to kill it.`;
  return `Closed ${r.output.replace(/.*CLOSED\s*/s, '')}.`;
}

async function systemInfo() {
  const ps = `
$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue
$os = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$up = (Get-Date) - $os.LastBootUpTime
$ssid = (netsh wlan show interfaces) -match '^\\s+SSID' | Select-Object -First 1
$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.*' } | Select-Object -First 1).IPAddress
"Time: $(Get-Date -Format 'dddd dd MMM yyyy, hh:mm tt')"
if ($b) { "Battery: $($b.EstimatedChargeRemaining)% ($(if ($b.BatteryStatus -eq 2) {'charging/plugged in'} else {'on battery'}))" } else { "Battery: none (desktop)" }
"CPU load: $cpu%"
"Memory: $([math]::Round(($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/1MB,1)) GB used of $([math]::Round($os.TotalVisibleMemorySize/1MB,1)) GB"
Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object { "Disk $($_.Name): $([math]::Round($_.Free/1GB,1)) GB free of $([math]::Round(($_.Used+$_.Free)/1GB,0)) GB" }
"Wi-Fi: $(if ($ssid) { ($ssid -split ':',2)[1].Trim() } else { 'not connected' })"
"IP: $ip"
"Uptime: $($up.Days)d $($up.Hours)h $($up.Minutes)m"
"Heaviest apps: " + ((Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 6 | ForEach-Object { "$($_.ProcessName) $([math]::Round($_.WorkingSet64/1MB))MB" }) -join ', ')`;
  return (await powershell(ps, { timeoutMs: 30000 })).output;
}

const VK = { play_pause: 179, next: 176, previous: 177 };

function sendKeysSpec(keys) {
  // "ctrl+shift+s" -> "^+s", "enter" -> "{ENTER}", "alt+f4" -> "%{F4}"
  const named = { enter: 'ENTER', return: 'ENTER', tab: 'TAB', esc: 'ESC', escape: 'ESC', backspace: 'BACKSPACE', delete: 'DELETE', del: 'DELETE',
    up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', home: 'HOME', end: 'END', pageup: 'PGUP', pagedown: 'PGDN', space: ' ' };
  return String(keys).split(/\s*,\s*|\s+then\s+|\s+(?=[a-z]+\+)/i).filter(Boolean).map((combo) => {
    const parts = combo.toLowerCase().split('+').map((s) => s.trim());
    const key = parts.pop();
    let mod = '';
    for (const m of parts) mod += m === 'ctrl' || m === 'control' ? '^' : m === 'alt' ? '%' : m === 'shift' ? '+' : '';
    let k = named[key] ? (named[key] === ' ' ? ' ' : `{${named[key]}}`) : /^f\d{1,2}$/.test(key) ? `{${key.toUpperCase()}}` : key;
    if (k.length === 1 && /[+^%~(){}[\]]/.test(k)) k = `{${k}}`;
    return mod + k;
  }).join('');
}

function escapeSendKeys(text) {
  return String(text).replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`).replace(/\r?\n/g, '{ENTER}');
}

// Keystrokes are only sent once the intended window is verified to be in front,
// so they can never land in whatever the user happens to be working in.
const FOCUS_PS = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class SpideyWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  // Windows blocks background processes from stealing focus; borrowing the foreground thread's input queue gets around it.
  public static bool Focus(IntPtr h) {
    IntPtr fg = GetForegroundWindow();
    uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero), me = GetCurrentThreadId(), target = GetWindowThreadProcessId(h, IntPtr.Zero);
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    AttachThreadInput(me, fgThread, true); AttachThreadInput(target, fgThread, true);
    if (IsIconic(h)) ShowWindow(h, 9);
    BringWindowToTop(h); SetForegroundWindow(h);
    AttachThreadInput(me, fgThread, false); AttachThreadInput(target, fgThread, false);
    if (GetForegroundWindow() != h) SwitchToThisWindow(h, true);
    System.Threading.Thread.Sleep(350);
    return GetForegroundWindow() == h;
  }
}
"@
function Get-FgProcess { $h = [SpideyWin]::GetForegroundWindow(); $id = 0; [void][SpideyWin]::GetWindowThreadProcessId($h, [ref]$id); Get-Process -Id $id -ErrorAction SilentlyContinue }
`;

async function keyboard(args, ctx) {
  if (!args.text && !args.keys) return 'Nothing to type: give text or keys.';
  await ctx.releaseFocus?.();
  let ps = `${FOCUS_PS}
$w = New-Object -ComObject WScript.Shell
Start-Sleep -Milliseconds 300
`;
  if (args.window) {
    const n = String(args.window).replace(/'/g, "''");
    ps += `
$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.ProcessName -like '*${n}*' -or $_.MainWindowTitle -like '*${n}*') } | Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $p) { "NO_WINDOW"; return }
[void][SpideyWin]::Focus($p.MainWindowHandle)
$fg = Get-FgProcess
if (-not $fg -or ($fg.Id -ne $p.Id -and $fg.ProcessName -ne $p.ProcessName)) { "FOCUS_FAILED $($fg.ProcessName)"; return }
`;
  } else {
    ps += `
$fg = Get-FgProcess
if ((-not $fg) -or ($fg.ProcessName -eq 'electron')) { "NO_TARGET"; return }
`;
  }
  if (args.text) ps += `$w.SendKeys('${escapeSendKeys(args.text).replace(/'/g, "''")}')\n`;
  if (args.keys) ps += `Start-Sleep -Milliseconds 100; $w.SendKeys('${sendKeysSpec(args.keys).replace(/'/g, "''")}')\n`;
  ps += `"TYPED into $((Get-FgProcess).ProcessName)"`;
  const r = await powershell(ps, { timeoutMs: 60000 });
  if (r.output.includes('NO_WINDOW')) return `No open window matching "${args.window}". Open it first (open tool), then call keyboard again.`;
  if (r.output.includes('FOCUS_FAILED')) return `Windows wouldn't bring "${args.window}" to the front, so I typed nothing (safety). Try again, or ask the user to click on it.`;
  if (r.output.includes('NO_TARGET')) return 'No app window is active to type into. Pass the window name (e.g. "notepad").';
  const into = r.output.match(/TYPED into (\S+)/)?.[1];
  return `Done${args.text ? `: typed ${String(args.text).length} characters` : ''}${args.keys ? `, pressed ${args.keys}` : ''}${into ? ` in ${into}` : ''}.`;
}

async function systemControl(args, ctx) {
  const v = Math.max(0, Math.min(100, Math.round(Number(args.value ?? 50))));
  const mode = ctx.cfg.permissionMode;
  switch (args.action) {
    case 'volume': return `Volume set. ${await audio('volume-set', v)}`;
    case 'volume_up': case 'volume_down': {
      const cur = Number((await audio('volume-get')).match(/level=(\d+)/)?.[1] ?? 50);
      const step = Math.max(1, Math.min(100, Number(args.value) || 10));
      const next = Math.max(0, Math.min(100, cur + (args.action === 'volume_up' ? step : -step)));
      return `Volume ${cur}% -> ${next}%. ${await audio('volume-set', next)}`;
    }
    case 'mute': return `Muted. ${await audio('mute')}`;
    case 'unmute': return `Unmuted. ${await audio('unmute')}`;
    case 'brightness': {
      const r = await powershell(`(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods -ErrorAction Stop).WmiSetBrightness(1, ${v}); "OK"`);
      return r.output.includes('OK') ? `Brightness set to ${v}%.` : `Couldn't change brightness on this display: ${clip(r.output, 200)}`;
    }
    case 'lock': await powershell('rundll32.exe user32.dll,LockWorkStation'); return 'Locked the PC.';
    case 'screenshot': {
      const png = await ctx.screenshot?.();
      if (!png) return 'Screenshot failed.';
      const file = path.join(HOME, 'Pictures', 'Screenshots', `Kanishk ${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, png);
      ctx.emit('agent:file', { path: file });
      return `Screenshot saved to ${file}`;
    }
    case 'empty_recycle_bin': {
      if (mode !== 'full' && !(await ctx.confirm('Empty the Recycle Bin?', 'Files in the Recycle Bin will be gone for good.'))) return 'The user declined.';
      await powershell('Clear-RecycleBin -Force -ErrorAction SilentlyContinue');
      return 'Recycle Bin emptied.';
    }
    case 'sleep': case 'shutdown': case 'restart': {
      if (mode !== 'full' && !(await ctx.confirm(`${args.action[0].toUpperCase()}${args.action.slice(1)} the PC?`, 'Unsaved work in other apps could be lost.'))) return 'The user declined.';
      const cmd = { sleep: 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState("Suspend", $false, $false)', shutdown: 'shutdown /s /t 10', restart: 'shutdown /r /t 10' }[args.action];
      setTimeout(() => powershell(cmd), 2500);
      return `${args.action} in a few seconds.`;
    }
    default: return `Unknown action ${args.action}`;
  }
}

/** One question about one image, answered by the model's vision module. */
async function askVision(image, mime, prompt, ctx) {
  // tiny images are rejected (min 32px a side): pad them up
  try {
    let img = nativeImage.createFromBuffer(image);
    const { width, height } = img.getSize();
    if (width && height && (width < 32 || height < 32)) { img = img.resize({ width: Math.max(32, width * 4), height: Math.max(32, height * 4) }); image = img.toPNG(); mime = 'image/png'; }
  } catch {}
  const text = await groq.complete([{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: `data:${mime};base64,${image.toString('base64')}` } },
      { type: 'text', text: prompt },
    ],
  }], { maxTokens: 900, temperature: 0.3, models: [ctx.cfg.groq.visionModel] });
  return text || '(nothing)';
}

async function lookAtScreen(question, ctx) {
  if (ctx.offline) return "FAILED: I need the internet to see your screen, and it's down right now.";
  const jpeg = await ctx.screenshot?.({ jpeg: true, maxWidth: 1280 });
  if (!jpeg) return 'Could not capture the screen.';
  try {
    const answer = await askVision(jpeg, 'image/jpeg',
      `This is a screenshot of the user's Windows screen (a small Spider-Man helper in the corner is the assistant itself, ignore it). ${question}\nAnswer precisely; quote any important text exactly.`, ctx);
    return `What I see on the screen:\n${answer}`;
  } catch (e) {
    return `Vision failed: ${e.message}`;
  }
}

const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp)$/i;

async function lookAtImage(file, question, ctx) {
  if (ctx.offline) return "FAILED: I need the internet to look at pictures, and it's down right now.";
  const p = expand(file);
  if (!fs.existsSync(p)) return `No image at ${p}`;
  if (!IMAGE_EXT.test(p)) return `${path.basename(p)} isn't an image. Use read_file for documents.`;
  // shrink big photos first: faster, and the model sees the same detail at this size
  let data = fs.readFileSync(p), mime = /\.png$/i.test(p) ? 'image/png' : 'image/jpeg';
  try {
    let img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) {
      if (img.getSize().width > 1600) img = img.resize({ width: 1600, quality: 'good' });
      data = img.toJPEG(85); mime = 'image/jpeg';
    }
  } catch {}
  try {
    const answer = await askVision(data, mime, `${question || 'Describe this image in detail.'}\nAnswer precisely; quote any text in the image exactly.`, ctx);
    return `About ${path.basename(p)}:\n${answer}`;
  } catch (e) {
    return `Vision failed: ${e.message}`;
  }
}

// ---------- documents ----------

async function readPdf(p) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(p)), useSystemFonts: true, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(doc.numPages, 60); i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push(`--- page ${i} ---\n${tc.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+/g, ' ').trim()}`);
  }
  const text = pages.join('\n\n');
  return text.replace(/--- page \d+ ---/g, '').trim()
    ? `${path.basename(p)} (${doc.numPages} pages${doc.numPages > 60 ? ', first 60 read' : ''}):\n${text}`
    : `${path.basename(p)} has no text layer (it's probably scanned). Ask me to look at it as an image instead.`;
}

/** Read the XML parts of an Office file (it's a zip) whose names match `pattern`. Returns [{ name, xml }]. */
async function zipParts(p, pattern) {
  const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::OpenRead('${p.replace(/'/g, "''")}')
try {
  $out = @{}
  foreach ($e in $z.Entries) { if ($e.FullName -match '${pattern}') { $r = New-Object IO.StreamReader($e.Open()); $out[$e.FullName] = $r.ReadToEnd(); $r.Close() } }
  [Console]::Out.Write(($out | ConvertTo-Json -Compress -Depth 2))
} finally { $z.Dispose() }`;
  const r = await powershell(ps, { timeoutMs: 45000 });
  let obj = {};
  try { obj = JSON.parse(r.output || '{}'); } catch {}
  const num = (n) => Number((n.match(/(\d+)\.xml$/) || [])[1] || 0);
  return Object.entries(obj).map(([name, xml]) => ({ name, xml })).sort((a, b) => num(a.name) - num(b.name));
}

const unxml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

async function readPptx(p) {
  const slides = await zipParts(p, '^ppt/slides/slide\\d+\\.xml$');
  if (!slides.length) return `Couldn't read ${path.basename(p)} as a PowerPoint file.`;
  const text = slides.map((s, i) => {
    const paras = s.xml.split('</a:p>').map((para) => [...para.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('')).filter((t) => t.trim());
    return `--- slide ${i + 1} ---\n${unxml(paras.join('\n'))}`;
  }).join('\n\n');
  return `${path.basename(p)} (${slides.length} slides):\n${text}`;
}

async function readXlsx(p) {
  const parts = await zipParts(p, '^xl/(sharedStrings|worksheets/sheet\\d+)\\.xml$');
  const shared = parts.find((x) => x.name.endsWith('sharedStrings.xml'));
  const strings = shared ? [...shared.xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml([...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => t[1]).join(''))) : [];
  const sheets = parts.filter((x) => x.name.includes('worksheets/'));
  if (!sheets.length) return `Couldn't read ${path.basename(p)} as an Excel file.`;
  const out = sheets.slice(0, 5).map((s, i) => {
    const rows = [...s.xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].slice(0, 200).map((row) =>
      [...row[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => {
        const v = (c[2] || '').match(/<v>([^<]*)<\/v>/)?.[1] ?? (c[2] || '').match(/<t[^>]*>([^<]*)<\/t>/)?.[1] ?? '';
        return /t="s"/.test(c[1]) ? strings[Number(v)] ?? '' : unxml(v);
      }).join(' | '));
    return `--- sheet ${i + 1} ---\n${rows.join('\n')}`;
  });
  return `${path.basename(p)} (${sheets.length} sheet${sheets.length > 1 ? 's' : ''}${sheets.length > 5 ? ', first 5 shown' : ''}):\n${out.join('\n\n')}`;
}

/** True if the bytes look like a binary file rather than text. */
function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  let odd = 0;
  for (let i = 0; i < n; i++) { const c = buf[i]; if (c === 0) return true; if (c < 9 || (c > 13 && c < 32)) odd++; }
  return n > 0 && odd / n > 0.1;
}

async function readDocx(p) {
  // a .docx is a zip; the text lives in word/document.xml
  const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::OpenRead('${p.replace(/'/g, "''")}')
try { $e = $z.GetEntry('word/document.xml'); if (-not $e) { 'NOT_DOCX'; return }
  $r = New-Object IO.StreamReader($e.Open()); [Console]::Out.Write($r.ReadToEnd()); $r.Close() } finally { $z.Dispose() }`;
  const r = await powershell(ps, { timeoutMs: 30000 });
  if (r.output.includes('NOT_DOCX') || !/<w:/.test(r.output)) return `Couldn't read ${path.basename(p)} as a Word document.`;
  const text = r.output.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  return `${path.basename(p)}:\n${text.trim()}`;
}

// ---------- time ----------

/** "18:30", "6:30 pm", "7 am" -> next Date at that time (today, or tomorrow if already past). */
function parseClock(text) {
  const m = String(text).trim().toLowerCase().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ap = m[3]?.[0];
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  const d = new Date();
  d.setHours(h, min, 0, 0);
  if (d <= new Date()) d.setDate(d.getDate() + 1);
  return d;
}

// ---------- search anywhere ----------

const SEARCH_SITES = {
  google: 'https://www.google.com/search?q=%s',
  images: 'https://www.google.com/search?tbm=isch&q=%s',
  news: 'https://news.google.com/search?q=%s',
  maps: 'https://www.google.com/maps/search/%s',
  youtube: 'https://www.youtube.com/results?search_query=%s',
  'youtube music': 'https://music.youtube.com/search?q=%s',
  amazon: 'https://www.amazon.in/s?k=%s',
  flipkart: 'https://www.flipkart.com/search?q=%s',
  wikipedia: 'https://en.wikipedia.org/w/index.php?search=%s',
  github: 'https://github.com/search?q=%s',
  reddit: 'https://www.reddit.com/search/?q=%s',
  stackoverflow: 'https://stackoverflow.com/search?q=%s',
  'stack overflow': 'https://stackoverflow.com/search?q=%s',
  linkedin: 'https://www.linkedin.com/search/results/all/?keywords=%s',
  twitter: 'https://x.com/search?q=%s',
  x: 'https://x.com/search?q=%s',
  bing: 'https://www.bing.com/search?q=%s',
  duckduckgo: 'https://duckduckgo.com/?q=%s',
  chatgpt: 'https://chatgpt.com/?q=%s',
  perplexity: 'https://www.perplexity.ai/search?q=%s',
  spotify: 'spotify:search:%s',
  'google drive': 'https://drive.google.com/drive/search?q=%s',
  drive: 'https://drive.google.com/drive/search?q=%s',
  gmail: 'https://mail.google.com/mail/u/0/#search/%s',
};

function searchUrl(where, query) {
  const w = String(where || 'google').toLowerCase().replace(/^(on|in)\s+/, '').replace(/\.com$/, '').trim();
  const q = encodeURIComponent(query);
  if (SEARCH_SITES[w]) return SEARCH_SITES[w].replace('%s', q);
  if (/^[\w-]+(\.[\w-]+)+$/.test(where)) return `https://www.google.com/search?q=${encodeURIComponent(`site:${where} ${query}`)}`;
  return `https://www.google.com/search?q=${encodeURIComponent(`${where} ${query}`)}`;
}

const BROWSERS = { chrome: 'chrome', 'google chrome': 'chrome', edge: 'msedge', 'microsoft edge': 'msedge', firefox: 'firefox', brave: 'brave', opera: 'opera', browser: null };

async function searchIn(where, query, browser) {
  let w = String(where || '').trim().replace(/^(on|in)\s+/i, '');
  if (/^(files|this pc|my pc|computer|pc)$/i.test(w)) return findFiles(query);
  // "search it in chrome": the browser is WHERE to show it, Google is what to search with
  if (w.toLowerCase() in BROWSERS) { browser = browser || w; w = 'google'; }
  const url = searchUrl(w || 'google', query);
  const exe = browser ? BROWSERS[String(browser).toLowerCase()] ?? browser : null;
  if (exe && /^https?:/.test(url)) {
    if (await openWith(exe, url)) return `Opened ${w || 'Google'} results for "${query}" in ${browser} (new tab).`;
  }
  await shell.openExternal(url);
  return `Opened ${w || 'Google'} results for "${query}"${browser ? ` (couldn't use ${browser}, used the default browser)` : ''}.`;
}

// ---------- files ----------

async function findFiles(name, folder) {
  const roots = folder ? [expand(folder)] : ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music', 'OneDrive'].map((f) => path.join(HOME, f));
  const list = roots.filter((r) => fs.existsSync(r)).map((r) => `'${r.replace(/'/g, "''")}'`).join(',');
  if (!list) return 'None of those folders exist.';
  const pat = String(name).replace(/'/g, "''").replace(/\s+/g, '*');
  const ps = `Get-ChildItem -LiteralPath ${list} -Recurse -Depth 6 -Filter '*${pat}*' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 15 |
    ForEach-Object { '{0}  |  {1}  |  {2}' -f $_.FullName, $_.LastWriteTime.ToString('dd MMM yyyy'), $(if ($_.PSIsContainer) { 'folder' } else { '{0:N0} KB' -f ($_.Length / 1KB) }) }`;
  const r = await powershell(ps, { timeoutMs: 45000 });
  return r.output ? `Found (newest first):\n${r.output}` : `No files or folders matching "${name}".`;
}

// ---------- to-do and notes ----------

const TODO_PATH = path.join(config.ROOT, 'todo.json');
const NOTES_PATH = path.join(config.ROOT, 'notes.md');

function loadTodo() { try { return JSON.parse(fs.readFileSync(TODO_PATH, 'utf8')); } catch { return []; } }
function saveTodo(items) { fs.writeFileSync(TODO_PATH, JSON.stringify(items, null, 2)); }

function todo(args) {
  let items = loadTodo();
  const item = String(args.item || '').trim();
  const match = (x) => x.text.toLowerCase().includes(item.toLowerCase());
  const show = () => (items.length ? items.map((x, i) => `${i + 1}. ${x.done ? '[x]' : '[ ]'} ${x.text}`).join('\n') : '(the list is empty)');
  switch (args.action) {
    case 'add':
      if (!item) return 'Nothing to add.';
      for (const part of item.split(/\s*(?:,|\band\b)\s*/i).filter(Boolean)) items.push({ text: part, done: false, added: new Date().toISOString() });
      saveTodo(items);
      return `Added. List now:\n${show()}`;
    case 'done': case 'remove': {
      const hit = items.find((x) => match(x)) || items[Number(item) - 1];
      if (!hit) return `"${item}" isn't on the list.\n${show()}`;
      if (args.action === 'done') hit.done = true; else items = items.filter((x) => x !== hit);
      saveTodo(items);
      return `Updated. List now:\n${show()}`;
    }
    case 'clear':
      items = items.filter((x) => !x.done && item && !/all|everything/i.test(item));
      saveTodo(items);
      return `Cleared. List now:\n${show()}`;
    default:
      return show();
  }
}

function notes(args) {
  const text = String(args.text || '').trim();
  let all = '';
  try { all = fs.readFileSync(NOTES_PATH, 'utf8'); } catch {}
  if (args.action === 'add') {
    if (!text) return 'Nothing to note.';
    fs.appendFileSync(NOTES_PATH, `- ${new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}: ${text}\n`);
    return 'Noted.';
  }
  const lines = all.split('\n').filter(Boolean);
  const hits = args.action === 'find' && text ? lines.filter((l) => text.toLowerCase().split(/\s+/).every((w) => l.toLowerCase().includes(w))) : lines;
  return hits.length ? hits.slice(-25).join('\n') : 'No matching notes.';
}

// ---------- windows ----------

async function windowAction(args) {
  if (args.action === 'minimize_all') {
    await powershell('(New-Object -ComObject Shell.Application).MinimizeAll()');
    return 'Showing the desktop.';
  }
  const n = String(args.name || '').replace(/'/g, "''");
  if (!n) return 'Which app?';
  const cmd = { minimize: 6, maximize: 3, restore: 9 }[args.action];
  const ps = `Add-Type -Name W -Namespace Spidey -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);'
$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -notin @('electron','msedgewebview2') -and ($_.ProcessName -like '*${n}*' -or $_.MainWindowTitle -like '*${n}*') }
if (-not $p) { 'NONE'; return }
$p | ForEach-Object { [void][Spidey.W]::ShowWindow($_.MainWindowHandle, ${cmd}) }
($p | Select-Object -ExpandProperty ProcessName -Unique) -join ', '`;
  const r = await powershell(ps);
  if (r.output.includes('NONE')) return `No open window matching "${args.name}".`;
  return `Done: ${args.action} ${r.output.trim()}.`;
}

// ---------- briefing ----------

async function briefing(args, ctx) {
  const parts = [`Date: ${new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`];
  const city = String(args.city || ctx.cfg.city || '').trim();
  const [weather, news] = await Promise.all([
    fetch(`https://wttr.in/${encodeURIComponent(city)}?format=%l:+%c+%t+(feels+%f),+%w+wind,+%h+humidity`, { headers: { 'User-Agent': 'curl/8' }, signal: AbortSignal.timeout(10000) })
      .then((r) => r.text()).catch(() => 'unavailable'),
    fetch('https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en', { signal: AbortSignal.timeout(10000) })
      .then((r) => r.text())
      .then((x) => [...x.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>/g)].slice(0, 5).map((m) => `- ${htmlToText(m[1].replace(/<!\[CDATA\[|\]\]>/g, ''))}`).join('\n'))
      .catch(() => ''),
  ]);
  parts.push(`Weather: ${weather.trim()}`);
  const rem = ctx.listReminders?.() || [];
  parts.push(`Reminders: ${rem.length ? rem.map((r) => `${new Date(r.due).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${r.message}`).join('; ') : 'none'}`);
  const open = loadTodo().filter((x) => !x.done);
  parts.push(`To-do: ${open.length ? open.map((x) => x.text).join(', ') : 'nothing pending'}`);
  if (news) parts.push(`Headlines:\n${news}`);
  return parts.join('\n');
}

// ---------- search inside files ----------

const TEXT_EXT = /\.(txt|md|markdown|csv|json|js|mjs|cjs|ts|jsx|tsx|py|java|c|cc|cpp|h|hpp|cs|go|rs|php|rb|kt|swift|sql|html?|css|scss|xml|ya?ml|ini|cfg|toml|ps1|bat|sh|ipynb|v|sv|vhd|vhdl|asm|s|tex|log|r|dart|lua|m)$/i;
const DOC_EXT = /\.(pdf|docx|pptx|xlsx)$/i;
const SKIP_DIR = /^(node_modules|\.git|\.svn|\.venv|venv|env|__pycache__|dist|build|out|\.next|\.cache|AppData|\$Recycle\.Bin|site-packages|runtime|Program Files.*|Windows|bin|obj|\.idea|\.vscode)$/i;
const CACHE_PATH = path.join(config.ROOT, 'runtime', 'textcache.json');
let textCache = null;

function cacheGet(p, mtime) {
  if (!textCache) { try { textCache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { textCache = {}; } }
  const e = textCache[p];
  return e && e.m === mtime ? e.t : null;
}
function cacheSet(p, mtime, text) {
  textCache[p] = { m: mtime, t: text.slice(0, 200000) };
  const keys = Object.keys(textCache);
  if (keys.length > 600) delete textCache[keys[0]];
}
function cacheSave() { try { fs.writeFileSync(CACHE_PATH, JSON.stringify(textCache)); } catch {} }

async function docText(p) {
  if (/\.pdf$/i.test(p)) return readPdf(p);
  if (/\.docx$/i.test(p)) return readDocx(p);
  if (/\.pptx$/i.test(p)) return readPptx(p);
  return readXlsx(p);
}

function searchRoots(folder) {
  if (folder) return [expand(folder)];
  return ['Desktop', 'Documents', 'Downloads', 'OneDrive', 'projects', 'source', 'Projects', 'code']
    .map((f) => path.join(HOME, f)).filter((p, i, a) => fs.existsSync(p) && a.indexOf(p) === i);
}

/** "flip-flop code" -> [["flip-flop","flipflop","flip flop"], ["code"]] (each inner list = one term's spellings) */
function queryTerms(q) {
  const stop = new Set(['the', 'a', 'an', 'my', 'where', 'did', 'i', 'write', 'wrote', 'is', 'in', 'of', 'for', 'to', 'and', 'or', 'about', 'file', 'files', 'find', 'that', 'which', 'with', 'what', 'some', 'any', 'me']);
  return String(q).toLowerCase().split(/[\s,;]+/).map((w) => w.replace(/^[^\w]+|[^\w+#-]+$/g, '')).filter((w) => w.length > 1 && !stop.has(w))
    .map((w) => [...new Set([w, w.replace(/[-_]/g, ''), w.replace(/[-_]/g, ' ')])]);
}

async function searchInFiles(query, folder) {
  const terms = queryTerms(query);
  if (!terms.length) return 'What should I look for?';
  const roots = searchRoots(folder);
  if (!roots.length) return 'None of the usual folders exist.';
  const started = Date.now();
  const results = [];
  let scanned = 0, docs = 0;
  const need = terms.length === 1 ? 1 : Math.ceil(terms.length * 0.6);
  const walk = async (dir, depth) => {
    if (depth > 8 || scanned > 20000 || Date.now() - started > 40000) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.test(e.name) && !e.name.startsWith('.')) await walk(p, depth + 1); continue; }
      const isText = TEXT_EXT.test(e.name), isDoc = DOC_EXT.test(e.name);
      if (!isText && !isDoc) continue;
      scanned++;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (isText && st.size > 2e6) continue;
      if (isDoc && (st.size > 40e6 || docs > 250)) continue;
      let text = cacheGet(p, st.mtimeMs);
      if (text == null) {
        try {
          text = isText ? fs.readFileSync(p, 'utf8') : await docText(p);
          if (isDoc) { docs++; cacheSet(p, st.mtimeMs, text); }
        } catch { continue; }
      }
      const lower = text.toLowerCase(), name = e.name.toLowerCase();
      let distinct = 0, hits = 0;
      for (const spellings of terms) {
        const n = spellings.reduce((s, w) => s + Math.min(50, lower.split(w).length - 1), 0);
        const inName = spellings.some((w) => name.includes(w));
        if (n || inName) distinct++;
        hits += n + (inName ? 5 : 0);
      }
      if (distinct < need) continue;
      // first few lines that mention a term
      const lines = text.split(/\r?\n/);
      let where = '';
      const snippets = [];
      for (let i = 0; i < lines.length && snippets.length < 2; i++) {
        const m = lines[i].match(/^--- (page|slide|sheet) (\d+) ---$/);
        if (m) { where = `${m[1]} ${m[2]}`; continue; }
        const l = lines[i].toLowerCase();
        const w = terms.flat().find((x) => l.includes(x));
        if (!w) continue;
        const at = l.indexOf(w);
        snippets.push(`${where || `line ${i + 1}`}: ${lines[i].slice(Math.max(0, at - 60), at + 90).trim()}`);
      }
      results.push({ p, score: distinct * 100 + Math.min(hits, 90), mtime: st.mtimeMs, snippets });
    }
  };
  for (const r of roots) await walk(r, 0);
  cacheSave();
  results.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  const took = ((Date.now() - started) / 1000).toFixed(1);
  if (!results.length) return `Searched ${scanned} files in ${roots.map((r) => path.basename(r)).join(', ')} (${took}s): nothing mentions "${query}". Try other words.`;
  return `Searched ${scanned} files (${took}s). Best matches:\n` + results.slice(0, 10).map((r, i) =>
    `${i + 1}. ${r.p}  (${new Date(r.mtime).toLocaleDateString()})\n${r.snippets.map((s) => `     ${s}`).join('\n')}`).join('\n');
}

// ---------- file butler (preview first, never deletes, undoable) ----------

const CATEGORIES = [
  ['Images', /\.(png|jpe?g|gif|bmp|webp|heic|svg|ico|tiff?)$/i], ['Videos', /\.(mp4|mkv|mov|avi|wmv|webm|flv|m4v)$/i],
  ['Music', /\.(mp3|wav|flac|m4a|aac|ogg|wma|opus)$/i], ['Documents', /\.(pdf|docx?|pptx?|xlsx?|txt|md|rtf|odt|ods|odp|csv|epub)$/i],
  ['Code', /\.(py|js|ts|java|c|cpp|h|cs|go|rs|php|rb|html?|css|json|xml|ipynb|sql|sh|ps1|bat|v|vhd|asm)$/i],
  ['Archives', /\.(zip|rar|7z|tar|gz|bz2|xz|iso)$/i], ['Installers', /\.(exe|msi|msix|appx|apk)$/i],
];
const UNDO_DIR = path.join(config.ROOT, 'runtime', 'undo');
const plans = new Map();

function butlerAllowed(dir) {
  const d = path.resolve(dir).toLowerCase();
  const home = HOME.toLowerCase();
  if (/^[a-z]:\\?$/.test(d)) return 'a whole drive';
  if (d === home) return 'your whole user folder';
  if (d.startsWith(path.join(home, 'appdata').toLowerCase())) return 'app data';
  if (/\\(windows|program files( \(x86\))?|programdata)(\\|$)/.test(d)) return 'a system folder';
  if (d.startsWith(config.ROOT.toLowerCase())) return "Kanishk's own folder";
  return null;
}

function sha256(p) {
  return require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function makePlan(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
  const files = [];
  for (const e of entries) {
    if (/^(desktop\.ini|thumbs\.db)$/i.test(e.name) || /\.(crdownload|part|tmp|download)$/i.test(e.name)) continue;
    const p = path.join(dir, e.name);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (Date.now() - st.mtimeMs < 10 * 60000) continue;     // still being downloaded/edited
    files.push({ name: e.name, p, size: st.size, mtime: st.mtimeMs });
  }
  // duplicates: same size, then same contents; keep the oldest copy
  const bySize = new Map();
  for (const f of files) if (f.size > 0 && f.size < 2e9) bySize.set(f.size, [...(bySize.get(f.size) || []), f]);
  const dupes = [];
  for (const group of bySize.values()) {
    if (group.length < 2) continue;
    const byHash = new Map();
    for (const f of group) { try { const h = sha256(f.p); byHash.set(h, [...(byHash.get(h) || []), f]); } catch {} }
    for (const same of byHash.values()) {
      if (same.length < 2) continue;
      // keep the cleanly named, oldest copy; "x copy.jpg" / "x (1).jpg" are the extras
      const messy = (n) => (/(\bcopy\b|\(\d+\))/i.test(n) ? 1 : 0);
      same.sort((a, b) => messy(a.name) - messy(b.name) || a.mtime - b.mtime);
      for (const extra of same.slice(1)) { extra.dupeOf = same[0].name; dupes.push(extra); }
    }
  }
  const counts = {};
  const moves = [];
  for (const f of files) {
    const cat = f.dupeOf ? '_Duplicates' : (CATEGORIES.find(([, re]) => re.test(f.name)) || ['Other'])[0];
    counts[cat] = (counts[cat] || 0) + 1;
    moves.push({ from: f.p, to: path.join(dir, cat, f.name), cat });
  }
  const bigOld = files.filter((f) => f.size > 200e6 && Date.now() - f.mtime > 90 * 864e5).sort((a, b) => b.size - a.size);
  return { dir, moves, counts, dupes, bigOld, made: Date.now() };
}

async function organizeFolder(args, ctx) {
  const dir = expand(args.path || 'Downloads');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return `No folder at ${dir}`;
  const why = butlerAllowed(dir);
  if (why) return `I won't reorganise ${why} (${dir}); pick a normal folder like Downloads or Desktop.`;
  const key = path.resolve(dir).toLowerCase();
  if (!args.apply) {
    const plan = makePlan(dir);
    plans.set(key, plan);
    if (!plan.moves.length) return `${dir} is already tidy: no loose files to sort.`;
    const mb = (n) => `${(n / 1048576).toFixed(n > 1048576 * 10 ? 0 : 1)} MB`;
    const lines = [
      `PLAN for ${dir} (nothing has moved yet):`,
      ...Object.entries(plan.counts).sort((a, b) => b[1] - a[1]).map(([c, n]) => `- ${n} file${n === 1 ? '' : 's'} -> ${c}\\`),
      plan.dupes.length ? `Duplicates (exact copies, moved to _Duplicates, not deleted): ${plan.dupes.slice(0, 8).map((d) => `${d.name} (copy of ${d.dupeOf})`).join('; ')}${plan.dupes.length > 8 ? ` and ${plan.dupes.length - 8} more` : ''}` : 'No duplicates.',
      plan.bigOld.length ? `Big files untouched for 3+ months (left where they are, consider deleting): ${plan.bigOld.slice(0, 6).map((f) => `${f.name} ${mb(f.size)}`).join('; ')}` : '',
      'Nothing is deleted, and it can be undone. Show this plan to the user and ask them to confirm; when they say yes, call organize_folder again with apply=true.',
    ];
    return lines.filter(Boolean).join('\n');
  }
  let plan = plans.get(key);
  if (!plan || Date.now() - plan.made > 30 * 60000) plan = makePlan(dir);
  if (!plan.moves.length) return 'Nothing to move.';
  if (ctx.cfg.permissionMode !== 'full' && !(await ctx.confirm(`Tidy ${path.basename(dir)}?`, `Move ${plan.moves.length} files into folders (${Object.keys(plan.counts).join(', ')}). Nothing is deleted; you can undo.`))) return 'The user declined.';
  const done = [];
  for (const m of plan.moves) {
    if (!fs.existsSync(m.from)) continue;
    let to = m.to;
    for (let i = 2; fs.existsSync(to); i++) to = m.to.replace(/(\.[^.\\]+)?$/, ` (${i})$1`);
    try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(m.from, to); done.push({ from: m.from, to }); } catch {}
  }
  fs.mkdirSync(UNDO_DIR, { recursive: true });
  fs.writeFileSync(path.join(UNDO_DIR, `organize-${Date.now()}.json`), JSON.stringify({ dir, done }, null, 2));
  plans.delete(key);
  return `Moved ${done.length} of ${plan.moves.length} files in ${dir} into ${[...new Set(done.map((d) => path.basename(path.dirname(d.to))))].join(', ')}. Say "undo the cleanup" to put everything back.`;
}

function undoOrganize() {
  let logs = [];
  try { logs = fs.readdirSync(UNDO_DIR).filter((f) => f.startsWith('organize-')).sort(); } catch {}
  if (!logs.length) return 'There is no cleanup to undo.';
  const file = path.join(UNDO_DIR, logs[logs.length - 1]);
  const { dir, done } = JSON.parse(fs.readFileSync(file, 'utf8'));
  let back = 0;
  for (const m of [...done].reverse()) {
    if (!fs.existsSync(m.to) || fs.existsSync(m.from)) continue;
    try { fs.renameSync(m.to, m.from); back++; } catch {}
  }
  // remove folders the cleanup created, if they're empty now
  for (const d of new Set(done.map((m) => path.dirname(m.to)))) { try { if (!fs.readdirSync(d).length) fs.rmdirSync(d); } catch {} }
  fs.rmSync(file, { force: true });
  return `Put ${back} file${back === 1 ? '' : 's'} back where they were in ${dir}.`;
}

// ---------- lecture-to-notes: study packs ----------

const MEDIA_EXT = /\.(mp3|wav|m4a|aac|ogg|opus|flac|wma|webm|mp4|mkv|mov|avi|m4v)$/i;

function chunkText(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function wavHeader(bytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(bytes, 40);
  return h;
}

/** Any recording -> text, all on this PC: Windows converts it to 16 kHz WAV, whisper transcribes it minute by minute. */
async function transcribeMedia(file, ctx, onProgress) {
  const wav = path.join(os.tmpdir(), `spidey-lecture-${Date.now()}.wav`);
  try {
    const out = await new Promise((resolve) => require('child_process').execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'towav.ps1'), file, wav],
      { windowsHide: true, timeout: 30 * 60000 }, (err, stdout, stderr) => resolve(err ? `FAIL ${String(stderr || err.message).split('\n')[0]}` : String(stdout).trim())));
    if (!/OK/.test(out) || !fs.existsSync(wav)) throw new Error(`Windows couldn't decode ${path.basename(file)} (${out.replace(/^FAIL\s*/, '').slice(0, 120)}). Try an mp3, m4a, wav or mp4.`);
    const buf = fs.readFileSync(wav);
    let off = 12, data = null;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4);
      if (id === 'data') { data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size)); break; }
      off += 8 + size + (size & 1);
    }
    if (!data || data.length < 32000) throw new Error(`${path.basename(file)} has no sound I can hear.`);
    const MIN = 32000 * 60, total = Math.ceil(data.length / MIN), text = [];
    for (let i = 0; i < total; i++) {
      onProgress?.(i, total);
      const pcm = data.subarray(i * MIN, Math.min(data.length, (i + 1) * MIN));
      const form = new FormData();
      form.append('file', new Blob([wavHeader(pcm.length), pcm], { type: 'audio/wav' }), 'part.wav');
      form.append('response_format', 'json');
      form.append('temperature', '0.0');
      const r = await fetch(`http://127.0.0.1:${ctx.cfg.whisperPort}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(180000) });
      if (!r.ok) throw new Error(`speech recognition failed (HTTP ${r.status})`);
      const t = String((await r.json()).text || '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
      if (t) text.push(t);
    }
    return text.join('\n');
  } finally {
    fs.rmSync(wav, { force: true });
  }
}

async function studyPack(args, ctx) {
  const p = expand(args.path || '');
  // "5 quiz questions from these slides" is a quick answer, not a whole pack of files
  const req = String(ctx.request || '').replace(/\[Attached files:[^\]]*\]/g, '');
  if (req && !MEDIA_EXT.test(p) && !/study ?pack|notes|flash ?cards?|revision|revise|study material|lecture to notes/i.test(req)
      && /\b(\d+|a few|some)\s+(quiz\s+|practice\s+|mcq\s+)?(questions|mcqs?)\b|\bsummar|\bexplain\b/i.test(req)) {
    // hand over the text right away, so the model can answer without another step
    let text = '';
    try { text = fs.existsSync(p) ? await execute('read_file', { path: p }, ctx) : ''; } catch {}
    return text
      ? `Not a study-pack request, so no pack was made. Here is the file; now write exactly what the user asked, inside <output>:\n${text}`
      : `Not a study-pack request: call read_file on ${p}, then write exactly what the user asked yourself, inside <output>.`;
  }
  if (!fs.existsSync(p)) return `No file at ${p}`;
  let title = String(args.title || path.basename(p).replace(/\.[^.]+$/, '')).replace(/[<>:"/\\|?*]+/g, '').slice(0, 60) || 'Lecture';
  const progress = (label) => ctx.emit('agent:tool', { name: 'study_pack', label });
  const started = Date.now();

  // 1. get the material as text
  let material = '', kind = 'lecture slides';
  try {
    if (MEDIA_EXT.test(p)) {
      kind = 'lecture recording transcript';
      progress('Listening to the recording');
      material = await transcribeMedia(p, ctx, (done, total) => progress(`Listening to the lecture: minute ${done + 1} of ${total}`));
    } else if (IMAGE_EXT.test(p)) {
      kind = 'photo of notes/board';
      material = await lookAtImage(p, 'Transcribe all the text, formulas and diagram labels exactly.', ctx);
    } else {
      progress(`Reading ${path.basename(p)}`);
      if (/\.pdf$/i.test(p)) material = await readPdf(p);
      else if (/\.docx$/i.test(p)) material = await readDocx(p);
      else if (/\.pptx$/i.test(p)) material = await readPptx(p);
      else if (/\.(txt|md|markdown|srt|vtt|rtf|html?)$/i.test(p)) material = fs.readFileSync(p, 'utf8');
      else return `I can make study packs from PowerPoint, PDF, Word, text files, photos of notes and audio/video recordings, not ${path.extname(p) || 'that kind of file'}.`;
    }
  } catch (e) {
    return `Couldn't read ${path.basename(p)}: ${e.message}`;
  }
  material = String(material || '').trim();
  if (material.length < 150) return `There's too little text in ${path.basename(p)} to make study notes (${material.length} characters).`;

  // 2. long material: condense part by part first
  const parts = chunkText(material, 12000);
  let base = material;
  if (parts.length > 1) {
    const notes = [];
    for (let i = 0; i < parts.length; i++) {
      progress(`Reading part ${i + 1} of ${parts.length}`);
      notes.push(await llm(ctx, [{ role: 'user', content: `Write detailed study notes (markdown bullets) of this part of a ${kind}. Keep every definition, fact, formula and example.\n\n${parts[i]}` }], { maxTokens: 1800, temperature: 0.3 }));
    }
    base = notes.join('\n\n');
  }
  base = base.slice(0, 14000);

  // 3. the pack. Formulas stay plain text: LaTeX looks like junk in Notepad, and inside JSON "\bar"/"\frac" turn into control characters.
  const PLAIN = `Write formulas in plain text that reads well anywhere, e.g. Q_next = J·Q' + K'·Q, v = u + at, x², a/b. Never use LaTeX or $ signs.`;
  progress('Writing clean notes');
  const notes = await llm(ctx, [{ role: 'user', content: `You are a brilliant teacher. From this ${kind}, write clean, well organised study notes in markdown: "##" headings per topic, short bullet points, **key terms** in bold, formulas on their own lines, and a tiny example where it helps. Keep every important fact; no filler, no intro sentence. ${PLAIN}\n\nMATERIAL:\n${base}` }], { maxTokens: 3200, temperature: 0.35 });
  progress('Writing the one-page summary');
  const summary = await llm(ctx, [{ role: 'user', content: `Write a ONE-PAGE revision summary of this material in markdown: 8-12 crisp bullet points of the core ideas, then "**Key formulas / rules**" (bullets, or "none"), then "**Must remember for the exam**" (3-5 bullets). No intro sentence. ${PLAIN}\n\nMATERIAL:\n${base}` }], { maxTokens: 1000, temperature: 0.35 });
  progress('Making flashcards');
  const fc = await llm(ctx, [{ role: 'user', content: `Make 15 flashcards from this material. Each: a short question "q" and a short, precise answer "a". Cover definitions, formulas, differences and examples. ${PLAIN}\n\nMATERIAL:\n${base}` }],
    { maxTokens: 1800, temperature: 0.4, schema: { type: 'object', properties: { cards: { type: 'array', items: { type: 'object', properties: { q: { type: 'string' }, a: { type: 'string' } }, required: ['q', 'a'] } } }, required: ['cards'] } });
  progress('Writing the practice quiz');
  const qz = await llm(ctx, [{ role: 'user', content: `Write a 10-question multiple-choice practice quiz on this material, from easy to hard. Each question has exactly 4 options. Work out a calculation BEFORE writing the options so exactly one option is right. Then "why": one sentence that names the correct option's text. Then "answer": the index (0-3) of that option. Spread the correct answers over A-D. ${PLAIN}\n\nMATERIAL:\n${base}` }],
    { maxTokens: 3000, temperature: 0.4, schema: { type: 'object', properties: { questions: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, why: { type: 'string' }, answer: { type: 'integer' } }, required: ['question', 'options', 'why', 'answer'] } } }, required: ['questions'] } });

  // any LaTeX that slipped through: put back the backslashes JSON decoding swallowed
  const fix = (x) => String(x ?? '').replace(/\x08/g, '\\b').replace(/\f/g, '\\f').replace(/\t(?=[a-z])/g, '\\t').replace(/\r(?=[a-z])/g, '\\r');
  const cards = (fc.cards || []).filter((c) => c.q && c.a).slice(0, 25).map((c) => ({ q: fix(c.q), a: fix(c.a) }));
  // a question whose explanation argues with itself ("wait, the options are wrong") is not worth keeping
  const qs = (qz.questions || []).filter((q) => q.question && Array.isArray(q.options) && q.options.length >= 2 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < Math.min(4, q.options.length)
    && !/\b(wait|re-?evaluat|let'?s|let me|none of the options|options are wrong)\b/i.test(q.why || '')).slice(0, 15)
    .map((q) => {
      // models love putting the right answer at C, so shuffle the options and follow the answer
      const opts = q.options.slice(0, 4).map((o, j) => ({ o: fix(o), right: j === q.answer }));
      for (let j = opts.length - 1; j > 0; j--) { const k = Math.floor(Math.random() * (j + 1)); [opts[j], opts[k]] = [opts[k], opts[j]]; }
      return { question: fix(q.question), options: opts.map((x) => x.o), answer: opts.findIndex((x) => x.right), why: fix(q.why) };
    });
  // "Lecture Notes" / "lecture" says nothing: name the pack after what it's actually about
  if (/^(the )?(lectures?|notes?|lecture notes|study (pack|notes)|class|slides|presentation\d*|document\d*|untitled.*)$|^(new )?(recording|audio|video|vid|rec|voice|aud|screen ?recording|lecture)[\s_-]*[\d\s_-]*$|^[\d\s_.-]+$/i.test(title)) {
    try {
      const t = String(await llm(ctx, [{ role: 'user', content: `Give a 2-5 word title for these study notes (just the topic, e.g. "JK Flip-Flops" or "Newton's Laws of Motion"). Reply with the title only.\n\n${summary.slice(0, 1500)}` }], { maxTokens: 20, temperature: 0.2 }))
        .replace(/[<>:"/\\|?*#*_`]+/g, '').split('\n')[0].trim().slice(0, 60);
      if (t.length > 2) title = t;
    } catch {}
  }
  const L = 'ABCD';
  const cell = (x) => String(x).replace(/\|/g, '/').replace(/\n+/g, ' ');
  const md = [
    `# ${title}: study pack`,
    `*Made by Kanishk from ${path.basename(p)} on ${new Date().toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}.*`,
    '', '## One-page summary', '', summary,
    '', '---', '', '# Notes', '', notes,
    '', '---', '', '## Flashcards', '', '| # | Question | Answer |', '|---|---|---|',
    ...cards.map((c, i) => `| ${i + 1} | ${cell(c.q)} | ${cell(c.a)} |`),
    '', '---', '', '## Practice quiz', '',
    ...qs.flatMap((q, i) => [`**${i + 1}. ${q.question}**`, '', ...q.options.slice(0, 4).map((o, j) => `- ${L[j]}) ${o}`), '']),
    '### Answer key', '',
    ...qs.map((q, i) => `${i + 1}. **${L[q.answer]}** - ${q.why}`),
  ].join('\n');

  const dir = path.join(HOME, 'Documents', 'Kanishk Study');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${title} - study pack.md`);
  fs.writeFileSync(file, md, 'utf8');
  const csv = path.join(dir, `${title} - flashcards.csv`);
  fs.writeFileSync(csv, cards.map((c) => `"${String(c.q).replace(/"/g, '""')}","${String(c.a).replace(/"/g, '""')}"`).join('\r\n'), 'utf8');
  if (MEDIA_EXT.test(p)) fs.writeFileSync(path.join(dir, `${title} - transcript.txt`), material, 'utf8');
  ctx.emit('agent:file', { path: file, content: md });
  return `Study pack saved to ${file} and ALREADY open in the panel, so do not use <output>; reply in 1-2 short sentences. It has: one-page summary, notes, ${cards.length} flashcards (also as ${path.basename(csv)} for Anki/Quizlet) and a ${qs.length}-question quiz with answers. Took ${Math.round((Date.now() - started) / 1000)}s. Offer to quiz them now in study mode.`;
}

// ---------- small helper: one direct question to the model (used inside tools) ----------

async function llm(ctx, messages, { maxTokens = 1200, temperature = 0.6, schema = null } = {}) {
  let msgs = messages;
  if (schema) {   // Groq JSON mode: describe the shape in the prompt itself
    const last = msgs[msgs.length - 1];
    msgs = [...msgs.slice(0, -1), { ...last, content: `${last.content}\n\nReply ONLY with a JSON object matching this JSON schema:\n${JSON.stringify(schema)}` }];
  }
  return groq.complete(msgs, { maxTokens, temperature, json: !!schema });
}

// ---------- wardrobe: Kanishk designs and wears outfits ----------

const Outfits = require('./outfits');
const OUTFIT_DIR = path.join(config.ROOT, 'runtime', 'outfits');

function savedOutfits() {
  try {
    return fs.readdirSync(OUTFIT_DIR).filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(OUTFIT_DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

async function designOutfit(description, ctx) {
  const hats = Object.keys(Outfits.HATS), items = Object.keys(Outfits.ITEMS), emblems = Object.keys(Outfits.EMBLEMS);
  const colors = { type: 'object', properties: { A: { type: 'string' }, C: { type: 'string' }, D: { type: 'string' } }, required: ['A', 'C', 'D'] };
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      suit: { type: 'object', properties: { main: { type: 'string' }, second: { type: 'string' } }, required: ['main', 'second'] },
      hat: { type: 'string', enum: [...hats, 'custom', 'none'] },
      hatColors: colors,
      customHat: { type: 'array', items: { type: 'string' } },
      item: { type: 'string', enum: [...items, 'custom', 'none'] },
      itemColors: colors,
      customItem: { type: 'array', items: { type: 'string' } },
      emblem: { type: 'string', enum: [...emblems, 'number', 'none'] },
      emblemText: { type: 'string' },
      emblemColor: { type: 'string' },
    },
    required: ['name', 'suit', 'hat', 'hatColors', 'item', 'itemColors', 'emblem', 'emblemColor'],
  };
  const hints = Outfits.hintsFor(description);
  const hintLine = Object.keys(hints).length ? `\nSuggested parts for this costume: ${Object.entries(hints).map(([k, v]) => `${k} = ${v}`).join(', ')}.` : '';
  const prompt = `You design pixel-art outfits for Kanishk, a tiny chibi Spider-Man sprite (head 13px wide, body 9px wide), seen from the front.
Design: "${description}". Make it instantly recognisable.${hintLine}
Strongly prefer the ready-made parts; draw "custom" only when none of them fits.

Pick:
- suit.main (head, arms, chest) and suit.second (sides of the body, legs) as #hex colours.
- hat: one of ${hats.join(', ')}; or "custom" and draw customHat; or "none".
- item held in his right hand: one of ${items.join(', ')}; or "custom" and draw customItem; or "none".
- emblem on the chest: one of ${emblems.join(', ')}; or "number" with emblemText (1-2 digits); or "none". emblemColor as #hex.
- hatColors / itemColors: #hex for the letters A (main), C (second), D (detail) used in the part.
Drawing a custom part: rows of equal length using only A, C, D and "." (transparent). Hat max 17 wide x 9 tall, its last row sits on top of the head. Item max 11 wide x 14 tall, upright, held at the bottom.
Example custom party crown hat: [".D.D.D.D.", ".A.A.A.A.", "AAAAAAAAA", "ACACACACA"]

Examples:
cricket kit -> {"name":"Cricket kit","suit":{"main":"#f4f4f0","second":"#f4f4f0"},"hat":"cap","hatColors":{"A":"#2b5fd6","C":"#1b2a6b","D":"#ff9933"},"item":"bat","itemColors":{"A":"#d6b37a","C":"#d6b37a","D":"#7a4a24"},"emblem":"number","emblemText":"18","emblemColor":"#2b5fd6"}
astronaut -> {"name":"Astronaut","suit":{"main":"#e8ecf2","second":"#9aa3b5"},"hat":"helmet","hatColors":{"A":"#f4f4f0","C":"#c9cfdb","D":"#5ff2ff"},"item":"flag","itemColors":{"A":"#e3263b","C":"#f4f4f0","D":"#8d93a6"},"emblem":"star","emblemColor":"#2b5fd6"}`;
  let raw;
  try { raw = ctx.offline ? null : await llm(ctx, [{ role: 'user', content: prompt }], { schema, temperature: 0.5, maxTokens: 900 }); } catch { raw = null; }
  if (!raw || !raw.suit) raw = offlineOutfit(description);   // no internet: build it from the wardrobe's parts and colour words
  const spec = Outfits.normalize({ ...raw, description });
  if (!spec) throw new Error('the design came back empty');
  return spec;
}

// costume -> suit colours; the hat/item/emblem come from Outfits.hintsFor() inside normalize()
const COSTUME_COLOURS = [
  [/pirate/, 'Pirate captain', '#1b2a6b', '#9c1428'], [/cricket/, 'Cricket kit', '#f4f4f0', '#f4f4f0'], [/king|emperor/, 'King', '#7b4bd6', '#f2b632'],
  [/queen|princess/, 'Queen', '#ff6fae', '#f2b632'], [/viking/, 'Viking', '#7a4a24', '#8d93a6'], [/wizard|mage|witch|harry/, 'Wizard', '#7b4bd6', '#1b2a6b'],
  [/astronaut|space/, 'Astronaut', '#e8ecf2', '#9aa3b5'], [/chef|cook|baker/, 'Chef', '#f4f4f0', '#1d1b26'], [/santa|christmas/, 'Santa', '#e3263b', '#f4f4f0'],
  [/ninja|samurai/, 'Ninja', '#1d1b26', '#9c1428'], [/cowboy|sheriff/, 'Cowboy', '#7a4a24', '#d6b37a'], [/angel/, 'Angel', '#f4f4f0', '#ffd84a'],
  [/devil|demon/, 'Devil', '#9c1428', '#1d1b26'], [/thor/, 'Thor', '#8d93a6', '#e3263b'], [/iron ?man/, 'Iron Man', '#9c1428', '#f2b632'],
  [/captain america/, 'Captain America', '#2b5fd6', '#e3263b'], [/hulk/, 'Hulk', '#2fae4f', '#7b4bd6'], [/superman/, 'Superman', '#2b5fd6', '#e3263b'],
  [/batman/, 'Batman', '#1d1b26', '#8d93a6'], [/police|cop/, 'Police', '#1b2a6b', '#1b2a6b'], [/doctor|nurse/, 'Doctor', '#f4f4f0', '#5ff2ff'],
  [/army|soldier/, 'Soldier', '#6b7a2b', '#c8b77a'], [/punk|rock/, 'Rock star', '#1d1b26', '#e3263b'], [/party|birthday/, 'Party time', '#ff6fae', '#7b4bd6'],
  [/graduat|student/, 'Graduate', '#1d1b26', '#1d1b26'], [/football|soccer/, 'Football kit', '#2b5fd6', '#f4f4f0'], [/cat|kitty/, 'Kitty', '#8d93a6', '#f4f4f0'],
  [/bunny|rabbit/, 'Bunny', '#f4f4f0', '#ff6fae'], [/love|valentine|romantic|date/, 'Date night', '#9c1428', '#1d1b26'], [/india|tiranga/, 'Team India', '#2b5fd6', '#ff9933'],
];
function offlineOutfit(description) {
  const d = String(description).toLowerCase();
  const known = COSTUME_COLOURS.find(([re]) => re.test(d));
  const words = Object.keys(Outfits.NAMED).filter((c) => new RegExp(`\\b${c}\\b`).test(d));
  const raw = {
    name: known ? known[1] : String(description).replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 30),
    suit: { main: words[0] || (known ? known[2] : '#e3263b'), second: words[1] || words[0] || (known ? known[3] : '#2b5fd6') },
  };
  if (/love|valentine|date|romantic/.test(d)) { raw.emblem = 'heart'; raw.emblemColor = '#ff6fae'; }
  return raw;
}

function describeSpec(s) {
  const bits = [];
  if (s.suit?.main) bits.push(`suit ${s.suit.main}${s.suit.second && s.suit.second !== s.suit.main ? ` / ${s.suit.second}` : ''}`);
  if (s.hat) bits.push(`${s.hat.template || 'custom-drawn'} hat`);
  if (s.item) bits.push(`${s.item.template || 'custom-drawn'} in hand`);
  if (s.emblem) bits.push(s.emblem.template === 'number' ? `number ${s.emblem.text} on the chest` : `${s.emblem.template} emblem`);
  return bits.join(', ');
}

async function outfit(args, ctx) {
  const action = String(args.action || 'wear');
  const desc = String(args.description || '').trim();
  if (action === 'list') {
    const all = savedOutfits();
    return all.length ? `Wardrobe:\n${all.map((o) => `- ${o.name}: ${describeSpec(o)}`).join('\n')}` : 'The wardrobe is empty so far.';
  }
  if (action === 'remove' || /^(classic|normal|original|regular|default|usual)\b|\b(take (it )?off|remove)\b/i.test(desc)) {
    ctx.emit('outfit:wear', { spec: null });
    return 'Back in the classic red and blue suit.';
  }
  if (!desc) return 'What should I wear?';
  const want = desc.toLowerCase();
  let spec = action !== 'redesign' && savedOutfits().find((o) => o.name.toLowerCase() === want || want.includes(o.name.toLowerCase()));
  let fresh = false;
  if (!spec) {
    spec = await designOutfit(desc, ctx);
    fresh = true;
    fs.mkdirSync(OUTFIT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUTFIT_DIR, `${spec.id}.json`), JSON.stringify(spec, null, 2));
  }
  ctx.emit('outfit:wear', { spec, fresh });
  return `Now wearing "${spec.name}" (${describeSpec(spec)}). ${fresh ? 'Designed it fresh and saved it to the wardrobe.' : 'Took it out of the wardrobe.'} The user can see it on Spidey right now.`;
}

// ---------- routines ----------

const ROUTINES_PATH = path.join(config.ROOT, 'routines.json');
function loadRoutines() { try { return JSON.parse(fs.readFileSync(ROUTINES_PATH, 'utf8')); } catch { return {}; } }
const routineKey = (n) => String(n || '').toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ').trim();

function saveRoutine(args) {
  const name = routineKey(args.name);
  const steps = String(args.steps || '').split(/\r?\n|;|(?:,\s*then\s+)/).map((x) => x.replace(/^\s*(\d+[.)]|-|\*)\s*/, '').trim()).filter(Boolean);
  if (!name || !steps.length) return 'A routine needs a name and at least one step.';
  const all = loadRoutines();
  all[name] = { steps, saved: new Date().toISOString() };
  fs.writeFileSync(ROUTINES_PATH, JSON.stringify(all, null, 2));
  return `Saved routine "${name}" with ${steps.length} step(s):\n${steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}\nSay "${name}" anytime to run it.`;
}

function runRoutine(args) {
  const all = loadRoutines();
  const want = routineKey(args.name);
  const name = all[want] ? want : Object.keys(all).find((k) => want.includes(k) || k.includes(want));
  if (!name) return `No routine called "${args.name}". Saved: ${Object.keys(all).join(', ') || 'none yet'}.`;
  return `Routine "${name}". Do ALL of these now, in order, using your tools, then report briefly:\n${all[name].steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}`;
}

function listRoutines(args) {
  const all = loadRoutines();
  if (args.delete) {
    const k = routineKey(args.delete);
    if (!all[k]) return `No routine called "${args.delete}".`;
    delete all[k];
    fs.writeFileSync(ROUTINES_PATH, JSON.stringify(all, null, 2));
    return `Deleted routine "${k}".`;
  }
  const names = Object.keys(all);
  return names.length ? names.map((n) => `- ${n}: ${all[n].steps.join(' -> ')}`).join('\n') : 'No routines yet.';
}

// ---------- daily recap ----------

const ACTIVITY_PATH = path.join(config.ROOT, 'runtime', 'activity.jsonl');

function dailyRecap(ctx) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  let entries = [];
  try {
    entries = fs.readFileSync(ACTIVITY_PATH, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && e.t >= start.getTime());
  } catch {}
  const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const asked = entries.filter((e) => e.type === 'user').map((e) => `- ${time(e.t)} ${e.text.slice(0, 140)}`);
  const done = entries.filter((e) => e.type === 'tool' && !/^(show_output|daily_recap|briefing)$/.test(e.name))
    .map((e) => `- ${time(e.t)} ${e.label}`);
  const open = loadTodo().filter((x) => !x.done).map((x) => `- ${x.text}`);
  const ahead = (ctx.listReminders?.() || []).filter((r) => r.due < Date.now() + 36 * 3600e3)
    .map((r) => `- ${new Date(r.due).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} ${r.message}`);
  return [
    `Date: ${new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}`,
    `Requests today (${asked.length}):\n${asked.slice(-40).join('\n') || '- none'}`,
    `Actions Kanishk took (${done.length}):\n${done.slice(-40).join('\n') || '- none'}`,
    `Still on the to-do list:\n${open.join('\n') || '- nothing'}`,
    `Coming up:\n${ahead.join('\n') || '- no reminders'}`,
  ].join('\n\n');
}

/** Human-readable label for the speech bubble while a tool runs. */
function describe(name, a = {}) {
  switch (name) {
    case 'run_command': return `Running: ${String(a.command || '').split('\n')[0].slice(0, 60)}`;
    case 'open': return `Opening ${a.target}`;
    case 'close_app': return `Closing ${a.name}`;
    case 'play_youtube': return `Finding "${a.query}" on YouTube`;
    case 'play_music': return `Playing ${/trending/i.test(a.query || '') ? 'something trending' : `"${a.query}"`} on ${a.app || 'YouTube'}`;
    case 'read_file': return `Reading ${path.basename(String(a.path || ''))}`;
    case 'write_file': return `Writing ${path.basename(String(a.path || ''))}`;
    case 'list_dir': return `Looking in ${a.path}`;
    case 'web_search': return `Searching: ${a.query}`;
    case 'fetch_url': return `Reading ${String(a.url || '').replace(/^https?:\/\//, '').slice(0, 40)}`;
    case 'show_output': return `Preparing ${a.title || 'output'}`;
    case 'system_info': return 'Checking your system';
    case 'system_control': return `System: ${a.action}${a.value !== undefined ? ` ${a.value}` : ''}`;
    case 'media_control': return `Media: ${String(a.action || '').replace('_', ' ')}`;
    case 'keyboard': return a.text ? `Typing in ${a.window || 'the active window'}` : `Pressing ${a.keys}`;
    case 'look_at_screen': return 'Looking at your screen';
    case 'look_at_image': return `Looking at ${path.basename(String(a.path || 'the image'))}`;
    case 'daily_recap': return 'Looking back over your day';
    case 'kanishk': return a.action === 'move' ? `Doing a ${a.value || 'trick'}!` : a.action === 'mode' ? `Switching to ${a.value} mode` : 'Adjusting myself';
    case 'outfit': return a.action === 'list' ? 'Opening the wardrobe' : a.action === 'remove' ? 'Changing back' : `Designing "${a.description || 'an outfit'}"`;
    case 'save_routine': return `Learning the "${a.name}" routine`;
    case 'run_routine': return `Running "${a.name}"`;
    case 'list_routines': return 'Checking your routines';
    case 'send_to_phone': return a.path ? `Sending ${path.basename(String(a.path))} to your phone` : 'Sending it to your phone';
    case 'set_reminder': return 'Setting a reminder';
    case 'timer': return a.focus ? `Starting a ${a.minutes}-minute focus session` : `Starting a ${a.minutes}-minute timer`;
    case 'search': return `Searching ${a.where || 'Google'} for "${a.query}"`;
    case 'study_pack': return `Making a study pack from ${path.basename(String(a.path || ''))}`;
    case 'search_in_files': return `Searching inside your files for "${a.query}"`;
    case 'organize_folder': return a.apply ? `Tidying ${a.path}` : `Planning a tidy-up of ${a.path}`;
    case 'undo_organize': return 'Putting the files back';
    case 'find_files': return `Looking for "${a.name}"`;
    case 'todo': return a.action === 'list' ? 'Checking your list' : 'Updating your list';
    case 'notes': return a.action === 'add' ? 'Writing that down' : 'Checking your notes';
    case 'window': return a.action === 'minimize_all' ? 'Clearing the desktop' : `${a.action} ${a.name || ''}`.trim();
    case 'briefing': return 'Putting your briefing together';
    case 'clipboard': return a.action === 'write' ? 'Copying to clipboard' : 'Checking clipboard';
    case 'remember': return 'Noting that down';
    default: return name;
  }
}

/**
 * ctx: { cfg, confirm(title, detail), emit(channel, payload), reminder(minutes, message),
 *        screenshot(opts) -> Buffer, releaseFocus(), vision: boolean }
 */
async function execute(name, args, ctx) {
  args = args || {};
  const mode = ctx.cfg.permissionMode;
  const needsOk = (risky) => mode === 'confirm-all' || (mode === 'confirm-risky' && risky);

  switch (name) {
    case 'run_command': {
      const command = String(args.command || '');
      if (!command.trim()) return 'Error: empty command';
      const elevated = args.elevated === true || args.elevated === 'true';   // UAC is its own confirmation
      if (needsOk(isRisky(command))) {
        const ok = await ctx.confirm('Run this command?', command);
        if (!ok) return 'The user declined to run this command.';
      }
      const timeoutMs = Math.min(600, Math.max(5, Number(args.timeout_seconds) || 60)) * 1000;
      const cwd = args.cwd ? expand(args.cwd) : HOME;
      const r = elevated ? await runElevated(command, cwd, timeoutMs) : await powershell(command, { cwd, timeoutMs });
      return `exit code ${r.code}\n${clip(r.output) || '(no output)'}`;
    }
    case 'open': return openTarget(args.target || '', { app: args.app, newWindow: args.new_window === true });
    case 'close_app': {
      if (needsOk(args.force === true)) {
        if (!(await ctx.confirm(`Force-close ${args.name}?`, 'Unsaved work in it will be lost.'))) return 'The user declined.';
      }
      return closeApp(args.name || '', args.force === true);
    }
    case 'play_music': return playMusic(args);
    case 'play_youtube': return playMusic({ query: args.query, app: 'youtube' });
    case 'read_file': {
      const p = expand(args.path);
      const stat = fs.statSync(p);
      if (stat.isDirectory()) return `That's a folder. Contents:\n${fs.readdirSync(p).join('\n')}`;
      if (/\.pdf$/i.test(p)) return clip(await readPdf(p), 24000);
      if (/\.docx$/i.test(p)) return clip(await readDocx(p), 24000);
      if (/\.pptx$/i.test(p)) return clip(await readPptx(p), 24000);
      if (/\.xlsx$/i.test(p)) return clip(await readXlsx(p), 24000);
      if (IMAGE_EXT.test(p)) return lookAtImage(p, 'Describe this image in detail, including any text in it.', ctx);
      const buf = fs.readFileSync(p);
      if (looksBinary(buf)) return `${path.basename(p)} is a binary file (${(stat.size / 1024).toFixed(0)} KB) that I can't read as text. I can read text, code, PDF, Word, PowerPoint, Excel and images.`;
      return clip(buf.toString('utf8'), 20000);
    }
    case 'write_file': {
      const p = expand(args.path || 'Desktop/kanishk-note.txt');
      const exists = fs.existsSync(p);
      if (needsOk(exists && !args.append)) {
        const ok = await ctx.confirm(`Overwrite ${path.basename(p)}?`, p);
        if (!ok) return 'The user declined to overwrite the file.';
      }
      const content = String(args.content ?? '');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (args.append) fs.appendFileSync(p, content, 'utf8');
      else fs.writeFileSync(p, content, 'utf8');
      ctx.emit('agent:file', { path: p, content: args.append ? null : content });
      return `Saved ${p} (${Buffer.byteLength(content)} bytes). The user can see it in the output panel with Open / Show-in-folder buttons.`;
    }
    case 'list_dir': {
      const p = expand(args.path);
      const entries = fs.readdirSync(p, { withFileTypes: true }).slice(0, 300);
      return `${p}\n` + entries.map((e) => (e.isDirectory() ? `[dir]  ${e.name}` : `       ${e.name}`)).join('\n');
    }
    case 'show_output':
      ctx.emit('agent:output', { title: String(args.title || 'Output'), content: String(args.content || '') });
      return 'Shown to the user in the output panel.';
    case 'web_search': return webSearch(String(args.query || ''));
    case 'fetch_url': {
      const url = /^https?:/i.test(args.url) ? args.url : `https://${args.url}`;
      const r = await fetch(url, { headers: { 'User-Agent': /wttr\.in/.test(url) ? 'curl/8' : UA }, signal: AbortSignal.timeout(20000) });
      const type = r.headers.get('content-type') || '';
      const body = await r.text();
      return clip(type.includes('html') ? htmlToText(body) : body, 12000);
    }
    case 'system_info': return systemInfo();
    case 'system_control': return systemControl(args, ctx);
    case 'media_control': {
      const code = VK[args.action];
      if (!code) return systemControl({ action: args.action === 'mute' ? 'mute' : 'volume', value: args.value }, ctx);
      await powershell(`(New-Object -ComObject WScript.Shell).SendKeys([char]${code})`);
      return 'Done.';
    }
    case 'keyboard': {
      // wiping or closing things by keystroke can destroy unsaved work
      const wipe = /ctrl\+a[\s\S]*(delete|del|backspace)|shift\+delete|alt\+f4|ctrl\+w\b/i.test(String(args.keys || ''));
      if (needsOk(wipe) && !(await ctx.confirm(`Press ${args.keys} in ${args.window || 'the active window'}?`, 'This can erase or close what is open there.'))) return 'The user declined.';
      return keyboard(args, ctx);
    }
    case 'look_at_image': return lookAtImage(String(args.path || ''), String(args.question || ''), ctx);
    case 'daily_recap': return dailyRecap(ctx);
    case 'kanishk': return ctx.self ? ctx.self(String(args.action || ''), String(args.value ?? '')) : 'Not available here.';
    case 'outfit': return outfit(args, ctx);
    case 'save_routine': return saveRoutine(args);
    case 'run_routine': return runRoutine(args);
    case 'list_routines': return listRoutines(args);
    case 'send_to_phone': {
      const file = args.path ? expand(args.path) : null;
      if (file && !fs.existsSync(file)) return `No file at ${file}`;
      if (!file && !args.text) return 'Nothing to send.';
      return phone.push(ctx.cfg, { title: String(args.title || (file ? path.basename(file) : 'From Kanishk')), message: String(args.text || ''), file, tags: 'spider,inbox_tray' });
    }
    case 'look_at_screen': return lookAtScreen(String(args.question || 'Describe what is on the screen.'), ctx);
    case 'set_reminder': {
      let due = args.at ? parseClock(String(args.at)) : null;
      if (args.at && !due) return `I couldn't read the time "${args.at}". Use something like "18:30" or "6:30 pm".`;
      if (!due) due = new Date(Date.now() + Math.max(0.1, Number(args.minutes) || 1) * 60000);
      ctx.reminder((due - Date.now()) / 60000, String(args.message || 'Reminder!'));
      const day = due.toDateString() === new Date().toDateString() ? 'today' : 'tomorrow';
      return `Reminder set for ${due.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ${day}.`;
    }
    case 'timer': {
      const minutes = Math.max(0.1, Math.min(600, Number(args.minutes) || 25));
      ctx.timer?.(minutes, String(args.label || (args.focus ? 'Focus session' : 'Timer')), args.focus === true);
      return `${args.focus ? 'Focus session' : 'Timer'} started: ${minutes} min. A countdown shows next to Kanishk.`;
    }
    case 'search': return searchIn(String(args.where || 'google'), String(args.query || ''), args.browser);
    case 'study_pack': return studyPack(args, ctx);
    case 'search_in_files': return searchInFiles(String(args.query || ''), args.folder);
    case 'organize_folder': return organizeFolder(args, ctx);
    case 'undo_organize': return undoOrganize();
    case 'find_files': return findFiles(String(args.name || ''), args.folder);
    case 'todo': return todo(args);
    case 'notes': return notes(args);
    case 'window': return windowAction(args);
    case 'briefing': return briefing(args, ctx);
    case 'clipboard':
      if (args.action === 'write') { clipboard.writeText(String(args.text ?? '')); return 'Copied to clipboard.'; }
      return clip(clipboard.readText() || '(clipboard is empty)');
    case 'remember': {
      const fact = String(args.fact || '');
      config.addMemory(fact);
      // "User's name is Kanishk" / "my name is ...": also the name Kanishk uses everywhere
      const nm = fact.match(/\b(?:user'?s|my|their|his|her)\s+name\s+is\s+([\p{L}][\p{L}'-]{0,30})/iu);
      if (nm) {
        const name = nm[1][0].toUpperCase() + nm[1].slice(1);
        ctx.cfg.userName = name;
        try { const c = config.load(); c.userName = name; config.save(c); } catch {}
        return `Saved to memory. From now on I call the user ${name}.`;
      }
      return 'Saved to memory.';
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

module.exports = { SCHEMAS, execute, describe, isRisky, powershell, audio, expand, sendKeysSpec, parseClock, searchUrl, loadRoutines, llm, savedOutfits, itunesSong };
