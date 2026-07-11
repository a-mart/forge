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

# After stop, drop destination runtime.lock so the isolated tree does not retain
# live PID/lock semantics. Never touch production ~/.forge/runtime.lock.
if [[ -n "${FORGE_DATA_DIR:-}" && -f "${FORGE_DATA_DIR}/runtime.lock" ]]; then
  PROD_REAL="$(python3 -c 'import os; print(os.path.realpath(os.path.expanduser("~/.forge")))')"
  DEST_REAL="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$FORGE_DATA_DIR")"
  if [[ "$DEST_REAL" != "$PROD_REAL" && "$DEST_REAL" != "$PROD_REAL"/* ]]; then
    echo "Removing isolated runtime.lock at destination"
    rm -f "${FORGE_DATA_DIR}/runtime.lock"
  else
    echo "ERROR: refusing to delete runtime.lock — FORGE_DATA_DIR resolves to production" >&2
    exit 1
  fi
fi
