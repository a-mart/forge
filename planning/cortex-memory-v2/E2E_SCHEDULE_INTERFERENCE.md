# E2E Schedule / Steer Interference Diagnosis

## Verdict
- **Primary cause:** Cortex closeout-reminder **self-steer race** on idle transition, not copied schedules by themselves.
- **Product severity:** real product-level sharp edge, because any immediate internal manager->self nudge sent at the wrong idle/turn boundary can collide with Codex steer delivery.
- **Current status:** **mitigated by the timer-based reminder deferral** in `apps/backend/src/swarm/swarm-manager.ts`, with an additional defensive queued-steer recovery fallback in `apps/backend/src/swarm/codex-agent-runtime.ts`.
- **Blocking status:** **does not need to block further hardening work** after these fixes, based on focused rerun validation.

## What the failing rerun showed before the fix
Earlier postfix reruns in `.tmp/e2e-cortex-postfix-rerun/result.json` timed out on all 3 scenarios and lost every final closeout. Backend logs showed:
- `runtime:error`
- `phase: 'steer_delivery'`
- `message: 'no active turn to steer'`
- repeated against agent `cortex`

That pattern means an internal follow-up message was being delivered as a queued steer exactly as the active turn was ending.

## Why copied schedules were probably not the main cause
Focused inspection of the copied scratch data showed:
- `profiles/cortex/schedules/schedules.json` was empty.
- The only overdue copied schedule found in the scratch env was under `profiles/mobile-app/schedules/schedules.json`.
- So the scratch env did contain copied schedules, but **not a Cortex schedule payload that cleanly explains the repeated Cortex steer failures**.

That made "schedule contamination only" an incomplete explanation.

## Most likely trigger
The better fit was the Cortex closeout-reminder path:
- direct/on-demand review finishes,
- Cortex transitions to idle,
- manager immediately sends itself the `CORTEX_USER_CLOSEOUT_REMINDER_MESSAGE`,
- Codex runtime still has a just-ending turn boundary,
- self-message gets accepted as steer,
- runtime hits `no active turn to steer`,
- closeout path stalls/poisons the run.

This matches the symptom pattern much better than the copied schedules theory:
- all final closeouts disappeared,
- failures clustered right at scenario completion windows,
- the issue specifically involved Cortex self-steer behavior.

## Fix validated
Latest worktree state changed the closeout reminder to schedule **250ms after idle** instead of sending immediately:
- `apps/backend/src/swarm/swarm-manager.ts`
  - `scheduleCortexCloseoutReminder()`
  - `clearCortexCloseoutReminder()`
  - delayed `maybeRemindCortexCloseout()` call

## Validation run
Validated with the postfix rerun harness:
- command: `node .tmp/e2e-cortex-postfix-rerun.mjs`
- result: **all 3 scenarios completed successfully**
- durations: ~13–18s each instead of timing out at 300s
- final closeouts were restored via `speak_to_user`
- backend log grep found **no** `no active turn to steer` / `steer_delivery` runtime errors during the rerun

Also passed:
- `cd apps/backend && pnpm exec vitest run src/swarm/__tests__/cortex-closeout.test.ts`
- `cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit`
- `cd apps/ui && pnpm exec tsc --noEmit`

## Follow-up result
A later hardening pass cleaned up the remaining closeout-format issue too:
- Cortex user-visible `FILES:` reporting now normalizes absolute `.../profiles/...` paths to relative `profiles/...` paths.
- Latest postfix rerun evidence shows scenario `postfix-03-larger-history` closing with:
  - `profiles/feature-manager/reference/gotchas.md`
  - `profiles/feature-manager/sessions/playwright-test/meta.json`

That path-format fix is separate from the self-steer diagnosis, but it means this lane no longer has an outstanding user-visible sharp edge in the current rerun set.

## Recommended disposition
- Treat the timer-based closeout reminder deferral as the **main mitigation** for this lane.
- Treat the Codex queued-steer recovery fallback and path normalization as useful defensive follow-through, not the primary root-cause fix.
- Do **not** block additional hardening on a deeper Codex runtime change right now.
- Keep an eye on future `steer_delivery` / `no active turn to steer` logs, but only reopen runtime-level recovery work if the failure reappears after these fixes.
