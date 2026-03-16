# Cortex Memory v2 — Copied-Env Cortex Learning Evaluation

**Date:** 2026-03-15/16  
**Worktree:** `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`  
**Isolated copied data dir:** `/Users/adam/.middleman-cortex-memory-v2-migrate`  
**Production touched:** **No**

## Goal
Run more real Cortex review behavior against historical conversations in the copied isolated instance and judge what it actually learns and writes.

Primary evaluation lenses:
- **usefulness** — does the learned output help future work?
- **precision** — does Cortex write the right thing to the right place?
- **noise** — does it avoid promoting transient runbook junk?
- **magical vs bloated** — does the result feel like high-signal memory/reference curation or just more markdown?

## Runtime harness used
Exact command:

```bash
cd /Users/adam/repos/middleman-worktrees/cortex-memory-v2 && node .tmp/e2e-cortex-learning-eval-runner.mjs > .tmp/e2e-cortex-learning-eval-runner.stdout.json
```

Primary runtime artifacts:
- `.tmp/e2e-cortex-learning-eval/result.json`
- `.tmp/e2e-cortex-learning-eval/backend.log`
- `.tmp/e2e-cortex-learning-eval/eval-01-middleman-memory-delta/*`
- `.tmp/e2e-cortex-learning-eval/eval-02-middleman-transcript-delta/*`
- `.tmp/e2e-cortex-learning-eval/eval-03-feature-manager-history/*`

Cortex worker artifacts created during the run:
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/cortex/sessions/cortex/workers/eval01-mm-enh-*`
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/cortex/sessions/cortex/workers/eval02-playwright-dashboard-tx*`
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/cortex/sessions/cortex/workers/eval03-feature-playwright-test-tx*`
- `/tmp/eval01-middleman-enhancements-synthesis.md`
- `/tmp/eval02-playwright-dashboard-transcript.md`
- `/tmp/eval03-feature-playwright-test-transcript.md`

## Baseline before new review activity
### Profile output shape in copied env
- `profiles/middleman-project/memory.md` was relatively lean: **4,075 bytes / 38 lines**.
- `profiles/feature-manager/memory.md` was already very large: **31,975 bytes / 454 lines**.
- Both profiles had only minimal reference structure before this run:
  - `reference/index.md`
  - `reference/legacy-profile-knowledge.md`
- There were **no focused topic reference docs** yet under either profile.

### Immediate qualitative baseline
- `middleman-project` already felt closer to the intended v2 shape: concise injected memory + empty room for deeper pull-based docs.
- `feature-manager` still felt **bloated**: injected memory was carrying a lot of project runbook/process detail that should ideally migrate toward reference docs or be compressed.
- So this run was a good test of whether Cortex would:
  1. avoid adding more bloat to `feature-manager`, and
  2. create useful topic docs in reference when the signal was narrow.

---

## Scenario 1 — memory-only / low-signal delta
### Target
- Session: `middleman-project/middleman-enhancements`
- Exact watched files:
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/middleman-project/memory.md`
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/middleman-project/reference/index.md`
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/middleman-project/sessions/middleman-enhancements/meta.json`

### Before
From `.tmp/e2e-cortex-learning-eval/eval-01-middleman-memory-delta/before/scan.json`:
- transcript delta: `0`
- memory delta: `68`
- feedback delta: `0`
- status: `needs-review`

### What Cortex actually did
Cortex spawned a real multi-part review wave for transcript + memory + feedback + synthesis:
- `eval01-mm-enh-tx`
- `eval01-mm-enh-mem`
- `eval01-mm-enh-fb`
- `eval01-mm-enh-synth`

The synthesis artifact (`/tmp/eval01-middleman-enhancements-synthesis.md`) correctly concluded:
- **no durable findings**
- **no profile-memory update needed**
- **no reference-doc update needed**

That semantic judgment was good.

### After
Observed file changes:
- **Changed:** `profiles/middleman-project/sessions/middleman-enhancements/meta.json`
- **Unchanged:**
  - `profiles/middleman-project/memory.md`
  - `profiles/middleman-project/reference/index.md`
  - `profiles/middleman-project/reference/legacy-profile-knowledge.md`

Meta watermark deltas:
- `cortexReviewedAt`: `2026-03-13T02:20:35.915Z` -> `2026-03-16T02:03:45Z`
- `cortexReviewedBytes`: `8781933` -> `8782147`
- `cortexReviewedMemoryBytes`: `140` -> `208`
- `cortexReviewedMemoryAt`: `null` -> `2026-03-16T02:03:45Z`
- `cortexReviewedFeedbackBytes`: `371` -> `571`
- `cortexReviewedFeedbackAt`: `2026-03-08T03:30:12.983Z` -> `2026-03-16T02:03:45Z`

