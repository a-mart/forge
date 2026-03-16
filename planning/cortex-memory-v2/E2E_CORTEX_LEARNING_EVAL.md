# Cortex Memory v2 — Copied-Env Cortex Learning Eval

**Date:** 2026-03-16  
**Worktree:** `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`  
**Copied data dir only:** `/Users/adam/.middleman-cortex-memory-v2-migrate`

## Goal
Retry the copied-env historical-conversation evaluation with a simpler rubric: prove what Cortex actually does after being pointed at one old copied-instance conversation, even if it never emits a clean final assistant summary.

## Scenario choice
I used **one historical session only**:
- **Profile:** `middleman-project`
- **Session:** `middleman-enhancements`

Why this one:
- It was the **highest-signal lane from the first attempt** in `.tmp/e2e-cortex-learning-eval/result.json`.
- The first lane already showed real Cortex review behavior against this exact session: the target session `meta.json` changed while `profiles/middleman-project/memory.md` and `merge-audit.log` did not, and the run created `eval01-mm-enh-*` workers recorded in Cortex metadata.
- The first lane still timed out waiting for a final assistant completion token, so it was the right candidate for a bounded retry with looser success criteria.

## First-lane evidence that informed the retry
From `.tmp/e2e-cortex-learning-eval/result.json`:
- Scenario: `eval-01-middleman-memory-delta`
- Target session: `middleman-project/middleman-enhancements`
- Observed file change:
  - `profiles/middleman-project/sessions/middleman-enhancements/meta.json`
    - before: `13878 bytes`, sha `c1ef347d...`
    - after: `13888 bytes`, sha `22190701...`
- No profile-memory or merge-audit change in that first lane.
- The first lane timed out waiting for a final Cortex assistant completion event.

That told us the useful signal was likely in **worker activity / review bookkeeping**, not in a clean top-level assistant reply.

## Retry method
I ran a bounded copied-env-only retry and captured snapshots in:
- `.tmp/e2e-cortex-learning-eval-retry/result.json`
- `.tmp/e2e-cortex-learning-eval-retry/backend.log`

Prompt sent to Cortex:
> Copied-env Cortex-learning eval retry. Review only `middleman-project/middleman-enhancements` in this copied instance. Goal: process this old conversation using the normal Cortex workflow and make only the durable changes actually warranted. Delegate session reading to workers if helpful. Keep injected memory lean, prefer reference material for narrow detail, and do not force writes if the session adds no durable knowledge. A terse completion note is welcome but optional.

## Exact files inspected/watched
### Copied data dir
- `profiles/middleman-project/memory.md`
- `profiles/middleman-project/merge-audit.log`
- `profiles/middleman-project/sessions/middleman-enhancements/meta.json`
- `profiles/middleman-project/sessions/middleman-enhancements/memory.md`
- `profiles/middleman-project/reference/index.md`
- `profiles/middleman-project/reference/index.md.bak`
- `profiles/middleman-project/reference/legacy-profile-knowledge.md`
- `profiles/middleman-project/reference/playwright-dashboard.md`
- `profiles/cortex/sessions/cortex/meta.json`

### Worker-produced temp artifacts
- `/tmp/eval-retry-middleman-enhancements-fulltx.md`
- `/tmp/eval-retry-middleman-enhancements-fulltx-r2.md`

## Before/after observations

### 1) Cortex definitely processed the old conversation
Even without a final assistant summary, Cortex launched focused review workers for the historical session and got structured callbacks back.

New workers appended to `profiles/cortex/sessions/cortex/meta.json` during the retry:
- `eval-retry-mm-enh-fulltx`
  - model: `openai-codex/gpt-5.4`
  - input tokens: `42977`
- `eval-retry-mm-enh-fulltx-r2`
  - model: `openai-codex/gpt-5.3-codex`
  - input tokens: `40883`

Observed callbacks in `.tmp/e2e-cortex-learning-eval-retry/result.json`:
- `DONE findings=10 artifact=/tmp/eval-retry-middleman-enhancements-fulltx.md blockers=none`
- `DONE findings=8 artifact=/tmp/eval-retry-middleman-enhancements-fulltx-r2.md blockers=none`

This is the clearest evidence that Cortex really did re-read and extract from the old copied conversation.

