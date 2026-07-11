#!/usr/bin/env bash
# Launch an isolated Forge backend+UI for Pi upgrade validation.
# Refuses production data/ports. Never prints secret file contents.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:${HOME}/Library/pnpm:${PATH:-}"

# Live provider calls fail under Socket Firewall HTTP proxies; clear them for isolated E2E.
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy \
  YARN_HTTP_PROXY YARN_HTTPS_PROXY CARGO_HTTP_PROXY GIT_PROXY_SSL_CAINFO || true

if [[ ! -f "$ROOT/.env" ]]; then
  echo "ERROR: $ROOT/.env missing. Create it with FORGE_DATA_DIR, FORGE_PORT, VITE_FORGE_WS_URL." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a
source "$ROOT/.env"
set +a

BACKEND_PORT="${FORGE_PORT:?FORGE_PORT required}"
UI_PORT="${FORGE_UI_PORT:-$((BACKEND_PORT + 1))}"
export FORGE_UI_PORT="$UI_PORT"
INSTANCE_NONCE="$(node -e 'console.log(require("crypto").randomUUID())')"
if [[ -z "${FORGE_DATA_DIR:-}" || -z "$INSTANCE_NONCE" ]]; then
  echo "ERROR: isolated identity is empty (FORGE_DATA_DIR and nonce are required)." >&2
  exit 1
fi

