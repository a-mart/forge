# Cortex Memory v2 — E2E Fresh Runtime (Isolated)

Date: 2026-03-15
Tester: `cortex-memv2-e2e-fresh-runtime`
Worktree: `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`
Fresh data dir: `/Users/adam/.middleman-cortex-memory-v2-fresh`
Target ports: backend `47487`, UI `47489`

## Final status
**Blocked**: live model auth in fresh runtime did not produce assistant responses; runtime returns provider auth/key errors (`openai-codex` missing key; `anthropic` missing/expired auth).

---

## 1) Preflight isolation + port checks
Exact commands:

```bash
pwd && ls -la
lsof -nP -iTCP:47487 -sTCP:LISTEN || true
lsof -nP -iTCP:47489 -sTCP:LISTEN || true
```

Result:
- Correct cwd confirmed at worktree root.
- Both ports free before start.

---

## 2) Fresh data dir reset
Exact commands:

```bash
FRESH_DIR="/Users/adam/.middleman-cortex-memory-v2-fresh"
rm -rf "$FRESH_DIR"
mkdir -p "$FRESH_DIR"
ls -la "$FRESH_DIR"
```

Result:
- Fresh dir recreated empty.

---

## 3) Build (explicit)
Exact commands:

```bash
export VITE_MIDDLEMAN_WS_URL="ws://127.0.0.1:47487"
pnpm --filter @middleman/protocol build
pnpm --filter @middleman/backend build
pnpm --filter @middleman/ui build
```

Result:
- Builds succeeded.

---

## 4) Start backend + UI non-blocking with pid/log files under `.tmp/`
Exact commands:

```bash
BACKEND_LOG=.tmp/e2e-fresh-backend.log
BACKEND_PID_FILE=.tmp/e2e-fresh-backend.pid
UI_LOG=.tmp/e2e-fresh-ui.log
UI_PID_FILE=.tmp/e2e-fresh-ui.pid
: > "$BACKEND_LOG"
: > "$UI_LOG"

MIDDLEMAN_HOST=127.0.0.1 MIDDLEMAN_PORT=47487 MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-fresh NODE_ENV=production \
  pnpm --filter @middleman/backend start >>"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
echo "$BACKEND_PID" > "$BACKEND_PID_FILE"

MIDDLEMAN_HOST=127.0.0.1 VITE_MIDDLEMAN_WS_URL=ws://127.0.0.1:47487 \
  pnpm --filter @middleman/ui exec vite preview --port 47489 --strictPort --host 127.0.0.1 >>"$UI_LOG" 2>&1 &
UI_PID=$!
echo "$UI_PID" > "$UI_PID_FILE"
```

Readiness checks used:

```bash
lsof -nP -iTCP:47487 -sTCP:LISTEN
lsof -nP -iTCP:47489 -sTCP:LISTEN
curl -sS http://127.0.0.1:47487/api/health
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:47489/
```

Result:
- Backend healthy (`/api/health` OK).
- UI preview responded `200`.

---

## 5) True E2E message flow (WS-driven) and runtime artifact checks
Automation script used:
- `.tmp/e2e-fresh-runtime-check.mjs`

Run commands:

```bash
node .tmp/e2e-fresh-runtime-check.mjs > .tmp/e2e-fresh-runtime-result-attempt1.json
node .tmp/e2e-fresh-runtime-check.mjs > .tmp/e2e-fresh-runtime-result-attempt2.json
node .tmp/e2e-fresh-runtime-check.mjs > .tmp/e2e-fresh-runtime-result-attempt3.json
```

Script behavior:
1. `GET /api/cortex/scan` baseline.
2. WS `subscribe`.
3. WS `create_manager` (new profile each run).
4. WS `create_session`.
5. WS `subscribe` to that new session.
6. WS `user_message` with real prompt text.
7. Wait for assistant response containing `FRESH_E2E_OK`.
8. Re-check `/api/cortex/scan` and filesystem assertions.

### Message round-trips observed
For each attempt:
- User message was successfully sent and persisted.
- System error message was returned in session conversation stream.
- **No assistant content reply** was returned within timeout.

Concrete session example:
- File: `/Users/adam/.middleman-cortex-memory-v2-fresh/profiles/fresh-e2e-498379/sessions/fresh-e2e-498379--s2/session.conversation.jsonl`
- Contains:
  - user message: `Fresh runtime E2E check...`
  - system message: `No API key found for anthropic...`

