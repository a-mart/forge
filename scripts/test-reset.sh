#!/usr/bin/env bash
set -euo pipefail

TEST_DATA_DIR="${HOME}/.middleman-dev"
LIVE_DATA_DIR="${HOME}/.middleman"
BACKEND_PORT="47387"
UI_PORT="47389"
PID_FILE="${TMPDIR:-/tmp}/middleman-test-instance-middleman-multi-session.pid"

log() {
  printf '[test-reset] %s\n' "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "Missing required command: $1"
    exit 1
  fi
}

read_pid_value() {
  local key="$1"
  awk -F= -v search_key="${key}" '$1 == search_key { print $2; exit }' "${PID_FILE}" 2>/dev/null | tr -d '[:space:]'
}

wait_for_pid_exit() {
  local pid="$1"
  local attempts=40

  while [ "${attempts}" -gt 0 ]; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      return 0
    fi
    sleep 0.25
    attempts=$((attempts - 1))
  done

  return 1
}

stop_pid_if_running() {
  local pid="$1"
  local label="$2"

  if [ -z "${pid}" ]; then
    return 0
  fi

  if ! [[ "${pid}" =~ ^[0-9]+$ ]]; then
    return 0
  fi

  if ! kill -0 "${pid}" 2>/dev/null; then
    return 0
  fi

  log "Stopping ${label} (pid ${pid})..."
  kill "${pid}" 2>/dev/null || true

  if wait_for_pid_exit "${pid}"; then
    return 0
  fi

  log "${label} did not stop gracefully. Sending SIGKILL to pid ${pid}."
  kill -9 "${pid}" 2>/dev/null || true
}

is_port_in_use() {
  local port="$1"
  lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
}

show_port_owners() {
  local port="$1"
  lsof -nP -iTCP:"${port}" -sTCP:LISTEN || true
}

require_command lsof

if [ -f "${PID_FILE}" ]; then
  script_pid="$(read_pid_value SCRIPT_PID)"
  backend_pid="$(read_pid_value BACKEND_PID)"
  ui_pid="$(read_pid_value UI_PID)"

  stop_pid_if_running "${script_pid}" "test-instance launcher"
  stop_pid_if_running "${ui_pid}" "test UI preview"
  stop_pid_if_running "${backend_pid}" "test backend"

  rm -f "${PID_FILE}"
  log "Stopped test instance processes tracked by pid file."
else
  log "No test-instance pid file found at ${PID_FILE}."
fi

if is_port_in_use "${BACKEND_PORT}" || is_port_in_use "${UI_PORT}"; then
  log "Warning: one or more test ports are still in use."
  if is_port_in_use "${BACKEND_PORT}"; then
    log "Port ${BACKEND_PORT} listeners:"
    show_port_owners "${BACKEND_PORT}"
  fi
  if is_port_in_use "${UI_PORT}"; then
    log "Port ${UI_PORT} listeners:"
    show_port_owners "${UI_PORT}"
  fi
  log "Continuing with data reset."
fi

if [ "${TEST_DATA_DIR}" != "${HOME}/.middleman-dev" ]; then
  log "Safety check failed: unexpected TEST_DATA_DIR=${TEST_DATA_DIR}"
  exit 1
fi

if [ -d "${TEST_DATA_DIR}" ]; then
  log "Removing ${TEST_DATA_DIR} ..."
  rm -rf "${TEST_DATA_DIR}"
else
  log "Test data directory not found (nothing to remove): ${TEST_DATA_DIR}"
fi

if [ ! -d "${LIVE_DATA_DIR}" ]; then
  log "Live data directory not found: ${LIVE_DATA_DIR}"
  log "Cannot repopulate test data."
  exit 1
fi

mkdir -p "$(dirname "${TEST_DATA_DIR}")"
cp -a "${LIVE_DATA_DIR}" "${TEST_DATA_DIR}"

log "Reset complete."
log "Live data source : ${LIVE_DATA_DIR}"
log "Test data target : ${TEST_DATA_DIR}"
log "Your live instance data was not modified."
