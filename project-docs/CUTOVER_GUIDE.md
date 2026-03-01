# Multi-Session Cutover Guide

## Overview

This cutover moves the live repo (`/Users/adam/repos/middleman`, branch `main`) to include the `feature/multi-session` work from the worktree (`/Users/adam/repos/middleman-multi-session`).

Why this needs care:

- The live manager instance is currently running from `main`.
- Live state is in `~/.middleman` and must be preserved.
- The merge introduces major session/model changes (profiles + multi-session UI + protocol changes).

The safe sequence is:

1. Pre-flight checks
2. Data backup
3. Stop test and live processes
4. Merge + install + build
5. Restart live instance
6. Verify behavior and data
7. Clean up worktree branch

---

## Prerequisites

Before starting, confirm all of the following:

- You can run commands in both repos:
  - Worktree: `/Users/adam/repos/middleman-multi-session`
  - Live repo: `/Users/adam/repos/middleman`
- `pnpm`, `git`, and `lsof` are available in your shell.
- Both repos are clean (no uncommitted changes).
- You have enough disk space to copy `~/.middleman`.
- You are okay with a short downtime window while stopping live and restarting.

---

## Manual Steps (with commands)

### 0) Set variables (copy/paste once)

```bash
WORKTREE="/Users/adam/repos/middleman-multi-session"
MAIN="/Users/adam/repos/middleman"
FEATURE="feature/multi-session"
LIVE_DATA="$HOME/.middleman"
BACKUP="$HOME/.middleman-backup-$(date +%Y%m%d-%H%M%S)"
```

Verify:

```bash
echo "$WORKTREE"
echo "$MAIN"
echo "$LIVE_DATA"
echo "$BACKUP"
```

---

### 1) Pre-flight checks

```bash
cd "$WORKTREE"

# Branch checks
git -C "$WORKTREE" rev-parse --abbrev-ref HEAD
git -C "$MAIN" rev-parse --abbrev-ref HEAD

# Clean working trees
git -C "$WORKTREE" status --porcelain
git -C "$MAIN" status --porcelain

# Commits to merge
git -C "$MAIN" log --oneline --reverse main.."$FEATURE"
```

Verify:

- Worktree branch is `feature/multi-session`.
- Main repo branch is `main`.
- `status --porcelain` outputs nothing for both repos.
- Commit log shows the expected multi-session commits.

---

### 2) Backup live data (`~/.middleman`)

```bash
cp -a "$LIVE_DATA" "$BACKUP"

# Verify backup exists and has key content
[ -f "$BACKUP/agents.json" ] && echo "agents.json: OK"
[ -d "$BACKUP/sessions" ] && echo "sessions/: OK"
[ -d "$BACKUP/memory" ] && echo "memory/: OK"

echo "Backup created at: $BACKUP"
```

Verify:

- Backup path exists.
- `agents.json`, `sessions/`, and `memory/` exist inside backup.

---

### 3) Stop test instance (if running on 47387 / 47389)

Inspect:

```bash
lsof -nP -iTCP:47387 -sTCP:LISTEN || true
lsof -nP -iTCP:47389 -sTCP:LISTEN || true
```

Stop listeners on test ports:

```bash
for PORT in 47387 47389; do
  while read -r PID; do
    [ -n "$PID" ] && kill -TERM "$PID" 2>/dev/null || true
  done < <(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
done

sleep 2

# Force kill any stragglers
for PORT in 47387 47389; do
  while read -r PID; do
    [ -n "$PID" ] && kill -KILL "$PID" 2>/dev/null || true
  done < <(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
done
```

Verify:

```bash
lsof -nP -iTCP:47387 -sTCP:LISTEN || true
lsof -nP -iTCP:47389 -sTCP:LISTEN || true
```

Expected: no listeners.

---

### 4) Stop live instance (prod + dev fallback ports)

Inspect likely live ports:

```bash
for PORT in 47287 47289 47187 47188; do
  echo "--- port $PORT ---"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN || true
done
```

Also detect any listening process launched from the live repo (captures custom UI ports):