### 2) The extracted artifacts were actually useful
The worker outputs were not empty/noise. They contained concrete durable findings from `middleman-enhancements`, including:
- session rename should **not** bump recency/sort order
- drafts are **session-scoped** and persisted locally, including pending attachments
- sidebar collapse/expand behavior is a reusable product convention
- Cortex multi-session support is already largely a **UI concern**, not a backend-gap problem
- worker lifecycle hardening matters: preserve worker descriptors, recover missing workers on boot
- legacy compact vs smart compact are intentionally separate manual paths

Those are real learnings from the historical conversation, not just bookkeeping.

### 3) But Cortex did not promote those findings into the copied profile knowledge
The main target files stayed unchanged across the retry:
- `profiles/middleman-project/memory.md`
  - before: `4075 bytes`, sha `21438e3f...`
  - after: `4075 bytes`, sha `21438e3f...`
- `profiles/middleman-project/merge-audit.log`
  - before: `1194 bytes`, sha `9884130b...`
  - after: `1194 bytes`, sha `9884130b...`
- `profiles/middleman-project/sessions/middleman-enhancements/meta.json`
  - before: `13888 bytes`, sha `22190701...`
  - after: `13888 bytes`, sha `22190701...`
- `profiles/middleman-project/sessions/middleman-enhancements/memory.md`
  - before: `208 bytes`, sha `0ff66126...`
  - after: `208 bytes`, sha `0ff66126...`

So the retry proved **extraction**, but not **promotion/merge into profile memory**.

### 4) Scan/bookkeeping did not move on this retry
The copied-env scan summary was identical before and after the retry:
- `needsReview: 55`
- `upToDate: 41`
- `reviewedBytes: 601849668`
- `attentionBytes: 332465073`
- `sessionsWithTranscriptDrift: 54`
- `sessionsWithMemoryDrift: 4`
- `sessionsWithFeedbackDrift: 4`

So this retry did **not** advance review watermarks or reduce scan attention. That differs from the first lane, where the target session `meta.json` did change.

### 5) There was one small noisy filesystem side effect
A new copied-data file appeared:
- `profiles/middleman-project/reference/index.md.bak.reretry`
  - created during retry
  - `514 bytes`
  - contents are effectively a duplicate of `reference/index.md`

This looks like backup churn rather than useful learned output.

### 6) There was still no clean final Cortex assistant message
- No `conversation_message` assistant reply from Cortex was captured for the retry.
- The useful output existed in worker artifacts and callbacks, not in a top-level final assistant summary.

## Exact changed files from the retry
Changed inside the copied data dir:
- `profiles/cortex/sessions/cortex/meta.json`
  - grew from `52748` to `53570` bytes as new retry workers were recorded
- `profiles/middleman-project/reference/index.md.bak.reretry`
  - new file created

Not changed in the target profile/session:
- `profiles/middleman-project/memory.md`
- `profiles/middleman-project/merge-audit.log`
- `profiles/middleman-project/sessions/middleman-enhancements/meta.json`
- `profiles/middleman-project/sessions/middleman-enhancements/memory.md`
- `profiles/middleman-project/reference/index.md`
- `profiles/middleman-project/reference/legacy-profile-knowledge.md`
- `profiles/middleman-project/reference/playwright-dashboard.md`

## Judgment
**Verdict: helpful output exists, but the end-to-end behavior still needs prompt/design adjustment.**

### What was helpful
- Cortex clearly **did process** the old copied-instance conversation.
- It spawned targeted workers, consumed substantial context, and produced two structured extraction artifacts with real durable findings.
- Those findings are plausibly useful and mostly on-topic for future work.

### What was too noisy / incomplete
- Cortex did **not** turn that useful extraction into a clean promoted outcome in copied profile memory/reference docs.
- It also did **not** emit a clear final assistant summary.
- The only copied-data write beyond Cortex’s own session metadata was a slightly noisy duplicate backup file: `reference/index.md.bak.reretry`.

### Bottom line
If the evaluation question is **“Does Cortex actually learn/process something useful from an old copied conversation?”** the answer is **yes**.

If the evaluation question is **“Is the current end-to-end result clean and polished enough without prompt/design changes?”** the answer is **not quite**.

The useful behavior is currently concentrated in **worker extraction artifacts and callbacks**, while the final synthesis/promotion layer is still inconsistent and mildly noisy.
