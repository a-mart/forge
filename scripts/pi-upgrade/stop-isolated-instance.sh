#!/usr/bin/env bash
# Stop isolated Pi upgrade Forge instance by recorded owned PIDs from .env (never production ports).
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
LOG_DIR="${TMPDIR:-/tmp}/forge-pi-upgrade-isolated"

node "$ROOT/scripts/pi-upgrade/assert-isolation.mjs" >/dev/null

stop_recorded_pid() {
  local label="$1"
  local port="$2"
  local pid_file="$LOG_DIR/${label}-${port}.pid"
  local nonce_file="$LOG_DIR/${label}-${port}.nonce"

  if [[ ! -f "$pid_file" ]]; then
    echo "No recorded $label PID for port $port"
    return
  fi
  if [[ ! -f "$nonce_file" ]]; then
    echo "ERROR: refusing to stop $label on port $port without recorded nonce" >&2
    exit 1
  fi

  local pid nonce live_env live_nonce live_data
  pid="$(tr -dc '0-9' <"$pid_file")"
  nonce="$(cat "$nonce_file")"
  if [[ -z "$pid" || -z "$nonce" ]]; then
    echo "ERROR: refusing to stop $label on port $port with empty recorded identity" >&2
    exit 1
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    echo "Recorded $label pid $pid is not running"
    rm -f "$pid_file" "$nonce_file"
    return
  fi

  live_env="$(ps eww -p "$pid" 2>/dev/null || true)"
  live_nonce="$(printf '%s' "$live_env" | tr ' ' '\n' | awk -F= '/^FORGE_PI_UPGRADE_INSTANCE_NONCE=/{print $2; exit}' || true)"
  if [[ "$live_nonce" != "$nonce" ]]; then
    echo "ERROR: refusing to stop $label pid $pid: nonce mismatch" >&2
    exit 1
  fi

  if [[ "$label" == "backend" ]]; then
    live_data="$(printf '%s' "$live_env" | tr ' ' '\n' | awk -F= '/^FORGE_DATA_DIR=/{print $2; exit}' || true)"
    if [[ -z "$live_data" || "$live_data" != "${FORGE_DATA_DIR:-}" ]]; then
      echo "ERROR: refusing to stop backend pid $pid: FORGE_DATA_DIR mismatch" >&2
      exit 1
    fi
  fi

  local listener_pids
  listener_pids="$(lsof -i ":$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "$listener_pids" && " $listener_pids " != *" $pid "* ]]; then
    echo "ERROR: recorded $label pid $pid is not the listener on port $port; refusing arbitrary kill" >&2
    exit 1
  fi

  echo "Stopping recorded $label pid $pid on port $port"
  kill "$pid" 2>/dev/null || true
  rm -f "$pid_file" "$nonce_file"
}

stop_recorded_pid backend "$BACKEND_PORT"
stop_recorded_pid ui "$UI_PORT"

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
