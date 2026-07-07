#!/bin/bash
# Double-click this file to launch Paleoscope on macOS.
cd "$(dirname "$0")" || exit 1
PORT=8000
URL="http://localhost:$PORT/"

echo "============================================"
echo "  Paleoscope - Fossil Globe"
echo "============================================"
echo
echo "Starting a local server at $URL"
echo "Your browser will open shortly."
echo "Leave this window open while using Paleoscope. Press Ctrl+C (or close it) to stop."
echo

( sleep 1; open "$URL" ) &

if command -v python3 >/dev/null 2>&1; then
  python3 -m http.server "$PORT"
else
  echo "Python 3 was not found. Opening the app file directly instead."
  open "index.html"
fi
