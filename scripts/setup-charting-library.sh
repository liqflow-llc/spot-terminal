#!/bin/bash
# Copy the licensed TradingView Advanced Charts bundle into the frontend's public folder.
# It is served as static files at /charting_library/ and is never committed (see .gitignore).
set -e
SRC="${CHARTING_LIBRARY_SRC:-$HOME/workspace/charting_library/charting_library}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/frontend/public/charting_library"
if [ ! -f "$SRC/charting_library.standalone.js" ]; then
  echo "Charting library not found at $SRC (set CHARTING_LIBRARY_SRC)" >&2
  exit 1
fi
mkdir -p "$DEST"
rsync -a --delete "$SRC/" "$DEST/"
echo "Copied TradingView charting library to $DEST"
