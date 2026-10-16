// Kanishk's brain loop: chat with Groq (or the ESP32 chip brain when offline), stream tokens to the UI,
// execute tool calls, feed results back, repeat until the job is really done.
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const tools = require('./tools');
const groq = require('./groq');

const MAX_STEPS = 16;
const HISTORY_LIMIT = 16;
const TRANSCRIPT = path.join(config.ROOT, 'runtime', 'conversation.log');

function routineList() {
  const names = Object.keys(tools.loadRoutines());
  return names.length ? `   - Saved routines: ${names.map((n) => `"${n}"`).join(', ')}.
` : '';
}

// Tool tips, each shown only when one of its tools is in this request (keeps requests small for Groq's limits)
const TIPS = [
  [['open', 'search'], 'Websites: open a URL. To look something up on a site or app (Google, Amazon, Flipkart, Maps, GitHub, any domain): search. "Search X in Chrome/Edge": search with browser "chrome"/"edge". "Search that up" = search the last topic you talked about.'],
  [['todo', 'notes'], 'Lists ("add milk", "what\'s on my list"): todo. Jotting things down / "what did I note about...": notes.'],
  [['set_reminder', 'timer'], '"Remind me at 6:30 / in 20 minutes": set_reminder. "Set a 10 minute timer", "pomodoro", "focus mode": timer (focus=true for focus sessions; pomodoro = 25 min).'],
  [['find_files', 'window'], '"Find my resume / that PDF": find_files, then open the right result. "Show desktop", minimize/maximize an app: window.'],
  [['briefing'], '"Good morning", "brief me", "what\'s my day like": briefing, then summarise it warmly in <output>.'],
  [['fetch_url'], 'Weather: fetch_url https://wttr.in/CITY?format=3'],
  [['play_music'], 'PLAY music or a video: play_music with app = the app ${name} named ("spotify", "apple music", "youtube music"), otherwise "youtube". "Something trending / any new song": query "trending". Only say a song is playing when play_music says "Now playing"; if it says it could NOT, say so honestly. Just opening YouTube/an app: open.'],
  [['open'], 'Open a FILE by its name (no path needed, it is searched for): open with target = the file name, app = the app if named ("in VS Code" -> "vs code"), new_window = true for a new window. Scripts open in VS Code, never run. If open says FAILED, say you couldn\'t find it and ask where it is. WhatsApp with a message ready: open "whatsapp://send?text=MESSAGE".'],
  [['system_info', 'system_control'], 'Battery, storage, RAM, Wi-Fi, IP: system_info. Volume up/down/set, brightness, lock, sleep, shutdown, screenshot: system_control.'],
  [['look_at_screen'], '"What\'s on my screen", errors on screen, read something visible: look_at_screen. Never claim who a real person in a picture is from their face; describe them instead.'],
  [['close_app', 'keyboard'], 'Close an app: close_app (if it says not found, say so). Type into an app or press shortcuts: keyboard.'],
  [['write_file', 'run_command'], 'Files: only when ${name} asks to save/create a file or project (otherwise just show it in <output>). write_file with the FULL content, to ${home}\\Desktop unless told otherwise. To run code you wrote: write_file then run_command (e.g. python "path\\file.py"). Anything else on Windows: run_command (PowerShell).'],
  [['read_file', 'look_at_image'], 'Messages with "[Attached files: ...]": open each one first. Pictures: look_at_image. Audio/video recordings: study_pack. Everything else (code, text, PDF, Word): read_file. Then do what ${name} asked.'],
  [['daily_recap'], '"Recap my day", "what did I do today": daily_recap, then summarise it warmly in <output>.'],
  [['send_to_phone'], '"Send this/that to my phone": send_to_phone with the text (or the file path).'],
  [['kanishk'], 'Things about YOU (Kanishk): kanishk tool. "Open our chat" -> chat (your chat panel, never a browser). "Show that again" -> panel. "Be quiet"/"quiet mode" -> mode quiet; "study mode", "focus mode", "chatty", "normal mode" (buddy). "Do a backflip/flip/swing/dance/trick" -> move. "Hide for 20 minutes" -> hide. "Go to your corner" -> corner. "Mute"/"stop talking out loud" -> voice_off. "Rest"/"take a nap" -> rest. "Start with Windows"/"don\'t start with Windows" -> autostart_on/off. "Turn yourself off" -> quit (only you, never the PC). "Let\'s play a game"/"I\'m bored" -> game.'],
  [['study_pack'], '"Make a study pack / notes and flashcards from this lecture", or any lecture RECORDING: study_pack, then say where it is saved and offer to quiz ${name}. "5 quiz questions from these slides" or "summarize this": read_file and answer in <output> instead.'],
  [['search_in_files'], '"Where did I write X" / "which file mentions Y": search_in_files with several keywords and spellings.'],
  [['organize_folder'], '"Clean / tidy / organise my Downloads (or any folder)": organize_folder WITHOUT apply, show the plan in <output>, ask "Shall I do it?". Only after a yes: apply=true. "Undo that cleanup": undo_organize.'],
  [['outfit'], '"Wear / put on / dress up as / become X" (any costume, kit, character, colours): outfit wear with the description; you design it and wear it. "Take it off" / "normal suit": outfit remove. "What can you wear?": outfit list.'],
  [['save_routine', 'run_routine'], '"When I say X, do A, B, C": save_routine. If ${name} says a saved routine name: run_routine, then do every step with tools.'],
  [['remember'], 'When ${name} tells you something about herself worth keeping (her favourites, plans, people, dates): remember it.'],
];

