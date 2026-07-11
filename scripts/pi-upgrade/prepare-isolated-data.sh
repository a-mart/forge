#!/usr/bin/env bash
# Prepare an isolated Forge data root for Pi upgrade testing.
# - Verifies free disk space before copying
# - Refuses destinations that resolve to / overlap production ~/.forge
# - Faithful copy (rsync -a) preserving permissions
# - Never prints secret file contents
# - Sanitizes inherited live process-state artifacts in the destination
set -euo pipefail

export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:${PATH:-}"

PROD_DATA="${FORGE_PROD_DATA_DIR:-$HOME/.forge}"
BRANCH_NAME="${1:-pi-upgrade-0.80.6-safety}"
DEST_DATA="${2:-$HOME/.forge-worktree-$BRANCH_NAME}"
# Require this much free space above the source size (default 20 GiB headroom).
HEADROOM_BYTES="${FORGE_ISOLATED_COPY_HEADROOM_BYTES:-$((20 * 1024 * 1024 * 1024))}"

realpath_py() {
  python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

bytes_free() {
  # Portable-ish free bytes for the volume containing $1
  df -k "$1" | awk 'NR==2 { print $4 * 1024 }'
}

echo "Forge isolated data prepare"
echo "  source: $PROD_DATA"
echo "  dest:   $DEST_DATA"

if [[ ! -d "$PROD_DATA" ]]; then
  echo "ERROR: production data dir missing: $PROD_DATA" >&2
  exit 1
fi

PROD_REAL="$(realpath_py "$PROD_DATA")"
mkdir -p "$(dirname "$DEST_DATA")"
# If dest exists, resolve it; else resolve parent + basename.
if [[ -e "$DEST_DATA" ]]; then
  DEST_REAL="$(realpath_py "$DEST_DATA")"
else
  PARENT_REAL="$(realpath_py "$(dirname "$DEST_DATA")")"
  DEST_REAL="$PARENT_REAL/$(basename "$DEST_DATA")"
fi

if [[ "$DEST_REAL" == "$PROD_REAL" ]]; then
  echo "ERROR: destination resolves to production data path ($PROD_REAL)" >&2
  exit 1
fi
case "$DEST_REAL" in
  "$PROD_REAL"/*)
    echo "ERROR: destination is inside production data path ($PROD_REAL)" >&2
    exit 1
    ;;
esac
case "$PROD_REAL" in
  "$DEST_REAL"/*)
    echo "ERROR: production path is inside destination ($DEST_REAL)" >&2
    exit 1
    ;;
esac
if [[ -L "$DEST_DATA" ]]; then
  echo "ERROR: destination is a symlink; refuse (could alias production)" >&2
  exit 1
fi

SRC_BYTES="$(du -sk "$PROD_DATA" | awk '{ print $1 * 1024 }')"
FREE_BYTES="$(bytes_free "$(dirname "$DEST_DATA")")"
NEED_BYTES=$((SRC_BYTES + HEADROOM_BYTES))
echo "  source_bytes=$SRC_BYTES"
echo "  free_bytes=$FREE_BYTES"
echo "  need_bytes=$NEED_BYTES (source + ${HEADROOM_BYTES} headroom)"

if (( FREE_BYTES < NEED_BYTES )); then
  echo "ERROR: insufficient free disk space for faithful copy" >&2
  exit 1
fi

if [[ -d "$DEST_DATA" ]]; then
  echo "Destination already exists — refreshing with rsync -a (permissions preserved)."
else
  echo "Creating destination and copying (rsync -a)..."
  mkdir -p "$DEST_DATA"
fi

# Faithful archive-mode copy. Do not use --link-dest / hardlinks into production.
# Exclude regenerable caches/uploads/terminal journals to save time/space while
# keeping auth/config/sessions for realistic testing. Override with FORGE_ISOLATED_COPY_FULL=1.
EXCLUDES=(
  --exclude 'shared/cache/'
  --exclude 'uploads/'
  --exclude '**/terminals/*/delta.ndjson'
  --exclude '**/terminals/*/snapshot.vt'
)
if [[ "${FORGE_ISOLATED_COPY_FULL:-0}" == "1" ]]; then
  EXCLUDES=()
fi

rsync -a "${EXCLUDES[@]}" "$PROD_DATA/" "$DEST_DATA/"

# Sanitize live process-state semantics inherited from production (or prior runs).
# Never touch production.
SANITIZE_LIST=(
  "$DEST_DATA/runtime.lock"
)
for f in "${SANITIZE_LIST[@]}"; do
  if [[ -e "$f" ]]; then
    echo "Sanitizing destination artifact: ${f#$DEST_DATA/}"
    rm -f "$f"
  fi
done
# Drop any stray pid/socket files under dest root only (not deep skill venv locks).
find "$DEST_DATA" -maxdepth 2 \( -name '*.pid' -o -name '*.sock' -o -name '*.socket' \) -type f -print -delete 2>/dev/null || true

# Verify auth presence/mode without reading secrets.
AUTH="$DEST_DATA/shared/config/auth/auth.json"
if [[ ! -f "$AUTH" ]]; then
  echo "ERROR: auth.json missing after copy" >&2
  exit 1
fi
MODE="$(stat -f '%Lp' "$AUTH")"
if [[ "$MODE" != "600" && "$MODE" != "400" ]]; then
  echo "WARN: auth.json mode is $MODE (expected 600); chmod u=rw,go= applied"
  chmod u=rw,go= "$AUTH"
fi

# Final overlap check on auth inodes (must not be hardlinked to production).
python3 - <<PY
import os, sys
prod=os.stat(os.path.join("$PROD_REAL", "shared/config/auth/auth.json"))
dest=os.stat(os.path.join("$DEST_REAL", "shared/config/auth/auth.json"))
if prod.st_ino == dest.st_ino and prod.st_dev == dest.st_dev:
    print("ERROR: destination auth.json shares inode with production (hardlink)", file=sys.stderr)
    sys.exit(1)
print("auth_inode_isolated=true")
print("auth_mode=%s" % oct(dest.st_mode & 0o777))
PY

echo "Isolated data ready at $DEST_REAL"
echo "Reminder: point FORGE_DATA_DIR here; never at $PROD_REAL"
