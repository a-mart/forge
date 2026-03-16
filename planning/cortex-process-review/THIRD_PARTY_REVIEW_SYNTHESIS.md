# Third-Party Cortex Review Synthesis

## 1. Executive Take

The third-party review is directionally very strong. It correctly identifies that Cortex's biggest current weaknesses are **not conceptual**; they are **contract clarity, evidence discipline, injected-scope discipline, and operational reliability**.

The most important thing to do next is **not** a broad redesign. The best signal-to-complexity path is:

1. **Fix the prompt/workflow contract bugs**
   - worker outputs are missing required classification/target fields
   - session-memory extraction is required by the manager prompt but has no concrete template
   - feedback telemetry paths are hardcoded and non-portable
   - scan ownership is muddled between “Cortex can run it directly” and “spawn a scan worker every cycle”

2. **Tighten what gets promoted into injected memory**
   - add an explicit evidence policy
   - narrow `common.md` scope further
   - add budget targets/ceilings
   - make tentative signals easier to hold without over-promoting them

3. **Add lightweight operational guardrails**
   - review log
   - lightweight promotion manifest / commit gate
   - simple singleton lock/lease
   - thresholded sharding for huge deltas
   - stronger queue priority than pure delta-bytes

4. **Defer heavier architecture until the above stabilizes**
   - full evidence ledger
   - full transactional rollback engine
   - audience-aware injection
   - semantic cursor migration away from bytes

The review is most right when it says: **Cortex should be stricter, more auditable, and harder to fool itself.** It overreaches when it implies those benefits require a fully expanded metadata/ledger architecture immediately.

**Bottom-line recommendation:** do a **P0 contract-hardening pass** first. That gets most of the value with much less churn than a major storage/governance redesign.

---

## 2. Strong Agree

These are the third-party points that are clearly correct and should drive immediate changes.

### A. The prompt contract is currently inconsistent
This is the strongest finding.

The current Cortex manager prompt expects workers to classify and route findings, but the extraction template does not require enough structure to do that reliably. That forces the manager to reconstruct missing intent during synthesis.

**Why this matters:**
- weakens auditability
- increases synthesis drift
- makes prompt behavior fragile across transcript/session-memory/feedback reviews
- creates ambiguity about what workers are actually supposed to return

**Decision:** fix now.

---

### B. Session-memory extraction is a real workflow gap
The manager prompt says session-memory changes may require dedicated review, but there is no first-class session-memory worker template.

**Why this matters:**
- required workflow has no concrete implementation contract
- session memory is different from transcript evidence and should be treated more conservatively
- today the system is relying on improvisation

**Decision:** add a dedicated session-memory mode/template now.

---

### C. Cortex needs an explicit evidence policy
All four analyses agree on the core issue: Cortex is vulnerable to learning from its own downstream behavior unless evidence sources are ranked more explicitly.

The third-party review is right that:
- explicit user corrections/instructions should dominate
- trusted repo/system artifacts should rank high
- feedback telemetry should rank high
- repeated user-side patterns can justify promotion
- manager/worker behavior shaped by prior memory is weak evidence

**Why this matters:** it prevents “self-made lore.”

**Decision:** add lightweight evidence rules now.

---

### D. `common.md` must remain unusually strict and small
The review is right that the template currently invites broader injected memory than Cortex should carry by default. In particular, `Project Landscape` should not be a default always-injected section.

**Decision:**
- remove `Project Landscape` from the default common-memory template
- keep `common.md` focused on behavior-shaping defaults
- move broader topology/background to reference surfaces when needed

---

### E. Budget discipline needs to become operational, not just aspirational
Current guidance says “keep injected memory lean,” but there are no numerical targets or enforcement triggers.

**Decision:** add target budgets and ceilings now, even if token estimation is heuristic at first.

Recommended starting policy:
- `shared/knowledge/common.md`: target <= 1200 tokens, hard ceiling ~1800
- `profiles/<profileId>/memory.md`: target <= 1600 tokens, hard ceiling ~2400