PNPM_BIN="$(command -v pnpm || true)"
if [[ -z "$PNPM_BIN" || "$PNPM_BIN" != /* ]]; then
  if [[ -x "${HOME}/Library/pnpm/pnpm" ]]; then
    PNPM_BIN="${HOME}/Library/pnpm/pnpm"
  else
    echo "ERROR: could not resolve a pnpm executable path (shell functions are not usable under nohup)." >&2
    exit 1
  fi
fi

node "$ROOT/scripts/pi-upgrade/assert-isolation.mjs"

for port in "$BACKEND_PORT" "$UI_PORT"; do
  if lsof -i ":$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "ERROR: port $port is already in use; refusing to adopt an existing listener." >&2
    exit 1
  fi
done

# Copied data roots inherit production runtime.lock; remove only from isolated trees.
if [[ -f "${FORGE_DATA_DIR}/runtime.lock" ]]; then
  echo "Removing inherited runtime.lock from isolated data dir (not production)"
  rm -f "${FORGE_DATA_DIR}/runtime.lock"
fi

LOG_DIR="${TMPDIR:-/tmp}/forge-pi-upgrade-isolated"
mkdir -p "$LOG_DIR"
BACKEND_LOG="$LOG_DIR/backend-${BACKEND_PORT}.log"
UI_LOG="$LOG_DIR/ui-${UI_PORT}.log"

echo "Starting isolated backend on 127.0.0.1:${BACKEND_PORT} (data=${FORGE_DATA_DIR})"
# Prefer non-watch tsx for stable E2E (avoids protocol rebuild lock races).
nohup env FORGE_HOST=127.0.0.1 FORGE_PORT="$BACKEND_PORT" FORGE_DATA_DIR="$FORGE_DATA_DIR" FORGE_PI_UPGRADE_INSTANCE_NONCE="$INSTANCE_NONCE" \
  "$PNPM_BIN" --filter @forge/backend exec tsx src/index.ts \
  >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
echo "$BACKEND_PID" >"$LOG_DIR/backend-${BACKEND_PORT}.pid"
echo "$INSTANCE_NONCE" >"$LOG_DIR/backend-${BACKEND_PORT}.nonce"

echo "Waiting for backend health..."
for i in $(seq 1 90); do
  if curl --noproxy '*' -sf "http://127.0.0.1:${BACKEND_PORT}/api/health" >/dev/null 2>&1; then
    LIVE_ENV="$(ps eww -p "$BACKEND_PID" 2>/dev/null || true)"
    if [[ "$LIVE_ENV" == *"FORGE_DATA_DIR=${FORGE_DATA_DIR}"* && "$LIVE_ENV" == *"FORGE_PI_UPGRADE_INSTANCE_NONCE=${INSTANCE_NONCE}"* ]]; then
      echo "Backend ready (pid=$BACKEND_PID)"
      break
    fi
    echo "ERROR: backend health did not match recorded child/data/nonce identity." >&2
    tail -40 "$BACKEND_LOG" >&2 || true
    kill "$BACKEND_PID" 2>/dev/null || true
    exit 1
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "ERROR: backend exited early. Tail of log:" >&2
    tail -40 "$BACKEND_LOG" >&2 || true
    exit 1
  fi
  if [[ "$i" -eq 90 ]]; then
    echo "ERROR: backend did not become healthy. Tail of log:" >&2
    tail -80 "$BACKEND_LOG" >&2 || true
    exit 1
  fi
  sleep 1
done

LIVE_DATA="$(ps eww -p "$BACKEND_PID" 2>/dev/null | tr ' ' '\n' | awk -F= '/^FORGE_DATA_DIR=/{print $2; exit}' || true)"
LIVE_NONCE="$(ps eww -p "$BACKEND_PID" 2>/dev/null | tr ' ' '\n' | awk -F= '/^FORGE_PI_UPGRADE_INSTANCE_NONCE=/{print $2; exit}' || true)"
if [[ -z "$LIVE_DATA" || "$LIVE_DATA" != "$FORGE_DATA_DIR" || -z "$LIVE_NONCE" || "$LIVE_NONCE" != "$INSTANCE_NONCE" ]]; then
  echo "ERROR: live backend identity mismatch (expected isolated data and nonce)." >&2
  kill "$BACKEND_PID" 2>/dev/null || true
  exit 1
fi

echo "Starting isolated UI on 127.0.0.1:${UI_PORT} (vite dev only; VITE_FORGE_WS_URL=${VITE_FORGE_WS_URL})"
nohup env VITE_FORGE_WS_URL="$VITE_FORGE_WS_URL" FORGE_PI_UPGRADE_INSTANCE_NONCE="$INSTANCE_NONCE" \
  "$PNPM_BIN" --filter @forge/ui exec vite dev --port "$UI_PORT" --strictPort \
  >"$UI_LOG" 2>&1 &
UI_PID=$!
echo "$UI_PID" >"$LOG_DIR/ui-${UI_PORT}.pid"
echo "$INSTANCE_NONCE" >"$LOG_DIR/ui-${UI_PORT}.nonce"

echo "Waiting for UI..."
for i in $(seq 1 45); do
  if curl --noproxy '*' -sf "http://127.0.0.1:${UI_PORT}" >/dev/null 2>&1; then
    LIVE_UI_NONCE="$(ps eww -p "$UI_PID" 2>/dev/null | tr ' ' '\n' | awk -F= '/^FORGE_PI_UPGRADE_INSTANCE_NONCE=/{print $2; exit}' || true)"
    if [[ "$LIVE_UI_NONCE" == "$INSTANCE_NONCE" ]]; then
      echo "UI ready (pid=$UI_PID)"
      break
    fi
    echo "ERROR: UI health did not match recorded child/nonce identity." >&2
    tail -40 "$UI_LOG" >&2 || true
    kill "$BACKEND_PID" "$UI_PID" 2>/dev/null || true
    exit 1
  fi
  if ! kill -0 "$UI_PID" 2>/dev/null; then
    echo "ERROR: UI exited early. Tail of log:" >&2
    tail -40 "$UI_LOG" >&2 || true
    kill "$BACKEND_PID" 2>/dev/null || true
    exit 1
  fi
  if [[ "$i" -eq 45 ]]; then
    echo "ERROR: UI did not become ready. Tail of log:" >&2
    tail -40 "$UI_LOG" >&2 || true
    kill "$BACKEND_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

echo ""
echo "Isolated instance ready"
echo "  UI:      http://127.0.0.1:${UI_PORT}"
echo "  Backend: http://127.0.0.1:${BACKEND_PORT}"
echo "  Data:    ${FORGE_DATA_DIR}"
echo "  Logs:    ${LOG_DIR}"
echo "  Stop:    scripts/pi-upgrade/stop-isolated-instance.sh"
