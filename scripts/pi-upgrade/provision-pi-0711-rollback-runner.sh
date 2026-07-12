#!/usr/bin/env bash
# Provision a hermetic frozen Pi 0.71.1 SessionManager runner for WP-8 rollback gates.
# Uses the committed package.json + package-lock.json under
# scripts/pi-upgrade/pi-0711-rollback-runner/ and installs via `npm ci` into
# <repo>/.forge/pi-upgrade-runners/0.71.1 (gitignored). Does not touch production
# ~/.forge or live ports.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SOURCE_DIR="$ROOT/scripts/pi-upgrade/pi-0711-rollback-runner"
RUNNER_ROOT="${FORGE_PI_0711_RUNNER_ROOT:-$ROOT/.forge/pi-upgrade-runners/0.71.1}"
SESSION_MANAGER_JS="$RUNNER_ROOT/node_modules/@mariozechner/pi-coding-agent/dist/core/session-manager.js"

if [[ ! -f "$SOURCE_DIR/package.json" || ! -f "$SOURCE_DIR/package-lock.json" ]]; then
  echo "ERROR: missing committed runner package.json/package-lock.json under $SOURCE_DIR" >&2
  exit 1
fi

mkdir -p "$RUNNER_ROOT"
cp "$SOURCE_DIR/package.json" "$RUNNER_ROOT/package.json"
cp "$SOURCE_DIR/package-lock.json" "$RUNNER_ROOT/package-lock.json"
cd "$RUNNER_ROOT"

echo "Installing frozen @mariozechner/pi-coding-agent@0.71.1 via npm ci into $RUNNER_ROOT"
npm ci --omit=dev --no-fund --no-audit

if [[ ! -f "$SESSION_MANAGER_JS" ]]; then
  echo "ERROR: expected SessionManager at $SESSION_MANAGER_JS" >&2
  exit 1
fi

VERSION="$(node -e "console.log(require('./node_modules/@mariozechner/pi-coding-agent/package.json').version)")"
NAME="$(node -e "console.log(require('./node_modules/@mariozechner/pi-coding-agent/package.json').name)")"
if [[ "$NAME" != "@mariozechner/pi-coding-agent" || "$VERSION" != "0.71.1" ]]; then
  echo "ERROR: expected @mariozechner/pi-coding-agent@0.71.1, got ${NAME}@${VERSION}" >&2
  exit 1
fi

# Integrity: lockfile must pin the exact package and the installed tree must match.
LOCK_VERSION="$(node -e "const l=require('./package-lock.json'); const p=l.packages?.['node_modules/@mariozechner/pi-coding-agent'] || l.dependencies?.['@mariozechner/pi-coding-agent']; if(!p) process.exit(2); console.log(p.version)")"
if [[ "$LOCK_VERSION" != "0.71.1" ]]; then
  echo "ERROR: package-lock pins ${LOCK_VERSION}, expected 0.71.1" >&2
  exit 1
fi

# Prove the old Forge-facing SessionManager export is importable.
node --input-type=module -e "
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(process.argv[1]).href);
if (mod.CURRENT_SESSION_VERSION !== 3) throw new Error('CURRENT_SESSION_VERSION');
if (typeof mod.SessionManager?.open !== 'function') throw new Error('SessionManager.open');
console.log('import-ok', mod.CURRENT_SESSION_VERSION);
" "$SESSION_MANAGER_JS"

echo "OK: frozen runner ready (npm ci, lock-integrity verified)"
echo "FORGE_PI_0711_SESSION_MANAGER_JS=$SESSION_MANAGER_JS"
echo "Default characterization test path: $SESSION_MANAGER_JS"
