#!/usr/bin/env bash
# Launch an isolated Forge backend+UI for Pi upgrade validation.
# Records the actual TCP listener PID (not the pnpm wrapper), validated against
# parent ancestry, nonce, and data dir. Refuses production data/ports.
# Never prints secret file contents.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:${HOME}/Library/pnpm:${PATH:-}"

# Live provider calls fail under Socket Firewall HTTP proxies / CA injection.
# Clearing only HTTP(S)_PROXY is insufficient: SSL_CERT_FILE / NODE_EXTRA_CA_CERTS
# can replace the trust store and break direct TLS when the proxy is unset.
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy \
  YARN_HTTP_PROXY YARN_HTTPS_PROXY CARGO_HTTP_PROXY GIT_PROXY_SSL_CAINFO \
  SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS GIT_SSL_CAINFO PIP_CERT \
  REQUESTS_CA_BUNDLE CURL_CA_BUNDLE || true

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

is_descendant_of() {
  local child="$1"
  local ancestor="$2"
  local current="$child"
  local guard=0
  while [[ -n "$current" && "$current" != "0" && "$current" != "1" ]]; do
    if [[ "$current" == "$ancestor" ]]; then
      return 0
    fi
    current="$(ps -o ppid= -p "$current" 2>/dev/null | tr -dc '0-9' || true)"
    guard=$((guard + 1))
    if [[ "$guard" -gt 64 ]]; then
      return 1
    fi
  done
  return 1
}

process_env_contains() {
  local pid="$1"
  local needle="$2"
  local env_blob
  env_blob="$(ps eww -p "$pid" 2>/dev/null || true)"
  [[ "$env_blob" == *"$needle"* ]]
}

resolve_listener_pid() {
  local port="$1"
  local wrapper_pid="$2"
  local require_data_dir="${3:-}"
  local listener_pids listener_pid

  listener_pids="$(lsof -i ":$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -z "$listener_pids" ]]; then
    echo "ERROR: no listener on port $port after health became ready" >&2
    return 1
  fi

  for listener_pid in $listener_pids; do
    listener_pid="$(printf '%s' "$listener_pid" | tr -dc '0-9')"
    [[ -z "$listener_pid" ]] && continue
    if [[ "$listener_pid" != "$wrapper_pid" ]] && ! is_descendant_of "$listener_pid" "$wrapper_pid"; then
      continue
    fi
    if ! process_env_contains "$listener_pid" "FORGE_PI_UPGRADE_INSTANCE_NONCE=${INSTANCE_NONCE}"; then
      # Nonce may live on an ancestor in the owned wrapper tree.
      local walk="$listener_pid"
      local found_nonce=0
      local guard=0
      while [[ -n "$walk" && "$walk" != "0" && "$walk" != "1" ]]; do
        if process_env_contains "$walk" "FORGE_PI_UPGRADE_INSTANCE_NONCE=${INSTANCE_NONCE}"; then
          found_nonce=1
          break
        fi
        if [[ "$walk" == "$wrapper_pid" ]]; then
          break
        fi
        walk="$(ps -o ppid= -p "$walk" 2>/dev/null | tr -dc '0-9' || true)"
        guard=$((guard + 1))
        [[ "$guard" -gt 64 ]] && break
      done
      if [[ "$found_nonce" -ne 1 ]]; then
        continue
      fi
    fi
    if [[ -n "$require_data_dir" ]]; then
      local found_data=0
      local walk_data="$listener_pid"
      local guard_data=0
      while [[ -n "$walk_data" && "$walk_data" != "0" && "$walk_data" != "1" ]]; do
        if process_env_contains "$walk_data" "FORGE_DATA_DIR=${FORGE_DATA_DIR}"; then
          found_data=1
          break
        fi
        if [[ "$walk_data" == "$wrapper_pid" ]]; then
          break
        fi
        walk_data="$(ps -o ppid= -p "$walk_data" 2>/dev/null | tr -dc '0-9' || true)"
        guard_data=$((guard_data + 1))
        [[ "$guard_data" -gt 64 ]] && break
      done
      if [[ "$found_data" -ne 1 ]]; then
        continue
      fi
    fi
    printf '%s' "$listener_pid"
    return 0
  done

  echo "ERROR: listener on port $port is not in the owned wrapper ancestry with matching nonce/data identity" >&2
  return 1
}

echo "Starting isolated backend on 127.0.0.1:${BACKEND_PORT} (data=${FORGE_DATA_DIR})"
# Prefer non-watch tsx for stable E2E (avoids protocol rebuild lock races).
nohup env FORGE_HOST=127.0.0.1 FORGE_PORT="$BACKEND_PORT" FORGE_DATA_DIR="$FORGE_DATA_DIR" FORGE_PI_UPGRADE_INSTANCE_NONCE="$INSTANCE_NONCE" \
  "$PNPM_BIN" --filter @forge/backend exec tsx src/index.ts \
  >"$BACKEND_LOG" 2>&1 &
