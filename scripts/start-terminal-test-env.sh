#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${REPO_ROOT}/.env.test"
if [ ! -f "${ENV_FILE}" ]; then
  echo "[terminal-test] Missing ${ENV_FILE}. Copy .env.test from the repository root template first."
  exit 1
fi

set -a
source "${ENV_FILE}"
set +a

HOST="${FORGE_HOST:-127.0.0.1}"
BACKEND_PORT="${FORGE_PORT:-47387}"
UI_PORT="${FORGE_TEST_UI_PORT:-47388}"
DATA_DIR="${FORGE_DATA_DIR:-${HOME}/.forge-terminal-test}"
VITE_WS="${VITE_FORGE_WS_URL:-ws://${HOST}:${BACKEND_PORT}}"

# Default to fully disabling TanStack devtools for isolated test runs.
FORGE_DISABLE_TANSTACK_DEVTOOLS="${FORGE_DISABLE_TANSTACK_DEVTOOLS:-true}"
VITE_FORGE_DISABLE_TANSTACK_DEVTOOLS="${VITE_FORGE_DISABLE_TANSTACK_DEVTOOLS:-${FORGE_DISABLE_TANSTACK_DEVTOOLS}}"
FORGE_TANSTACK_DEVTOOLS_PORT="${FORGE_TANSTACK_DEVTOOLS_PORT:-42169}"

# Set FORGE_TEST_DRY_RUN=1 to validate config/commands without launching processes.
FORGE_TEST_DRY_RUN="${FORGE_TEST_DRY_RUN:-0}"

log() {
  printf '[terminal-test] %s\n' "$*"
}

fail() {
  log "$*"
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required command: $1"
  fi
}

is_truthy() {
  local normalized
  normalized="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "${normalized}" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

validate_port() {
  local value="$1"
  local name="$2"

  if ! [[ "${value}" =~ ^[0-9]+$ ]] || [ "${value}" -lt 1 ] || [ "${value}" -gt 65535 ]; then
    fail "${name} must be a valid TCP port (1-65535), got: ${value}"
  fi
}

is_port_in_use() {
  lsof -nP -iTCP:"${1}" -sTCP:LISTEN >/dev/null 2>&1
}

show_port_owners() {
  lsof -nP -iTCP:"${1}" -sTCP:LISTEN || true
}

check_port_available() {
  local port="$1"
  local label="$2"

  if is_port_in_use "${port}"; then
    log "${label} port ${port} is already in use."
    show_port_owners "${port}"
    exit 1
  fi
}

require_command pnpm
require_command npx
require_command lsof

validate_port "${BACKEND_PORT}" "FORGE_PORT"
validate_port "${UI_PORT}" "FORGE_TEST_UI_PORT"
validate_port "${FORGE_TANSTACK_DEVTOOLS_PORT}" "FORGE_TANSTACK_DEVTOOLS_PORT"

if [ "${BACKEND_PORT}" = "${UI_PORT}" ]; then
  fail "Backend and UI ports must be different (both are ${BACKEND_PORT})."
fi

if ! is_truthy "${FORGE_DISABLE_TANSTACK_DEVTOOLS}" && [[ "${FORGE_TANSTACK_DEVTOOLS_PORT}" == "${BACKEND_PORT}" || "${FORGE_TANSTACK_DEVTOOLS_PORT}" == "${UI_PORT}" ]]; then
  fail "FORGE_TANSTACK_DEVTOOLS_PORT (${FORGE_TANSTACK_DEVTOOLS_PORT}) must not match backend/UI ports."
fi

check_port_available "${BACKEND_PORT}" "Backend"
check_port_available "${UI_PORT}" "UI"

if ! is_truthy "${FORGE_DISABLE_TANSTACK_DEVTOOLS}"; then
  check_port_available "${FORGE_TANSTACK_DEVTOOLS_PORT}" "TanStack devtools event bus"
fi

BACKEND_CMD="FORGE_HOST=${HOST} FORGE_PORT=${BACKEND_PORT} FORGE_DATA_DIR=${DATA_DIR} pnpm --filter @forge/backend dev"
UI_CMD="cd apps/ui && VITE_FORGE_WS_URL=${VITE_WS} FORGE_DISABLE_TANSTACK_DEVTOOLS=${FORGE_DISABLE_TANSTACK_DEVTOOLS} VITE_FORGE_DISABLE_TANSTACK_DEVTOOLS=${VITE_FORGE_DISABLE_TANSTACK_DEVTOOLS} FORGE_TANSTACK_DEVTOOLS_PORT=${FORGE_TANSTACK_DEVTOOLS_PORT} npx vite dev --host ${HOST} --port ${UI_PORT} --strictPort"

log "Starting isolated backend on ${HOST}:${BACKEND_PORT} with data dir ${DATA_DIR}"
log "Starting UI dev server on ${HOST}:${UI_PORT}"
log "Backend WS URL: ${VITE_WS}"
if is_truthy "${FORGE_DISABLE_TANSTACK_DEVTOOLS}"; then
  log "TanStack devtools: disabled"
else
  log "TanStack devtools event bus port: ${FORGE_TANSTACK_DEVTOOLS_PORT}"
fi

if is_truthy "${FORGE_TEST_DRY_RUN}"; then
  log "Dry run enabled (FORGE_TEST_DRY_RUN=${FORGE_TEST_DRY_RUN})."
  log "Would run backend command: ${BACKEND_CMD}"
  log "Would run UI command: ${UI_CMD}"
  exit 0
fi

cd "${REPO_ROOT}"

pnpm exec concurrently \
  --names backend,ui \
  --kill-others-on-fail \
  "${BACKEND_CMD}" \
  "${UI_CMD}"