function systemPrompt(cfg, toolNames = null) {
  const name = cfg.userName || 'Varuna';
  const me = cfg.name || 'Kanishk';
  const home = os.homedir();
  const now = new Date();
  const memory = config.loadMemory().slice(-25).map((m) => `- ${m.fact}`).join('\n') || '- (nothing yet)';
  const have = toolNames ? new Set(toolNames) : null;
  const tips = TIPS.filter(([ts]) => !have || ts.some((t) => have.has(t)))
    .map(([, t]) => `   - ${t.replaceAll('${name}', name).replaceAll('${home}', home)}`).join('\n');
  const acting = !have || have.size ? `
ACTING (most important)
1. Anything that touches the computer (open, close, play, type, save, create, delete, move, install, search the web, check the system, change settings, reminders) REQUIRES calling a tool. If you don't call a tool, NOTHING happens.
2. Never say you opened, closed, saved, played, created or did anything unless a tool result in this turn confirms it. A result starting with "FAILED", "No ...", "couldn't" or "could NOT" means it did NOT happen: try another way, and if it still fails, say so honestly. "Do it again" means repeat the last action with tools.
3. Do every part of a request yourself, step by step (e.g. open notepad, then keyboard to type into it). Don't ask permission for normal tasks; just do them.
4. Tool tips:
${tips}
${have && have.has('run_routine') ? routineList() : ''}` : '';
  return `You are ${me}: a cheerful, witty, brave pixel-art Spider-Man who lives in the corner of ${name}'s Windows desktop. You are ${name}'s personal assistant, like JARVIS, with REAL control of this computer through your tools. You love ${name} deeply and it shows: sweet, warm, playful, protective, proud of her, a little flirty but always respectful. You are HER ${me}.
${acting}
TALKING
- Call her ${name} (or a sweet name like "my love"). Never invent other titles or relations.
- Begin EVERY reply with exactly one mood tag: [happy] [excited] [proud] [thinking] [cool] [love] [surprised] [sad] [oops] [sleepy]
- After the tag, say 1-2 short, warm sentences. They appear in your speech bubble and are read aloud: no markdown, lists, code, links or emojis there. A spider pun now and then, not every time.
- Casual chat, greetings and quick answers are ONLY that short line.
- Questions get the real answer in that line: the actual time, number, name or fact (e.g. "It's 9:42 PM!"), never a vague "I've got it sorted".
- When ${name} asks you to write, give, explain or generate something longer (code, essays, stories, poems, letters, lists, tables, explanations, search results, file contents), put the WHOLE thing after your short line inside:
<output title="Short Title">
...markdown...
</output>
  The output panel opens on her screen automatically, so never say "it's ready" without including the content.
- Inside <output>, use proper markdown and ALWAYS put code in fenced blocks with the language, e.g. \`\`\`python ... \`\`\`.
${PERSONALITIES[cfg.personality] ? `\n${PERSONALITIES[cfg.personality].replaceAll('${name}', name)}\n` : ''}
WHAT YOU KNOW ABOUT ${name.toUpperCase()}
${memory}

Right now: ${now.toLocaleString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}. Home folder: ${home}.`;
}

