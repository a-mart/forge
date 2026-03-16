# Cortex Memory v2 — Copied-Production E2E Runtime Validation

Date: 2026-03-15
Worktree: `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`
Copied data dir used: `/Users/adam/.middleman-cortex-memory-v2-migrate`
Backend/UI ports used: `47387` / `47389`

## 1) Port ownership pre-check (before start)
Exact command:
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && mkdir -p .tmp planning/cortex-memory-v2 && (lsof -nP -iTCP:47387 -sTCP:LISTEN || true) && (lsof -nP -iTCP:47389 -sTCP:LISTEN || true)
```
Result:
- No listeners returned for either port (only `lsof` smbfs warning noise).

## 2) Start backend + UI in non-blocking mode with pid/log files
Exact command:
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && rm -f .tmp/e2e-backend.pid .tmp/e2e-ui.pid .tmp/e2e-backend.log .tmp/e2e-ui.log && (MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-migrate MIDDLEMAN_PORT=47387 pnpm --filter @middleman/backend dev > .tmp/e2e-backend.log 2>&1 & echo $! > .tmp/e2e-backend.pid) && (VITE_MIDDLEMAN_WS_URL=ws://127.0.0.1:47387 pnpm --filter @middleman/ui exec vite dev --port 47389 --strictPort > .tmp/e2e-ui.log 2>&1 & echo $! > .tmp/e2e-ui.pid) && echo "started backend pid $(cat .tmp/e2e-backend.pid), ui pid $(cat .tmp/e2e-ui.pid)"
```
Initial shell PIDs recorded:
- backend launcher pid: `89978`
- ui launcher pid: `89980`

Readiness + listener verification command:
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && for i in {1..30}; do if curl -sf http://127.0.0.1:47387/api/health >/dev/null; then echo "backend ready"; break; fi; sleep 1; done; for i in {1..30}; do if curl -sf http://127.0.0.1:47389 >/dev/null; then echo "ui ready"; break; fi; sleep 1; done; lsof -nP -iTCP:47387 -sTCP:LISTEN; lsof -nP -iTCP:47389 -sTCP:LISTEN
```
Result:
- `backend ready`
- `ui ready`
- Listener on 47387: `node` pid `90026`
- Listener on 47389: `node` pid `89985`

## 3) End-to-end runtime message round-trip (real WS user message)
I created and executed a purpose-built runtime E2E script:
- Script: `.tmp/e2e-migrate-runtime-check.mjs`
- Result file: `.tmp/e2e-migrate-runtime-result.json`

Execution command:
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && node .tmp/e2e-migrate-runtime-check.mjs > .tmp/e2e-migrate-runtime-result.json
```

### WS flow performed by the script
1. Connect to `ws://127.0.0.1:47387`.
2. `subscribe` bootstrap.
3. Wait for `agents_snapshot` and `profiles_snapshot`.
4. `create_session` on copied-production profile (first successful run used profile `cortex`).
5. Subscribe to the new session agent.
6. Send real `user_message`:
   - `Runtime E2E check: reply with token E2E_MIGRATE_RUNTIME_OK and one short sentence confirming response path.`
7. Wait for assistant `conversation_message`.

### Message round-trip result (successful)
From `.tmp/e2e-migrate-runtime-result.json`:
- `targetProfileId`: `cortex`
- `sessionAgentId`: `cortex--s4`
- assistant role/source: `assistant` / `speak_to_user`
- assistant text:
  - `E2E_MIGRATE_RUNTIME_OK Response delivered via Cortex speak_to_user on the web path.`
- Agent status stream captured (`idle -> streaming`) confirming live runtime processing.

## 4) Cortex processing surfaces check

