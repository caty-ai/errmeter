'use strict';

const { cleanValue } = require('./sinks/clean');

async function notify(ctx, alert) {
  const results = { sent: [], failed: [] };
  if (ctx.dryRun) return results;
  const channels = ctx.config.notify || [];
  const masks = [...(ctx.maskList || []), ctx.config.sink?.token,
    ...channels.flatMap(entry => [entry.token, entry.webhook_url, ...Object.values(entry.headers || {})])].filter(Boolean);
  const cleaned = cleanValue({ key: alert.key, title: alert.title, body: alert.body }, masks);
  const text = cleanValue((alert.title || '') + '\n' + (alert.body || ''), masks);
  for (const entry of channels) {
    try {
      let url; let body; let headers = {};
      if (entry.type === 'telegram') {
        url = 'https://api.telegram.org/bot' + entry.token + '/sendMessage';
        body = { chat_id: entry.chat_id, text };
      } else if (entry.type === 'slack') {
        url = entry.webhook_url;
        body = { text };
      } else if (entry.type === 'webhook') {
        url = entry.url;
        headers = entry.headers || {};
        body = { alert: cleaned };
      } else throw new Error('Unknown notification type');
      const transport = ctx.http || require('./http').request;
      const response = await (typeof transport === 'function' ? transport : transport.request.bind(transport))({ method: 'POST', url, headers, body });
      if (!Number.isInteger(response?.status) || response.status < 200 || response.status >= 300) throw new Error('Notification rejected');
      results.sent.push(entry.type);
    } catch (_) {
      results.failed.push(entry.type);
      // Transport errors can embed the Telegram token in their URL. Diagnostics
      // deliberately contain no transport-supplied text, response, or target URL.
      try { ctx.log?.('notify: ' + entry.type + ' delivery failed'); } catch (_) { /* Try every channel even when logging fails. */ }
    }
  }
  return results;
}

module.exports = { notify };
