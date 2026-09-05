'use strict';

const { createHash } = require('node:crypto');
const FPV = 1;

function normalize(message) {
  return message
    .toLowerCase()
    .replace(/(?:[a-z]:)?(?:[\\/][^\s"'`:;,)]+){2,}/g, "#path#")
    .replace(/https?:\/\/[^\s"'`)]+/g, "#url#")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "#uuid#")
    .replace(/\b0x[0-9a-f]+\b/g, "#hex#")
    .replace(/\b[0-9a-f]{12,}\b/g, "#hex#")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "#ip#")
    .replace(/:\d+(?::\d+)?\b/g, ":#")
    .replace(/\b\d{4,}\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function fingerprint(agent, message) {
  return createHash('sha256').update(agent + '\n' + normalize(message)).digest('hex').slice(0, 16);
}

module.exports = { FPV, normalize, fingerprint };
