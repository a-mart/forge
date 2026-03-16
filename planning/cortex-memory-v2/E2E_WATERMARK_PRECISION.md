# Cortex Memory v2 — Watermark Precision Fix

**Date:** 2026-03-15/16 overnight  
**Worktree:** `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`

## Problem
Copied-env learning evaluation exposed a bookkeeping bug:
- Cortex could advance `cortexReviewedBytes` / `cortexReviewedFeedbackBytes` beyond the actual current file sizes.
- Result: scan rows could end up with negative deltas while still showing `needs-review`.

The semantic review decision could be correct, but scan freshness bookkeeping became imprecise.

## Root cause
`apps/backend/src/swarm/scripts/cortex-scan.ts` trusted stale byte-size values from `meta.json`:
- `stats.sessionFileSize`
- `stats.memoryFileSize`
- `feedbackFileSize`

If those fields drifted from the real on-disk file sizes, scan math used the stale metadata instead of the actual files.

## Low-churn fix implemented
Updated `scanCortexReviewStatus` to prefer actual on-disk file sizes when the files exist:
- `session.jsonl`
- `memory.md`
- `feedback.jsonl`

Implementation details:
- added `stat` import from `node:fs/promises`
- introduced `readExistingFileSize(filePath)` helper
- scan now uses actual file sizes first, then falls back to meta byte fields only when the file is missing

Touched files:
- `apps/backend/src/swarm/scripts/cortex-scan.ts`
- `apps/backend/src/test/cortex-scan.test.ts`

## Test coverage added
New test proves scan prefers real file sizes over stale meta byte fields and reports:
- `totalBytes` from actual `session.jsonl`
- `memoryTotalBytes` from actual `memory.md`
- `feedbackTotalBytes` from actual `feedback.jsonl`
- zero deltas / `up-to-date` when reviewed bytes match actual file sizes

## Validation
Executed:
- `cd apps/backend && pnpm exec vitest run src/test/cortex-scan.test.ts`
- `cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit`
- `cd apps/ui && pnpm exec tsc --noEmit`

Result:
- focused cortex-scan test: **pass**
- backend typecheck: **pass**
- UI typecheck: **pass**

## Why this is the right fix
- no redesign
- no migration requirement
- no production-data rewrite
- fixes the scan surface where the user-visible bookkeeping error actually appeared
- keeps meta byte fields as fallback only, which preserves compatibility for missing files / old data

## Net effect
This should eliminate the specific class of “reviewed bytes overshot actual file size” anomalies seen during copied-env Cortex learning evaluation while keeping the implementation elegant and low-churn.
