#!/usr/bin/env bash
# Provision a hermetic frozen Pi 0.71.1 SessionManager runner for WP-8 rollback gates.
# Installs outside shipped Forge deps under <repo>/.forge/pi-upgrade-runners/0.71.1
# (gitignored). Does not touch production ~/.forge or live ports.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNNER_ROOT="${FORGE_PI_0711_RUNNER_ROOT:-$ROOT/.forge/pi-upgrade-runners/0.71.1}"
SESSION_MANAGER_JS="$RUNNER_ROOT/node_modules/@mariozechner/pi-coding-agent/dist/core/session-manager.js"

mkdir -p "$RUNNER_ROOT"
cd "$RUNNER_ROOT"

if [[ ! -f package.json ]]; then
  cat > package.json <<'EOF'
{
  "name": "forge-pi-0711-rollback-runner",
  "private": true,
  "version": "0.0.0",
  "dependencies": {
    "@mariozechner/pi-coding-agent": "0.71.1"
  }
}
EOF
fi

echo "Installing exact @mariozechner/pi-coding-agent@0.71.1 into $RUNNER_ROOT"
npm install --omit=dev --no-fund --no-audit --no-package-lock "@mariozechner/pi-coding-agent@0.71.1"

if [[ ! -f "$SESSION_MANAGER_JS" ]]; then
  echo "ERROR: expected SessionManager at $SESSION_MANAGER_JS" >&2
  exit 1
fi

VERSION="$(node -e "console.log(require('./node_modules/@mariozechner/pi-coding-agent/package.json').version)")"
if [[ "$VERSION" != "0.71.1" ]]; then
  echo "ERROR: expected 0.71.1, got $VERSION" >&2
  exit 1
fi

echo "OK: frozen runner ready"
echo "FORGE_PI_0711_SESSION_MANAGER_JS=$SESSION_MANAGER_JS"
echo "Default characterization test path: $SESSION_MANAGER_JS"
