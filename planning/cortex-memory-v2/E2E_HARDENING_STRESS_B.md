# Cortex Memory v2 — Hardening Stress Lane B

**Date:** 2026-03-16  
**Worktree:** `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`

## Goal
Run a second copied-env stress pass with different scenario shapes and look specifically for:
- no-op discipline
- clean reference promotion
- backup noise
- completion-token / closeout reliability

Primary raw artifact:
- `.tmp/e2e-cortex-hardening-stress-b/result.json`

## Scenario set

### 1) `stress-b-01-noop-middleman-enhancements`
- Shape: no-op review
- Scope: `middleman-project/middleman-enhancements`
- Result: **mixed**

Observed behavior:
- harness timed out waiting for the requested `STRESS_B_DONE ...` completion token
- but there were real file changes:
  - `profiles/middleman-project/reference/gotchas.md`
  - `profiles/cortex/sessions/cortex/meta.json`

Judgment:
- This is not a clean no-op result.
- Cortex appears to have promoted at least one narrow gotcha/reference rule instead of remaining fully quiet.
- That may still be defensible semantically, but it misses the intended “no noise” standard for this scenario.
- More importantly, the completion contract was unreliable: the harness did not receive the requested final token.

### 2) `stress-b-02-reference-session-history`
- Shape: clean reference promotion expectation
- Scope: `middleman-project/session-history-visability`
- Result: **useful reference promotion, but still weak completion determinism**

Observed behavior:
- harness timed out waiting for the requested `STRESS_B_DONE ...` completion token
- but useful file changes happened:
  - `profiles/middleman-project/reference/index.md`
  - `profiles/middleman-project/reference/session-history-bootstrap.md`
  - `profiles/middleman-project/sessions/session-history-visability/meta.json`
- extra backup artifacts also appeared:
  - `profiles/middleman-project/reference/index.md.bak.stress-a-02`
  - `profiles/middleman-project/reference/index.md.bak.stress-b02`

Judgment:
- Promotion placement was directionally right: a focused topic doc in reference instead of injected memory.
- But the result still felt noisier than ideal because of extra backup-file churn.
- And again, the completion/reporting contract was not deterministic enough for a harness to trust.

## Main findings

### What looked good
1. **Reference placement instincts were still generally good**
   - Cortex continued to push narrow operational/history detail toward reference docs.

2. **The system did real work under pressure**
   - Even when the harness was unhappy, the underlying review flow still produced meaningful artifact-level changes.

### What still looked weak
1. **Completion determinism was not yet good enough in this lane**
   - Both scenarios timed out on the requested completion token.
   - This reinforces the earlier observation that the user-facing finish was the weakest part of the system.

2. **Backup noise was still too visible**
   - Extra `.bak` variants around `reference/index.md` made the resulting state feel less polished.

3. **No-op discipline was not fully trustworthy yet**
   - The no-op lane still promoted a reference entry, which suggests Cortex could still over-promote in edge cases.

## Scorecard
- **Usefulness:** 7/10
- **Precision:** 6/10
- **Closeout quality:** 4/10
- **Low noise:** 5/10
- **Magical-feeling output:** 4/10

## Bottom line
Stress lane B is the more adversarial read of the new Cortex:
- the underlying review/promotion logic is promising,
- reference placement is often reasonable,
- but completion reliability and backup-noise discipline were still not where they needed to be.

This lane is valuable because it justifies the later hardening work:
- stricter prompt discipline,
- stronger no-op bias,
- reduced backup churn,
- and the runtime closeout reminder.

In other words: stress B shows why the next hardening iteration was necessary.