### `/api/cortex/scan` availability + drift/reporting
Commands:
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && curl -s http://127.0.0.1:47387/api/health > .tmp/e2e-health.json && node -e "fetch('http://127.0.0.1:47387/api/cortex/scan').then(r=>r.json()).then(j=>{const out={summary:j.scan.summary,profileMemory:j.files.profileMemory,profileReference:j.files.profileReference};console.log(JSON.stringify(out,null,2));}).catch(e=>{console.error(e);process.exit(1)})" > .tmp/e2e-scan-snapshot.json
```

Observed from scan payloads (pre/post in `.tmp/e2e-migrate-runtime-result.json`):
- Endpoint responds successfully.
- Scan summary includes full drift metrics (`needsReview`, `upToDate`, transcript/memory/feedback totals, sessionsWith*Drift, attentionBytes).
- Pre/post summaries remained unchanged across this chat-only runtime message (expected).

### `profileMemory` / `profileReference` surfaces
Observed from scan (`.tmp/e2e-scan-snapshot.json`):
- `files.profileMemory` populated for copied-production managed profiles (`amd-migration`, `feature-manager`, `middleman-project`, `ortho-invoice`).
- `files.profileReference` populated for the same profile set.
- Note: `cortex` exists as a runtime profile/session in WS snapshots, but was not present in this scan file map in this copied dataset snapshot.

## 5) Additional attempted profile round-trip + blocker evidence
I attempted a second runtime round-trip targeting a scan-tracked profile (moved to `middleman-project`) to pair chat flow with scan-tracked profile files.

Result:
- WS assistant response timed out in script.
- Backend log shows root cause during prompt dispatch for `middleman-project--s6`:
  - `Authentication failed for "anthropic". Credentials may have expired or network is unavailable. Run '/login anthropic' to re-authenticate.`
- Evidence location: `.tmp/e2e-backend.log`

## 6) Artifacts generated
- `.tmp/e2e-backend.log`
- `.tmp/e2e-ui.log`
- `.tmp/e2e-backend.pid`
- `.tmp/e2e-ui.pid`
- `.tmp/e2e-migrate-runtime-check.mjs`
- `.tmp/e2e-migrate-runtime-result.json`
- `.tmp/e2e-health.json`
- `.tmp/e2e-scan-snapshot.json`
- `planning/cortex-memory-v2/E2E_MIGRATE_RUNTIME.md` (this report)

## 7) Addendum — targeted bounded rerun (copied-production, non-Cortex, codex/default)
Date: 2026-03-15
Worktree: `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`
Copied data dir: `/Users/adam/.middleman-cortex-memory-v2-migrate`
Ports used: backend `47487` (WS only for this rerun)

### Start backend (non-blocking, short-timeout harness, pid/log in `.tmp/`)
Exact command:
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && mkdir -p .tmp && (lsof -nP -iTCP:47487 -sTCP:LISTEN || true) && rm -f .tmp/e2e-rerun-backend.pid .tmp/e2e-rerun-backend.log && (MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-migrate MIDDLEMAN_PORT=47487 pnpm --filter @middleman/backend dev > .tmp/e2e-rerun-backend.log 2>&1 & echo $! > .tmp/e2e-rerun-backend.pid) && echo "launcher pid $(cat .tmp/e2e-rerun-backend.pid)" && for i in {1..25}; do if curl -sf http://127.0.0.1:47487/api/health >/dev/null; then echo READY; break; fi; sleep 1; done && lsof -nP -iTCP:47487 -sTCP:LISTEN
```

### Single decisive copied-production E2E experiment
Representative non-Cortex target path:
- profile: `ortho-invoice`
- session/agent: `ortho-invoice`

Script:
- `.tmp/e2e-migrate-runtime-rerun-ortho-codex-default.mjs`

