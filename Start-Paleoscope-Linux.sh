#!/usr/bin/env bash
# Run this to launch Paleoscope on Linux:  ./Start-Paleoscope-Linux.sh
cd "$(dirname "$0")" || exit 1
PORT=8000
URL="http://localhost:$PORT/"

echo "============================================"
echo "  Paleoscope - Fossil Globe"
echo "============================================"
echo
echo "Starting a local server at $URL"
echo "Leave this terminal open while using Paleoscope. Press Ctrl+C to stop."
echo

# Try to open a browser automatically (ignored if running headless).
( sleep 1; xdg-open "$URL" >/dev/null 2>&1 || true ) &

if command -v python3 >/dev/null 2>&1; then
  python3 -m http.server "$PORT"
elif command -v python >/dev/null 2>&1; then
  python -m http.server "$PORT"
else
  echo "Python was not found. Install it (e.g. 'sudo dnf install python3' on Oracle Linux)"
  echo "or simply open index.html in your web browser."
  exit 1
fi