If a promotion would exceed target, Cortex should first:
- merge
- sharpen
- demote to reference
- retire stale content

---

### F. Scan ownership should be simplified
The operational analysis is right: Cortex can safely run bounded scan itself, so scan delegation should not be the default path.

**Decision:** make direct scan canonical, keep scan-worker only as optional fallback if needed.

---

### G. Lightweight operational reliability features are worth adding now
The ops review is right that current promotion/watermark rules are directionally good but underspecified.

**Adopt now:**
- lightweight review log JSONL
- lightweight per-cycle promotion manifest / commit gate
- singleton lock/lease
- thresholded sharding for very large deltas
- better queue priority than bytes-only

These are practical, high-ROI guardrails.

---

### H. Governance guardrails should begin now
The governance review is right that Cortex should be allowed to improve heuristics and prompts, but not freely rewrite its own foundational safety/discipline rules.

**Decision:** add a lightweight constitution-vs-policy boundary now.

---

## 3. Agree but Narrow/Modify

These are recommendations where the third-party review is right about the problem, but the first implementation should be narrower than proposed.

### A. `note` should become first-class in the workflow, but not require a heavy storage redesign
The review is correct that there is a mismatch between a 3-way classification model and `.cortex-notes.md` being a real maturity stage.

But the narrow, practical fix is:
- make `note` an explicit **workflow outcome**
- allow workers to propose `note`
- allow the manager to downgrade weak `inject/reference` candidates into `note`
- store notes in the existing notes surface for now

**Do not** block this on introducing a full new ledger architecture.

**Recommended interpretation:**
- `inject` and `reference` = promotion classes
- `note` = provisional holding state
- `discard` = terminal state

That resolves the conceptual mismatch without overbuilding.

---

### B. Normalize worker outputs, but keep the schema minimal
The review is right that freeform worker output is too loose. It is wrong to imply the full future ledger schema must exist in worker artifacts immediately.

**Minimum useful schema for now:**
- `id`
- `statement`
- `type`
- `proposed_outcome`
- `proposed_target`
- `scope`
- `confidence`
- `evidence_tier`
- `sources`
- `rationale`

**Do not add yet:**
- `first_seen`
- `last_confirmed`
- `review_after`
- full lifecycle/status metadata
- audience routing fields unless runtime uses them

This is enough to fix correctness without dragging in a full metadata platform.

---

### C. Add evidence tiers, but keep them simple
The third-party evidence-ladder idea is good. The first implementation should stay small and enforceable.

**Recommended tiers now:**
- `explicit_user`
- `trusted_artifact`
- `feedback_signal`
- `repeated_user_pattern`
- `agent_inference`

Keep the rule simple:
- do not promote weak evidence directly to `common.md`
- treat session memory as supporting evidence, not authoritative evidence
- if the signal is interesting but weak, route to `note`

---

### D. Add promotion transaction discipline, but start lightweight
The review is correct that promotion should be more transactional. But a full rollback engine is not required for the next pass.

**Start with:**
- per-cycle manifest
- validate planned writes
- snapshot before first edit
- apply writes
- only commit watermark updates for successfully applied items
- record outcome in review log

This gets most of the reliability benefit without building a full database-style transaction layer.

---

### E. Remove `Project Landscape` as a default section, but do not ban cross-project context entirely
The review is right that it does not belong as a default always-injected section.

But some cross-project knowledge may still matter when it changes behavior broadly.

**Correct policy:**
- not a default injected section
- rare exception only when it clearly changes behavior across profiles
- otherwise place it in shared reference

---

### F. Make direct scan canonical, but keep fallback paths
The governance review is right to resist a blanket deletion of the scan-worker path. That can remain as fallback/harness if special environments need it.

**Correct policy:** direct scan is default; delegated scan is optional fallback, not primary design.

---

## 4. Defer / Later Architecture

These ideas are good, but they should come after the contract-hardening pass.

