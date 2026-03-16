# Cortex Memory v2 — Focused E2E Scan Delta Evidence (SCAN-02 / SCAN-03 / SCAN-04)

Date: 2026-03-15  
Worktree: `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`  
Isolated data dir: `/Users/adam/.middleman-cortex-memory-v2-migrate` (copied environment only; no writes to `~/.middleman`)  
Backend port: `47587`

## Scope
Goal: capture **real before/after `/api/cortex/scan` evidence** for:
- `SCAN-02` transcript delta drift
- `SCAN-03` memory delta drift
- `SCAN-04` feedback delta drift

All probes were run with tightly scoped file edits and immediate restore.

---

## 1) Backend startup in isolated env
Command:
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && (lsof -nP -iTCP:47587 -sTCP:LISTEN || true) && rm -f .tmp/e2e-scan-delta-backend.pid .tmp/e2e-scan-delta-backend.log && (MIDDLEMAN_DATA_DIR=/Users/adam/.middleman-cortex-memory-v2-migrate MIDDLEMAN_PORT=47587 pnpm --filter @middleman/backend dev > .tmp/e2e-scan-delta-backend.log 2>&1 & echo $! > .tmp/e2e-scan-delta-backend.pid) && echo "launcher pid $(cat .tmp/e2e-scan-delta-backend.pid)" && for i in {1..40}; do if curl -sf http://127.0.0.1:47587/api/health >/dev/null; then echo READY; break; fi; sleep 1; done && lsof -nP -iTCP:47587 -sTCP:LISTEN
```

Result: backend healthy on `http://127.0.0.1:47587`.

---

## 2) Bounded probe harness
Created script:
- `.tmp/e2e-scan-delta-probe.mjs`

Execution command:
```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && node .tmp/e2e-scan-delta-probe.mjs > .tmp/e2e-scan-delta-probe-output.json
```

The harness performs, per case:
1. Fetch **before** snapshot from `GET /api/cortex/scan`.
2. Apply one tightly scoped drift edit to one session (plus minimal `meta.json` size-field bump to mirror runtime accounting).
3. Fetch **after** snapshot.
4. Restore original files.
5. Fetch **restored** snapshot (sanity check).

Aggregate report:
- `.tmp/e2e-scan-delta-report.json`

Per-case snapshots:
- `.tmp/e2e-scan-delta-SCAN-02-transcript-delta-before.json`
- `.tmp/e2e-scan-delta-SCAN-02-transcript-delta-after.json`
- `.tmp/e2e-scan-delta-SCAN-02-transcript-delta-restored.json`
- `.tmp/e2e-scan-delta-SCAN-03-memory-delta-before.json`
- `.tmp/e2e-scan-delta-SCAN-03-memory-delta-after.json`
- `.tmp/e2e-scan-delta-SCAN-03-memory-delta-restored.json`
- `.tmp/e2e-scan-delta-SCAN-04-feedback-delta-before.json`
- `.tmp/e2e-scan-delta-SCAN-04-feedback-delta-after.json`
- `.tmp/e2e-scan-delta-SCAN-04-feedback-delta-restored.json`

---

## 3) Exact file edits applied during probes

### SCAN-02 (transcript delta)
Session: `feature-manager/agno-2-5-6-upgrade`
- Appended one JSONL line to:
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/feature-manager/sessions/agno-2-5-6-upgrade/session.jsonl`
- Updated:
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/feature-manager/sessions/agno-2-5-6-upgrade/meta.json`
  - field `stats.sessionFileSize += 165` (bytes appended)
  - field `updatedAt = <now>`

### SCAN-03 (memory delta)
Session: `feature-manager/channel-load-error`
- Appended one marker line to:
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/feature-manager/sessions/channel-load-error/memory.md`
- Updated:
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/feature-manager/sessions/channel-load-error/meta.json`
  - field `stats.memoryFileSize += 59` (bytes appended)
  - field `updatedAt = <now>`

### SCAN-04 (feedback delta)
Session: `middleman-project/auto-resume-stale-worker`
- Appended one JSONL feedback row to:
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/middleman-project/sessions/auto-resume-stale-worker/feedback.jsonl`
- Updated:
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/middleman-project/sessions/auto-resume-stale-worker/meta.json`
  - field `feedbackFileSize += 162` (bytes appended)
  - field `lastFeedbackAt = <now>`
  - field `updatedAt = <now>`

All edited files were restored to original contents immediately after each case.

---

## 4) Before/after results

Source of truth: `.tmp/e2e-scan-delta-report.json`

### SCAN-02 — transcript delta
- Before session: `deltaBytes: 0`, `status: up-to-date`
- After session: `deltaBytes: 165`, `status: needs-review`
- Summary movement:
  - `sessionsWithTranscriptDrift: 53 -> 54`
  - `needsReview: 55 -> 56`

### SCAN-03 — memory delta
- Before session: `memoryDeltaBytes: 0`, `status: up-to-date`
- After session: `memoryDeltaBytes: 59`, `status: needs-review`
- Summary movement:
  - `sessionsWithMemoryDrift: 4 -> 5`
  - `needsReview: 55 -> 56`

### SCAN-04 — feedback delta
- Before session: `feedbackDeltaBytes: 0`, `feedbackTimestampDrift: false`, `status: up-to-date`
- After session: `feedbackDeltaBytes: 162`, `feedbackTimestampDrift: true`, `status: needs-review`
- Summary movement:
  - `sessionsWithFeedbackDrift: 3 -> 4`
  - `needsReview: 55 -> 56`

Restored snapshots for all three cases returned the touched sessions to their original `up-to-date` values.

---

## 5) Pass/fail by delta type
- `SCAN-02` transcript delta: **PASS**
- `SCAN-03` memory delta: **PASS**
- `SCAN-04` feedback delta: **PASS**

No subcase was blocked or impractical in this isolated run.
