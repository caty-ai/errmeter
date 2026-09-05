'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sensitiveKey = /(token|secret|password|passwd|pwd|api[_-]?key|auth|bearer|cookie|session)/i;
const whitespace = /\s/;

function isPairKeyChar(char) {
  return char !== undefined && ((char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') ||
    (char >= '0' && char <= '9') || char === '_' || char === '.' || char === '-');
}

function isSchemeChar(char) {
  return (isPairKeyChar(char) && char !== '_') || char === '+';
}

function isAsciiLetter(char) {
  return char !== undefined && ((char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z'));
}

function markerEndAt(text, start) {
  if (text.startsWith('[REDACTED TOKEN]', start)) return start + 16;
  if (text.startsWith('[REDACTED PEM]', start)) return start + 14;
  if (text.startsWith('[REDACTED]', start)) return start + 10;
  return -1;
}

function queryValueEnd(text, start) {
  const marked = markerEndAt(text, start);
  if (marked !== -1) return marked;
  let end = start;
  while (end < text.length) {
    const char = text[end];
    if (char === '&' || char === '#' || char === '"' || char === "'" || whitespace.test(char)) break;
    end++;
  }
  return end;
}

function pairValue(text, start) {
  const quote = text[start] === '"' || text[start] === "'" ? text[start] : '';
  if (quote) {
    let end = start + 1;
    while (end < text.length && text[end] !== '\r' && text[end] !== '\n') {
      if (text[end] === '\\') {
        if (end + 1 >= text.length || text[end + 1] === '\r' || text[end + 1] === '\n') break;
        end += 2;
      } else if (text[end] === quote) {
        return { end: end + 1, quote, closed: true };
      } else {
        end++;
      }
    }
    if (end === text.length || text[end] === '\r' || text[end] === '\n') {
      return { end, quote, closed: false };
    }
    // A trailing backslash makes the quoted regex fail, so its unquoted
    // alternative determines the same delimiter boundary as before.
  }
  let end = start;
  while (end < text.length && text[end] !== '\r' && text[end] !== '\n' && text[end] !== '&' && text[end] !== ';') end++;
  const fallbackQuote = text[start] === '"' || text[start] === "'" ? text[start] : '';
  return { end, quote: fallbackQuote, closed: Boolean(fallbackQuote && end - start > 1 && text[end - 1] === fallbackQuote) };
}

function redactPairs(text) {
  const chunks = [];
  let cursor = 0;
  let index = 0;

  function replacePair(start, valueStart, value) {
    const bodyStart = valueStart + (value.quote ? 1 : 0);
    const bodyEnd = value.end - (value.closed ? 1 : 0);
    const keepMarker = markerEndAt(text, bodyStart) === bodyEnd;
    chunks.push(text.slice(cursor, start), text.slice(start, valueStart), value.quote,
      keepMarker ? text.slice(bodyStart, bodyEnd) : '[REDACTED]', value.closed ? value.quote : '');
    cursor = value.end;
    index = value.end;
  }

  while (index < text.length) {
    const char = text[index];

    if (char === '?' || char === '&') {
      const keyStart = index + 1;
      let keyEnd = keyStart;
      while (keyEnd < text.length) {
        const keyChar = text[keyEnd];
        if (keyChar === '=' || keyChar === '&' || keyChar === '?' || keyChar === '#' || whitespace.test(keyChar)) break;
        keyEnd++;
      }
      if (keyEnd > keyStart && text[keyEnd] === '=') {
        const valueStart = keyEnd + 1;
        const valueEnd = queryValueEnd(text, valueStart);
        if (sensitiveKey.test(text.slice(keyStart, keyEnd))) {
          chunks.push(text.slice(cursor, index), char, text.slice(keyStart, keyEnd), '=[REDACTED]');
          cursor = valueEnd;
        }
        index = valueEnd;
        continue;
      }
    }

    if ((char === '"' || char === "'") && isPairKeyChar(text[index + 1])) {
      const keyStart = index + 1;
      let keyEnd = keyStart + 1;
      while (isPairKeyChar(text[keyEnd])) keyEnd++;
      if (text[keyEnd] === char) {
        let separatorEnd = keyEnd + 1;
        while (text[separatorEnd] === ' ' || text[separatorEnd] === '\t') separatorEnd++;
        if (text[separatorEnd] === ':' || text[separatorEnd] === '=') {
          do { separatorEnd++; } while (text[separatorEnd] === ' ' || text[separatorEnd] === '\t');
          if (sensitiveKey.test(text.slice(keyStart, keyEnd))) {
            replacePair(index, separatorEnd, pairValue(text, separatorEnd));
            continue;
          }
        }
      }
    }

    if (isPairKeyChar(char) && (index === 0 || !isPairKeyChar(text[index - 1]))) {
      const keyStart = index;
      let keyEnd = index + 1;
      while (isPairKeyChar(text[keyEnd])) keyEnd++;
      let separatorEnd = keyEnd;
      while (text[separatorEnd] === ' ' || text[separatorEnd] === '\t') separatorEnd++;
      if (text[separatorEnd] === ':' || text[separatorEnd] === '=') {
        do { separatorEnd++; } while (text[separatorEnd] === ' ' || text[separatorEnd] === '\t');
        if (sensitiveKey.test(text.slice(keyStart, keyEnd))) {
          replacePair(index, separatorEnd, pairValue(text, separatorEnd));
          continue;
        }
      }
      index = keyEnd;
      continue;
    }

    index++;
  }
  if (chunks.length === 0) return text;
  chunks.push(text.slice(cursor));
  return chunks.join('');
}

function redactUrlUserinfo(text) {
  const chunks = [];
  let cursor = 0;
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const schemeEnd = text.indexOf('://', searchFrom);
    if (schemeEnd === -1) break;
    let runStart = schemeEnd;
    while (runStart > 0 && isSchemeChar(text[runStart - 1])) runStart--;
    let schemeStart = runStart;
    while (schemeStart < schemeEnd && !isAsciiLetter(text[schemeStart])) schemeStart++;
    if (schemeStart === schemeEnd) {
      searchFrom = schemeEnd + 3;
      continue;
    }
    let valueEnd = schemeEnd + 3;
    let lastAt = -1;
    while (valueEnd < text.length) {
      const char = text[valueEnd];
      if (char === '/' || char === '?' || char === '#' || whitespace.test(char)) break;
      if (char === '@') lastAt = valueEnd;
      valueEnd++;
    }
    if (lastAt !== -1) {
      chunks.push(text.slice(cursor, schemeStart), text.slice(schemeStart, schemeEnd + 3), '[REDACTED]@');
      cursor = lastAt + 1;
      searchFrom = lastAt + 1;
    } else {
      searchFrom = schemeEnd + 3;
    }
  }
  if (chunks.length === 0) return text;
  chunks.push(text.slice(cursor));
  return chunks.join('');
}

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
  result = redactUrlUserinfo(result);
  // Scan each key and value once. The previous lookahead-driven pair regex
  // retried a suffix-wide value alternative at every position on long lines.
  result = redactPairs(result);
  result = result.replace(/\bAuthorization:[ \t]*[^\r\n]*/gi, 'Authorization: [REDACTED]');
  result = result.replace(/\bBearer[ \t]+[^\r\n,;]*/gi, 'Bearer [REDACTED]');
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

module.exports = { buildMaskList, redact, tailLines, sensitiveKey };
