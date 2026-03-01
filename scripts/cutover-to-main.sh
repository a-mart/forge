#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"

WORKTREE_ROOT="/Users/adam/repos/middleman-multi-session"
MAIN_REPO="/Users/adam/repos/middleman"
FEATURE_BRANCH="feature/multi-session"
MAIN_BRANCH="main"
MERGE_MESSAGE="feat: multi-session per manager"

LIVE_DATA_DIR="${HOME}/.middleman"
BACKUP_DIR=""
BACKUP_CREATED=0
PRE_MERGE_COMMIT=""
MERGE_DONE=0
START_LOG=""
START_PID=""

CURRENT_STEP="initialization"
ASSUME_YES="${CUTOVER_ASSUME_YES:-0}"

# Colors
if [ -t 1 ]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_BLUE=$'\033[34m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
  C_MAGENTA=$'\033[35m'
else
  C_RESET=""
  C_BOLD=""
  C_BLUE=""
  C_GREEN=""
  C_YELLOW=""
  C_RED=""
  C_MAGENTA=""
fi

usage() {
  cat <<EOF
Usage: ${SCRIPT_NAME} [--yes]

Safe cutover from ${FEATURE_BRANCH} (worktree) into ${MAIN_BRANCH} (live repo).

Options:
  -y, --yes    Auto-confirm prompts (dangerous; use carefully)
  -h, --help   Show this help text

Environment:
  CUTOVER_ASSUME_YES=1  Same as --yes
EOF
}

section() {
  printf '\n%b==> %s%b\n' "${C_MAGENTA}${C_BOLD}" "$1" "${C_RESET}"
}

info() {
  printf '%b[INFO]%b %s\n' "${C_BLUE}" "${C_RESET}" "$*"
}

warn() {
  printf '%b[WARN]%b %s\n' "${C_YELLOW}" "${C_RESET}" "$*"
}

success() {
  printf '%b[OK]%b %s\n' "${C_GREEN}" "${C_RESET}" "$*"
}

error() {
  printf '%b[ERROR]%b %s\n' "${C_RED}" "${C_RESET}" "$*" >&2
}

normalize_lines() {
  awk 'NF' | sort -u
}

