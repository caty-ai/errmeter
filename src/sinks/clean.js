'use strict';

const { redact, sensitiveKey } = require('../redact');

function cleanValue(value, masks) {
  if (typeof value === 'string') {
    // The explicit credential boundary also covers short configured credentials.
    for (const secret of masks.filter(item => typeof item === 'string' && item.length > 0).sort((a, b) => b.length - a.length)) {
      value = value.split(secret).join('[REDACTED]');
    }
    return redact(value, masks);
  }
  if (Array.isArray(value)) return value.map(item => cleanValue(item, masks));
  if (value && typeof value === 'object') {
    const result = Object.create(null);
    for (const [key, item] of Object.entries(value)) result[key] = cleanValue(item, masks);
    return result;
  }
  return value;
}

function cleanEvent(event, masks = []) {
  const result = cleanValue(event, masks);
  if (result && result.meta && typeof result.meta === 'object') {
    for (const key of Object.keys(result.meta)) if (sensitiveKey.test(key)) result.meta[key] = '[REDACTED]';
  }
  return result;
}

module.exports = { cleanValue, cleanEvent };