Execution command:
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && node .tmp/e2e-migrate-runtime-rerun-ortho-codex-default.mjs > .tmp/e2e-migrate-runtime-rerun-ortho-codex-default-result.json
```

Exact model used:
- preset: `codex-app`
- resolved provider/model: `openai-codex-app-server/default`

Exact message sent:
- `COPIED_PROD_RERUN_CODEX_DEFAULT: reply exactly RERUN_CODEX_DEFAULT_OK`

Result:
- success (`assistant_response_received`)
- assistant reply: `RERUN_CODEX_DEFAULT_OK`
- source: `speak_to_user`
- artifact: `.tmp/e2e-migrate-runtime-rerun-ortho-codex-default-result.json`

Conclusion from this rerun:
- WS/runtime plumbing in copied-production is functioning on a non-Cortex profile/session when forced to codex/default.
- This is consistent with the prior `middleman-project` failure being provider-specific Anthropic auth invalidity, not a generalized WS/runtime transport failure.

### Cleanup
Exact command:
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && if [ -f .tmp/e2e-rerun-backend.pid ]; then kill $(cat .tmp/e2e-rerun-backend.pid) 2>/dev/null || true; fi; sleep 1; pkill -f "MIDDLEMAN_PORT=47487" 2>/dev/null || true; lsof -nP -iTCP:47487 -sTCP:LISTEN || true; rm -f .tmp/e2e-rerun-backend.pid
```

## 8) Comprehensive copied-production matrix rerun (bounded, March 15 night)
Date: 2026-03-15/16

### Primary matrix command (single-runner, backend lifecycle inside script)
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && node .tmp/e2e-migrate-v2-runner.mjs > .tmp/e2e-migrate-v2-runner-result.json
```

Artifacts:
- `.tmp/e2e-migrate-v2-runner.mjs`
- `.tmp/e2e-migrate-v2-runner-result.json`
- `.tmp/e2e-migrate-v2-inline-backend.log`

### Supplementary transcript-drift confirmation (runtime-generated transcript delta)
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && node .tmp/e2e-migrate-v2-transcript-drift-runner.mjs > .tmp/e2e-migrate-v2-transcript-drift-result.json
```

Artifacts:
- `.tmp/e2e-migrate-v2-transcript-drift-runner.mjs`
- `.tmp/e2e-migrate-v2-transcript-drift-result.json`
- `.tmp/e2e-migrate-v2-transcript-backend.log`

### Additional scan snapshot extraction
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && (MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-migrate MIDDLEMAN_PORT=47587 pnpm --filter @middleman/backend exec tsx src/index.ts > .tmp/e2e-migrate-v2-scanonly-backend.log 2>&1 &) ; pid=$!; for i in {1..30}; do curl -sf http://127.0.0.1:47587/api/health >/dev/null && break; sleep 1; done; curl -s http://127.0.0.1:47587/api/cortex/scan > .tmp/e2e-migrate-v2-scan-post.json; kill $pid >/dev/null 2>&1 || true
```

Artifacts:
- `.tmp/e2e-migrate-v2-scan-post.json`
- `.tmp/e2e-migrate-v2-scanonly-backend.log`

### Observations by requested matrix area

1. **Real assistant response path**
   - PASS (real runtime response captured twice in this lane):
     - New manager created in copied-prod dir (`e2e-mv2-1773625008871`) returned assistant response via `speak_to_user`.
     - `middleman-project` root manager round-trip returned exact token (`E2E_TRANSCRIPT_1773625161880`).
   - Evidence:
     - `.tmp/e2e-migrate-v2-runner-result.json` → `checks.assistantRoundTrip`
     - `.tmp/e2e-migrate-v2-transcript-drift-result.json` → `roundTrip`

2. **`/api/cortex/scan` surfaces**
   - PASS for enriched file maps:
     - `files.profileMemory`, `files.profileReference`, `files.profileMergeAudit` populated.
     - `cortex` excluded from `profileMemory` map (`cortexPresentInProfileMemory: false`).
   - PASS for merge-audit exposure:
     - `ortho-invoice` and `feature-manager` merge-audit entries surfaced with `exists: true` + sizes.
   - Evidence:
     - `.tmp/e2e-migrate-v2-runner-result.json` → `checks.scanFilesSurface`

3. **Profile memory vs session memory ownership split**
   - PASS:
     - Distinct writable/readonly paths verified:
       - profile canonical: `profiles/ortho-invoice/memory.md`
       - root session writable: `profiles/ortho-invoice/sessions/ortho-invoice/memory.md`
       - sub-session writable: `profiles/ortho-invoice/sessions/e2e-mv2-sub-1773625033391/memory.md`
     - Session `meta.json` confirms both `memoryFile` and `profileMemoryFile` fields.
   - Evidence:
     - `.tmp/e2e-migrate-v2-runner-result.json` → `checks.ownershipPaths`
     - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/ortho-invoice/sessions/e2e-mv2-sub-1773625033391/meta.json`

