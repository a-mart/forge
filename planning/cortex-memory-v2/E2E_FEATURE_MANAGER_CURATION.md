# Cortex Memory v2 — Feature-Manager Curation Plan (Copied Isolated Env)

**Date:** 2026-03-15/16  
**Worktree:** `/Users/adam/repos/middleman-worktrees/cortex-memory-v2`  
**Evaluated profile (copied env only):** `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/feature-manager`  
**Production touched:** **No**

## Goal
Define an elegantly simple, low-churn path to de-bloat `feature-manager` profile memory for Memory v2:
- keep only high-value injected context,
- compress repeated/process-heavy material,
- move deep runbook/procedural detail to pull-based reference docs.

This lane prioritizes **analysis + concrete keep/compress/move plan** over broad rewrites.

---

## Current state (evidence)

### Size + shape
- `memory.md`: **31,975 bytes / 455 lines** (large for auto-injected profile memory)
- `reference/` before this pass: only `index.md` + `legacy-profile-knowledge.md`

### Section concentration inside `memory.md`
- `## Project Facts`: **270 lines** (largest block)
- Most bloated subsections are procedural runbooks/tools:
  - `### Work Triage & Routing`: 81 lines
  - `### Worktree Development ...`: 38 lines
  - `### Devserver Agent Config Snapshot ...`: 33 lines
  - `### Devserver Config Management ...`: 40 lines
  - `### Playwright Testing ...`: 22 lines

### Qualitative finding
`feature-manager/memory.md` currently mixes three tiers that should be separated in Memory v2:
1. **Durable injected guidance** (good in memory)
2. **Long operational procedures + command catalogs** (should be reference)
3. **Historical project/postmortem detail** (should be summarized or archived)

---

## Keep / Compress / Move plan (with examples from current content)

### 1) KEEP in injected memory (durable, high-frequency, behavior-shaping)
Keep these categories in `memory.md`, but concise:

- User operating preferences and guardrails
  - Example: “NEVER merge to `dev` without explicit user approval.”
  - Example: communication style + autonomy preference
- Stable quality bar
  - Example: “No AI slop” standard
- Stable routing heuristics
  - Keep one compact triage summary (Tracks 1–4), not full playbooks
- A small set of evergreen architecture truths
  - Example: channel files distinct from legacy files_tool semantics
- Critical known bug that still affects ongoing work
  - Example: Cognee Falkor adapter `IndexError` note (if still active)

**Target shape:** concise bullets, no command blocks, no multi-step runbooks.

### 2) COMPRESS in injected memory (retain concept, remove implementation detail)
Compress these sections to short policy statements + pointers:

- `Work Triage & Routing`
  - Keep: one-screen manager policy and model routing summary
  - Compress out: full per-track execution scripts/checklists already encoded in manager behavior
- `Worktree Development`
  - Keep: “use scripted worktree bootstrap; avoid raw git worktree add”
  - Compress out: full cleanup sequence command-by-command
- Long “Learnings” collections
  - Keep: only repeated evergreen lessons
  - Compress out: one-off incident chronology and implementation diary detail

### 3) MOVE to reference docs (pull-based, detailed procedures)
Move these out of injected memory into topic docs under `reference/`:

- Devserver operational runbooks
  - Current memory blocks: Session Debugging, Config Snapshot, Remote Debug Setup, Debug Tooling, Config Management, Security Model
- Playwright auth/bootstrap command workflow
- E2E chat API test cookbook details
- Long script invocation examples and parameter lists

These are valuable but **too detailed for auto-injection** and should be read only when task-relevant.

### 4) DROP or archive from injected memory
- Completed-work timeline prose (retain only durable outcomes if still behaviorally relevant)
- Redundant/duplicate guidance that already exists in AGENTS or reference docs
- One-off branch names/commit-level specifics unless needed repeatedly

---

## Proposed low-churn rollout (next curation pass)

### Pass A — Structural (safe)
1. Ensure reference core docs exist and are linkable from `reference/index.md`.
2. Add focused topic docs for heavy operational domains (devserver ops, testing playbooks).
3. Keep `legacy-profile-knowledge.md` untouched as rollback/reference source.

### Pass B — Memory reduction (targeted)
1. Reduce `memory.md` from ~455 lines toward a lean injected core (rough target: ~120–180 lines).
2. Replace long procedural sections with 1–3 bullet summaries + explicit reference-doc links.
3. Preserve user-critical constraints verbatim (approval/merge guardrails, quality standards).

### Pass C — Validate quality
1. Manual sanity check for missing critical guardrails.
2. Ensure moved details are discoverable from `reference/index.md`.
3. Confirm memory is now mostly durable policy + project identity, not runbook payload.

---

## “Elegant simplicity” rubric for this profile
A curation change is accepted only if it improves all three:
1. **Prompt hygiene:** injected memory gets materially smaller and less procedural.
2. **Usefulness:** no loss of critical user preferences/safety constraints.
3. **Retrievability:** detailed runbooks remain available via obvious reference paths.

---

## Small safe improvement implemented in this lane (copied env docs only)

To de-risk the next compression pass, I added the missing core reference docs in the copied isolated env so index links are no longer dead and there is a clear destination for moved material:

- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/feature-manager/reference/overview.md`
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/feature-manager/reference/architecture.md`
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/feature-manager/reference/conventions.md`
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/feature-manager/reference/gotchas.md`
- `/Users/adam/.middleman-cortex-memory-v2-migrate/profiles/feature-manager/reference/decisions.md`

Notes:
- These are **seed docs** only (concise, derived from existing profile content).
- No production paths were touched.
- `memory.md` was intentionally **not** broadly rewritten in this lane.

---

## Recommended immediate next step
Run a focused curation edit that only touches `profiles/feature-manager/memory.md` in copied env and performs these exact reductions:
1. Collapse all devserver procedural subsections into a short “Devserver ops exist in reference” summary.
2. Collapse Playwright + E2E testing command catalogs into short reminders + links.
3. Trim long historical learnings to recurring durable heuristics.

This gives the largest bloat reduction with minimal risk and stays aligned with Memory v2’s “lean injected memory, rich pull-based reference” model.
