#!/bin/bash
# Build and (re)start the app under pm2. Run from anywhere.
set -e
cd "$(dirname "$0")/.."
export PATH=/home/phil/.nvm/versions/node/v20.20.2/bin:$PATH
./scripts/setup-charting-library.sh
(cd backend && npm install --omit=dev --silent)
(cd frontend && npm install --silent && npx vite build)
pm2 startOrReload ecosystem.config.js --update-env
pm2 save
echo "✅ spot-terminal deployed"
pm2 list | grep spot-terminal