is_path_within() {
  local path="$1"
  local root="$2"

  if [ -z "${path}" ] || [ -z "${root}" ]; then
    return 1
  fi

  case "${path}" in
    "${root}"|"${root}"/*) return 0 ;;
    *) return 1 ;;
  esac
}

confirm() {
  local prompt="$1"

  if [ "${ASSUME_YES}" = "1" ]; then
    warn "Auto-confirm enabled: ${prompt}"
    return 0
  fi

  if [ ! -t 0 ]; then
    error "Non-interactive shell: cannot prompt for confirmation."
    error "Re-run with --yes only if you fully understand the risks."
    return 1
  fi

  printf '%b%s [y/N]: %b' "${C_YELLOW}" "${prompt}" "${C_RESET}"
  local answer
  read -r answer || true

  case "${answer}" in
    y|Y|yes|YES)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

abort_cutover() {
  trap - ERR
  warn "Cutover aborted at step: ${CURRENT_STEP}"
  exit 1
}

print_rollback_instructions() {
  warn "Rollback instructions:"

  if [ -f "${MAIN_REPO}/.git/MERGE_HEAD" ]; then
    printf '  1) Abort merge in progress:\n'
    printf '     git -C "%s" merge --abort\n' "${MAIN_REPO}"
  elif [ "${MERGE_DONE}" -eq 1 ] && [ -n "${PRE_MERGE_COMMIT}" ]; then
    printf '  1) Reset main to pre-merge commit:\n'
    printf '     git -C "%s" reset --hard "%s"\n' "${MAIN_REPO}" "${PRE_MERGE_COMMIT}"
  else
    printf '  1) If needed, inspect main branch state:\n'
    printf '     git -C "%s" status\n' "${MAIN_REPO}"
  fi

  if [ "${BACKUP_CREATED}" -eq 1 ] && [ -n "${BACKUP_DIR}" ]; then
    printf '  2) Restore live data backup:\n'
    printf '     rm -rf "%s"\n' "${LIVE_DATA_DIR}"
    printf '     cp -a "%s" "%s"\n' "${BACKUP_DIR}" "${LIVE_DATA_DIR}"
  else
    printf '  2) No backup was created in this run. Restore data from another known-good backup.\n'
  fi

  printf '  3) Restart the previous version:\n'
  printf '     cd "%s" && pnpm prod:start\n' "${MAIN_REPO}"

  if [ -n "${START_LOG}" ]; then
    printf '  4) Inspect startup logs:\n'
    printf '     tail -n 200 "%s"\n' "${START_LOG}"
  fi
}

fail() {
  local message="$1"
  trap - ERR
  error "${message}"
  printf '\n'
  print_rollback_instructions
  exit 1
}

on_unhandled_error() {
  local exit_code=$?
  trap - ERR
  error "Unexpected failure during step: ${CURRENT_STEP} (exit ${exit_code})."
  printf '\n'
  print_rollback_instructions
  exit "${exit_code}"
}

trap on_unhandled_error ERR

require_command() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    fail "Missing required command: ${cmd}"
  fi
}

is_port_listening() {
  local port="$1"
  lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
}

pid_cwd() {
  local pid="$1"
  lsof -a -p "${pid}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

is_pid_running() {
  local pid="$1"
  if [ -z "${pid}" ]; then
    return 1
  fi

  kill -0 "${pid}" 2>/dev/null
}

collect_port_listener_pids() {
  local port
  for port in "$@"; do
    lsof -nP -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true
  done | normalize_lines
}

collect_repo_listener_pids() {
  local repo="$1"
  local pid
  local cwd

  lsof -nP -iTCP -sTCP:LISTEN -t 2>/dev/null | sort -u | while read -r pid; do
    [ -z "${pid}" ] && continue
    cwd="$(pid_cwd "${pid}")"
    if is_path_within "${cwd}" "${repo}"; then
      printf '%s\n' "${pid}"
    fi
  done | normalize_lines
}

matches_runtime_pattern() {
  local cmd="$1"

  case "${cmd}" in
    *"pnpm prod"*|*"pnpm prod:start"*|*"pnpm dev"*|*"concurrently"*|*"prod-daemon.mjs"*|*"@middleman/backend start"*|*"apps/backend/dist/index.js"*|*"vite preview"*|*"vite dev"*|*"apps/ui/.output/server/index.mjs"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

collect_repo_runtime_pids() {
  local repo="$1"
  local pid
  local cmd
  local cwd

  ps -axo pid=,command= | while read -r pid cmd; do
    [ -z "${pid}" ] && continue
    [ -z "${cmd}" ] && continue
    [ "${pid}" = "$$" ] && continue

    if matches_runtime_pattern "${cmd}"; then
      cwd="$(pid_cwd "${pid}")"
      if is_path_within "${cwd}" "${repo}"; then
        printf '%s\n' "${pid}"
      fi
    fi
  done | normalize_lines
}

ports_for_pid() {
  local pid="$1"
  lsof -nP -a -p "${pid}" -iTCP -sTCP:LISTEN -Fn 2>/dev/null \
    | sed -nE 's/^n.*:([0-9]+).*/\1/p' \
    | normalize_lines
}

collect_ports_for_pid_list() {
  local pid_list="$1"
  local pid

  while read -r pid; do
    [ -z "${pid}" ] && continue
    ports_for_pid "${pid}" || true
  done <<< "${pid_list}" | normalize_lines
}

csv_from_lines() {
  local lines="$1"
  if [ -z "$(printf '%s\n' "${lines}" | awk 'NF')" ]; then
    printf ''
    return 0
  fi

  printf '%s\n' "${lines}" | normalize_lines | paste -sd',' -
}