### A. Full evidence / promotion ledger
A ledger is likely valuable eventually, especially for:
- provenance
- supersession
- stale-entry review
- dedupe history
- user trust/auditability

But it is **not** required to fix today's main problems.

**Defer until after:**
- outcome model is stable
- worker schema is normalized
- review log exists
- evidence policy is working in practice

---

### B. Full transactional rollback engine
A richer manifest/rollback system may be worthwhile later, especially if multi-file promotion failures become common.

For now, a commit gate + review log is enough.

---

### C. Semantic review cursors replacing byte offsets
The ops review is right that byte offsets are fragile if files can be rewritten in-place or compacted in ways size-only watermarks cannot fully detect.

**Best sequence:**
1. add guardrails now (compaction detection, tail-hash/integrity checks, safe fallback to full re-review)
2. migrate to more semantic cursors later if needed

Do not make cursor migration part of the first cleanup wave.

---

### D. Audience-aware injection
Useful eventually (`manager | worker | all`), but only if runtime injection can actually act on it.

This is a second-wave capability, not a first-wave correctness fix.

---

### E. Shared reference expansion and structured reference taxonomy
Worth doing, but after the injected-memory contract is fixed. The immediate need is to stop overloading injected surfaces; a larger reference taxonomy can follow.

---

## 5. Reject / Not Worth It Yet

These are the parts of the third-party review that should not drive the first implementation wave.

### A. Do not build a full metadata-heavy schema into every worker artifact yet
Fields like:
- `status`
- `review_after`
- `first_seen`
- `last_confirmed`
- retirement metadata
- broad lifecycle state

are more appropriate for a future ledger than for first-pass worker outputs.

**Why reject for now:** too much complexity for too little immediate benefit.

---

### B. Do not make ledger implementation a prerequisite for improving Cortex
The review sometimes implies audit quality depends on a real ledger. It does not.

A lighter path is enough first:
- normalized worker artifacts
- review log
- better evidence policy
- commit-gated promotion

---

### C. Do not perform a broad knowledge-surface redesign before fixing prompt correctness
Fix the current contract bugs first. Otherwise the system will just generate better-looking inconsistency.

---

### D. Do not overfit queue prioritization into a complex scoring engine yet
Pure delta-bytes ordering is too weak, but a highly elaborate ranking framework is unnecessary.

A simple weighted priority tuple is enough for now.

---

### E. Do not force an immediate byte-cursor replacement if append-only + guardrails are sufficient short-term
This is a real issue, but not the first issue.

---

## 6. Recommended P0 / P1 / P2 roadmap

## P0 — Contract hardening and low-regret reliability

These are the next changes with the best signal-to-complexity ratio.

### 1. Add `note` as an explicit Cortex workflow outcome
- update manager prompt language from 3-way to 4-way
- allow worker proposal of `note`
- allow manager downgrade to `note`
- keep notes in existing notes surface for now

### 2. Normalize worker outputs across transcript / session-memory / feedback review
Mandate minimal structured findings with:
- `id`
- `statement`
- `type`
- `proposed_outcome`
- `proposed_target`
- `scope`
- `confidence`
- `evidence_tier`
- `sources`
- `rationale`

### 3. Add a dedicated session-memory extraction template or explicit mode
- same schema as transcript extraction
- extra guidance: session memory is supporting evidence, not authoritative truth
- bias weak signals toward `note`

### 4. Add explicit evidence policy to the Cortex prompt
- exogenous > endogenous evidence
- user corrections/instructions strongest
- trusted artifacts high
- feedback high
- repeated user patterns medium-high
- manager/worker behavior shaped by memory weak
- do not promote weak evidence directly to `common.md`

### 5. Remove hardcoded absolute paths and model IDs from prompt templates
- use env/config placeholders
- use capability/config aliases rather than literal provider model names where possible

### 6. Tighten `common.md` template and budget policy
- remove `Project Landscape` as default section
- add target/ceiling budget guidance
- require compaction-before-promotion when target exceeded

