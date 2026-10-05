module.exports = {
  apps: [{
    name: 'spot-aggregator',
    script: 'backend/src/server.js',
    cwd: '/home/phil/workspace/spot-aggregator',
    interpreter: '/home/phil/.nvm/versions/node/v20.20.2/bin/node',
    // nginx proxies juporderbook.com to 127.0.0.1:3000.
    // Payouts are paid by LiqFlow LLC's hot wallet (56Pk…, shared with Skirmish). It only ever
    // holds a little SOL; the treasury is on a hardware wallet.
    env: { PORT: '3000', HOST: '127.0.0.1', NODE_ENV: 'production', KEEPER_KEYPAIR: '/home/phil/workspace/skirmish/server/airdrop.keypair.json' },
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    time: true,
    // Exactly one instance: two keepers must never submit the same claims.
    instances: 1,
    exec_mode: 'fork',
  }],
};
