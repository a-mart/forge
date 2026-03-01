#!/usr/bin/env bash
# Safely rebuild and restart the test instance.
# This script ALWAYS sets VITE_MIDDLEMAN_WS_URL to prevent connecting to the live backend.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

HOST="${MIDDLEMAN_HOST:-127.0.0.1}"
BACKEND_PORT="47387"
UI_PORT="47389"
TEST_DATA_DIR="${HOME}/.middleman-dev"
WS_URL="ws://${HOST}:${BACKEND_PORT}"

log() { printf '[test-rebuild] %s\n' "$*"; }

# ── Safety: kill any running test instance ──
log "Stopping any running test instance..."
for port in "${BACKEND_PORT}" "${UI_PORT}"; do
  pids=$(lsof -ti :"${port}" 2>/dev/null || true)
  if [[ -n "${pids}" ]]; then
    echo "${pids}" | xargs kill -9 2>/dev/null || true
    log "  Killed processes on port ${port}"
  fi
done
sleep 1

# ── Safety: verify test data dir exists ──
if [[ ! -d "${TEST_DATA_DIR}" ]]; then
  log "ERROR: Test data directory ${TEST_DATA_DIR} does not exist."
  log "Run ./scripts/test-instance.sh first to create it."
  exit 1
fi

# ── Build with VITE_MIDDLEMAN_WS_URL hardcoded ──
log "Building with VITE_MIDDLEMAN_WS_URL=${WS_URL} ..."
cd "${REPO_ROOT}"
export VITE_MIDDLEMAN_WS_URL="${WS_URL}"
pnpm build

# ── Start backend ──
log "Starting backend on ${HOST}:${BACKEND_PORT} ..."
MIDDLEMAN_DATA_DIR="${TEST_DATA_DIR}" MIDDLEMAN_PORT="${BACKEND_PORT}" \
  node apps/backend/dist/index.js > /tmp/middleman-test-backend.log 2>&1 &
BACKEND_PID=$!
disown "${BACKEND_PID}"
sleep 3

if ! lsof -ti :"${BACKEND_PORT}" >/dev/null 2>&1; then
  log "ERROR: Backend failed to start. Check /tmp/middleman-test-backend.log"
  exit 1
fi
log "  ✅ Backend running (PID ${BACKEND_PID})"

# ── Start UI (Nitro server directly) ──
log "Starting UI on ${HOST}:${UI_PORT} ..."
cd "${REPO_ROOT}/apps/ui"
PORT="${UI_PORT}" HOST="${HOST}" \
  node .output/server/index.mjs > /tmp/middleman-test-ui.log 2>&1 &
UI_PID=$!
disown "${UI_PID}"
sleep 2

if ! lsof -ti :"${UI_PORT}" >/dev/null 2>&1; then
  log "ERROR: UI failed to start. Check /tmp/middleman-test-ui.log"
  kill -9 "${BACKEND_PID}" 2>/dev/null || true
  exit 1
fi
log "  ✅ UI running (PID ${UI_PID})"

# ── Verification: confirm UI connects to TEST backend, not live ──
log ""
log "╔════════════════════════════════════════════════════╗"
log "║  Test instance is running                         ║"
log "║                                                   ║"
log "║  UI:      http://${HOST}:${UI_PORT}               ║"
log "║  Backend: ws://${HOST}:${BACKEND_PORT}            ║"
log "║  Data:    ${TEST_DATA_DIR}                        ║"
log "║  WS URL:  ${WS_URL}  (baked into build)           ║"
log "║                                                   ║"
log "║  ⚠️  Your live instance is NOT affected.           ║"
log "╚════════════════════════════════════════════════════╝"
log ""
log "To stop: kill ${BACKEND_PID} ${UI_PID}"
echo "${BACKEND_PID} ${UI_PID}" > /tmp/middleman-test-pids.txt
