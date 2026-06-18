#!/usr/bin/env bash
# Serve PDMap over HTTP. Usage: ./serve.sh [port]
set -e
PORT="${1:-8000}"
cd "$(dirname "$0")"
echo "PDMap serving at http://localhost:${PORT}  (Ctrl-C to stop)"
exec python3 -m http.server "${PORT}"
