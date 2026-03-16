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
| Lane 1 — Usefulness | Historical stress + postfix rerun kept finding narrow, reusable signal without major bloat regressions | **8/10** | Keep running mixed historical scenarios; watch for any weak/duplicative promotions in larger sessions |
| Lane 2 — Precision | Scan precision hardening is solid, closeout path reporting now normalizes to relative `profiles/...` paths, and queued-steer recovery no longer leaves a poisoned delivery at the head of the queue in focused tests | **9/10** | Keep stress-testing for any repeated `queuedDeliveryId` poisoning or path-format regressions |
| Lane 3 — Closeout quality | Postfix rerun is now clean end-to-end: all 3 scenarios emitted correct `speak_to_user` closeouts, and scenario 3 now reports relative changed-file paths | **9/10** | Keep validating across more historical shapes; watch for duplicate or stale closeouts |
| Lane 4 — Low noise | No-op discipline is much better after the latest hardening; narrow reference placement remains strong; `feature-manager` memory still warrants caution | **9/10** | Keep pressure on lean injected memory, especially for `feature-manager` |
| Lane 5 — Magical-feeling output | Fresh chat, reconnect, history load, and direct-review closeout now feel much more coherent; the latest postfix rerun removed the last obvious path-leak distraction | **9/10** | Push broader repeated scenario coverage instead of more closeout-path tweaking |

## Notes
- This is a **supplemental coordination artifact only**. It does not overwrite existing package docs.
- No production-side writes were performed as part of this tracker update.