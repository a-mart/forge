# Cortex Memory v2 — Decisions

## Locked Decisions
- Option A is the target architecture.
- Rollout should be low-churn first, but the end-state should still be complete.
- Work must happen in a separate worktree with zero production-environment risk.
- Testing must cover both:
  - migration from a copied existing `.middleman` dir
  - net-new empty-data boot
- Primary implementation model: GPT-5.4 high.
- Review models: Codex 5.3 high + Opus 4.6 high.
- E2E validation should use separate medium-reasoning workers.
- Cortex should maintain explicit project status/task artifacts to survive compaction.
- Cortex messages to the user should stay concise; detailed reasoning goes in markdown files.

## Working Implementation Order
1. Session-memory freshness/review bookkeeping
2. Reference-doc migration plumbing
3. Root-session memory separation
4. Merge/promotion hardening
5. Remaining metadata/audit hardening