### 7. Make direct scan canonical
- Cortex runs bounded scan itself
- scan-worker becomes fallback only

### 8. Add lightweight review log + lightweight promotion manifest / commit gate
- review-cycle JSONL log
- record reviewed sessions, changed files, blockers, watermark decisions
- only commit watermark updates after successful writes

### 9. Add a simple singleton lock/lease
- prevent duplicate simultaneous review cycles
- include heartbeat/stale-lock recovery

### 10. Add thresholded sharding for very large deltas
- only above explicit threshold
- synthesize shards before promotion

---

## P1 — Stronger operational quality after P0 stabilizes

### 1. Upgrade queue prioritization
Use a simple weighted tuple such as:
1. correction/feedback signal
2. never-reviewed boost
3. stale review age
4. attention bytes
5. FIFO tie-breaker

### 2. Add cursor integrity guardrails
- compaction/rewrite detection
- optional tail-hash or integrity check
- safe fallback to full re-review when uncertain
- fix any prompt guidance that confuses byte offsets with line offsets

### 3. Add shared reference surfaces where needed
Good candidate:
- `shared/knowledge/reference/`

Use this as the home for cross-profile background that is useful but should not be always injected.

### 4. Improve `.cortex-notes.md` structure
Suggested sections:
- candidate patterns
- contested observations
- open questions
- recently promoted
- recently retired

### 5. Add explicit periodic scope/budget audit behavior
Especially for `common.md`.

---

## P2 — Heavier architecture if real pain persists

### 1. Full evidence / promotion ledger sidecar
Add only if provenance, stale review, and dedupe history are becoming real pain points.

### 2. Full manifest-based transactional promotion / rollback
Add after lightweight commit gating proves insufficient.

### 3. Semantic review cursors
Move beyond byte offsets if append-only assumptions weaken or compact/rewrite drift becomes frequent.

### 4. Audience-aware injection
Ship only when runtime injection can make use of it.

### 5. More advanced fairness/backpressure scheduling
Only after sharding and simple priority rules are stable.

---

## 7. Exact prompt/workflow fixes to make first

These are the concrete first edits and workflow changes that should happen before broader architecture work.

### A. In `apps/backend/src/swarm/archetypes/builtins/cortex.md`

#### 1. Change the outcome model everywhere from 3-way to 4-way
Replace language like:
- `inject | reference | discard`

with:
- `note | inject | reference | discard`

Recommended definitions:
- `note` = plausible/useful but not yet strong enough to promote
- `inject` = durable runtime-loaded guidance
- `reference` = durable but too detailed/narrow for injection
- `discard` = transient/duplicative/weak/not worth retaining

#### 2. Add an `Evidence policy` section
Suggested content:

```md
## Evidence policy

Prefer exogenous evidence over endogenous evidence.

Strong evidence:
- explicit user instructions or corrections
- trusted source-of-truth artifacts
- explicit feedback telemetry
- repeated user-side patterns across sessions

Weak evidence:
- manager/worker behavior that may have been shaped by existing memory
- assistant narrative claims
- session-local memory by itself
- one-off inferences from ambiguous context

Rules:
- Do not promote weak evidence directly to `common.md`.
- Treat session-local memory as supporting evidence, not authoritative evidence.
- If a signal is interesting but weak, classify it as `note`.
```

#### 3. Tighten `common.md` guidance
- remove `Project Landscape` as a default injected section
- explicitly state that `common.md` is for behavior-shaping defaults only
- say cross-project background belongs in reference unless it changes behavior broadly

#### 4. Add injected-budget guidance
Suggested language:

```md
## Injected memory budget

Injected memory is scarce.

- Keep `shared/knowledge/common.md` near <=1200 tokens; treat ~1800 as a hard ceiling.
- Keep `profiles/<profileId>/memory.md` near <=1600 tokens; treat ~2400 as a hard ceiling.
- If a promotion would exceed target budget, first merge, sharpen, demote, or retire existing content.
- Prefer one atomic idea per bullet.
```

