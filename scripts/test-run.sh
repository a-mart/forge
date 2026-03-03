#!/usr/bin/env bash
# Run the data-restructure branch on isolated ports with test data
set -euo pipefail

cd "$(dirname "$0")/.."

export MIDDLEMAN_DATA_DIR="/Users/adam/repos/middleman-data-restructure/.middleman-test"
export MIDDLEMAN_PORT=47387

echo "=== Data Directory Restructure — Test Instance ==="
echo "Backend: http://127.0.0.1:47387"
echo "UI:      http://127.0.0.1:47388"
echo "Data:    $MIDDLEMAN_DATA_DIR"
echo ""
echo "Live system (unchanged):"
echo "  Dev:  http://127.0.0.1:47187 / http://127.0.0.1:47188"
echo "  Prod: http://127.0.0.1:47287 / http://127.0.0.1:47289"
echo ""

# Run with concurrently on test ports.
# Call vite directly for the UI to override the baked-in port in package.json.
exec pnpm concurrently --kill-others-on-fail --names backend,ui \
  "pnpm --filter @middleman/backend dev" \
  "cd apps/ui && VITE_MIDDLEMAN_WS_URL=ws://127.0.0.1:47387 npx vite dev --host 127.0.0.1 --port 47388 --strictPort"