print_pid_report() {
  local pid_list="$1"
  local pid
  local cmd
  local cwd
  local ports

  while read -r pid; do
    [ -z "${pid}" ] && continue

    cmd="$(ps -p "${pid}" -o command= 2>/dev/null | sed 's/^ *//')"
    if [ -z "${cmd}" ]; then
      cmd="<exited>"
    fi

    cwd="$(pid_cwd "${pid}")"
    if [ -z "${cwd}" ]; then
      cwd="<unknown>"
    fi

    ports="$(csv_from_lines "$(ports_for_pid "${pid}" || true)")"
    if [ -z "${ports}" ]; then
      ports="-"
    fi

    printf '  PID %-7s ports=[%s]\n' "${pid}" "${ports}"
    printf '      cwd: %s\n' "${cwd}"
    printf '      cmd: %s\n' "${cmd}"
  done <<< "${pid_list}"
}

running_pids_from_list() {
  local pid
  while read -r pid; do
    [ -z "${pid}" ] && continue
    if is_pid_running "${pid}"; then
      printf '%s\n' "${pid}"
    fi
  done | normalize_lines
}

terminate_pids() {
  local pid_list="$1"
  local label="$2"
  local pid
  local remaining
  local attempts=40

  if [ -z "$(printf '%s\n' "${pid_list}" | awk 'NF')" ]; then
    info "No ${label} processes to stop."
    return 0
  fi

  info "Sending SIGTERM to ${label} processes..."
  while read -r pid; do
    [ -z "${pid}" ] && continue
    if is_pid_running "${pid}"; then
      kill -TERM "${pid}" 2>/dev/null || true
    fi
  done <<< "${pid_list}"

  remaining="${pid_list}"
  while [ "${attempts}" -gt 0 ]; do
    remaining="$(printf '%s\n' "${remaining}" | running_pids_from_list)"
    if [ -z "${remaining}" ]; then
      break
    fi

    sleep 0.5
    attempts=$((attempts - 1))
  done

  if [ -n "${remaining}" ]; then
    warn "Some ${label} processes did not stop with SIGTERM. Sending SIGKILL..."
    while read -r pid; do
      [ -z "${pid}" ] && continue
      if is_pid_running "${pid}"; then
        kill -KILL "${pid}" 2>/dev/null || true
      fi
    done <<< "${remaining}"

    sleep 1
    remaining="$(printf '%s\n' "${remaining}" | running_pids_from_list)"
    if [ -n "${remaining}" ]; then
      error "Failed to stop PIDs: $(csv_from_lines "${remaining}")"
      return 1
    fi
  fi

  success "Stopped ${label} processes."
}

busy_ports_from_list() {
  local port
  while read -r port; do
    [ -z "${port}" ] && continue
    if is_port_listening "${port}"; then
      printf '%s\n' "${port}"
    fi
  done | normalize_lines
}

wait_for_ports_free() {
  local ports="$1"
  local timeout_seconds="$2"
  local label="$3"

  local attempts="${timeout_seconds}"
  local busy

  while [ "${attempts}" -gt 0 ]; do
    busy="$(printf '%s\n' "${ports}" | busy_ports_from_list)"
    if [ -z "${busy}" ]; then
      return 0
    fi

    sleep 1
    attempts=$((attempts - 1))
  done

  busy="$(printf '%s\n' "${ports}" | busy_ports_from_list)"
  if [ -n "${busy}" ]; then
    error "${label} still busy after ${timeout_seconds}s: $(csv_from_lines "${busy}")"
    return 1
  fi

  return 0
}

wait_for_port() {
  local port="$1"
  local timeout_seconds="$2"
  local watch_pid="${3:-}"

  local attempts="${timeout_seconds}"
  while [ "${attempts}" -gt 0 ]; do
    if is_port_listening "${port}"; then
      return 0
    fi

    if [ -n "${watch_pid}" ] && ! is_pid_running "${watch_pid}"; then
      return 1
    fi

    sleep 1
    attempts=$((attempts - 1))
  done

  return 1
}

wait_for_http() {
  local url="$1"
  local timeout_seconds="$2"

  if ! command -v curl >/dev/null 2>&1; then
    warn "curl not found; skipping HTTP check for ${url}."
    return 0
  fi

  local attempts="${timeout_seconds}"
  while [ "${attempts}" -gt 0 ]; do
    if curl -sS -o /dev/null "${url}"; then
      return 0
    fi

    sleep 1
    attempts=$((attempts - 1))
  done

  return 1
}