#### 5. Add lightweight self-improvement boundary language
Suggested language:

```md
## Self-improvement boundaries

You may improve worker prompts, extraction heuristics, ranking heuristics, and compaction heuristics.
You may not silently rewrite constitutional rules covering:
- secret handling
- transcript/session review delegation rules
- write targets
- watermark discipline
- evidence discipline
- budget discipline

Constitutional changes require explicit reviewed direction.
```

#### 6. Clarify scan ownership
State clearly that Cortex may run the bounded scan directly and should treat scan delegation as fallback, not default.

---

### B. In `.cortex-worker-prompts.md`

#### 1. Replace loose extraction outputs with a normalized minimum schema
Recommended worker artifact contract:

```json
{
  "profile": "<profileId>",
  "session": "<sessionId>",
  "source_kind": "transcript | session_memory | feedback",
  "findings": [
    {
      "id": "F1",
      "statement": "atomic durable claim",
      "type": "preference | workflow | decision | fact | gotcha | procedure | feedback",
      "proposed_outcome": "note | inject | reference | discard",
      "proposed_target": "common | profile_memory | reference/<file>.md | notes | none",
      "scope": "common | profile",
      "confidence": "high | medium | low",
      "evidence_tier": "explicit_user | trusted_artifact | feedback_signal | repeated_user_pattern | agent_inference",
      "sources": [
        { "kind": "session_message | session_memory | feedback | doc", "ref": "..." }
      ],
      "rationale": "why this routing is appropriate"
    }
  ],
  "summary": {
    "finding_count": 0,
    "blockers": []
  }
}
```

Rules:
- cap findings (for example top 8)
- prefer atomic claims
- return empty `findings` if nothing durable exists
- do not summarize the entire session as a substitute for findings

#### 2. Add a dedicated session-memory extraction template or mode
Required extra instructions:
- review only the changed session-memory material
- treat session memory as supporting evidence
- prefer `note` when claims are not independently confirmed

#### 3. Align feedback telemetry worker to the same schema
- remove hardcoded `/Users/adam/.middleman/...` paths
- use runtime-resolved placeholders
- allow `note` outcome

#### 4. Stop hardcoding model IDs in templates where possible
Use capability/config aliases for:
- fast extraction
- deep synthesis
- fallback models

---

### C. Operational workflow fixes

#### 1. Review-cycle log
Add `shared/knowledge/.cortex-review-log.jsonl` with per-cycle entries including:
- review ID
- timestamp
- sessions reviewed
- changed files
- promotions / retirements / notes
- blockers/failures
- watermark decisions

#### 2. Lightweight promotion manifest / commit gate
Per review cycle:
1. build candidate changes
2. validate them
3. snapshot target files before first write
4. apply writes
5. record outcomes
6. only then update session watermarks for successful items

#### 3. Queue ordering
Upgrade from pure byte-size ranking to a stable priority tuple:
- corrections / feedback first
- never-reviewed sessions next
- stale review age next
- delta size next
- FIFO tie-breaker

#### 4. Large-delta handling
If delta exceeds threshold:
- shard extraction
- synthesize shard outputs
- then promote once

#### 5. Singleton discipline
Add simple local lock/lease plus stale-lock recovery.

---

## Final Recommendation

The third-party review should be treated as a **high-quality diagnosis with an over-ambitious second half**.

The right move is:
- **accept the diagnosis** on prompt inconsistency, evidence discipline, scope discipline, and operational guardrails
- **narrow the implementation** to a P0 contract-hardening pass
- **defer heavy architecture** until the cleaned-up system runs long enough to show where deeper machinery is actually needed

If only one principle guides the next iteration, it should be:

> Fix what Cortex claims to do before expanding what Cortex is allowed to remember.

That sequencing gives the best signal-to-complexity ratio and keeps the next implementation wave practical, testable, and low-regret.
