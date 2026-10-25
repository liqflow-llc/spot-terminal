#!/bin/bash
# Copy the licensed TradingView Advanced Charts bundle into the frontend's public folder.
# It is served as static files at /charting_library/ and is never committed (see .gitignore).
# Optional: without it the app uses the free Lightweight Charts instead. To get it, request access
# at https://www.tradingview.com/advanced-charts/ and clone their charting_library repository.
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
# Default: a charting_library clone next to this repository.
SRC="${CHARTING_LIBRARY_SRC:-$REPO/../charting_library/charting_library}"
DEST="$REPO/frontend/public/charting_library"
if [ ! -f "$SRC/charting_library.standalone.js" ]; then
  echo "Charting library not found at $SRC (set CHARTING_LIBRARY_SRC)" >&2
  exit 1
fi
mkdir -p "$DEST"
rsync -a --delete "$SRC/" "$DEST/"
echo "Copied TradingView charting library to $DEST"