ensure_repo_clean() {
  local repo="$1"
  local label="$2"
  local status

  status="$(git -C "${repo}" status --porcelain)"
  if [ -n "${status}" ]; then
    error "${label} has uncommitted changes: ${repo}"
    printf '%s\n' "${status}" | sed 's/^/  /'
    return 1
  fi

  success "${label} is clean."
}

preflight_checks() {
  CURRENT_STEP="pre-flight checks"
  section "Step 1: Pre-flight checks"

  require_command git
  require_command pnpm
  require_command lsof
  require_command ps
  require_command awk
  require_command sed
  require_command cp
  require_command date

  if [ "${REPO_ROOT}" != "${WORKTREE_ROOT}" ]; then
    fail "Script must be executed from worktree repo ${WORKTREE_ROOT}. Detected script repo: ${REPO_ROOT}"
  fi

  local cwd
  cwd="$(pwd -P)"
  if ! is_path_within "${cwd}" "${WORKTREE_ROOT}"; then
    fail "Run this script from inside ${WORKTREE_ROOT}. Current directory: ${cwd}"
  fi

  if [ ! -d "${MAIN_REPO}" ] || [ ! -d "${MAIN_REPO}/.git" ]; then
    fail "Main repo not found at ${MAIN_REPO}"
  fi

  local worktree_branch
  worktree_branch="$(git -C "${WORKTREE_ROOT}" rev-parse --abbrev-ref HEAD)"
  if [ "${worktree_branch}" != "${FEATURE_BRANCH}" ]; then
    fail "Worktree must be on ${FEATURE_BRANCH}. Current branch: ${worktree_branch}"
  fi

  if ! git -C "${MAIN_REPO}" show-ref --verify --quiet "refs/heads/${FEATURE_BRANCH}"; then
    fail "Branch ${FEATURE_BRANCH} does not exist in ${MAIN_REPO}"
  fi

  local main_branch
  main_branch="$(git -C "${MAIN_REPO}" rev-parse --abbrev-ref HEAD)"
  if [ "${main_branch}" != "${MAIN_BRANCH}" ]; then
    fail "Main repo must be on ${MAIN_BRANCH}. Current branch: ${main_branch}"
  fi

  ensure_repo_clean "${WORKTREE_ROOT}" "Worktree"
  ensure_repo_clean "${MAIN_REPO}" "Main repo"

  local commit_log
  local commit_count
  commit_log="$(git -C "${MAIN_REPO}" log --oneline --reverse "${MAIN_BRANCH}..${FEATURE_BRANCH}")"
  commit_count="$(git -C "${MAIN_REPO}" rev-list --count "${MAIN_BRANCH}..${FEATURE_BRANCH}")"

  if [ "${commit_count}" = "0" ]; then
    fail "No commits to merge from ${FEATURE_BRANCH} into ${MAIN_BRANCH}."
  fi

  info "Commits to merge (${commit_count}):"
  printf '%s\n' "${commit_log}" | sed 's/^/  /'
}

backup_live_data() {
  CURRENT_STEP="backup live data"
  section "Step 2: Backup live data"

  if [ ! -d "${LIVE_DATA_DIR}" ]; then
    fail "Live data directory not found: ${LIVE_DATA_DIR}"
  fi

  BACKUP_DIR="${HOME}/.middleman-backup-$(date +%Y%m%d-%H%M%S)"

  if [ -e "${BACKUP_DIR}" ]; then
    fail "Backup path already exists: ${BACKUP_DIR}"
  fi

  info "Creating backup: ${LIVE_DATA_DIR} -> ${BACKUP_DIR}"
  cp -a "${LIVE_DATA_DIR}" "${BACKUP_DIR}"

  if [ ! -d "${BACKUP_DIR}" ]; then
    fail "Backup directory was not created: ${BACKUP_DIR}"
  fi

  if [ ! -f "${BACKUP_DIR}/swarm/agents.json" ]; then
    fail "Backup verification failed: missing swarm/agents.json in ${BACKUP_DIR}"
  fi

  if [ ! -d "${BACKUP_DIR}/sessions" ]; then
    fail "Backup verification failed: missing sessions/ in ${BACKUP_DIR}"
  fi

  if [ ! -d "${BACKUP_DIR}/memory" ]; then
    fail "Backup verification failed: missing memory/ in ${BACKUP_DIR}"
  fi

  BACKUP_CREATED=1
  success "Backup created and verified: ${BACKUP_DIR}"
}

