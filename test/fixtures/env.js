'use strict';

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  // Fixtures opt into ERRMETER_* inputs; never inherit developer settings.
  for (const key of Object.keys(env)) {
    if (key.startsWith('ERRMETER_')) delete env[key];
  }
  return { ...env, ...overrides };
}

module.exports = { cleanEnv };
