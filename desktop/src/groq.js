// Kanishk's cloud brain: Groq (OpenAI-compatible). Every model+key pair has its own rate limit
// (free tier: ~7-8K tokens/minute each), so requests rotate over all of them, skip ones that are
// cooling down, and wait briefly when every one is busy, instead of failing.
// Throws OfflineError only when the internet itself is unreachable: that's the cue for the chip brain.
const config = require('./config');

class OfflineError extends Error { constructor(msg) { super(msg || 'no internet'); this.name = 'OfflineError'; } }

// fields Groq accepts; anything else (top_k, min_p, chat_template_kwargs...) is a 400 there
const ALLOWED = ['model', 'messages', 'tools', 'tool_choice', 'temperature', 'top_p', 'max_tokens', 'stream', 'response_format', 'reasoning_effort', 'stop', 'seed'];
const NET_ERR = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|getaddrinfo|network|fetch failed/i;

const cool = new Map();         // "model|keyIndex" -> epoch ms when usable again
let lastOk = 0, lastOffline = 0;

function buckets(models) {
  const keys = config.loadSecrets().groqKeys || [];
  const out = [];
  for (const model of models) keys.forEach((key, i) => out.push({ model, key, id: `${model}|${i}` }));
  return out;
}
function retryAfter(res, text) {
  const h = Number(res.headers.get('retry-after'));
  if (h > 0) return h * 1000;
  const m = String(text).match(/try again in ([\d.]+)(ms|s|m)/i);
  if (m) return Number(m[1]) * (m[2] === 'ms' ? 1 : m[2] === 'm' ? 60000 : 1000);
  return 20000;
}
function clean(body, model) {
  const b = {};
  for (const k of ALLOWED) if (body[k] !== undefined) b[k] = body[k];
  b.model = model;
  // no hidden "thinking" for Qwen; gpt-oss always reasons, keep it short
  b.reasoning_effort = model.includes('gpt-oss') ? 'low' : 'none';
  if (!b.tools || !b.tools.length) { delete b.tools; delete b.tool_choice; }
  return b;
}
function isNetError(e) { return e && (NET_ERR.test(String(e.message)) || NET_ERR.test(String(e.cause && (e.cause.code || e.cause.message)))); }

/**
 * Send one chat completion. opts: { signal, models, onWait(seconds), maxWaitMs, timeoutMs }
 * Returns the fetch Response (ok) so the caller can stream or read JSON.
 */
async function send(body, opts = {}) {
  // just found the internet down: answer from the chip right away, and try Groq again in a little while
  if (Date.now() - lastOffline < 20000) throw new OfflineError('offline (recently checked)');
  const cfg = config.load();
  const list = buckets(opts.models || cfg.groq.models);
  if (!list.length) throw new Error('No Groq API keys in secrets.json');
  const deadline = Date.now() + (opts.maxWaitMs ?? 75000);
  let lastErr = null, netFails = 0;
  for (;;) {
    let tried = 0;
    let retryable = true;       // every failure in this pass was a rate limit / overload: wait and go again
    for (const b of list) {
      if ((cool.get(b.id) || 0) > Date.now()) continue;
      tried++;
      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || 15000);   // until the first response; streaming continues after
      let res;
      try {
        res = await fetch(process.env.KANISHK_GROQ_URL || cfg.groq.url, {   // (env override only for testing offline)
          method: 'POST', headers: { Authorization: `Bearer ${b.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(clean(body, b.model)), signal: ctl.signal,
        });
      } catch (e) {
        clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort);
        if (opts.signal?.aborted) { const a = new Error('aborted'); a.name = 'AbortError'; throw a; }
        if (isNetError(e) || e.name === 'AbortError' || e.name === 'TimeoutError') { netFails++; lastErr = e; if (netFails >= 2) { lastOffline = Date.now(); throw new OfflineError(e.message); } continue; }
        lastErr = e; continue;
      }
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (res.ok) { lastOk = Date.now(); res.bucket = b; return res; }
      const text = await res.text().catch(() => '');
      lastErr = new Error(`Groq ${res.status}: ${text.slice(0, 300)}`);
      if (res.status === 429) cool.set(b.id, Date.now() + Math.max(1000, retryAfter(res, text) + 250));
      else if (res.status === 401 || res.status === 403) cool.set(b.id, Date.now() + 3600e3);        // bad key: skip it for an hour
      else if (res.status === 413) cool.set(b.id, Date.now() + 15000);                              // too big for this model's limit right now
      else if (res.status >= 500) cool.set(b.id, Date.now() + 10000);
      else retryable = false;   // 400 (e.g. this model can't take the request): try the next model/key, but don't loop on it
    }
    if (!tried) {
      // every bucket is cooling down: wait for the earliest one (bounded), telling the UI
      const next = Math.min(...list.map((b) => cool.get(b.id) || 0));
      const wait = Math.max(300, next - Date.now());
      if (Date.now() + wait > deadline) throw lastErr || new Error('Groq is busy');
      opts.onWait?.(Math.ceil(wait / 1000));
      await new Promise((r, j) => {
        const t = setTimeout(r, wait);
        opts.signal?.addEventListener('abort', () => { clearTimeout(t); const a = new Error('aborted'); a.name = 'AbortError'; j(a); }, { once: true });
      });
      continue;
    }
    // everything was rate-limited or busy: go round again (the next pass waits for the first one to free up)
    if (retryable && Date.now() < deadline) continue;
    throw lastErr || new Error('Groq request failed');
  }
}

/** Non-streaming JSON/text helper (used by tools: outfits, study packs, vision). */
async function complete(messages, { maxTokens = 1200, temperature = 0.6, json = false, models, signal, onWait } = {}) {
  const body = { messages, max_tokens: maxTokens, temperature, top_p: 0.95 };
  if (json) body.response_format = { type: 'json_object' };
  const res = await send(body, { models, signal, onWait });
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content || '';
  if (!json) return text.trim();
  try { return JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('bad JSON from model'); }
}

/** Is the internet (Groq) reachable right now? Cheap: a recent success answers it. */
async function online() {
  if (Date.now() - lastOk < 60000) return true;
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${(config.loadSecrets().groqKeys || [])[0] || ''}` }, signal: AbortSignal.timeout(5000) });
    if (r.status < 500) { lastOk = Date.now(); return true; }
    return false;
  } catch (e) { if (isNetError(e) || e.name === 'TimeoutError' || e.name === 'AbortError') lastOffline = Date.now(); return false; }
}

function markOffline() { lastOffline = Date.now(); }

module.exports = { send, complete, online, OfflineError, isNetError, markOffline };
