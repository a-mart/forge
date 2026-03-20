# Review Run Resume Report

## Summary
Implemented startup reconciliation for interrupted Cortex review runs.

On boot, Forge now:
- scans persisted Cortex review-run ledger entries before the review queue check starts,
- detects runs that were still effectively running when the backend stopped,
- marks those old ledger entries as `interrupted`,
- appends a fresh queued review-run entry for the same request,
- logs a startup warning describing the interrupted/requeued runs.

## Key Changes

### Backend
- `apps/backend/src/swarm/swarm-manager.ts`
  - Added `reconcileInterruptedCortexReviewRunsForBoot()`.
  - Wired reconciliation into `boot()` before `scheduleCortexReviewRunQueueCheck(0)`.
  - Requeues interrupted runs as brand-new ledger entries instead of mutating/reusing the old queued item.
  - Emits a warning log when reconciliation occurs.

- `apps/backend/src/swarm/cortex-review-runs.ts`
  - Added persisted interruption metadata to stored review runs.
  - Exported and extended live status derivation so interrupted runs surface as `interrupted` instead of `completed`.

### Protocol / UI
- `packages/protocol/src/shared-types.ts`
  - Added `interrupted` to `CortexReviewRunStatus`.
  - Added optional `interruptedAt` and `interruptionReason` fields to `CortexReviewRunRecord`.

- `apps/ui/src/components/chat/cortex/ReviewStatusPanel.tsx`
  - Added badge/rendering support for interrupted runs.
  - Shows interruption reason in the recent-runs list.
  - Updated status sorting priorities to include the new status.

## Tests Added / Updated
- `apps/backend/src/swarm/__tests__/cortex-review-runs.test.ts`
  - Added coverage ensuring interrupted runs are not misclassified as completed.

- `apps/backend/src/test/swarm-manager.test.ts`
  - Added boot-time reconciliation test verifying:
    - interrupted run detection,
    - old entry marked `interrupted`,
    - fresh entry requeued and picked up by the queue processor,
    - startup warning logged.
  - Tightened restart reconstruction coverage so completed runs are not duplicated.

## Validation
Executed successfully:
- `cd apps/backend && pnpm exec vitest run`
- `cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit`
- `cd apps/ui && pnpm exec tsc --noEmit`
