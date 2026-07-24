#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

export FORGE_SOURCE_DATA_DIR="${FORGE_SOURCE_DATA_DIR:-/Users/adam/.forge}"
export FORGE_DATA_DIR="${FORGE_DATA_DIR:-/Users/adam/.forge-e2e-secure-sessions-20260723}"
export FORGE_ELECTRON_USER_DATA_DIR="${FORGE_ELECTRON_USER_DATA_DIR:-/Users/adam/Library/Application Support/@forge/electron-secure-sessions}"
export FORGE_PORT="${FORGE_PORT:-47687}"
export FORGE_UI_PORT="${FORGE_UI_PORT:-47688}"
export FORGE_RUNTIME_TARGET="builder"
export FORGE_HOST="127.0.0.1"
export FORGE_ELECTRON_DEV_SERVER_URL="http://127.0.0.1:${FORGE_UI_PORT}"
export VITE_FORGE_WS_URL="ws://127.0.0.1:${FORGE_PORT}"
export FORGE_TELEMETRY="false"
export FORGE_CORTEX_ENABLED="false"
export FORGE_TERMINAL_ENABLED="false"
export FORGE_SKILL_SHARE_DISABLED="true"
export FORGE_REMOTE_PROJECTS_ENABLED="false"
export FORGE_REMOTE_PROJECTS_TERMINALS_ENABLED="false"
export FORGE_VERSIONING_ENABLED="false"
export FORGE_DEBUG="false"
# Production Forge may already own TanStack's fixed development event-bus
# port. The isolated validation UI does not need browser devtools, so disable
# that sidecar rather than contending with the user's live instance.
export FORGE_DISABLE_TANSTACK_DEVTOOLS="true"

node "$SCRIPT_DIR/reset-isolated-data.mjs"
node "$SCRIPT_DIR/assert-isolation.mjs"

if [[ "${1:-}" == "--check-only" ]]; then
  echo '{"ok":true,"launchStarted":false,"secretsPrinted":false}'
  exit 0
fi
if [[ $# -gt 0 ]]; then
  echo '{"ok":false,"error":"Usage: launch-electron.sh [--check-only]","secretsPrinted":false}' >&2
  exit 1
fi

for port in "$FORGE_PORT" "$FORGE_UI_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo '{"ok":false,"error":"An isolated launch port is already in use.","secretsPrinted":false}' >&2
    exit 1
  fi
done

if [[ -L "$FORGE_ELECTRON_USER_DATA_DIR" ]]; then
  echo '{"ok":false,"error":"Electron user-data path must not be a symlink.","secretsPrinted":false}' >&2
  exit 1
fi
mkdir -p "$FORGE_ELECTRON_USER_DATA_DIR"
chmod 700 "$FORGE_ELECTRON_USER_DATA_DIR"

UI_PID=""
cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  if [[ -n "$UI_PID" ]] && kill -0 "$UI_PID" 2>/dev/null; then
    kill "$UI_PID" 2>/dev/null || true
    wait "$UI_PID" 2>/dev/null || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

cd "$REPO_ROOT"
command pnpm --filter @forge/ui exec vite dev \
  --host 127.0.0.1 \
  --port "$FORGE_UI_PORT" \
  --strictPort &
UI_PID=$!

command pnpm exec wait-on "tcp:127.0.0.1:${FORGE_UI_PORT}"
command pnpm --dir apps/electron dev