stop_test_instance_if_needed() {
  CURRENT_STEP="stop test instance"
  section "Step 3: Stop test instance (47387/47389)"

  local test_pids
  test_pids="$(collect_port_listener_pids 47387 47389)"

  if [ -z "${test_pids}" ]; then
    info "No test instance listeners detected on ports 47387/47389."
    return 0
  fi

  warn "Detected listeners on test ports:"
  print_pid_report "${test_pids}"

  if ! confirm "Kill test-instance processes now?"; then
    abort_cutover
  fi

  terminate_pids "${test_pids}" "test-instance"

  if ! wait_for_ports_free "47387
47389" 30 "test ports"; then
    fail "Test instance ports did not clear."
  fi

  success "Test ports are free."
}

stop_live_instance() {
  CURRENT_STEP="stop live instance"
  section "Step 4: Stop live instance"

  local live_pids
  live_pids="$({
    collect_port_listener_pids 47287 47289 47187 47188
    collect_repo_listener_pids "${MAIN_REPO}"
    collect_repo_runtime_pids "${MAIN_REPO}"
  } | normalize_lines | awk -v self="$$" '$1 != self')"

  if [ -z "${live_pids}" ]; then
    warn "No live/dev processes detected for ${MAIN_REPO}."
    warn "If the live instance is running on a custom UI port, stop it manually before continuing."
    if ! confirm "Continue without killing any live processes?"; then
      abort_cutover
    fi
    return 0
  fi

  local live_ports
  live_ports="$({
    printf '47287\n47289\n47187\n47188\n'
    collect_ports_for_pid_list "${live_pids}"
  } | normalize_lines)"

  warn "Processes targeted for shutdown:"
  print_pid_report "${live_pids}"
  info "Ports targeted: $(csv_from_lines "${live_ports}")"

  if ! confirm "Stop the live/dev processes listed above?"; then
    abort_cutover
  fi

  terminate_pids "${live_pids}" "live/dev"

  if ! wait_for_ports_free "${live_ports}" 60 "live/dev ports"; then
    fail "One or more live/dev ports are still in use."
  fi

  success "Live instance stopped and target ports are free."
}

merge_to_main() {
  CURRENT_STEP="merge to main"
  section "Step 5: Merge feature branch into main"

  PRE_MERGE_COMMIT="$(git -C "${MAIN_REPO}" rev-parse HEAD)"
  info "Pre-merge main commit: ${PRE_MERGE_COMMIT}"

  if ! confirm "Merge ${FEATURE_BRANCH} into ${MAIN_BRANCH} now?"; then
    abort_cutover
  fi

  if ! git -C "${MAIN_REPO}" merge "${FEATURE_BRANCH}" --no-ff -m "${MERGE_MESSAGE}"; then
    error "Merge failed. Resolve conflicts or abort merge before retrying."
    error "Suggested command: git -C \"${MAIN_REPO}\" merge --abort"
    fail "Could not merge ${FEATURE_BRANCH} into ${MAIN_BRANCH}."
  fi

  MERGE_DONE=1
  success "Merge completed."
}

install_dependencies() {
  CURRENT_STEP="install dependencies"
  section "Step 6: Install dependencies"

  info "Running pnpm install --frozen-lockfile in ${MAIN_REPO}"
  if ! (cd "${MAIN_REPO}" && pnpm install --frozen-lockfile); then
    fail "Dependency installation failed."
  fi

  success "Dependencies installed."
}

build_main_repo() {
  CURRENT_STEP="build"
  section "Step 7: Build"

  info "Running pnpm build in ${MAIN_REPO}"
  if ! (cd "${MAIN_REPO}" && pnpm build); then
    error "Build failed after merge."
    fail "Build failed. Use rollback instructions above."
  fi

  success "Build completed."
}

