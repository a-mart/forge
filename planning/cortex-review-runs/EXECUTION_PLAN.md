# Cortex Review Runs — Execution Plan

## Goals
- Launch Cortex reviews into fresh backing sessions instead of whichever Cortex chat is currently active.
- Make manual and scheduled review triggers converge on the same backend review-run path.
- Make review activity visible in the existing Cortex Review UI with recent-run history and session links.
- Reduce sidebar clutter from backing review sessions.

## Implemented Shape

### V1
- Added a first-class Cortex review-run start endpoint: `POST /api/cortex/review-runs`
- Added review-run listing endpoint: `GET /api/cortex/review-runs`
- Added durable review-run ledger: `shared/knowledge/.cortex-review-runs.json`
- Manual Review actions now create fresh Cortex review sessions under the hood.
- Existing scheduled/root review prompts are intercepted and re-routed into fresh review-run sessions.
- Cortex Review UI now shows recent runs, trigger source, status, closeout preview, and direct session links.

### V2
- Added explicit session metadata for hidden backing review sessions: `sessionPurpose: "cortex_review"`
- Cortex sidebar hides review-run sessions by default and points users back to the Cortex Review surface.
- Selected review-run sessions remain reachable/openable from the Review tab.

## Design Notes
- This is intentionally low-churn: existing generic schedule infrastructure stays in place, while review-like scheduled messages are re-routed through the new review-run path.
- Review-run lifecycle state is lightweight: durable metadata is stored, while live status is derived from the backing session state and worker activity.
- Review-run sessions are support artifacts; the primary UX is the Review tab, not the session list.

## Validation Plan
- Backend typecheck
- UI typecheck
- Targeted backend tests for manager flow, route coverage, data-path/versioning exclusions
- Targeted UI tests for Review tab launch behavior
- Independent code review after implementation