```bash
for PID in $(lsof -nP -iTCP -sTCP:LISTEN -t 2>/dev/null | sort -u); do
  CWD=$(lsof -a -p "$PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)
  if [[ "$CWD" == "$MAIN" || "$CWD" == "$MAIN/"* ]]; then
    echo "PID $PID"
    echo "  cwd: $CWD"
    ps -p "$PID" -o command=
    lsof -nP -a -p "$PID" -iTCP -sTCP:LISTEN || true
  fi
done
```

Stop known ports:

```bash
for PORT in 47287 47289 47187 47188; do
  while read -r PID; do
    [ -n "$PID" ] && kill -TERM "$PID" 2>/dev/null || true
  done < <(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
done
```

Stop any remaining repo-owned listeners:

```bash
for PID in $(lsof -nP -iTCP -sTCP:LISTEN -t 2>/dev/null | sort -u); do
  CWD=$(lsof -a -p "$PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)
  if [[ "$CWD" == "$MAIN" || "$CWD" == "$MAIN/"* ]]; then
    kill -TERM "$PID" 2>/dev/null || true
  fi
done

sleep 3

# Force kill remaining listeners from the same repo
for PID in $(lsof -nP -iTCP -sTCP:LISTEN -t 2>/dev/null | sort -u); do
  CWD=$(lsof -a -p "$PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)
  if [[ "$CWD" == "$MAIN" || "$CWD" == "$MAIN/"* ]]; then
    kill -KILL "$PID" 2>/dev/null || true
  fi
done
```

Verify ports are clear:

```bash
for PORT in 47287 47289 47187 47188; do
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN || true
done
```

Expected: no listeners for the live instance.

---

### 5) Merge feature branch into main

Capture pre-merge commit first (for rollback):

```bash
PRE_MERGE_COMMIT=$(git -C "$MAIN" rev-parse HEAD)
echo "$PRE_MERGE_COMMIT"
```

Run merge:

```bash
git -C "$MAIN" merge "$FEATURE" --no-ff -m "feat: multi-session per manager"
```

If merge conflicts occur:

```bash
git -C "$MAIN" status
git -C "$MAIN" merge --abort
```

Verify successful merge:

```bash
git -C "$MAIN" log --oneline -n 5
git -C "$MAIN" status --porcelain
```

---

### 6) Install dependencies

```bash
cd "$MAIN"
pnpm install --frozen-lockfile
```

Verify:

- Command exits successfully.
- No lockfile/install errors.

---

### 7) Build

```bash
cd "$MAIN"
pnpm build
```

Verify:

- Build exits successfully.
- No backend/UI build errors.

---

### 8) Start live instance

Start in background:

```bash
cd "$MAIN"
START_LOG="/tmp/middleman-prod-cutover-$(date +%Y%m%d-%H%M%S).log"
nohup pnpm prod:start > "$START_LOG" 2>&1 &
START_PID=$!
echo "START_PID=$START_PID"
echo "START_LOG=$START_LOG"
```

Wait for ports:

```bash
for _ in $(seq 1 120); do
  if lsof -nP -iTCP:47287 -sTCP:LISTEN >/dev/null 2>&1 && \
     lsof -nP -iTCP:47289 -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
```

Verify backend + UI:

```bash
lsof -nP -iTCP:47287 -sTCP:LISTEN
lsof -nP -iTCP:47289 -sTCP:LISTEN
curl -sS -o /dev/null http://127.0.0.1:47287 && echo "backend HTTP: OK"
curl -sS -o /dev/null http://127.0.0.1:47289 && echo "ui HTTP: OK"
```

If startup fails, inspect logs:

```bash
tail -n 200 "$START_LOG"
```

---

### 9) Clean up worktree + feature branch

Run only after successful startup verification.

```bash
git -C "$MAIN" worktree remove "$WORKTREE"
git -C "$MAIN" branch -d "$FEATURE"
```

Verify:

```bash
git -C "$MAIN" worktree list
git -C "$MAIN" branch --list "$FEATURE"
```

Expected: worktree removed and branch no longer listed.

---

### 10) Final confirmation

```bash
echo "Backend: http://127.0.0.1:47287"
echo "Backend WS: ws://127.0.0.1:47287"
echo "UI: http://127.0.0.1:47289"
echo "Backup: $BACKUP"
```

