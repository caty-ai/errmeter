'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sensitiveKey = /(token|secret|password|passwd|pwd|api[_-]?key|auth|bearer|cookie|session)/i;
const marker = '\\[REDACTED(?: PEM| TOKEN)?\\]';

function buildMaskList(config, env) {
  const masks = new Set();
  function add(value) {
    if (typeof value === 'string' && value.length >= 8) masks.add(value);
  }
  const seen = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (key.endsWith('_file') && typeof child === 'string') {
        try {
          const file = child === '~' ? os.homedir() : /^~[\\/]/.test(child) ? path.join(os.homedir(), child.slice(2)) : child;
          const content = fs.readFileSync(file, 'utf8').trim();
          add(content);
          for (const line of content.split(/\r?\n/)) add(line.trim());
        } catch (_) { /* Unavailable credentials do not prevent emitting. */ }
      } else {
        visit(child);
      }
    }
  }
  try { visit(config); } catch (_) { /* Best effort, including malformed caller data. */ }
  try {
    for (const [key, value] of Object.entries(env || {})) {
      if (key === 'ERRMETER_GITHUB_TOKEN' || sensitiveKey.test(key)) add(value);
    }
  } catch (_) { /* Mask construction never throws. */ }
  return Array.from(masks).sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function redact(text, maskList = []) {
  let result = String(text);
  result = result.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PEM]');
  const masks = Array.from(new Set(maskList.filter(value => typeof value === 'string' && value.length >= 8)))
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  for (const mask of masks) result = result.split(mask).join('[REDACTED]');
  result = result.replace(/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[ousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}|https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+|https:\/\/discord(app)?\.com\/api\/webhooks\/[^\s]+/g, '[REDACTED TOKEN]');
  result = result.replace(new RegExp('\\bAuthorization:[ \\t]*(?:' + marker + '|[^\\s]+[ \\t]+(?:' + marker + '|[^\\s,;]+))', 'gi'), 'Authorization: [REDACTED]');
  result = result.replace(new RegExp('\\bBearer[ \\t]+(?:' + marker + '|[^\\s,;]+)', 'gi'), 'Bearer [REDACTED]');
  result = result.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@');
  result = result.replace(new RegExp('([?&])([^\\s=&?#]+)=(' + marker + '|[^\\s&#"\']*)', 'g'), (all, separator, key, value) =>
    sensitiveKey.test(key) ? separator + key + '=[REDACTED]' : all);
  result = result.replace(new RegExp('(["\']?)([A-Za-z0-9_.-]+)\\1([ \\t]*[:=][ \\t]*)(["\']?)(' + marker + '|[^\\s&,;"\']+)', 'g'), (all, quote, key, separator, valueQuote, value) =>
    sensitiveKey.test(key) ? quote + key + quote + separator + valueQuote + ( /^\[REDACTED(?: PEM| TOKEN)?\]$/.test(value) ? value : '[REDACTED]') : all);
  const home = os.homedir();
  if (home) result = result.split(home).join('~');
  return result.replace(/%USERPROFILE%/g, '~');
}

function tailLines(text, n) {
  if (text === '') return { text: '', truncated: false };
  // A terminal newline terminates the last line; it is not an extra empty line.
  const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length <= n) return { text, truncated: false };
  const tail = n === 0 ? '' : lines.slice(-n).join('');
  return { text: `[errmeter: truncated to last ${n} lines]\n` + tail, truncated: true };
}

module.exports = { buildMaskList, redact, tailLines };
