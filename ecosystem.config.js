module.exports = {
  apps: [{
    name: 'spot-aggregator',
    script: 'backend/src/server.js',
    cwd: '/home/phil/workspace/spot-aggregator',
    interpreter: '/home/phil/.nvm/versions/node/v20.20.2/bin/node',
    // nginx proxies juporderbook.com to 127.0.0.1:3000.
    env: { PORT: '3000', HOST: '127.0.0.1', NODE_ENV: 'production' },
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    time: true,
    // Exactly one instance: two keepers must never submit the same claims.
    instances: 1,
    exec_mode: 'fork',
  }],
};
