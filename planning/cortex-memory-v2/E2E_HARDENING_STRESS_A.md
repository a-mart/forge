# Cortex Memory v2 — E2E Hardening Stress A

**Date:** 2026-03-15/16 overnight  
**Lane:** copied-env historical processing stress lane A  
**Worktree:** `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`  
**Primary isolated data dir:** `/Users/adam/.middleman-cortex-memory-v2-migrate`  
**Lane-specific validation scratch dir:** `/Users/adam/.middleman-cortex-memory-v2-stress-a-scratch`  
**Production touched:** **No**

## Goal
Push beyond “merge-ready” and judge whether real copied-instance historical reviews feel exceptional: useful, precise, quiet, and well-closed-out.

I read:
- `planning/cortex-memory-v2/E2E_CORTEX_LEARNING_EVAL.md`
- `planning/cortex-memory-v2/E2E_EXEC_SUMMARY.md`
- current Cortex prompt / review files, especially:
  - `apps/backend/src/swarm/archetypes/builtins/cortex.md`
  - `apps/backend/src/swarm/operational/builtins/cortex-worker-prompts.md`
  - `apps/backend/src/swarm/scripts/cortex-scan.ts`

I then ran **4 real copied-env historical review scenarios** plus **1 lane-specific scratch validation**.

---

## Scenario results

| Scenario | Outcome | Usefulness | Precision | Closeout quality | Noise |
|---|---|---:|---:|---:|---:|
| `middleman-project/middleman-project` | Promoted 1 narrow gotcha to reference; corrected root-session memory review state | Medium | Good | Good | Low |
| `middleman-project/cross-communication` | Wrote a strong new reference doc, but failed end-to-end closure | High potential | Mixed | Poor | Medium |
| `feature-manager/doc-processing-bakeoff` | Promoted a real ingestion policy, but also added to already-bloated injected memory | Medium | Mixed | Good | Medium |
| `feature-manager/dev-abililty-to-update-config` | Correct feedback-only no-op; watermark-only update | Medium | Good | Good | Low |
| Scratch validation: `middleman-project/test-push` | Exact one-shot closeout after prompt hardening | Low/expected | Good | Good | Low |

---

## 1) `middleman-project/middleman-project`
**What happened**
- Cortex delegated transcript + session-memory + synthesis workers.
- It promoted one narrow reference-only finding into:
  - `profiles/middleman-project/reference/gotchas.md`
- It also updated:
  - `profiles/middleman-project/sessions/middleman-project/meta.json`

**Actual learned signal**
- Good sharpened rule: do **not** persist transient `tool_execution_update` frames into session JSONL.

**Why this was good**
- It resisted over-promoting already-known material.
- It chose **reference**, not injected memory.
- User-facing closeout was clean, concise, and matched the work.

**Judgment**
- Solid review. Not magical, but disciplined.

---

## 2) `middleman-project/cross-communication`
**What happened**
- Cortex extracted a strong architectural/reference signal and created:
  - `profiles/middleman-project/reference/session-history-bootstrap.md`
- It updated:
  - `profiles/middleman-project/reference/index.md`
- But it **did not** advance the target session watermark.
- It also **failed the requested closeout format** during the scenario window.

**Actual learned signal**
- The new topic doc is good. It captures a durable fit/debugging pattern for session history bootstrap under WS payload pressure.

**Why this was promising**
- The created reference doc is exactly the kind of bounded, pull-based artifact v2 wants.

**Why this was not exceptional**
- The session remained effectively unclosed at the bookkeeping layer.
- The user-facing message that arrived during the run referenced a different session (`middleman-enhancements`) and did not include the required completion token.
- So Cortex had the right internal instinct, but the end-to-end experience felt unreliable.

**Judgment**
- Best raw product signal in this lane, but also the clearest proof that promotion/writeback + closeout still need hardening.

---

## 3) `feature-manager/doc-processing-bakeoff`
**What happened**
- Cortex extracted real durable signal from a historical evaluation session.
- It updated:
  - `profiles/feature-manager/memory.md`
  - `profiles/feature-manager/reference/gotchas.md`
  - `profiles/feature-manager/sessions/doc-processing-bakeoff/meta.json`

**Actual learned signal**
- Useful policy: for document ingestion, prefer **MarkItDown** for speed, **Docling** as fidelity fallback, and **OCR** for image/layout-heavy PDFs.

**What worked**
- The extracted signal was real and reusable.
- The closeout was concise and accurate.
- The narrower failure mode went to reference/gotchas, which was the right tier.

**What still felt off**
- Cortex also expanded `feature-manager/memory.md`, which is already too large.
- The promoted policy is useful, but this profile still feels too willing to accumulate injected detail instead of reserving memory for only the highest-leverage summary.

**Judgment**
- Useful, but not yet elegant. This profile still has a memory-bloat posture problem.

---

