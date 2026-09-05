'use strict';

const { redact } = require('../redact');

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

module.exports = { cleanValue };
