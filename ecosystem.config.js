// pm2 config for running SpotTerminal in production: `pm2 start ecosystem.config.js`.
// Settings for one host (node binary, port, public URL, keeper keypair path) go in
// ecosystem.local.js next to this file (not committed), shaped like { interpreter, env: {...} };
// anything left out falls back to .env and the defaults in backend/src/config.js.
let local = {};
try {
  local = require('./ecosystem.local.js');
} catch {
  // No local overrides.
}

module.exports = {
  apps: [{
    name: 'spot-terminal',
    script: 'backend/src/server.js',
    cwd: __dirname,
    ...(local.interpreter ? { interpreter: local.interpreter } : {}),
    env: { NODE_ENV: 'production', ...local.env },
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    time: true,
    // Exactly one instance: two keepers must never submit the same claims.
    instances: 1,
    exec_mode: 'fork',
  }],
};
