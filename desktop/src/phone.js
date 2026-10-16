// Spidey -> phone notifications through ntfy (https://ntfy.sh, free and open source).
// The laptop only *sends* messages out to a private topic your phone's ntfy app subscribes to;
// nothing on the phone can reach into the laptop.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  enabled: false,
  server: 'https://ntfy.sh',
  topic: '',
  notify: { reminders: true, timers: true, briefing: true, recap: true, tasks: true },
};

function settings(cfg) {
  const p = cfg.phone || {};
  return { ...DEFAULTS, ...p, notify: { ...DEFAULTS.notify, ...(p.notify || {}) } };
}

/** A long random topic name: it acts as the password for your notification channel. */
function newTopic() {
  return `spidey-${crypto.randomBytes(12).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

function topicUrl(cfg) {
  const s = settings(cfg);
  return `${s.server.replace(/\/+$/, '')}/${s.topic}`;
}

// HTTP headers must be ASCII; ntfy understands RFC 2047 encoded words for anything else (emoji, Hindi...)
const header = (v) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`);

/**
 * Send a notification (or a file) to the phone.
 * kind: which notify-toggle applies ('reminders' | 'timers' | 'briefing' | 'recap' | 'tasks' | 'manual').
 * Returns a short status string.
 */
async function push(cfg, { title = 'Kanishk', message = '', tags = 'spider', priority = 3, file = null, kind = 'manual' } = {}) {
  const s = settings(cfg);
  if (!s.enabled || !s.topic) return 'Phone notifications are not set up yet (right-click Kanishk > Phone notifications > Set up).';
  if (kind !== 'manual' && s.notify[kind] === false) return `Phone notifications for ${kind} are turned off.`;
  const headers = { Title: header(title.slice(0, 200)), Tags: tags, Priority: String(priority) };
  try {
    let res;
    if (file) {
      const size = fs.statSync(file).size;
      if (size > 15 * 1024 * 1024) return `${path.basename(file)} is ${(size / 1048576).toFixed(1)} MB; the limit for sending to the phone is 15 MB.`;
      headers.Filename = header(path.basename(file));
      if (message) headers.Message = header(message.replace(/\s+/g, ' ').slice(0, 900));
      res = await fetch(topicUrl(cfg), { method: 'PUT', headers, body: fs.readFileSync(file), signal: AbortSignal.timeout(60000) });
    } else {
      headers.Markdown = 'yes';
      res = await fetch(topicUrl(cfg), { method: 'POST', headers, body: Buffer.from(message || title, 'utf8'), signal: AbortSignal.timeout(20000) });
    }
    if (!res.ok) return `The notification service said no: HTTP ${res.status} ${(await res.text()).slice(0, 150)}`;
    return file ? `Sent ${path.basename(file)} to the phone.` : 'Sent to the phone.';
  } catch (e) {
    return `Couldn't reach the notification service (${e.message}). Is the laptop online?`;
  }
}

module.exports = { settings, newTopic, topicUrl, push, DEFAULTS };