Resulting scan row after review:
- transcript delta: **`-214`**
- memory delta: `0`
- feedback delta: **`-200`**
- status: **still `needs-review`**

### Evaluation
**What worked:**
- Cortex correctly recognized that the new content was just E2E drift marker noise.
- It did **not** bloat memory or reference docs.

**What did not work:**
- Watermark advancement overshot real file sizes, leaving the session in a malformed “reviewed beyond current bytes” state.
- That means the semantic decision was precise, but the bookkeeping was not.

### Scenario 1 judgment
- **Usefulness:** low-to-medium
- **Precision:** mixed — good semantic precision, bad watermark precision
- **Noise:** low in promoted knowledge, high in bookkeeping side effects
- **Magical or bloated?** Not bloated in outputs, but not magical either because the review ended in a still-broken freshness state.

---

## Scenario 2 — transcript delta promoted cleanly into reference
### Target
- Session: `middleman-project/playwright-dashboard`
- Exact watched files:
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/middleman-project/memory.md`
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/middleman-project/reference/index.md`
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/middleman-project/sessions/playwright-dashboard/meta.json`

### Before
From `.tmp/e2e-cortex-learning-eval/eval-02-middleman-transcript-delta/before/scan.json`:
- transcript delta: `82,064`
- memory delta: `0`
- feedback delta: `0`
- status: `needs-review`

Reference state before review:
- `reference/index.md`
- `reference/legacy-profile-knowledge.md`
- **no** focused topic doc for Playwright dashboard behavior

### What Cortex actually did
Cortex spawned a transcript extraction worker:
- `eval02-playwright-dashboard-tx`

Worker artifact:
- `/tmp/eval02-playwright-dashboard-transcript.md`

The worker extracted a narrow set of **reference** findings, including:
- named persistent Playwright smoke sessions
- liveness verification pattern
- idle-worker recovery / watchdog nudge pattern
- explicit cleanup pattern
- concise milestone/status reporting

### After
Observed file changes:
- **Changed:** `profiles/middleman-project/reference/index.md`
- **Created:** `profiles/middleman-project/reference/index.md.bak`
- **Created:** `profiles/middleman-project/reference/playwright-dashboard.md`
- **Changed:** `profiles/middleman-project/sessions/playwright-dashboard/meta.json`
- **Unchanged:** `profiles/middleman-project/memory.md`

Meta watermark deltas:
- `cortexReviewedAt`: `2026-03-10T19:19:14Z` -> `2026-03-16T02:10:30Z`
- `cortexReviewedBytes`: `36599705` -> `36681769`

Resulting scan row after review:
- transcript delta: `0`
- status: `up-to-date`

New reference doc created:
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/middleman-project/reference/playwright-dashboard.md`

The created doc was concise (~1.5 KB) and stayed out of injected memory. It captured a real topic doc rather than appending more bullets into `memory.md`.

### Evaluation
**What worked:**
- This was the strongest “v2 shape” result of the run.
- Cortex chose the right storage tier: **reference**, not injected memory.
- It updated the index cleanly and snapped a `.bak` before editing.
- The resulting output felt bounded and understandable.

**What was still imperfect:**
- The new doc is helpful, but it is still somewhat **runbook-literal**. It includes exact commands and validation steps that are useful, yet not especially distilled.
- So it feels more like a good operational note than a truly “magical” abstraction.

### Scenario 2 judgment
- **Usefulness:** medium-to-high
- **Precision:** good
- **Noise:** low
- **Magical or bloated?** Closer to magical than bloated. This is the best example from the run of Cortex creating the right kind of file in the right place.

---

## Scenario 3 — medium historical session with useful findings, but stalled promotion
### Target
- Session: `feature-manager/playwright-test`
- Exact watched files:
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/feature-manager/memory.md`
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/feature-manager/reference/index.md`
  - `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/feature-manager/sessions/playwright-test/meta.json`

### Before
From `.tmp/e2e-cortex-learning-eval/eval-03-feature-manager-history/before/scan.json`:
- transcript delta: `720,238`
- reviewed bytes: `0`
- status: `never-reviewed`

Baseline profile state was already the most at risk for bloat:
- `profiles/feature-manager/memory.md` was **31,975 bytes / 454 lines**
- reference output was still minimal (`index.md` + legacy snapshot only)

### What Cortex actually did
Cortex attempted multiple extraction passes:
- `eval03-feature-playwright-test-tx`
- `eval03-feature-playwright-test-tx-r2`
- `eval03-feature-playwright-test-tx-r3`

Observed failure mode:
- Backend log recorded a context-guard trigger on the initial worker:
  - `agentId: eval03-feature-playwright-test-tx`
  - `contextTokens: 123367 / 128000`
  - handoff skipped at hard threshold