### Runtime auth failures seen
From backend logs:
- `No API key found for openai-codex`
- `No API key found for anthropic`
- `Authentication failed for "anthropic" ... Run '/login anthropic'`

Log files:
- `.tmp/e2e-fresh-backend.log`
- `.tmp/e2e-fresh-backend-attempt2.log`

---

## 6) Auth copy workaround usage (approved single-file copy only)
Performed exactly this one copy:

```bash
mkdir -p /Users/adam/.middleman-cortex-memory-v2-fresh/shared/auth
cp /Users/adam/.middleman/shared/auth/auth.json /Users/adam/.middleman-cortex-memory-v2-fresh/shared/auth/auth.json
```

No other files were copied from `~/.middleman`.

Post-copy check:

```bash
curl -sS http://127.0.0.1:47487/api/settings/auth
```

Result:
- Providers reported as configured, but model calls still failed with missing/expired credentials in runtime.

---

## 7) Cortex-processing surface checks
Command:

```bash
curl -sS http://127.0.0.1:47487/api/cortex/scan > .tmp/e2e-fresh-scan-final.json
```

Observed (for fresh-created profiles `fresh-e2e-180669`, `fresh-e2e-342520`, `fresh-e2e-498379`):
- `files.profileMemory[profileId]` exists: **true**
- `files.profileReference[profileId]` exists: **true**
- `files.profileKnowledge[profileId]` exists: **false**
- Legacy profile knowledge file absent on disk:
  - `/Users/adam/.middleman-cortex-memory-v2-fresh/shared/knowledge/profiles/<profileId>.md` not present

Interpretation:
- v2 surfaces (`profileMemory` + `profileReference`) are present and updating for new profiles.
- Legacy per-profile knowledge dependency is absent for net-new profiles.
- Drift/reporting state currently all zeros (no transcript-byte stats surfaced yet in this blocked run path).

---

## 8) Artifacts produced
- `.tmp/e2e-fresh-runtime-check.mjs`
- `.tmp/e2e-fresh-runtime-result-attempt1.json`
- `.tmp/e2e-fresh-runtime-result-attempt2.json`
- `.tmp/e2e-fresh-runtime-result-attempt3.json`
- `.tmp/e2e-fresh-scan-final.json`
- `.tmp/e2e-fresh-backend.log`
- `.tmp/e2e-fresh-backend-attempt2.log`
- `.tmp/e2e-fresh-ui.log`
- `.tmp/e2e-fresh-ui-attempt2.log`

---

## 9) Process cleanup (only processes started here)
Commands to stop:

```bash
kill "$(cat .tmp/e2e-fresh-backend.pid)" 2>/dev/null || true
kill "$(cat .tmp/e2e-fresh-ui.pid)" 2>/dev/null || true
```

Validation:

```bash
lsof -nP -iTCP:47487 -sTCP:LISTEN || true
lsof -nP -iTCP:47489 -sTCP:LISTEN || true
```

---

## Addendum — 2026-03-15 targeted bounded rerun (pi-codex only)

Scope: exactly one fresh E2E dispatch experiment to isolate whether failures were caused by anthropic-forced harnessing.

### Exact commands executed

```bash
# 1) Ensure prior listeners are stopped (from earlier runs)
kill 90795 90766 2>/dev/null || true

# 2) Start isolated fresh backend (non-blocking, short command, pid/log under .tmp)
BACKEND_LOG=.tmp/e2e-fresh-rerun-backend.log
BACKEND_PID_FILE=.tmp/e2e-fresh-rerun-backend.pid
: > "$BACKEND_LOG"
MIDDLEMAN_HOST=127.0.0.1 MIDDLEMAN_PORT=47487 MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-fresh NODE_ENV=production pnpm --filter @middleman/backend start >>"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
echo "$BACKEND_PID" > "$BACKEND_PID_FILE"

# 3) Short health check poll
for i in 1 2 3 4 5 6 7 8; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:47487/api/health || true)
  if [ "$code" = "200" ]; then echo "healthy"; exit 0; fi
  sleep 1
done

# 4) Single decisive WS E2E run (pi-codex model)
node .tmp/e2e-fresh-runtime-rerun-pi-codex.mjs > .tmp/e2e-fresh-rerun-pi-codex-result.json

# 5) Cleanup
kill "$(cat .tmp/e2e-fresh-rerun-backend.pid)" 2>/dev/null || true
lsof -nP -iTCP:47487 -sTCP:LISTEN || true
```