## 4) `feature-manager/dev-abililty-to-update-config`
**What happened**
- Cortex reviewed a feedback-only delta.
- It made **no** memory/reference edits.
- It only updated:
  - `profiles/feature-manager/sessions/dev-abililty-to-update-config/meta.json`

**Actual learned signal**
- None. The feedback was a single unexplained up-vote.

**Why this was good**
- Correctly treated as telemetry noise, not knowledge.
- Clean watermark-only closure.
- Concise user-facing completion.

**Judgment**
- This is the right “quiet correctness” behavior for low-signal feedback drift.

---

## Repeated patterns

### Strongest wins
1. **Reference-doc placement is genuinely good when Cortex stays narrow.**
   - `session-history-bootstrap.md`
   - `middleman-project/reference/gotchas.md`
2. **No-op discipline is improving.**
   - Feedback-only and mostly-already-known sessions did not force junk promotions.
3. **User-facing closeouts can be crisp when the loop actually closes.**
   - Scenario 1 and 4 were both clean.

### Repeated rough edges
1. **Extraction quality is better than completion reliability.**
   Cortex often found the right signal before stumbling on watermarking or final user-visible closure.
2. **Feature-manager still has a weak inject/reference boundary.**
   Good signals are still too likely to leak into already-heavy injected memory.
3. **File-noise / artifact hygiene still feels rough.**
   Repeated `.bak` variants and partially-completed write patterns make the system feel less polished than the underlying curation quality.

---

## Top 3 product weaknesses

### 1) Closeout determinism is still not trustworthy enough
Scenario 2 produced good underlying work but the user-visible reply was wrong-session / wrong-shape during the evaluation window.

Why this matters:
- A smart internal review that closes out ambiguously does not feel exceptional.
- The product experience depends on the final message being target-specific and obviously complete.

### 2) Promotion/writeback can partially succeed without true review closure
Scenario 2 wrote a good reference doc and updated the index, but the session did not cleanly cash out into reviewed state.

Why this matters:
- Partial success is confusing: knowledge changed, but the attention queue still effectively remains open.
- This is worse than a clean no-op because it creates hidden state ambiguity.

### 3) Injected-memory discipline is still too weak on bloated profiles
Scenario 3 promoted real signal, but it still expanded `feature-manager/memory.md` instead of keeping even more of that detail in reference.

Why this matters:
- The system’s “feel” depends on injected memory staying sharp.
- Once a profile is already heavy, every extra line has to clear a very high bar.

---

## Low-churn improvement implemented
I made a **prompt-level hardening** change in:
- `apps/backend/src/swarm/archetypes/builtins/cortex.md`

Change:
- direct/on-demand reviews now explicitly require **exactly one** final `speak_to_user` completion
- the closeout must name the reviewed `profile/session`
- it must list changed files or `NONE`
- it must not send a closeout for a different session than the one just reviewed

This is low-churn and directly targets the most visible weakness from stress lane A.

---

## Focused validation of the improvement
To reduce cross-lane interference, I created a lane-specific scratch clone:
- `/Users/adam/.middleman-cortex-memory-v2-stress-a-scratch`

Then I ran one bounded validation review against:
- `middleman-project/test-push`

**Result:** successful exact closeout:
- `EVAL_DONE stress-a-validate-closeout`
- `TARGET: middleman-project/test-push`
- `FILES: ...`
- `OBS: ...`

This is a real improvement in closeout quality.

### Remaining caveat from validation
The closeout text still referenced a file path under the migrate dir rather than the scratch dir.
That means:
- **message shape improved**
- **target specificity improved**
- but **path-source fidelity still looks imperfect**

So the hardening helped, but did not fully eliminate the polish gap.

---

## Bottom line
Stress lane A says Cortex Memory v2 is **closer to exceptional than the earlier eval proved**, but it is **not consistently exceptional yet**.

Most encouraging signs:
- real historical sessions do yield useful durable signal
- reference-doc creation is often the right shape
- quiet/no-op reviews can stay disciplined

Main blocker to “truly exceptional” feel:
- not extraction quality
- **completion fidelity**: precise closeout, precise writeback, precise reviewed-state closure, and a stronger refusal to bloat injected memory

## Validation run list
Primary copied-env scenarios:
- `middleman-project/middleman-project`
- `middleman-project/cross-communication`
- `feature-manager/doc-processing-bakeoff`
- `feature-manager/dev-abililty-to-update-config`

Prompt-hardening validation:
- scratch clone: `middleman-project/test-push`

## Commands / checks executed
- bounded copied-env runtime runner: `.tmp/e2e-hardening-stress-a-runner.mjs`
- bounded scratch validation runner: `.tmp/e2e-hardening-stress-a-validate-closeout.mjs`
- backend typecheck: `cd apps/backend && pnpm exec tsc -p tsconfig.build.json --noEmit`
- UI typecheck: `cd apps/ui && pnpm exec tsc --noEmit`

All work stayed in the isolated worktree and isolated copied/scratch data dirs.