---

## Rollback Procedure

Use this section if anything fails.

### A) Restore live data backup

```bash
rm -rf "$LIVE_DATA"
cp -a "$BACKUP" "$LIVE_DATA"
```

Verify restore:

```bash
[ -f "$LIVE_DATA/agents.json" ] && echo "agents.json restored"
[ -d "$LIVE_DATA/sessions" ] && echo "sessions restored"
[ -d "$LIVE_DATA/memory" ] && echo "memory restored"
```

---

### B) Revert git merge

#### If merge is still in progress (conflicts not committed)

```bash
git -C "$MAIN" merge --abort
```

#### If merge commit was created locally and not pushed

```bash
git -C "$MAIN" reset --hard "$PRE_MERGE_COMMIT"
```

#### If merge commit was pushed/shared (safer history-preserving option)

```bash
MERGE_SHA=$(git -C "$MAIN" rev-parse HEAD)
git -C "$MAIN" revert -m 1 "$MERGE_SHA"
```

---

### C) Restart the previous version

If a failed new process is still running:

```bash
kill -TERM "$START_PID" 2>/dev/null || true
sleep 2
kill -KILL "$START_PID" 2>/dev/null || true
```

Start old version (after merge rollback + data restore):

```bash
cd "$MAIN"
nohup pnpm prod:start > /tmp/middleman-prod-rollback.log 2>&1 &
```

Verify:

```bash
lsof -nP -iTCP:47287 -sTCP:LISTEN
lsof -nP -iTCP:47289 -sTCP:LISTEN
curl -sS -o /dev/null http://127.0.0.1:47287 && echo "backend OK"
curl -sS -o /dev/null http://127.0.0.1:47289 && echo "ui OK"
```

---

## Post-Cutover Verification

After a successful cutover, run all checks below.

### 1) Backend health

```bash
curl -sS -o /dev/null http://127.0.0.1:47287 && echo "backend reachable"
```

### 2) UI loads

```bash
curl -sS -o /dev/null http://127.0.0.1:47289 && echo "ui reachable"
```

### 3) Managers have profiles (boot reconciliation)

```bash
node - <<'NODE'
const fs = require('fs');
const path = `${process.env.HOME}/.middleman/agents.json`;
const data = JSON.parse(fs.readFileSync(path, 'utf8'));
const managers = (data.agents || []).filter((a) => a.role === 'manager');
let ok = true;
for (const m of managers) {
  const profile = typeof m.profileId === 'string' && m.profileId.length > 0 ? m.profileId : '<missing>';
  console.log(`${m.agentId}\tprofileId=${profile}`);
  if (profile === '<missing>') ok = false;
}
if (!ok) process.exit(1);
NODE
```

Expected: every manager has a non-empty `profileId`.

### 4) Sessions visible in sidebar

Manual UI check:

1. Open the live UI.
2. Confirm the session sidebar renders.
3. Confirm existing sessions appear.
4. Create a new session and ensure it appears immediately.

### 5) Existing conversation history preserved

File-level sanity check:

```bash
echo "Backup session files: $(find "$BACKUP/sessions" -type f | wc -l | tr -d ' ')"
echo "Live session files:   $(find "$LIVE_DATA/sessions" -type f | wc -l | tr -d ' ')"
```

Manual check:

- Open at least one pre-existing conversation in the UI.
- Confirm historical messages are present.

---

## What Changed (for reference)

The merge brings in:

- **Phase 1:** Session/profile data model + boot reconciliation.
- **Phase 2:** Session lifecycle commands (create, stop, resume, delete, rename, fork).
- **Phase 3:** Session-scoped memory with deferred merge.
- **Phase 4:** Protocol + WebSocket session commands/events/routes.
- **Phase 5:** Frontend session UX (sidebar, routing, WS client behavior).
- Follow-up fixes for:
  - terminated-agent subscribe loop
  - forked sessions loading history after boot
  - dynamic default agent on reload
  - session collapse behavior
  - test rebuild script hardcoding correct WS URL

Primary user-facing change: **multiple concurrent sessions per manager with session-aware UI and runtime behavior**.
