'use strict';
const http = require('node:http');
const https = require('node:https');

function request({ method = 'GET', url, headers = {}, body, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const fail = code => {
      const error = new Error('HTTP request failed');
      error.code = code;
      reject(error);
    };
    let target; let payload;
    try {
      target = new URL(url);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return fail('EINVAL_URL');
      payload = body === undefined ? undefined : JSON.stringify(body);
    } catch (_) { return fail('EINVAL_REQUEST'); }
    const outgoing = { ...headers };
    if (payload !== undefined) {
      if (!Object.keys(outgoing).some(key => key.toLowerCase() === 'content-type')) outgoing['Content-Type'] = 'application/json';
      outgoing['Content-Length'] = Buffer.byteLength(payload);
    }
    let req;
    try {
      req = (target.protocol === 'https:' ? https : http).request(target, { method, headers: outgoing }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', () => fail('ECONNRESET'));
        res.on('aborted', () => fail('ECONNRESET'));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = text;
          try { parsed = JSON.parse(text); } catch (_) { /* Text responses remain text. */ }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, date: res.headers.date });
        });
      });
      req.on('error', error => fail(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(error.code) ? error.code : 'EHTTP'));
      req.setTimeout(timeoutMs, () => { fail('ETIMEDOUT'); req.destroy(); });
      req.end(payload);
    } catch (_) { if (req) req.destroy(); fail('EINVAL_REQUEST'); }
  });
}
module.exports = { request };