4. **Reference-doc exposure**
   - PASS:
     - `files.profileReference` map populated for copied-prod profiles (including newly created e2e profiles).
   - Evidence:
     - `.tmp/e2e-migrate-v2-runner-result.json` → `checks.scanFilesSurface.profileReferenceKeys`

5. **Merge behavior + diagnostics (including fail-closed where observed)**
   - PASS: template no-op path emits expected merged status:
     - `status: skipped`, `strategy: template_noop`.
   - PASS: fail-closed diagnostics surfaced on LLM merge failure:
     - `session_memory_merge_failed` with `status: failed`, `strategy: llm`, `stage: llm`, `auditPath`.
     - Profile memory unchanged after failure (`profileMemoryContainsMarker: false`).
   - PASS: audit logs written with attempt/status/stage/hash details.
   - NOTE: attempted “expected auth-fail” scenario on `middleman-project` unexpectedly succeeded (`status: applied`), indicating Anthropic credentials were valid in this run.
   - Evidence:
     - `.tmp/e2e-migrate-v2-runner-result.json` → `checks.templateMerge`, `checks.appliedMerge`, `checks.failClosedMerge`
     - `.tmp/e2e-migrate-v2-ortho-merge-audit-tail.txt`
     - `.tmp/e2e-migrate-v2-middleman-merge-audit-tail.txt`

6. **Freshness/delta behavior**
   - PASS (runtime transcript drift):
     - `middleman-project` root session moved from `deltaBytes: 0` to `deltaBytes: 576` after runtime chat.
     - Summary reflected increased transcript totals and one additional transcript-drift session.
   - PASS (memory drift):
     - `middleman-enhancements` shows `memoryDeltaBytes: 68` after memory-file append.
   - PARTIAL (feedback drift):
     - Manual append to `feedback.jsonl` did not increase `feedbackTotalBytes`/`feedbackDeltaBytes` in scan.
     - Observed behavior suggests scan feedback counters depend on tracked session metadata/runtime ingestion path rather than raw file-byte appends.
   - Evidence:
     - `.tmp/e2e-migrate-v2-transcript-drift-result.json`
     - `.tmp/e2e-migrate-v2-scan-post.json` (session entry for `middleman-enhancements`)

### Concise synthesis block (append-only)
```md
[E2E_MIGRATE_RUNTIME_RESULT_BLOCK]
Lane: copied-production comprehensive rerun
When: 2026-03-15/16
Overall: PASS with one PARTIAL caveat

PASS:
- Real assistant runtime path confirmed (new e2e manager + middleman-project root round-trip).
- `/api/cortex/scan` exposes `profileMemory`, `profileReference`, `profileMergeAudit`; `cortex` excluded.
- Ownership split verified: profile canonical memory separated from root/sub-session writable memory.
- Reference-doc map exposure confirmed in scan payload.
- Merge telemetry confirmed:
  - template no-op (`template_noop`)
  - fail-closed diagnostics (`session_memory_merge_failed` with strategy/stage/auditPath)
  - audit JSONL entries persisted with hashes/status.
- Runtime transcript drift detection confirmed (`deltaBytes` increase on middleman-project root).
- Session memory drift detection confirmed (`memoryDeltaBytes` increase on middleman-enhancements).

PARTIAL / caveat:
- Feedback drift was not triggered by direct file append to `feedback.jsonl`; scan counters remained unchanged, implying metadata/runtime ingestion gating.

Artifacts:
- .tmp/e2e-migrate-v2-runner-result.json
- .tmp/e2e-migrate-v2-transcript-drift-result.json
- .tmp/e2e-migrate-v2-scan-post.json
- .tmp/e2e-migrate-v2-ortho-merge-audit-tail.txt
- .tmp/e2e-migrate-v2-middleman-merge-audit-tail.txt
[/E2E_MIGRATE_RUNTIME_RESULT_BLOCK]
```
