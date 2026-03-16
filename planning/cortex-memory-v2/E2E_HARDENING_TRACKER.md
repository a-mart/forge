# Cortex Memory v2 — E2E Hardening Tracker

**Last updated:** 2026-03-16

## Objective
Harden the end-to-end Cortex Memory v2 flow toward reliable, low-noise, high-signal outputs by improving extraction usefulness, precision, closeout quality, noise discipline, and user-facing "magical-feeling" continuity.

## Active lanes

| Lane | Focus | Status | Owner |
|---|---|---|---|
| **Lane 1 — Usefulness** | Validate durable signal quality across copied/fresh sessions and identify reusable operational learnings | `ACTIVE` | Programmatic + worker extraction review |
| **Lane 2 — Precision** | Reduce false positives and stale-signal assertions in scan/review outputs | `ACTIVE` | Runtime + data-trace validation |
| **Lane 3 — Closeout quality** | Clean merge/learned output completion, final writes, and follow-up traceability | `ACTIVE` | Synthesis + manager-level closeout pass |
| **Lane 4 — Low noise** | Prevent over-promotion and keep injected memory tight and actionable | `ACTIVE` | Promotion/rubric audit |
| **Lane 5 — Magical-feeling output** | Improve perceived reliability of user-facing behavior (chat/reconnect/history flow) | `ACTIVE` | UX/runtime smoke + auth/path hardening |

## Target qualities to improve

1. **Usefulness** — extracted outputs should retain high-value, reusable conclusions with minimal context budget.
2. **Precision** — findings should reflect actual deltas/behavior, not stale bytes or inferred assumptions.
3. **Closeout quality** — prompted outputs should end with unambiguous completion + clean artifact/writeback state.
4. **Low noise** — avoid over-generalization, over-promotion, and one-off/local-only decisions.
5. **Magical-feeling output** — UX should appear smooth and reliable (fresh chat, reconnect, history load, scan/readiness continuity).

## Scoreboard (what each lane found)

| Lane | Last 24h findings | Score | Action next |
|---|---|---:|---|
| Lane 1 — Usefulness | Durable useful findings in copied-instance historical review; no major signal-bloat regressions | **8/10** | Keep current bounded extraction + synthesis gate; add one more copied-instance re-run for confirmation |
| Lane 2 — Precision | Confirmed one core hardening win: scan now prefers live file sizes over stale meta bytes; one legacy/meta corner remains test-verified only | **9/10** | Add explicit runtime proof for any remaining precision exceptions |
| Lane 3 — Closeout quality | Remaining rough edge: manager-level closeout/promotion polish still not fully clean in all historical-review flows | **5/10** | Prioritize callback completion clarity and deterministic closeout artifacts |
| Lane 4 — Low noise | Reduced scope drift by moving one-off/process details to narrower contexts; occasional residual global-noise risk remains | **7/10** | Continue per-lane dedupe with stricter global/profile split checks |
| Lane 5 — Magical-feeling output | Core UX paths are passing (history render, reconnect, fresh/migrated chat), but auth-state drift can still appear as a product-like failure in isolated runs | **6/10** | Add clearer auth-status messaging + isolated auth-repair guidance in docs/runtime helpers |

## Notes
- This is a **supplemental coordination artifact only**. It does not overwrite existing package docs.
- No production-side writes were performed as part of this tracker update.