### Exact model used
- `pi-codex`

### Exact user message sent
- `RERUN_PI_CODEX_FRESH_E2E: reply with EXACT token PI_CODEX_FRESH_OK`

### Result
- **Failed** (no assistant dispatch success token).
- Single-run output (`.tmp/e2e-fresh-rerun-pi-codex-result.json`) captured:
  - `ok: false`
  - `managerId: fresh-pi-codex-rerun-593517`
  - `sessionAgentId: fresh-pi-codex-rerun-593517--s2`

### Precise failure signature
- `system_message:⚠️ Agent error (attempt 2/2): No API key found for openai-codex. Use /login or set an API key environment variable ... Message may need to be resent.`

Interpretation for this rerun: dispatch still fails in fresh lane even when the harness explicitly uses `pi-codex` (i.e., not anthropic-forced).

### Cleanup status
- Backend process started for this rerun was terminated.
- Port `47487` no longer had a LISTEN process after cleanup.

---

## Addendum — 2026-03-15 late-night bounded fresh dispatch check (unique port 47687)

Scope: one compact two-step live-dispatch check to tighten blocker explanation. No production writes. Only isolated fresh dir + worktree were used.

### Exact commands executed

```bash
PORT=47687
FRESH_DIR=/Users/adam/.middleman-cortex-memory-v2-fresh
BACKEND_LOG=.tmp/e2e-fresh-bounded-backend-47687.log
BACKEND_PID_FILE=.tmp/e2e-fresh-bounded-backend-47687.pid

# Start clean auth state in fresh dir
mkdir -p "$FRESH_DIR/shared/auth"
rm -f "$FRESH_DIR/shared/auth/auth.json"

# Start backend on unique port
: > "$BACKEND_LOG"
MIDDLEMAN_HOST=127.0.0.1 MIDDLEMAN_PORT=${PORT} MIDDLEMAN_DATA_DIR="$FRESH_DIR" NODE_ENV=production pnpm --filter @middleman/backend start >>"$BACKEND_LOG" 2>&1 &
PID=$!
echo "$PID" > "$BACKEND_PID_FILE"

# Baseline run (no auth file)
WS_URL=ws://127.0.0.1:${PORT} MODEL=pi-codex node .tmp/e2e-fresh-live-dispatch-bounded.mjs > .tmp/e2e-fresh-bounded-noauth-result.json || true

# Single-file auth copy from production -> fresh, then rerun once
cp /Users/adam/.middleman/shared/auth/auth.json "$FRESH_DIR/shared/auth/auth.json"
WS_URL=ws://127.0.0.1:${PORT} MODEL=pi-codex node .tmp/e2e-fresh-live-dispatch-bounded.mjs > .tmp/e2e-fresh-bounded-copiedauth-result.json || true

# Cleanup
kill "$(cat "$BACKEND_PID_FILE")" 2>/dev/null || true
lsof -nP -iTCP:${PORT} -sTCP:LISTEN || true
```

### Result summary

Both runs failed with the same signature and no assistant token:
- `.tmp/e2e-fresh-bounded-noauth-result.json`
- `.tmp/e2e-fresh-bounded-copiedauth-result.json`

Common failure text:
- `No API key found for openai-codex ... Message may need to be resent.`

Backend corroboration:
- `.tmp/e2e-fresh-bounded-backend-47687.log` shows manager bootstrap and session dispatch both failing at `prompt_dispatch` with `openai-codex` key/auth failure.

### Auth state observed after copy

Fresh auth file now contains expired OAuth timestamps:
- `anthropic`: `1772570616258` (`2026-03-03T20:43:36.258Z`)
- `openai-codex`: `1773083312768` (`2026-03-09T19:08:32.768Z`)

Interpretation: copying production auth into fresh cannot unlock dispatch right now because source credentials are already stale/expired.

### Tightened blocker statement

Fresh live dispatch is currently blocked by credential validity, not by session/bootstrap/WS wiring:
- Manager + session creation succeeds.
- User messages persist.
- Dispatch fails immediately at model credential resolution (`openai-codex`) before assistant content can stream.

### Minimal next fix (bounded)

Run a fresh isolated re-auth for the active provider (`/login openai-codex`) in `~/.middleman-cortex-memory-v2-fresh`, then rerun **one** bounded script invocation (`.tmp/e2e-fresh-live-dispatch-bounded.mjs`) on a unique port to seek a real assistant token.