Despite that, retry worker `eval03-feature-playwright-test-tx-r2` eventually produced a useful artifact:
- `/tmp/eval03-feature-playwright-test-transcript.md`

That artifact contained real durable signals:
1. distinct `PLAYWRIGHT_CLI_SESSION` names per worker/lane to avoid cross-lane interference (**inject**)
2. `send_message_to_agent` `delivery:"default"` validation failure / omit delivery or use accepted modes (**inject**)
3. reliable worktree-based Playwright lane teardown sequence (**reference**)

So this was **not** a no-signal session.

### After
Observed file changes after the bounded evaluation window:
- **No changes** to watched profile memory/reference/meta files
- Session scan row remained unchanged:
  - transcript delta: `720,238`
  - status: `never-reviewed`

So the system successfully extracted useful knowledge at the worker layer, but it did **not** complete the promotion/write-back path within the scenario window.

### Evaluation
**What worked:**
- The retry lane recovered meaningful durable findings from a medium-sized historical session.
- The extracted findings were actually good: compact, actionable, and anti-bloat.

**What did not work:**
- Cortex did not turn those findings into durable profile/reference updates.
- No watermark advanced.
- No user-visible completion reply was emitted.

This is the clearest example from the run where the system had real signal in hand but failed to cash it out into learned state.

### Scenario 3 judgment
- **Usefulness:** potentially high, but unrealized
- **Precision:** good at extraction, poor at end-to-end completion
- **Noise:** medium, because retries/context-guard churn were needed before signal appeared
- **Magical or bloated?** Neither. It feels brittle: promising internals, incomplete outcome.

---

## Cross-scenario observations
### 1) The best v2 behavior is real, but inconsistent
Scenario 2 shows the intended shape clearly:
- narrow signal
- no injected-memory bloat
- focused reference doc
- clean scan/watermark closure

That path feels good.

### 2) The weakest part is not extraction quality — it is completion reliability
Across these runs, the biggest failures were:
- watermark overshoot / malformed review completion (scenario 1)
- stalled promotion despite useful extracted findings (scenario 3)
- **no user-facing completion message** in all three scenarios, even when work clearly happened

So the system is better at **finding** signal than at **closing the loop** cleanly.

### 3) Copied historical conversation processing still has a context-budget cliff
A 720 KB never-reviewed session was enough to trigger context-guard trouble in the first extraction attempt. Retry recovered some signal, but this still means copied historical backlog review is not yet smooth or predictably resilient.

### 4) Reference docs are the right place for narrow operational knowledge
The newly created `playwright-dashboard.md` is exactly the sort of thing that should live in reference instead of injected memory. That part of the design feels validated.

### 5) `feature-manager` still feels bloated before any new learning
This run did **not** worsen `feature-manager`, which is good. But it also highlighted that the profile starts from an already-heavy injected memory state, so the system still needs a stronger “compress / split to reference / keep only the meat” pass there.

---

## Practical verdict
### Usefulness
**Medium.** The system can produce genuinely helpful learned output, but not every successful extraction becomes durable knowledge.

### Precision
**Mixed.**
- semantic classification/placement was often solid
- bookkeeping/completion precision was weaker

### Noise
**Medium.** Promoted output stayed relatively clean in this run, but retry churn, watermark anomalies, and silent completions add operational noise.

### Magical vs bloated
**More promising than magical, and less bloated than before — but not yet elegant end-to-end.**

The strongest positive signal is this:
- Cortex can take a historical transcript delta and create a new, bounded topic reference doc without inflating injected memory.

The strongest negative signal is this:
- a medium historical session can yield useful findings and still fail to become learned state.

---

## Simple takeaways / low-churn fixes suggested by this run
1. **Clamp review watermarks to actual current file sizes before writing meta.**  
   Scenario 1 shows why: otherwise a no-op review can leave the session still needing review.

2. **Always emit a final user-facing completion message for on-demand Cortex review requests.**  
   The internal work happened, but the direct UX never closed the loop.

3. **Make retry/handoff on medium historical sessions more explicit and deterministic.**  
   Scenario 3 produced useful signal only after retry churn, then still failed to promote.

4. **Keep preferring reference docs for narrow operational learnings.**  
   Scenario 2 is the strongest proof that this is the right simplicity boundary.

## Bottom line
If the question is _“does Cortex Memory v2 in the copied instance sometimes learn something genuinely useful and place it better than before?”_ — **yes**.

If the question is _“does it already feel consistently magical, precise, and elegantly low-noise across real historical sessions?”_ — **not yet**.

Today it feels like:
- **good underlying curation instincts**
- **promising reference-doc behavior**
- **still-fragile completion mechanics**
- **and one profile (`feature-manager`) that remains too bloated to feel fully v2-clean**
