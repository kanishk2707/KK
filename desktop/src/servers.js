// Starts and talks to the two local engines:
//   llama-server  -> the Gemma 4 brain + vision (OpenAI-compatible API on localhost)
//   whisper       -> speech-to-text for the mic
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT } = require('./config');

const RUNTIME = path.join(ROOT, 'runtime');
const children = [];

function findFile(dir, name, depth = 3) {
  if (!fs.existsSync(dir) || depth < 0) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return p;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const hit = findFile(path.join(dir, entry.name), name, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

function resolveModel(cfg) {
  if (cfg.model) {
    const p = path.isAbsolute(cfg.model) ? cfg.model : path.join(ROOT, cfg.model);
    if (fs.existsSync(p)) return p;
  }
  const dir = path.join(RUNTIME, 'models');
  if (!fs.existsSync(dir)) return null;
  const ggufs = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.gguf') && !f.startsWith('mmproj') && fs.existsSync(path.join(dir, f + '.done')));
  return ggufs.length ? path.join(dir, ggufs[0]) : null;
}

function startProcess(exe, args, label, log) {
  const child = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true });
  children.push(child);
  const tail = [];
  const onData = (d) => {
    const s = d.toString();
    tail.push(s);
    if (tail.length > 40) tail.shift();
    if (!child.quiet || /error|failed|exception/i.test(s)) log?.(label, s);   // chatty request logs stay out once loaded
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.tail = tail;
  return child;
}

async function waitFor(url, child, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`exited with code ${child.exitCode}: ${child.tail.join('').slice(-800)}`);
    }
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('timed out while loading');
}

/** Kill engines left behind by a crashed previous run so the ports are free. */
function cleanupStale() {
  return new Promise((resolve) => {
    const ps = `Get-Process llama-server,whisper-server -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${RUNTIME.replace(/'/g, "''")}*' } | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*${path.join(__dirname, 'monitor.ps1').replace(/'/g, "''")}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }, () => resolve());
  });
}

function findMmproj(model, cfg) {
  const dir = path.dirname(model);
  if (cfg.mmproj) {
    const p = path.isAbsolute(cfg.mmproj) ? cfg.mmproj : path.join(ROOT, cfg.mmproj);
    return fs.existsSync(p) ? p : null;
  }
  // match on the model's family name, e.g. "gemma-4-E2B-it"
  const stem = path.basename(model).replace(/[-_.](Q\d.*|IQ\d.*|BF16|F16|F32)?\.gguf$/i, '').toLowerCase();
  const hits = fs.readdirSync(dir).filter((f) => /^mmproj.*\.gguf$/i.test(f) && fs.existsSync(path.join(dir, f + '.done')));
  const own = hits.find((f) => f.toLowerCase().includes(stem));
  return own ? path.join(dir, own) : null;
}

let llamaChild = null;

/**
 * After many interrupted generations llama-server can get stuck emitting "<unused49>" junk
 * (Gemma 4, b11524) until it is restarted. A fresh process fixes it, so restart just the model.
 */
async function restartLlama(cfg, log) {
  const old = llamaChild;
  if (old && old.exitCode === null) {
    const gone = new Promise((r) => old.once('exit', r));
    try { old.kill(); } catch {}
    await Promise.race([gone, new Promise((r) => setTimeout(r, 8000))]);
  }
  return startLlama(cfg, log);
}

async function startLlama(cfg, log) {
  const exe = findFile(path.join(RUNTIME, 'llama'), 'llama-server.exe');
  if (!exe) throw new Error('llama-server.exe not found. Run setup.ps1 first.');
  const model = resolveModel(cfg);
  if (!model) throw new Error('No GGUF model found in runtime/models. Run setup.ps1 first.');
  const args = [
    '-m', model,
    '--host', '127.0.0.1', '--port', String(cfg.llamaPort),
    '-ngl', String(cfg.gpuLayers),
    '-c', String(cfg.contextSize),
    '-np', '1',
    '--jinja',
    '--no-webui',
  ];
  // Vision projector: the one that belongs to this model (e.g. mmproj-gemma-4-E2B-it-*.gguf for gemma-4-E2B-it-*.gguf).
  const mmproj = findMmproj(model, cfg);
  const vision = cfg.vision !== false && !!mmproj;
  if (vision) {
    args.push('--mmproj', mmproj, '--image-max-tokens', String(cfg.imageMaxTokens || 560));
    // a big model fills the GPU, so its projector runs on the CPU (slow); a small one leaves room for it
    if (cfg.visionOnGpu === false) args.push('--no-mmproj-offload');
  }
  const child = startProcess(exe, args, 'llama', log);
  llamaChild = child;
  await waitFor(`http://127.0.0.1:${cfg.llamaPort}/health`, child, 240000);
  child.quiet = true;
  return { model: path.basename(model), vision };
}

let whisper = { mode: null };

async function startWhisper(cfg, log) {
  const model = path.join(RUNTIME, 'models', 'ggml-base.en.bin');
  if (!fs.existsSync(model)) throw new Error('Whisper model missing. Run setup.ps1 first.');
  const dir = path.join(RUNTIME, 'whisper');
  const server = findFile(dir, 'whisper-server.exe');
  if (server) {
    const threads = String(Math.max(2, Math.min(8, os.cpus().length - 2)));
    const child = startProcess(server, ['-m', model, '--host', '127.0.0.1', '--port', String(cfg.whisperPort), '-t', threads], 'whisper', log);
    await waitFor(`http://127.0.0.1:${cfg.whisperPort}/`, child, 60000);
    child.quiet = true;
    whisper = { mode: 'server', port: cfg.whisperPort };
    return;
  }
  const cli = findFile(dir, 'whisper-cli.exe') || findFile(dir, 'main.exe');
  if (!cli) throw new Error('whisper binaries not found. Run setup.ps1 first.');
  whisper = { mode: 'cli', exe: cli, model };
}

const HALLUCINATIONS = /^\s*(\[(blank_audio|music|silence|inaudible)[^\]]*\]|\(.*?\)|thank you\.?|thanks for watching!?|you|\.+|bye\.?)\s*$/i;

function cleanTranscript(text) {
  const t = String(text || '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim();
  return HALLUCINATIONS.test(t) ? '' : t;
}

/** wav: ArrayBuffer of 16 kHz mono PCM16 WAV. Returns plain text. */
async function transcribe(wav, prompt = '') {
  if (whisper.mode === 'server') {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0.0');
    if (prompt) form.append('prompt', prompt);
    const r = await fetch(`http://127.0.0.1:${whisper.port}/inference`, { method: 'POST', body: form });
    if (!r.ok) throw new Error(`whisper HTTP ${r.status}`);
    const j = await r.json();
    return cleanTranscript(j.text);
  }
  if (whisper.mode === 'cli') {
    const file = path.join(os.tmpdir(), `spidey-${Date.now()}.wav`);
    fs.writeFileSync(file, Buffer.from(wav));
    try {
      const out = await new Promise((resolve, reject) => {
        execFile(whisper.exe, ['-m', whisper.model, '-f', file, '-nt', '-np', ...(prompt ? ['--prompt', prompt] : [])], { windowsHide: true, timeout: 60000 },
          (err, stdout) => (err ? reject(err) : resolve(stdout)));
      });
      return cleanTranscript(out);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
  throw new Error('speech recognition is not ready');
}

function stopAll() {
  for (const c of children) {
    try { if (c.exitCode === null) c.kill(); } catch {}
  }
}

module.exports = { cleanupStale, startLlama, restartLlama, startWhisper, transcribe, stopAll };
