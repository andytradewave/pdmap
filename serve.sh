#!/usr/bin/env bash
# Serve Paleoscope over HTTP. Usage: ./serve.sh [port]
set -e
PORT="${1:-8000}"
cd "$(dirname "$0")"
echo "Paleoscope serving at http://localhost:${PORT}  (Ctrl-C to stop)"
exec python3 -m http.server "${PORT}"