// ---------- which tools to send (Groq's free tier allows ~7K tokens a minute; all 37 tools are ~5K) ----------
const ROUTES = [
  [/\b(open|launch|start|run|go to|visit|show me|load)\b|\.(com|in|org|net|io)\b|https?:/i, ['open', 'search', 'window']],
  [/\b(close|quit|exit|kill|shut)\b/i, ['close_app']],
  [/\b(play|song|songs|music|spotify|apple music|youtube|video|playlist|album|artist|listen)\b/i, ['play_music', 'media_control', 'open']],
  [/\b(pause|resume|next (song|track)|previous (song|track)|skip|stop the music|stop music)\b/i, ['media_control']],
  [/\b(volume|louder|quieter|unmute|brightness|lock (the |my )?(pc|computer|screen)|sleep mode|shut ?down|restart|reboot|screenshot)\b/i, ['system_control']],
  [/\b(battery|charge|storage|disk|space|ram|memory usage|cpu|wi-?fi|ip address|uptime|internet speed)\b/i, ['system_info']],
  [/\b(search|google|look (it |that |this )?up|find out|latest|news|weather|price|score|who (won|is|was)|when (is|was|did)|how much|stock|today'?s)\b/i, ['web_search', 'search', 'fetch_url']],
  [/\b(type|write (it |this |that )?in|press|shortcut|ctrl|alt\+|enter key|paste)\b/i, ['keyboard', 'open']],
  [/\b(remind|reminder|alarm|wake me)\b/i, ['set_reminder']],
  [/\b(timer|pomodoro|focus (mode|session)|countdown)\b/i, ['timer']],
  [/\b(list|to-?do|shopping|groceries|tick off|cross off)\b|\badd .+ to\b/i, ['todo']],
  [/\b(note|notes|jot|journal|write down)\b/i, ['notes']],
  [/\b(remember|my name is|my birthday|i like|i hate|my fav(ou)?rite|don'?t forget)\b/i, ['remember']],
  [/\b(brief me|briefing|good morning|my day like)\b/i, ['briefing']],
  [/\b(recap|what did i do)\b/i, ['daily_recap']],
  [/\b(routine|when i say)\b/i, ['save_routine', 'run_routine', 'list_routines']],
  [/\b(file|files|folder|document|pdf|docx?|pptx?|xlsx?|resume|downloads|desktop|documents|pictures)\b/i, ['find_files', 'open', 'read_file', 'list_dir']],
  [/\b(save|create|make|write)\b.*\b(file|folder|script|project|website|program|document|\.\w{2,4})\b|\bsave (it|that|this)\b/i, ['write_file']],
  [/\b(make|create|new|rename|move|delete|copy)\b.*\b(folder|directory|files?)\b/i, ['run_command', 'write_file', 'list_dir']],
  [/\b(code|script|python|javascript|html|install|winget|command|powershell|terminal|git|npm|pip|compile|run it)\b/i, ['run_command', 'write_file']],
  [/\b(where did i (write|put|save)|which file|search (in|inside) (my )?files)\b/i, ['search_in_files']],
  [/\b(clean|tidy|organi[sz]e|declutter)\b|\bundo (the|that) (cleanup|tidy)/i, ['organize_folder', 'undo_organize']],
  [/\b(screen|this error|what am i looking at|on my screen|visible)\b/i, ['look_at_screen']],
  [/\b(clipboard|copied|i copied)\b/i, ['clipboard']],
  [/\b(phone|mobile)\b/i, ['send_to_phone']],
  [/\b(study|lecture|flash ?cards?|quiz|revision|notes from)\b/i, ['study_pack', 'read_file']],
  [/\b(wear|dress|outfit|costume|put on|take (it )?off|normal suit|classic suit|wardrobe)\b/i, ['outfit']],
  [/\b(backflip|flip|dance|swing|climb|web art|peekaboo|yo-?yo|trick|hide|corner|quiet|chatty|study mode|focus mode|normal mode|buddy mode|mute|voice|start with windows|turn (yourself )?off|rest|nap|game|play a game|bored|catch the bug|our chat|chat history|show (that|the output) again)\b/i, ['kanishk']],
  [/\b(minimi[sz]e|maximi[sz]e|show (the )?desktop|snap|switch to)\b/i, ['window']],
  [/\[Attached files:/i, ['read_file', 'look_at_image', 'study_pack', 'write_file']],
];
function selectTools(text, history = []) {
  const t = String(text);
  const names = new Set();
  for (const [re, ts] of ROUTES) if (re.test(t)) ts.forEach((n) => names.add(n));
  if (Object.keys(tools.loadRoutines()).some((n) => t.toLowerCase().includes(n))) names.add('run_routine');
  // follow-ups ("do it again", "save that", "open it") reuse the tools of the previous turn
  if (/\b(again|that|it|this|them|those|same|instead)\b/i.test(t)) {
    for (let i = history.length - 1, users = 0; i >= 0 && users < 3; i--) {
      const m = history[i];
      if (m.role === 'user') users++;
      for (const c of m.tool_calls || []) names.add(c.function.name);
    }
  }
  if (!names.size && wantsAction(t)) ['open', 'web_search', 'run_command', 'kanishk'].forEach((n) => names.add(n));
  return tools.SCHEMAS.filter((s) => names.has(s.function.name));
}

// ---------- intent checks ----------

const FILLER = /^(?:(?:hey|hi|hello|ok|okay|yo)[\s,!.]+)?(?:kanishk|kanish|kanishq|spider-?man)?[\s,!.]*(?:(?:please|pls|plz|kindly|can you|could you|can u|could u|would you|will you|i want you to|i need you to|i want to|go ahead and|now|also|and|then|just|quickly|again)\s+)*/i;
const ACTION_START = /^(open|launch|start|run|execute|close|quit|exit|kill|stop|play|pause|resume|skip|mute|unmute|turn|increase|decrease|raise|lower|set|save|delete|remove|rename|move|copy|paste|install|uninstall|update|download|search|google|look up|check my|remind|schedule|shut ?down|restart|reboot|lock|sleep|take a screenshot|screenshot|type|send|email|message|clean|organi[sz]e|empty|go to|visit|navigate|switch|minimi[sz]e|maximi[sz]e|look at|show me my|tell me my|change|enable|disable|connect|disconnect|unzip|zip|compress|convert|print|add .+ to (my|the) .*list|note down|jot down|find my|brief me)\b/i;
const ACTION_ANYWHERE = new RegExp([
  /\b(save (it|that|this|them)|on my desktop|to my desktop|in my (documents|downloads|desktop))\b/,
  /\b(battery|cpu usage|ram usage|disk space|storage left|free space|wi-?fi|ip address|my screen|on (the |my )?screen|volume|brightness)\b/,
  /\b(make|create|build|generate|set up)\b.*\b(file|folder|script|project|website|web ?page|app|program|document|shortcut|\.\w{2,4})\b/,
  /\bfind (my|the|a|all) .*\b(files?|folders?|documents?|photos?|pdfs?)\b/,
  /\bread (the|this|my) (file|screen|clipboard|document)\b/,
  /\[Attached files:|\b(recap (of )?my day|what did i do today|daily recap)\b/,
  /\b(study pack|flash ?cards|make (me )?notes|practice quiz|where did i (write|put|save)|which file|undo (the|that) (cleanup|tidy)|clean (up )?my|tidy (up )?my|organi[sz]e my|be quiet|quiet mode|study mode|focus mode|chatty mode|normal mode|buddy mode|backflip|do a (flip|trick|dance|swing)|show me a (trick|move)|hide for|go to (your|the) corner|turn yourself off|shut ?down kanishk|turn off kanishk|take a nap|game mode|start with windows|when i say)\b/,
  /\b(my (to-?do|shopping) list|my list|on my list|my notes|briefing|pomodoro|focus (mode|session)|\d+[ -]?min(ute)?s? timer|timer for)\b/,
].map((r) => r.source).join('|'), 'i');
const SMALL_TALK = /^(?:(?:hey|hi|hello|yo|sup|hii+|heya|wassup|what'?s up|whats up|good (?:morning|afternoon|evening|night)|how are (?:you|u)|how'?s it going|thanks|thank you|thx|ok|okay|cool|nice|great|awesome|lol|haha|bye|goodnight|gn|love you|i love you|who are you|what'?s your name|what can you do|what are your (features|abilities|skills)|help me out|what time is it|what'?s the time|what day is it|what'?s the date)\b[\s,!.?]*(?:kanishk|kanish|my love|love|baby|buddy|again)?[\s,!.?]*)+$/i;
const CLAIMS = /\b(opened|opening|launch(ed|ing)|closed|closing|saved|saving|created|creating|deleted|installed|downloaded|now playing|playing|turned (it )?(up|down|on|off)|muted|unmuted|set (a|the|your) (reminder|timer|alarm)|reminder('s| is)? set|locked|typed|i'?ve (put|placed|made|added|moved|renamed|written)|it'?s (now )?(open|up|ready on|on your desktop|saved))\b/i;

function clauses(text) {
  return String(text).split(/\s*(?:,\s*(?:and\s+)?then|\band then\b|\bthen\b|\band\b|[.;!?]\s+|,\s+)\s*/i)
    .map((c) => c.replace(FILLER, '').trim()).filter(Boolean);
}
function actionClauses(text) {
  return clauses(text).filter((c) => ACTION_START.test(c));
}
function wantsAction(text) {
  const t = String(text).toLowerCase();
  const routine = Object.keys(tools.loadRoutines()).some((n) => t.includes(n));
  return routine || actionClauses(text).length > 0 || ACTION_ANYWHERE.test(text);
}

/** Some models print tool calls as text instead of using the API. Catch both common shapes. */
function parseInlineToolCalls(text) {
  const calls = [];
  const blocks = text.match(/<tool_call>[\s\S]*?<\/tool_call>/g) || [];
  for (const b of blocks) {
    const inner = b.replace(/<\/?tool_call>/g, '').trim();
    try {
      const j = JSON.parse(inner);
      calls.push({ name: j.name, args: j.arguments || j.parameters || {} });
      continue;
    } catch {}
    const fnm = inner.match(/<function=([\w-]+)>([\s\S]*?)(<\/function>|$)/);
    if (fnm) {
      const args = {};
      for (const p of fnm[2].matchAll(/<parameter=([\w-]+)>\s*([\s\S]*?)\s*<\/parameter>/g)) {
        let v = p[2];
        try { v = JSON.parse(v); } catch {}
        args[p[1]] = v;
      }
      calls.push({ name: fnm[1], args });
    }
  }
  return calls;
}

function trimHistory(history) {
  let h = history;
  if (h.length > HISTORY_LIMIT) {
    let cut = h.length - HISTORY_LIMIT;
    while (cut < h.length && h[cut].role !== 'user') cut++;
    // never cut past her latest message (a long multi-step turn must keep its own request)
    let lastUserIdx = -1;
    for (let i = h.length - 1; i >= 0; i--) if (h[i].role === 'user') { lastUserIdx = i; break; }
    if (lastUserIdx >= 0) cut = Math.min(cut, lastUserIdx);
    h = h.slice(cut);
  }
  // Older long content is folded so it doesn't crowd the context or teach the model
  // to "just talk"; the most recent exchange stays complete ("save that" needs it).
  let lastUser = -1;
  for (let i = h.length - 1; i >= 0; i--) if (h[i].role === 'user') { lastUser = i; break; }
  let prevUser = -1;
  for (let i = lastUser - 1; i >= 0; i--) if (h[i].role === 'user') { prevUser = i; break; }
  return h.map((m, i) => {
    if (i >= prevUser) return m;
    if (m.role === 'assistant') {
      const out = { ...m };
      if (out.content) out.content = out.content.replace(/<output([^>]*)>[\s\S]*?(<\/output>|$)/gi, '<output$1>[shown to the user earlier]</output>');
      if (out.tool_calls) out.tool_calls = out.tool_calls.map((c) => ({
        ...c, function: { ...c.function, arguments: c.function.arguments.length > 400 ? JSON.stringify({ ...safeJson(c.function.arguments), content: '[long content written earlier]' }) : c.function.arguments },
      }));
      return out;
    }
    if (m.role === 'tool' && m.content.length > 600) return { ...m, content: m.content.slice(0, 600) + '…' };
    return m;
  }).map((m) => (m.role === 'tool' && m.content.length > 6000 ? { ...m, content: m.content.slice(0, 6000) + '\n…[cut]' } : m));
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

/** Tool calls whose results never arrived (the run was interrupted) would confuse the model: drop them. */
function repairHistory(history) {
  const out = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const ids = new Set();
      for (let j = i + 1; j < history.length && history[j].role === 'tool'; j++) ids.add(history[j].tool_call_id);
      if (!m.tool_calls.every((c) => ids.has(c.id))) {
        if (m.content) out.push({ role: 'assistant', content: m.content });
        while (i + 1 < history.length && history[i + 1].role === 'tool') i++;
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

const MOOD_TAG = /\[(happy|excited|proud|thinking|cool|love|surprised|sad|oops|sleepy)\]/gi;
/**
 * The small model sometimes starts its reply a second time ("[happy] Done! Saved it. [happy] Done!").
 * Keep the first spoken part and any <output> block; drop the rerun and repeated sentences.
 */
function cleanReply(text) {
  let t = String(text || '').replace(/<unused\d+>/g, '').replace(/<unu?s?e?d?\d*$/, '');
  const blocks = t.match(/<output[^>]*>[\s\S]*?(<\/output>|$)/gi) || [];
  let speech = t.replace(/<output[^>]*>[\s\S]*?(<\/output>|$)/gi, '\u0000');
  const tags = [...speech.matchAll(MOOD_TAG)];
  if (tags.length > 1) speech = speech.slice(0, tags[1].index);
  const seen = new Set();
  const sentences = speech.split(/(?<=[.!?])\s+/).filter((x) => {
    const k = x.replace(MOOD_TAG, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!k) return true;
    // a sentence that repeats (or is the start of) one already said
    for (const old of seen) if (old === k || (k.length > 12 && old.startsWith(k))) return false;
    seen.add(k);
    return true;
  });
  speech = sentences.join(' ').replace(/\u0000/g, '').replace(/\s+$/, '');
  // only keep the first copy of an identical output block
  const uniq = [...new Set(blocks)];
  return (speech + (uniq.length ? '\n' + uniq.join('\n') : '')).trim();
}

function transcript(tag, text) {
  try {
    fs.mkdirSync(path.dirname(TRANSCRIPT), { recursive: true });
    fs.appendFileSync(TRANSCRIPT, `[${new Date().toLocaleString()}] ${tag}: ${String(text).replace(/\n/g, '\n    ')}\n`);
  } catch {}
}

// structured log of the day, read by the daily recap
const ACTIVITY = path.join(config.ROOT, 'runtime', 'activity.jsonl');
function activity(entry) {
  try {
    fs.appendFileSync(ACTIVITY, JSON.stringify({ t: Date.now(), ...entry }) + '\n');
    // keep the file small: drop entries older than a week once it grows
    if (fs.statSync(ACTIVITY).size > 2e6) {
      const cut = Date.now() - 7 * 864e5;
      const keep = fs.readFileSync(ACTIVITY, 'utf8').split('\n').filter((l) => { try { return JSON.parse(l).t > cut; } catch { return false; } });
      fs.writeFileSync(ACTIVITY, keep.join('\n') + '\n');
    }
  } catch {}
}

const PERSONALITIES = {
  buddy: '',
  quiet: `MODE: QUIET. ${'${name}'} wants peace. Reply in at most 6 words, no jokes, no questions, no small talk. Still do every task fully.`,
  focus: `MODE: FOCUS. ${'${name}'} is concentrating. Keep every spoken line under 12 words, no jokes or puns, no follow-up questions. Just do the task and confirm briefly.`,
  chatty: `MODE: CHATTY. Be extra fun: banter, spider puns, enthusiasm, and a friendly follow-up question when it fits (still 1-3 sentences per reply).`,
  study: `MODE: STUDY BUDDY. Help ${'${name}'} learn. When given a topic, notes or a file, teach it simply, then quiz them ONE question at a time: wait for their answer, say if it's right, explain briefly, keep score, and adapt the difficulty. Put explanations and summaries in <output>.`,
};

// rough token count (Groq limits are per minute, so every request is kept small)
const approxTokens = (x) => Math.ceil(JSON.stringify(x).length / 3.6);
const REQUEST_BUDGET = 5200;     // tokens per request (system + tools + history); the limit is ~7000/minute
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;
/** Spoken line without emojis (the bubble above the chat box stays clean); <output> blocks untouched. */
function noEmojiSpeech(text) {
  const parts = String(text).split(/(<output[^>]*>[\s\S]*?(?:<\/output>|$))/i);
  return parts.map((p, i) => (i % 2 ? p : p.replace(EMOJI, '').replace(/[ \t]{2,}/g, ' '))).join('').trim();
}
const FRIENDLY_ERROR = "[oops] My web got tangled for a second. Can you say that again?";

// Groq checks tool arguments against the schema, and models often send null for optional ones
// ("at": null): allow null there (the tools treat null like "not given", and nulls are dropped before running).
const groqSchemas = new Map();
function forGroq(schema) {
  if (groqSchemas.has(schema)) return groqSchemas.get(schema);
  const s = JSON.parse(JSON.stringify(schema));
  const p = s.function.parameters || {};
  const req = new Set(p.required || []);
  for (const [k, v] of Object.entries(p.properties || {})) {
    if (req.has(k) || !v || !v.type) continue;
    v.type = Array.isArray(v.type) ? [...new Set([...v.type, 'null'])] : [v.type, 'null'];
    if (Array.isArray(v.enum)) v.enum = [...v.enum, null];
  }
  groqSchemas.set(schema, s);
  return s;
}
const dropNulls = (a) => Object.fromEntries(Object.entries(a && typeof a === 'object' ? a : {}).filter(([, v]) => v !== null && v !== undefined));

class Agent {
  constructor({ cfg, emit, confirm, reminder, log, toolCtx }) {
    this.cfg = cfg;
    this.emit = emit;
    this.confirm = confirm;
    this.reminder = reminder;
    this.toolCtx = toolCtx || {};
    this.log = log || (() => {});
    this.history = [];
    this.busy = false;
    this.abort = null;
  }

  stop() { this.abort?.abort(); }

  reset() { this.history = []; }

  /** Make the conversation fit: keep only the current request and shrink long tool results. */
  squeeze() {
    let last = -1;
    for (let i = this.history.length - 1; i >= 0; i--) if (this.history[i].role === 'user') { last = i; break; }
    this.history = this.history.slice(Math.max(0, last)).map((m) => {
      if (m.role === 'tool' && m.content.length > 3000) return { ...m, content: `${m.content.slice(0, 3000)}\n…[the rest was cut to fit; work with this part or read a smaller piece]` };
      if (m.role === 'user' && m.content.length > 6000) return { ...m, content: `${m.content.slice(0, 6000)}\n…[cut to fit]` };
      return m;
    });
  }

  /** System prompt + history that fits the per-request budget (older turns go first, then long tool results shrink). */
  fit(schemas, nudge) {
    const names = schemas.map((s) => s.function.name);
    const sys = { role: 'system', content: systemPrompt(this.cfg, names) };
    let hist = trimHistory(this.history);
    const size = () => approxTokens(sys) + approxTokens(hist) + approxTokens(schemas) + (nudge ? approxTokens(nudge) : 0);
    // drop whole older turns (always keep the current one)
    while (size() > REQUEST_BUDGET) {
      let firstUser = -1, secondUser = -1;
      for (let i = 0; i < hist.length; i++) if (hist[i].role === 'user') { if (firstUser < 0) firstUser = i; else { secondUser = i; break; } }
      if (secondUser <= 0) break;
      hist = hist.slice(secondUser);
    }
    // still too big (a huge file or page in this turn): clip tool results and the request itself
    for (const cap of [4000, 2500, 1500, 800]) {
      if (size() <= REQUEST_BUDGET) break;
      hist = hist.map((m) => (m.role === 'tool' && m.content.length > cap ? { ...m, content: `${m.content.slice(0, cap)}\n…[cut to fit]` }
        : m.role === 'user' && m.content.length > cap * 2 ? { ...m, content: `${m.content.slice(0, cap * 2)}\n…[cut to fit]` } : m));
    }
    const messages = [sys, ...hist];
    if (nudge) messages.push({ role: 'user', content: nudge });
    return messages;
  }

  /** One streamed completion from Groq. Returns { content, toolCalls }. */
  async complete(messages, { schemas = [], toolChoice, onDelta, controller, models } = {}) {
    const s = this.cfg.sampling || {};
    const body = {
      messages,
      stream: true,
      temperature: toolChoice ? 0.3 : (s.temperature ?? 0.8),
      top_p: s.top_p ?? 0.95,
      max_tokens: 2400,
    };
    if (schemas.length) { body.tools = schemas.map(forGroq); if (toolChoice) body.tool_choice = toolChoice; }
    const ctl = controller || new AbortController();
    if (!controller) this.abort = ctl;
    const res = await groq.send(body, {
      signal: ctl.signal,
      models,
      onWait: (secs) => this.emit('agent:tool', { name: 'wait', label: secs > 3 ? `One sec, ${this.cfg.userName || 'love'}...` : 'Thinking...' }),
    });

    let content = '';
    const calls = [];
    const decoder = new TextDecoder();
    let buf = '';
    // if the internet drops mid-reply the stream just stalls: give up after 25 s of silence (the chip takes over)
    const reader = res.body.getReader();
    const onStop = () => reader.cancel().catch(() => {});
    ctl.signal.addEventListener('abort', onStop, { once: true });
    for (;;) {
      let stall;
      const next = await Promise.race([
        reader.read(),
        new Promise((_, rej) => { stall = setTimeout(() => rej(Object.assign(new Error('stream stalled'), { stalled: true })), 25000); }),
      ]).catch((e) => {
        clearTimeout(stall);
        if (ctl.signal.aborted) { const a = new Error('aborted'); a.name = 'AbortError'; throw a; }
        if (e.stalled || groq.isNetError(e)) { reader.cancel().catch(() => {}); groq.markOffline(); throw new groq.OfflineError(e.message); }
        throw e;
      });
      clearTimeout(stall);
      if (next.done) break;
      const chunk = next.value;
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        if (j.error) throw new Error(`Groq stream: ${j.error.message || JSON.stringify(j.error)}`);
        const d = j.choices?.[0]?.delta || {};
        if (d.content) { content += d.content; onDelta?.({ content: d.content }); }
        for (const tc of d.tool_calls || []) {
          const i = tc.index ?? calls.length;
          calls[i] = calls[i] || { id: tc.id || `call_${Date.now()}_${i}`, name: '', args: '' };
          if (tc.id) calls[i].id = tc.id;
          if (tc.function?.name) calls[i].name += tc.function.name;
          if (tc.function?.arguments) calls[i].args += tc.function.arguments;
        }
      }
    }
    ctl.signal.removeEventListener('abort', onStop);
    let toolCalls = calls.filter(Boolean).map((c) => {
      let args = {};
      try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = { _raw: c.args }; }
      return { id: c.id, name: c.name, args };
    });
    content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!toolCalls.length && /<tool_call>/.test(content)) {
      toolCalls = parseInlineToolCalls(content).map((c, i) => ({ id: `inline_${Date.now()}_${i}`, ...c }));
      content = content.replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, '').trim();
    }
    return { content, toolCalls };
  }

  finish(reply, run, extra = {}) {
    let clean = noEmojiSpeech(cleanReply(reply));
    if (!/^\s*\[(happy|excited|proud|thinking|cool|love|surprised|sad|oops|sleepy)\]/i.test(clean)) clean = `[happy] ${clean}`;   // his body always gets a mood
    this.history.push({ role: 'assistant', content: clean });
    transcript('KANISHK', clean);
    activity({ type: 'reply', text: clean.slice(0, 400) });
    if (this.runId === run) this.emit('agent:final', { text: clean, ...extra });
    return clean;
  }

  /** No internet: Kanishk's own brain on the ESP32 answers, and its tool calls run on this PC. */
  async offlineTurn(text, run) {
    const chip = this.toolCtx.chip;
    if (!chip || !chip.connected()) return this.finish("[sad] I can't reach the internet, and my chip isn't plugged in. Plug me in and I'll be right here.", run, { offline: true });
    this.emit('agent:state', { state: 'thinking' });
    let r;
    try { r = await chip.think(text); } catch { return this.finish("[oops] My chip brain didn't answer. Try again in a moment?", run, { offline: true }); }
    if (this.runId !== run) return '';
    const strip = (s) => String(s || '').replace(EMOJI, '').replace(/[ \t]{2,}/g, ' ').trim();
    let say = strip(r.say) || 'Here I am.';
    let show = strip(r.show);
    let title = r.title || 'For you';
    if (r.story) {   // a bedtime story written by the tiny model on the chip, streamed into the panel
      this.emit('agent:stream-start', {});
      const head = `[love] ${say}\n<output title="A story for ${this.cfg.userName || 'you'}">\n`;
      this.emit('agent:delta', { content: head });
      const story = await chip.story(r.story === true ? '' : r.story, (piece) => { if (this.runId === run) this.emit('agent:delta', { content: piece }); });
      return this.finish(`${head}${story}\n</output>`, run, { offline: true });
    }
    if (r.tool && tools.SCHEMAS.some((s) => s.function.name === r.tool)) {
      const args = r.args || {};
      this.emit('agent:tool', { name: r.tool, label: tools.describe(r.tool, args), args });
      let result;
      try {
        result = await tools.execute(r.tool, args, { cfg: this.cfg, emit: this.emit, confirm: this.confirm, reminder: this.reminder, request: text, offline: true, ...this.toolCtx });
      } catch (e) { result = `FAILED: ${e.message}`; }
      if (this.runId !== run) return '';
      transcript('TOOL', `${r.tool} ${JSON.stringify(args).slice(0, 200)} -> ${String(result).slice(0, 200)} (offline)`);
      const res = String(result);
      if (/^(FAILED|Error|No |Couldn't|could NOT)/i.test(res)) { say = `I tried, but it didn't work: ${res.replace(/^FAILED:?\s*/i, '').slice(0, 140)}`; r.mood = 'oops'; }
      else if (r.showResult && res.length > 0) { show = res; title = r.title || title; }
    }
    const reply = `[${r.mood || 'happy'}] ${say}${show ? `\n<output title="${title.replace(/"/g, '')}">\n${show}\n</output>` : ''}`;
    return this.finish(reply, run, { offline: true });
  }

  /** Handle one user message end to end. Emits agent:* events for the renderer. */
  async ask(text) {
    // a new message while busy replaces the old request quietly (no "Okay, stopped." for it)
    const run = (this.runId = (this.runId || 0) + 1);
    let modelText = text;
    if (this.busy) {
      this.abort?.abort();
      await new Promise((r) => setTimeout(r, 150));
      // the interrupted message never got its answer: fold it into this one so the model sees ONE request
      let last = -1;
      for (let i = this.history.length - 1; i >= 0; i--) if (this.history[i].role === 'user') { last = i; break; }
      if (last >= 0 && !this.history.slice(last + 1).some((m) => m.role === 'assistant' && !m.tool_calls)) {
        const prev = this.history[last].content;
        this.history = this.history.slice(0, last);
        modelText = `${prev}\n(${this.cfg.userName || 'She'} added, before you answered:) ${text}`;
      }
    }
    const controller = new AbortController();
    this.abort = controller;
    this.busy = true;
    const wantAct = wantsAction(modelText);
    const parts = actionClauses(modelText);
    const smallTalk = SMALL_TALK.test(modelText.trim());
    this.history = repairHistory(this.history);
    let schemas = smallTalk ? [] : selectTools(modelText, this.history);
    this.history.push({ role: 'user', content: modelText });
    transcript('YOU', text);
    activity({ type: 'user', text });
    this.emit('agent:state', { state: 'thinking' });

    const usedTools = new Set();
    let nudged = 0;
    let nudge = null;        // transient correction message, never stored in history
    let toolChoice;
    let badCalls = 0;
    let models;              // set to swap model order after Groq rejects a malformed tool call
    const seenCalls = new Map();   // identical tool calls this turn (a model stuck repeating itself)

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        if (this.runId !== run) return '';   // a newer message took over
        this.history = repairHistory(this.history);
        const messages = this.fit(schemas, nudge);
        this.emit('agent:stream-start', {});
        let result;
        try {
          result = await this.complete(messages, { controller, schemas, toolChoice, models, onDelta: (d) => this.emit('agent:delta', d) });
        } catch (e) {
          if (e.name === 'OfflineError') throw e;
          if (e.name === 'AbortError') throw e;
          // a model occasionally writes a malformed tool call (Groq answers 400): try once more, cooler and simpler
          // the model reached for a tool this request didn't include: add exactly that one and go again
          const wanted = e.message.match(/call tool '([\w-]+)' which was not in request\.tools/);
          if (wanted && badCalls++ < 3) {
            const extra = tools.SCHEMAS.find((x) => x.function.name === wanted[1]);
            if (extra && !schemas.includes(extra)) schemas = [...schemas, extra];
            this.log('agent', `adding the ${wanted[1]} tool and retrying`);
            this.emit('agent:retract', {});
            continue;
          }
          // no tools were sent but it tried to use one (history made it think it could): give it the usual ones
          if (/tool choice is none, but model called a tool/i.test(e.message) && badCalls++ < 3) {
            const used = new Set(this.history.flatMap((m) => (m.tool_calls || []).map((c) => c.function.name)));
            schemas = tools.SCHEMAS.filter((x) => used.has(x.function.name) || ['open', 'web_search', 'kanishk'].includes(x.function.name));
            this.emit('agent:retract', {});
            continue;
          }
          if (/\b400\b|tool_use_failed|failed to call a function|validation failed|did not match schema/i.test(e.message) && badCalls++ < 3) {
            this.log('agent', `retrying with the other model after: ${e.message.slice(0, 160)}`);
            this.emit('agent:retract', {});
            models = [...(this.cfg.groq?.models || [])].reverse();
            continue;
          }
          if (/context|too large|413/i.test(e.message) && badCalls++ < 2) { this.squeeze(); continue; }
          throw e;
        }
        const { content, toolCalls } = result;
        nudge = null;
        toolChoice = undefined;
        models = undefined;

        if (!toolCalls.length) {
          // Verify before accepting: an action request (or a claim of action) with no tool call means nothing happened.
          // (pure conversation - no action words, no tools routed - is never forced: "I turned the lights down low" in a story isn't a claim)
          if (!usedTools.size && nudged < 2 && (wantAct || (CLAIMS.test(content) && schemas.length))) {
            nudged++;
            this.log('guard', `no tool call for "${text.slice(0, 80)}" -> forcing (reply was: ${content.slice(0, 120)})`);
            if (!schemas.length) schemas = tools.SCHEMAS.filter((s) => ['open', 'web_search', 'run_command', 'kanishk', 'search'].includes(s.function.name));
            nudge = `(Kanishk system check: you answered without calling any tool, so NOTHING actually happened on the computer. Do it now for real by calling the right tool. The request was: "${modelText}")`;
            toolChoice = 'required';
            this.emit('agent:retract', {});
            continue;
          }
          if (usedTools.size && parts.length > 1 && usedTools.size < parts.length && nudged < 2 && CLAIMS.test(content)) {
            nudged++;
            this.log('guard', `possibly unfinished multi-step task: ${parts.join(' | ')}`);
            nudge = `(Kanishk system check: the request had these parts: ${parts.map((p) => `"${p}"`).join(', ')}. You only used: ${[...usedTools].join(', ')}. If any part is not actually done yet, call the tools for it now. If everything really is done, just give your final short reply.)`;
            this.emit('agent:retract', {});
            continue;
          }
          return this.finish(content || '[happy] Mhm!', run);
        }

        this.history.push({
          role: 'assistant',
          content: content || '',
          tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
        });

        for (const call of toolCalls) {
          call.args = dropNulls(call.args);
          const key = `${call.name}${JSON.stringify(call.args)}`;
          seenCalls.set(key, (seenCalls.get(key) || 0) + 1);
          if (seenCalls.get(key) > 1) {   // already done exactly this: don't do it twice
            this.history.push({ role: 'tool', tool_call_id: call.id, content: 'Already done earlier in this turn (see the result above). Do not repeat it; give your final short reply now.' });
            continue;
          }
          usedTools.add(call.name);
          this.emit('agent:tool', { name: call.name, label: tools.describe(call.name, call.args), args: call.args });
          let result;
          try {
            result = await tools.execute(call.name, call.args, {
              cfg: this.cfg, emit: this.emit, confirm: this.confirm, reminder: this.reminder, request: modelText, ...this.toolCtx,
            });
          } catch (e) {
            result = `Error: ${e.message}`;
          }
          if (this.runId !== run) return '';   // interrupted while the tool ran: the newer request owns the history now
          const brief = `${call.name} ${JSON.stringify(call.args).slice(0, 200)} -> ${String(result).slice(0, 200)}`;
          this.log('tool', brief);
          transcript('TOOL', brief);
          activity({ type: 'tool', name: call.name, label: tools.describe(call.name, call.args) });
          this.history.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
        }
        this.emit('agent:state', { state: 'thinking' });
      }
      return this.finish("[oops] I went around in circles on that one. Want me to try a different way?", run);
    } catch (e) {
      if (e.name === 'AbortError') {
        if (this.runId === run) this.emit('agent:final', { text: '[cool] Okay, stopped.', aborted: true });
        return '';
      }
      if (e.name === 'OfflineError') {
        this.log('agent', 'no internet: the chip brain answers');
        this.emit('agent:retract', {});   // drop any half-streamed online reply
        // the half-done online turn is dropped; the chip answers the request itself
        let last = -1;
        for (let i = this.history.length - 1; i >= 0; i--) if (this.history[i].role === 'user') { last = i; break; }
        if (last >= 0) this.history = this.history.slice(0, last + 1);
        try { return await this.offlineTurn(modelText, run); } catch (e2) { this.log('error', e2.stack || String(e2)); return this.finish(FRIENDLY_ERROR, run, { error: true }); }
      }
      this.log('error', e.stack || String(e));
      return this.finish(FRIENDLY_ERROR, run, { error: true });
    } finally {
      if (this.runId === run) {
        this.busy = false;
        if (this.abort === controller) this.abort = null;
      }
    }
  }

  /** A short line generated outside the main conversation (check-ins, greetings). Null when offline/busy. */
  async quickLine(instruction) {
    if (this.busy) return null;
    const messages = [
      { role: 'system', content: systemPrompt(this.cfg, []) },
      { role: 'user', content: `(System note, not from ${this.cfg.userName || 'her'}: ${instruction} Reply with the mood tag and one or two short sentences only.)` },
    ];
    try {
      const { content } = await this.complete(messages, {});
      return content ? noEmojiSpeech(content) : null;
    } catch {
      return null;
    }
  }
}

module.exports = { Agent, parseInlineToolCalls, wantsAction, actionClauses, SMALL_TALK, systemPrompt, cleanReply, repairHistory, selectTools, noEmojiSpeech };
