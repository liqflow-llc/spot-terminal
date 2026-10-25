#!/bin/bash
# Build and (re)start the app under pm2. Run from anywhere.
set -e
cd "$(dirname "$0")/.."
# Host-specific settings (e.g. which Node to build with), if any: scripts/deploy.local.sh.
[ -f scripts/deploy.local.sh ] && . scripts/deploy.local.sh
./scripts/setup-charting-library.sh || echo "Deploying with the free chart (no TradingView bundle)."
(cd backend && npm install --omit=dev --silent)
(cd frontend && npm install --silent && npx vite build)
# Restart by name when it's already running: a pm2 wrapper that routes commands per app (e.g. to
# another user's pm2) understands names, while `startOrReload` could start a second instance,
# and with it a second keeper.
if pm2 describe spot-terminal > /dev/null 2>&1; then
  pm2 restart spot-terminal
else
  pm2 start ecosystem.config.js
fi
pm2 save
echo "✅ spot-terminal deployed"
pm2 list | grep spot-terminal
