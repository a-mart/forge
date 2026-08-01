#!/usr/bin/env bash
# Stop isolated Pi upgrade Forge instance by verified owned listener/wrapper tree
# from .env (never production ports).
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

owned_tree_has_nonce() {
  local listener_pid="$1"
  local wrapper_pid="$2"
  local nonce="$3"
  local walk="$listener_pid"
  local guard=0
  while [[ -n "$walk" && "$walk" != "0" && "$walk" != "1" ]]; do
    if process_env_contains "$walk" "FORGE_PI_UPGRADE_INSTANCE_NONCE=${nonce}"; then
      return 0
    fi
    if [[ -n "$wrapper_pid" && "$walk" == "$wrapper_pid" ]]; then
      break
    fi
    walk="$(ps -o ppid= -p "$walk" 2>/dev/null | tr -dc '0-9' || true)"
    guard=$((guard + 1))
    [[ "$guard" -gt 64 ]] && break
  done
  if [[ -n "$wrapper_pid" ]] && kill -0 "$wrapper_pid" 2>/dev/null; then
    process_env_contains "$wrapper_pid" "FORGE_PI_UPGRADE_INSTANCE_NONCE=${nonce}"
    return $?
  fi
  return 1
}

# Emit descendants leaves-first while the verified wrapper ancestry still
# exists. Each candidate must also inherit this launch's nonce before it can be
# signalled, so stopping cannot spill into an unrelated process tree.
collect_owned_descendants() {
  local parent_pid="$1"
  local nonce="$2"
  local child_pid
  for child_pid in $(pgrep -P "$parent_pid" 2>/dev/null || true); do
    collect_owned_descendants "$child_pid" "$nonce"
    if process_env_contains "$child_pid" "FORGE_PI_UPGRADE_INSTANCE_NONCE=${nonce}"; then
      printf '%s\n' "$child_pid"
    fi
  done
}

# pnpm may leave its exec/tsx descendants alive after its wrapper receives
# SIGTERM. Capture the verified nonce-bearing tree before terminating the
# wrapper, give it a graceful stop, then only force-kill survivors that still
# prove ownership with the same nonce.
terminate_owned_process_tree() {
  local listener_pid="$1"
  local wrapper_pid="$2"
  local nonce="$3"
  local candidate
  local -a candidates=()

  if [[ -n "$wrapper_pid" ]] && kill -0 "$wrapper_pid" 2>/dev/null; then
    while IFS= read -r candidate; do
      [[ -n "$candidate" ]] && candidates+=("$candidate")
    done < <(collect_owned_descendants "$wrapper_pid" "$nonce")
    candidates+=("$wrapper_pid")
  fi
  candidates+=("$listener_pid")

  for candidate in "${candidates[@]}"; do
    if kill -0 "$candidate" 2>/dev/null && process_env_contains "$candidate" "FORGE_PI_UPGRADE_INSTANCE_NONCE=${nonce}"; then
      kill "$candidate" 2>/dev/null || true
    fi
  done

  sleep 1

  for candidate in "${candidates[@]}"; do
    if kill -0 "$candidate" 2>/dev/null && process_env_contains "$candidate" "FORGE_PI_UPGRADE_INSTANCE_NONCE=${nonce}"; then
      kill -KILL "$candidate" 2>/dev/null || true
    fi
  done
}

stop_owned_tree() {
  local label="$1"
  local port="$2"
  local pid_file="$LOG_DIR/${label}-${port}.pid"
  local wrapper_file="$LOG_DIR/${label}-${port}.wrapper.pid"
  local nonce_file="$LOG_DIR/${label}-${port}.nonce"

  if [[ ! -f "$pid_file" ]]; then
    echo "No recorded $label listener PID for port $port"
    return
  fi
  if [[ ! -f "$nonce_file" ]]; then
    echo "ERROR: refusing to stop $label on port $port without recorded nonce" >&2
    exit 1
  fi

  local listener_pid wrapper_pid nonce live_listener_pids
  listener_pid="$(tr -dc '0-9' <"$pid_file")"
  nonce="$(cat "$nonce_file")"
  wrapper_pid=""
  if [[ -f "$wrapper_file" ]]; then
    wrapper_pid="$(tr -dc '0-9' <"$wrapper_file")"
  fi
  if [[ -z "$listener_pid" || -z "$nonce" ]]; then
    echo "ERROR: refusing to stop $label on port $port with empty recorded identity" >&2
    exit 1
  fi

  live_listener_pids="$(lsof -i ":$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "$live_listener_pids" && " $live_listener_pids " != *" $listener_pid "* ]]; then
    echo "ERROR: recorded $label listener pid $listener_pid is not the listener on port $port; refusing arbitrary kill" >&2
    exit 1
  fi

  if kill -0 "$listener_pid" 2>/dev/null; then
    if [[ -n "$wrapper_pid" ]] && ! is_descendant_of "$listener_pid" "$wrapper_pid" && [[ "$listener_pid" != "$wrapper_pid" ]]; then
      echo "ERROR: refusing to stop $label pid $listener_pid: not in recorded wrapper ancestry ($wrapper_pid)" >&2
      exit 1
    fi
    if ! owned_tree_has_nonce "$listener_pid" "$wrapper_pid" "$nonce"; then
      echo "ERROR: refusing to stop $label pid $listener_pid: nonce mismatch in owned tree" >&2
      exit 1
    fi
    if [[ "$label" == "backend" ]]; then
      local found_data=0
      local walk="$listener_pid"
      local guard=0
      while [[ -n "$walk" && "$walk" != "0" && "$walk" != "1" ]]; do
        if process_env_contains "$walk" "FORGE_DATA_DIR=${FORGE_DATA_DIR:-}"; then
          found_data=1
          break
        fi
        if [[ -n "$wrapper_pid" && "$walk" == "$wrapper_pid" ]]; then
          break
        fi
        walk="$(ps -o ppid= -p "$walk" 2>/dev/null | tr -dc '0-9' || true)"
        guard=$((guard + 1))
        [[ "$guard" -gt 64 ]] && break
      done
      if [[ "$found_data" -ne 1 ]]; then
        echo "ERROR: refusing to stop backend pid $listener_pid: FORGE_DATA_DIR mismatch in owned tree" >&2
        exit 1
      fi
    fi
  elif [[ -z "$live_listener_pids" ]]; then
    echo "Recorded $label listener pid $listener_pid is not running"
  fi

  echo "Stopping verified owned $label tree (listener=$listener_pid wrapper=${wrapper_pid:-none}) on port $port"
  terminate_owned_process_tree "$listener_pid" "$wrapper_pid" "$nonce"

  rm -f "$pid_file" "$nonce_file" "$wrapper_file"
}

stop_owned_tree backend "$BACKEND_PORT"
stop_owned_tree ui "$UI_PORT"

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
