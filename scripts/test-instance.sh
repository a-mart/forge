#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

HOST="${FORGE_HOST:-127.0.0.1}"
BACKEND_PORT="47387"
UI_PORT="47389"
LIVE_DATA_DIR="${HOME}/.forge"
TEST_DATA_DIR="${HOME}/.forge-dev"
WS_URL="ws://${HOST}:${BACKEND_PORT}"
PID_FILE="${TMPDIR:-/tmp}/forge-test-instance-forge-multi-session.pid"
ASSUME_YES="${FORGE_TEST_ASSUME_YES:-0}"

export FORGE_HOST="${HOST}"
export FORGE_PORT="${BACKEND_PORT}"
export FORGE_DATA_DIR="${TEST_DATA_DIR}"
export VITE_FORGE_WS_URL="${WS_URL}"

BACKEND_PID=""
UI_PID=""

log() {
  printf '[test-instance] %s\n' "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "Missing required command: $1"
    exit 1
  fi
}

is_port_in_use() {
  local port="$1"
  lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
}

show_port_owners() {
  local port="$1"
  lsof -nP -iTCP:"${port}" -sTCP:LISTEN || true
}

wait_for_port() {
  local port="$1"
  local label="$2"
  local pid="$3"
  local attempts=120

  while [ "${attempts}" -gt 0 ]; do
    if is_port_in_use "${port}"; then
      return 0
    fi

    if [ -n "${pid}" ] && ! kill -0 "${pid}" 2>/dev/null; then
      return 1
    fi

    sleep 0.25
    attempts=$((attempts - 1))
  done

  return 1
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM

  if [ -n "${UI_PID}" ] && kill -0 "${UI_PID}" 2>/dev/null; then
    kill "${UI_PID}" 2>/dev/null || true
    wait "${UI_PID}" 2>/dev/null || true
  fi

  if [ -n "${BACKEND_PID}" ] && kill -0 "${BACKEND_PID}" 2>/dev/null; then
    kill "${BACKEND_PID}" 2>/dev/null || true
    wait "${BACKEND_PID}" 2>/dev/null || true
  fi

  if [ -f "${PID_FILE}" ]; then
    local pid_in_file
    pid_in_file="$(awk -F= '/^SCRIPT_PID=/{print $2}' "${PID_FILE}" 2>/dev/null || true)"
    if [ "${pid_in_file}" = "$$" ]; then
      rm -f "${PID_FILE}"
    fi
  fi

  exit "${exit_code}"
}

trap cleanup EXIT INT TERM

require_command pnpm
require_command lsof

if [ ! -f "${REPO_ROOT}/pnpm-workspace.yaml" ]; then
  log "Could not find pnpm-workspace.yaml at ${REPO_ROOT}."
  exit 1
fi

if [ -f "${PID_FILE}" ]; then
  existing_pid="$(awk -F= '/^SCRIPT_PID=/{print $2}' "${PID_FILE}" | tr -d '[:space:]')"
  if [ -n "${existing_pid}" ] && kill -0 "${existing_pid}" 2>/dev/null; then
    log "A test instance is already running (pid ${existing_pid})."
    log "Stop it first, or run scripts/test-reset.sh."
    exit 1
  fi

  log "Removing stale pid file: ${PID_FILE}"
  rm -f "${PID_FILE}"
fi

if is_port_in_use "${BACKEND_PORT}"; then
  log "Backend test port ${BACKEND_PORT} is already in use."
  show_port_owners "${BACKEND_PORT}"
  exit 1
fi

if is_port_in_use "${UI_PORT}"; then
  log "UI test port ${UI_PORT} is already in use."
  show_port_owners "${UI_PORT}"
  exit 1
fi

if [ -d "${TEST_DATA_DIR}" ]; then
  log "Reusing existing test data directory: ${TEST_DATA_DIR}"
else
  if [ -d "${LIVE_DATA_DIR}" ]; then
    log "Test data directory not found: ${TEST_DATA_DIR}"
    log "Source data available: ${LIVE_DATA_DIR}"

    should_copy="yes"
    if [ "${ASSUME_YES}" != "1" ] && [ -t 0 ]; then
      printf '[test-instance] Copy live data into test data dir now? [Y/n] '
      read -r answer
      case "${answer}" in
        [Nn]|[Nn][Oo])
          should_copy="no"
          ;;
      esac
    fi

    if [ "${should_copy}" = "yes" ]; then
      mkdir -p "$(dirname "${TEST_DATA_DIR}")"
      cp -a "${LIVE_DATA_DIR}" "${TEST_DATA_DIR}"
      log "Copied ${LIVE_DATA_DIR} -> ${TEST_DATA_DIR}"
    else
      mkdir -p "${TEST_DATA_DIR}"
      log "Created empty test data directory: ${TEST_DATA_DIR}"
    fi
  else
    mkdir -p "${TEST_DATA_DIR}"
    log "Live data directory was not found at ${LIVE_DATA_DIR}."
    log "Created empty test data directory: ${TEST_DATA_DIR}"
  fi
fi

log "Building production artifacts (VITE_FORGE_WS_URL=${VITE_FORGE_WS_URL})..."
(
  cd "${REPO_ROOT}"
  pnpm build
)

log "Starting backend on ${HOST}:${BACKEND_PORT} ..."
(
  cd "${REPO_ROOT}"
  NODE_ENV=production pnpm --filter @forge/backend start
) &
BACKEND_PID="$!"

if ! wait_for_port "${BACKEND_PORT}" "backend" "${BACKEND_PID}"; then
  log "Backend failed to start on port ${BACKEND_PORT}."
  exit 1
fi

log "Starting UI preview on ${HOST}:${UI_PORT} ..."
(
  cd "${REPO_ROOT}"
  cd apps/ui && npx vite preview --port "${UI_PORT}" --strictPort --host "${HOST}"
) &
UI_PID="$!"

if ! wait_for_port "${UI_PORT}" "UI" "${UI_PID}"; then
  log "UI preview failed to start on port ${UI_PORT}."
  exit 1
fi

cat > "${PID_FILE}" <<EOF
SCRIPT_PID=$$
BACKEND_PID=${BACKEND_PID}
UI_PID=${UI_PID}
BACKEND_PORT=${BACKEND_PORT}
UI_PORT=${UI_PORT}
DATA_DIR=${TEST_DATA_DIR}
REPO_ROOT=${REPO_ROOT}
EOF

printf '\n'
log "Test instance is running"
log "Backend URL : http://${HOST}:${BACKEND_PORT}"
log "Backend WS  : ws://${HOST}:${BACKEND_PORT}"
log "UI URL      : http://${HOST}:${UI_PORT}"
log "Data dir    : ${TEST_DATA_DIR}"
log "PID file    : ${PID_FILE}"
log "Your live instance is NOT affected"
log "Press Ctrl+C to stop"
printf '\n'

while true; do
  if ! kill -0 "${BACKEND_PID}" 2>/dev/null; then
    wait "${BACKEND_PID}" || true
    log "Backend process exited. Shutting down."
    exit 1
  fi

  if ! kill -0 "${UI_PID}" 2>/dev/null; then
    wait "${UI_PID}" || true
    log "UI preview process exited. Shutting down."
    exit 1
  fi

  sleep 1
done
