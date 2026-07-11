#!/usr/bin/env bash
# Stop isolated Pi upgrade Forge instance by ports from .env (never production ports).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ ! -f "$ROOT/.env" ]]; then
  echo "ERROR: missing .env" >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a
source "$ROOT/.env"
set +a

BACKEND_PORT="${FORGE_PORT:?}"
UI_PORT="${FORGE_UI_PORT:-$((BACKEND_PORT + 1))}"

node "$ROOT/scripts/pi-upgrade/assert-isolation.mjs" >/dev/null

for port in "$BACKEND_PORT" "$UI_PORT"; do
  pids="$(lsof -i ":$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "Stopping listeners on port $port: $pids"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
  else
    echo "No listener on port $port"
  fi
done