start_live_instance() {
  CURRENT_STEP="start live instance"
  section "Step 8: Start live instance"

  if ! confirm "Start live instance in background with pnpm prod:start?"; then
    abort_cutover
  fi

  START_LOG="${TMPDIR:-/tmp}/middleman-cutover-prod-start-$(date +%Y%m%d-%H%M%S).log"
  START_PID="$(cd "${MAIN_REPO}" && nohup pnpm prod:start > "${START_LOG}" 2>&1 & echo $!)"

  if [ -z "${START_PID}" ]; then
    fail "Failed to capture startup PID for pnpm prod:start."
  fi

  info "Started pnpm prod:start with PID ${START_PID}"
  info "Startup log: ${START_LOG}"

  if ! wait_for_port 47287 120 "${START_PID}"; then
    error "Backend port 47287 did not come up."
    fail "Live backend failed to start. Check ${START_LOG}."
  fi

  if ! wait_for_port 47289 120 "${START_PID}"; then
    error "UI port 47289 did not come up."
    fail "Live UI failed to start. Check ${START_LOG}."
  fi

  if ! wait_for_http "http://127.0.0.1:47287" 30; then
    error "Backend HTTP did not respond at http://127.0.0.1:47287"
    fail "Backend health check failed."
  fi

  if ! wait_for_http "http://127.0.0.1:47289" 30; then
    error "UI HTTP did not respond at http://127.0.0.1:47289"
    fail "UI health check failed."
  fi

  success "Live instance started and responding."
}

cleanup_worktree() {
  CURRENT_STEP="cleanup worktree"
  section "Step 9: Clean up worktree"

  if ! confirm "Remove worktree ${WORKTREE_ROOT} and delete branch ${FEATURE_BRANCH}?"; then
    abort_cutover
  fi

  cd "${MAIN_REPO}"

  if ! git -C "${MAIN_REPO}" worktree remove "${WORKTREE_ROOT}"; then
    fail "Failed to remove worktree ${WORKTREE_ROOT}."
  fi

  if ! git -C "${MAIN_REPO}" branch -d "${FEATURE_BRANCH}"; then
    fail "Failed to delete branch ${FEATURE_BRANCH}."
  fi

  success "Removed worktree and deleted feature branch."
}

postflight_verification() {
  CURRENT_STEP="post-flight verification"
  section "Step 10: Post-flight verification"

  if ! is_port_listening 47287; then
    fail "Backend is not listening on port 47287."
  fi

  if ! is_port_listening 47289; then
    fail "UI is not listening on port 47289."
  fi

  if ! wait_for_http "http://127.0.0.1:47287" 15; then
    fail "Backend HTTP endpoint is not responding."
  fi

  if ! wait_for_http "http://127.0.0.1:47289" 15; then
    fail "UI HTTP endpoint is not responding."
  fi

  success "Post-flight checks passed."

  printf '\n%bCUTOVER COMPLETE%b\n' "${C_GREEN}${C_BOLD}" "${C_RESET}"
  printf '  Backend HTTP: http://127.0.0.1:47287\n'
  printf '  Backend WS  : ws://127.0.0.1:47287\n'
  printf '  UI URL      : http://127.0.0.1:47289\n'
  printf '  Data backup : %s\n' "${BACKUP_DIR}"
  printf '  Start log   : %s\n\n' "${START_LOG}"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -y|--yes)
        ASSUME_YES=1
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        error "Unknown argument: $1"
        usage
        exit 1
        ;;
    esac
    shift
  done
}

main() {
  parse_args "$@"

  section "Middleman multi-session cutover"
  info "Worktree repo: ${WORKTREE_ROOT}"
  info "Main repo    : ${MAIN_REPO}"
  info "Feature branch: ${FEATURE_BRANCH}"

  preflight_checks
  backup_live_data
  stop_test_instance_if_needed
  stop_live_instance
  merge_to_main
  install_dependencies
  build_main_repo
  start_live_instance
  cleanup_worktree
  postflight_verification
}

main "$@"