BACKEND_WRAPPER_PID=$!
echo "$BACKEND_WRAPPER_PID" >"$LOG_DIR/backend-${BACKEND_PORT}.wrapper.pid"
echo "$INSTANCE_NONCE" >"$LOG_DIR/backend-${BACKEND_PORT}.nonce"

echo "Waiting for backend health..."
BACKEND_LISTENER_PID=""
for i in $(seq 1 90); do
  if curl --noproxy '*' -sf "http://127.0.0.1:${BACKEND_PORT}/api/health" >/dev/null 2>&1; then
    if BACKEND_LISTENER_PID="$(resolve_listener_pid "$BACKEND_PORT" "$BACKEND_WRAPPER_PID" "1")"; then
      echo "$BACKEND_LISTENER_PID" >"$LOG_DIR/backend-${BACKEND_PORT}.pid"
      echo "Backend ready (listener_pid=$BACKEND_LISTENER_PID wrapper_pid=$BACKEND_WRAPPER_PID)"
      break
    fi
    echo "ERROR: backend health did not match recorded listener/parent/data/nonce identity." >&2
    tail -40 "$BACKEND_LOG" >&2 || true
    kill "$BACKEND_WRAPPER_PID" 2>/dev/null || true
    exit 1
  fi
  if ! kill -0 "$BACKEND_WRAPPER_PID" 2>/dev/null; then
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

if [[ -z "$BACKEND_LISTENER_PID" ]]; then
  echo "ERROR: backend listener PID was not recorded" >&2
  kill "$BACKEND_WRAPPER_PID" 2>/dev/null || true
  exit 1
fi

echo "Starting isolated UI on 127.0.0.1:${UI_PORT} (vite dev only; VITE_FORGE_WS_URL=${VITE_FORGE_WS_URL})"
nohup env VITE_FORGE_WS_URL="$VITE_FORGE_WS_URL" FORGE_PI_UPGRADE_INSTANCE_NONCE="$INSTANCE_NONCE" \
  "$PNPM_BIN" --filter @forge/ui exec vite dev --port "$UI_PORT" --strictPort \
  >"$UI_LOG" 2>&1 &
UI_WRAPPER_PID=$!
echo "$UI_WRAPPER_PID" >"$LOG_DIR/ui-${UI_PORT}.wrapper.pid"
echo "$INSTANCE_NONCE" >"$LOG_DIR/ui-${UI_PORT}.nonce"

echo "Waiting for UI..."
UI_LISTENER_PID=""
for i in $(seq 1 45); do
  if curl --noproxy '*' -sf "http://127.0.0.1:${UI_PORT}" >/dev/null 2>&1; then
    if UI_LISTENER_PID="$(resolve_listener_pid "$UI_PORT" "$UI_WRAPPER_PID" "")"; then
      echo "$UI_LISTENER_PID" >"$LOG_DIR/ui-${UI_PORT}.pid"
      echo "UI ready (listener_pid=$UI_LISTENER_PID wrapper_pid=$UI_WRAPPER_PID)"
      break
    fi
    echo "ERROR: UI health did not match recorded listener/parent/nonce identity." >&2
    tail -40 "$UI_LOG" >&2 || true
    kill "$BACKEND_WRAPPER_PID" "$UI_WRAPPER_PID" 2>/dev/null || true
    exit 1
  fi
  if ! kill -0 "$UI_WRAPPER_PID" 2>/dev/null; then
    echo "ERROR: UI exited early. Tail of log:" >&2
    tail -40 "$UI_LOG" >&2 || true
    kill "$BACKEND_WRAPPER_PID" 2>/dev/null || true
    exit 1
  fi
  if [[ "$i" -eq 45 ]]; then
    echo "ERROR: UI did not become ready. Tail of log:" >&2
    tail -40 "$UI_LOG" >&2 || true
    kill "$BACKEND_WRAPPER_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

if [[ -z "$UI_LISTENER_PID" ]]; then
  echo "ERROR: UI listener PID was not recorded" >&2
  kill "$BACKEND_WRAPPER_PID" "$UI_WRAPPER_PID" 2>/dev/null || true
  exit 1
fi

echo ""
echo "Isolated instance ready"
echo "  UI:      http://127.0.0.1:${UI_PORT}"
echo "  Backend: http://127.0.0.1:${BACKEND_PORT}"
echo "  Data:    ${FORGE_DATA_DIR}"
echo "  Logs:    ${LOG_DIR}"
echo "  Stop:    scripts/pi-upgrade/stop-isolated-instance.sh"
