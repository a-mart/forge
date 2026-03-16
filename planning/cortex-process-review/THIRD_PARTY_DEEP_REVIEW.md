# Cortex Deep Review and Recommended Design Changes

## Executive Summary

Cortex is a strong concept. The core idea — a singleton memory analyst that curates what future agents should know by default, what they should fetch on demand, and what should be forgotten — is exactly the right abstraction for turning a multi-agent platform into a learning system.

The current design already has several good instincts:
- strict separation between injected memory and reference material
- mandatory delegation for transcript reading
- incremental review with watermarks
- a bias toward lean injected context
- self-reflection and prompt refinement over time

The biggest improvements I recommend are not about making Cortex more complicated. They are about making it **more explicit, more auditable, and harder to fool itself**.

### My highest-leverage recommendations

1. **Make tentative knowledge first-class.**  
   The current core triage loop only has `inject`, `reference`, and `discard`, but the design also describes `.cortex-notes.md` as a real staging area. That is a contradiction. Cortex needs an explicit `note` / `hold` outcome so it can preserve weak-but-interesting signals without either promoting or discarding them.

2. **Separate active memory from evidence and audit.**  
   `common.md` and `profiles/<profileId>/memory.md` should stay human-readable, concise, and optimized for runtime injection. Provenance, confidence, sources, supersession history, and review metadata should live somewhere else — a ledger/log surface. Without that separation, the injected files will either become bloated or lose auditability.

3. **Be much stricter about what becomes `common.md`.**  
   Cross-profile injected memory should be rare. Right now the conceptual scope of `common.md` is too broad, especially the “Project Landscape” idea. Common injected memory should contain only defaults that are broadly useful across most sessions and agents. Everything else should fall back to profile memory, shared reference, or notes.

4. **Replace freeform worker outputs with a normalized schema.**  
   The worker prompt file and the manager prompt are currently inconsistent. Workers are required to classify findings, but the extraction template does not actually ask them to return a classification field. This will produce drift, ambiguity, and noisy synthesis. Workers should return structured candidate findings with explicit fields.

5. **Introduce a constitution vs policy split for self-improvement.**  
   Cortex should be allowed to improve its worker prompts and heuristics. It should **not** be allowed to casually rewrite its own foundational rules. Keep a small, stable, human-owned constitutional layer; let Cortex self-edit only its policy/heuristics layer and prompt experiments.

6. **Make promotion transactional and idempotent.**  
   Cortex should not update watermarks unless all target writes succeed. It should generate a promotion manifest, validate it, snapshot once per file, apply edits, record the outcome, and only then advance review state.

These six changes would make Cortex materially more reliable without making it meaningfully harder to understand.

---

## What Cortex Already Gets Right

### 1. The product framing is correct
The write-up understands that Cortex is not “just another assistant.” It is a **memory governor** and **learning loop**. That is the right framing.

### 2. The injection/reference split is essential
The distinction between:
- always-loaded guidance
- pull-based deep knowledge
- discardable noise

is one of the strongest parts of the design. Many systems fail because they treat all memory as equally worth loading.

### 3. Mandatory delegation is the right instinct
Protecting Cortex’s context window by forcing transcript reading into workers is a good design choice. A singleton analyst should synthesize and curate; it should not burn itself reading raw logs.

### 4. Watermarking shows good operational discipline
Incremental review is the only scalable way to make this work. The scan → review → watermark loop is correct in spirit.

### 5. The prompt acknowledges that self-improvement matters
It is valuable that Cortex is expected to improve not only the memory base, but also its own review process and worker prompt quality.

### 6. Human-facing closeout matters
The requirement for concise, target-specific direct-review closeouts is good. Systems like this become untrustworthy when they act opaquely.

---

## Core Design Risks and Gaps

## 1. The current classification model is internally inconsistent

The design says Cortex has a three-way classification:
- `inject`
- `reference`
- `discard`

But it also says `.cortex-notes.md` is a real stage in the maturity pipeline for tentative observations.

That means the current triage model is missing a first-class outcome.

### Why this matters
A lot of the most valuable signals appear first as weak observations:
- “The user may be shifting toward shorter review closeouts.”
- “This profile may have a recurring environment gotcha.”
- “There may be a cross-project naming convention emerging.”

These are too valuable to throw away, but too weak to inject.

### Recommendation
Change the core outcome model from 3-way to 4-way:

- `note` — plausible, useful, not yet strong enough to promote
- `inject` — active default runtime guidance
- `reference` — durable but too detailed for injection
- `discard` — not worth retaining

This single change will make the rest of the system much cleaner.

---

## 2. Storage tier and epistemic status are conflated

Right now, the design mixes together several different questions:
- Is this true?
- How strongly do we believe it?
- Where should it be stored?
- Should it be always injected?
- Is it still current?

Those should not be collapsed into a single decision.

### Recommendation
Keep the user-facing workflow simple, but require Cortex internally to track at least these dimensions for each candidate finding:

- **Outcome:** `note | inject | reference | discard`
- **Type:** preference | convention | decision | fact | gotcha | procedure | feedback
- **Scope:** common | profile
- **Evidence tier:** explicit-user | trusted-doc | repeated-observation | agent-inference
- **Status:** active | tentative | contested | retired

Not all of this belongs in the injected markdown files. Much of it belongs in a ledger/log layer.

---

## 3. The system is vulnerable to self-reinforcing false memories

This is the most important reliability risk in the current design.

Once Cortex injects a belief into memory, manager agents may start behaving in line with that belief. If Cortex later reviews those sessions, it may falsely interpret the downstream agent behavior as confirmation that the belief was correct.

Example:
- Cortex promotes: “The user prefers terse status updates.”
- Managers become terse because that preference was injected.
- Cortex later sees terse manager behavior in many sessions.
- Cortex incorrectly treats that as stronger evidence that the preference is real.

That is a closed-loop confirmation trap.

### Recommendation
Cortex should distinguish between:

- **Exogenous evidence:** user statements, user corrections, repository docs, explicit feedback, objective outcomes
- **Endogenous evidence:** manager/worker behavior that may have been shaped by previously injected knowledge

Endogenous evidence should **not** be treated as strong confirmation for stylistic or preference claims.

### Practical rule
Use these weights mentally or in a ledger:
- explicit user correction / instruction → strongest
- trusted docs / source-of-truth artifacts → strong
- repeated user-side behavior across sessions → strong
- explicit feedback telemetry → strong
- manager behavior that may have been memory-shaped → weak
- assistant/worker narrative claims → weak unless user-endorsed

This will dramatically reduce “self-made lore.”

---

## 4. `common.md` is at high risk of becoming too broad

The current write-up gives `common.md` a very wide conceptual scope:
- user profile
- workflow preferences
- technical standards
- project landscape
- cross-project patterns
- known gotchas

That is too much for a file injected into *every* agent.

### Main issue
“Project Landscape” in particular does not belong in common injected memory unless the relationships themselves change behavior in a broad way. Most agents do not need a running inventory of all projects at all times.

### Recommendation
Make `common.md` much smaller and stricter. A better default structure is:

```md
# Common Knowledge

## Interaction Defaults
## Workflow Defaults
## Cross-Project Technical Standards
## Cross-Project Gotchas
```

Move project landscape and broader cross-profile topology into a **shared reference** surface, not an always-injected one.

Example new surface:

- `shared/knowledge/reference/index.md`
- `shared/knowledge/reference/projects.md`

### Scope rule
Default to **profile** unless the entry is:
- broadly reusable across profiles
- non-sensitive
- likely to matter in many future runs
- phrased as an actual behavioral default

When in doubt, it should *not* go to common injected memory.

---

## 5. There is no explicit budget enforcement

The design repeatedly says “keep injected memory lean,” but it does not define what lean means.

Without budgets, almost every memory system eventually bloats.

### Recommendation
Add hard and soft budgets.

Suggested starting points:
- `shared/knowledge/common.md`
  - target: under ~800–1200 tokens
  - hard ceiling: ~1500 tokens
- `profiles/<profileId>/memory.md`
  - target: under ~1000–1600 tokens
  - hard ceiling: ~2200 tokens

And add style rules:
- one atomic idea per bullet
- no bullet longer than 2 short lines
- each section should stay intentionally sparse
- adding new injected content that would exceed budget should force one of:
  - merge
  - sharpen
  - demote to reference
  - retire stale content

### Important
A system that says “remember what matters” should always be prepared to *remove* something less important when adding something more important.

---

## 6. The worker templates are inconsistent with the manager prompt

This is a concrete prompt bug.

The system prompt says:
- workers must classify every finding as `inject`, `reference`, or `discard`
- workers should return structured findings
- Cortex reads the artifacts, not raw sessions

But the extraction worker template only asks for:
- category
- evidence
- confidence
- scope
- profile/session

It does **not** explicitly require:
- proposed classification
- proposed destination
- finding type
- source reference granularity
- an ID for deduplication

### Recommendation
Normalize worker outputs.

At minimum, every finding should include:
- `id`
- `statement`
- `type`
- `proposed_outcome`
- `proposed_target`
- `scope`
- `confidence`
- `evidence_tier`
- `sources`
- `reason`

A normalized schema will reduce hallucinated synthesis and make promotion much more deterministic.

---

## 7. There is no dedicated session-memory extraction template

The system prompt explicitly says Cortex should spawn a session-memory extraction worker when session memory changes. But the worker prompt file does not provide a dedicated template for that task.

That is an implementation gap.

### Recommendation
Either:
- add a dedicated **Session Memory Review Worker** template, or
- generalize Template 1 so it supports multiple content kinds:
  - transcript delta
  - session memory delta
  - feedback digest

Right now the prompt set leaves too much room for improvisation.

---

## 8. The scan/triage worker is probably unnecessary overhead

The system prompt already says Cortex can safely run the scan script itself. The scan script returns small bounded output. That means a separate scan worker is usually needless complexity.

### Recommendation
Remove the scan/triage worker template unless there is a platform-specific reason to keep it.

Use delegation for:
- transcript reading
- large or ambiguous extraction
- large synthesis sets

Do **not** delegate tiny deterministic housekeeping tasks that Cortex can do safely itself.

This keeps the architecture simpler and faster.

---

## 9. The feedback telemetry worker prompt hardcodes host paths

Template 4 uses hardcoded paths like:

```bash
/Users/adam/.middleman/...
```

That breaks portability and conflicts with the otherwise clean `${SWARM_DATA_DIR}`-based path model.

### Recommendation
Replace hardcoded paths with placeholders or environment-relative commands everywhere.

This is a concrete fix, not a conceptual one.

---

## 10. Byte-offset review cursors may be fragile

The design assumes workers can read from byte offsets into `session.jsonl` and that this safely represents “already reviewed” vs “new.”

That works only if the file is truly append-only and never rewritten.

### Recommendation
Choose one of these paths explicitly:

### Option A — enforce append-only
If sessions are append-only, say so clearly and keep byte offsets.

### Option B — use more stable review cursors
If sessions may be rewritten, use a more stable cursor:
- message sequence number
- line index
- event ID
- tail hash / digest

### My preference
If append-only is guaranteed, byte offsets are fine and simple.  
If append-only is *not* guaranteed, move away from offsets before this system scales.

---

## 11. There is no explicit transaction model for promotion

The current prompt says:
- snapshot before first edit
- write only when needed
- watermark after successful promotion

That is good, but incomplete.

### Failure mode
If Cortex edits one target file successfully, fails on another, and then partially advances state or forgets what happened, drift and duplication will accumulate.

### Recommendation
Use a promotion manifest and a simple transaction discipline:

1. build candidate changes
2. lint/validate them
3. snapshot target files once
4. apply writes
5. record promotion outcome
6. only then update review watermarks

If any write fails:
- do not advance watermarks
- record failure in a review log
- leave backups available for recovery

If the platform can ever start more than one Cortex, also add a file lock / lease.

---

## 12. Cortex should not freely rewrite its own constitution

The write-up wants self-improvement, which is good. But unrestricted self-editing of the core system prompt is risky.

### Recommendation
Split Cortex’s prompt surfaces into two layers:

### Constitution — human-owned, stable
Contains:
- no secret storage
- mandatory delegation for transcript reading
- scope rules
- promotion safety rules
- write targets
- budget discipline
- evidence conservatism
- watermark discipline

### Policy — Cortex-owned, adaptable
Contains:
- worker prompt templates
- extraction heuristics
- ranking thresholds
- compaction heuristics
- experimental prompt variants

Cortex should be able to improve policy.  
It should not casually rewrite its constitution.

This gives you self-improvement without prompt drift turning into self-corruption.

A similar principle applies to model selection: prefer configuration aliases or capability labels over hardcoded model IDs in prompts. Prompt policy should describe the kind of model needed, while deployment/config decides the actual current model name.

---

## Recommended Target Model

## 1. Treat Cortex as four products, not one

Cortex is currently described mostly as a memory layer. It is better understood as maintaining four related but distinct products:

1. **Injected defaults**
   - small, active, future-facing
   - optimized for runtime use

2. **Reference knowledge**
   - durable, deeper, pull-based
   - optimized for discoverability and usefulness

3. **Working notes**
   - tentative hypotheses and first sightings
   - optimized for learning over time

4. **Evidence / audit ledger**
   - provenance, confidence, supersession, timestamps, review outcomes
   - optimized for correctness and maintainability

The current design clearly has (1), (2), and part of (3).  
It is missing a clean version of (4), and that is the biggest structural gap.

---

## 2. Keep the active docs human-readable; keep the ledger machine-friendly

### Injected and reference docs should remain clean markdown
These files should answer:
- What should the agent know?
- What should it do differently?
- What should it read next if needed?

### Provenance should not clutter injected docs
Do not stuff `common.md` with source citations, timestamps, and audit text. That belongs in a sidecar surface.

### Recommendation
Add something like:

- `shared/knowledge/.cortex-ledger.jsonl`
- or `shared/knowledge/.cortex-ledger.md` if JSONL is not convenient
- plus `shared/knowledge/.cortex-review-log/`

Each promotion event should record:
- finding ID
- statement
- outcome
- target
- scope
- evidence tier
- sources
- first seen / last confirmed
- supersedes / retired_by
- review cycle ID

This will make synthesis, rollback, deduplication, and stale review dramatically easier.

---

## 3. Introduce an evidence ladder

A simple evidence ladder will improve reliability more than almost any amount of prose guidance.

Suggested ladder:

### Tier 4 — explicit user instruction / correction
Examples:
- “I want Cortex closeouts to be concise.”
- “Do not put this in common memory.”
- “Actually I prefer X now.”

Eligible for:
- `inject` or `reference` immediately if durable

### Tier 3 — trusted source-of-truth artifact
Examples:
- `AGENTS.md`
- architecture docs
- repo config conventions
- stable operational docs

Eligible for:
- `reference` immediately
- `inject` if short and behavior-shaping

### Tier 2 — repeated user-side observation
Examples:
- same preference appears across multiple sessions
- same project convention repeated by user or validated workflow

Eligible for:
- `inject` if repeated and strong
- otherwise `note` or `reference`

### Tier 1 — agent-side inference / one-off observation
Examples:
- assistant behavior
- speculative interpretation
- a single ambiguous session signal

Eligible for:
- `note` only, unless later confirmed

### Rule
Do not promote Tier 1 directly into `common.md`.

---

## 4. Add retirement and staleness rules

The write-up mentions retirement, but the policy should be more explicit.

### Recommendation
Every active injected entry should be thought of as one of:
- active
- contested
- retired

And every category should have an implicit staleness expectation.

Examples:
- user communication preferences: long-lived, but update immediately on correction
- tool quirks / environment gotchas: medium-lived, revisit after version changes
- current project priorities: usually reference or notes, not injected defaults

A simple `review_after` or `last_confirmed` field in the ledger is enough.  
The injected files themselves can remain clean.

---

## 5. Add audience awareness if the platform supports it

This is optional, but high value.

Manager agents and code workers do not need exactly the same injected memory.

Examples:
- “User prefers concise status updates” is more relevant to managers than low-level code workers
- “Always run targeted tests before proposing a merge” matters to workers too

### Recommendation
If the platform supports it, add an `audience` field:
- `manager`
- `worker`
- `all`

This can be stored in the ledger and used by the injection layer, without complicating the markdown docs too much.

If the platform does not support audience-based injection yet, treat this as a future improvement, not a requirement.


## 6. Recommended revised operating loop

A cleaner Cortex loop would be:

1. **Scan directly**  
   Cortex runs the bounded scan itself and builds a queue.

2. **Prioritize**  
   Rank by a mix of feedback/corrections, unresolved notes, recency, and delta size.

3. **Delegate bounded extraction**  
   Delegate transcript and changed-session-memory reading to workers. Shard large deltas.

4. **Normalize findings**  
   Require structured candidate findings with explicit outcome, scope, evidence tier, and sources.

5. **Deduplicate against the ledger and active knowledge**  
   Do not compare only against prose in markdown files.

6. **Synthesize**  
   Merge duplicates, resolve scope, and keep contradictory signals out of injected defaults unless they can be phrased conditionally and cleanly.

7. **Validate**  
   Run a promotion lint pass:
   - no secrets
   - no duplicate active entries
   - no contradictory injected defaults
   - budget still within bounds
   - targets are portable / valid

8. **Promote transactionally**  
   Snapshot once, apply edits, record the outcome.

9. **Advance watermarks only after success**  
   Never move review cursors ahead of partially applied writes.

10. **Reflect**  
   Record what worked, what produced noise, and whether any prompt or heuristic changes should be tested.

This keeps the system simple while making the critical reliability points explicit.

## 7. Mixed-authorship safety (recommended if humans may edit memory files)

If humans or non-Cortex agents may ever edit the same markdown files Cortex curates, add managed blocks such as:

```md
<!-- cortex:begin managed -->
...
<!-- cortex:end managed -->
```

Cortex should prefer editing only inside its managed regions and avoid rewriting external notes unless explicitly asked. That reduces accidental clobbering and makes collaboration much safer.

---

## Concrete Prompt and Workflow Changes

## 1. Replace the 3-way classification with a 4-way one

### Current
- inject
- reference
- discard

### Recommended
- `note`
- `inject`
- `reference`
- `discard`

### Prompt-level effect
Wherever the system prompt says “Every finding gets one of three classifications,” replace it with language like:

```md
Every finding gets one of four outcomes:

- **note** — tentative or weakly evidenced, worth retaining in working notes / ledger but not ready for promotion
- **inject** — durable default guidance worth auto-loading into runtime context
- **reference** — durable but too detailed or narrow for default injection
- **discard** — transient, duplicated, low-confidence, or not worth retaining
```

This fixes the biggest conceptual mismatch in the current design.

---

## 2. Add an explicit evidence policy

Recommended addition to the system prompt:

```md
## Evidence policy

Prefer exogenous evidence over endogenous evidence.

Strong evidence:
- explicit user instructions or corrections
- trusted source-of-truth docs
- repeated user-side patterns across sessions
- explicit feedback telemetry

Weak evidence:
- manager/worker behavior that may have been influenced by existing memory
- assistant narrative claims
- one-off inferences

Rules:
- Do not promote weak evidence directly to common injected memory.
- Session-local memory is supporting evidence, not sufficient evidence by itself.
- If evidence is weak but interesting, keep it as a note rather than promoting it.
```

---

## 3. Add a budget and compaction policy

Recommended addition:

```md
## Injected memory budget

Injected memory is a scarce resource.

- Keep `shared/knowledge/common.md` intentionally small.
- Keep `profiles/<profileId>/memory.md` concise and high-signal.
- Prefer one atomic idea per bullet.
- If adding a new injected entry would push a file past its target budget, first merge, sharpen, demote, or retire lower-value content.
- Default to surgical edits, but allow controlled section-level rewrites during dedicated compaction passes after snapshotting.
```

This preserves simplicity while preventing inevitable sprawl.

---

## 4. Add a transaction / promotion manifest policy

Recommended addition:

```md
## Promotion transaction discipline

For each review pass:
1. assemble candidate updates
2. validate and lint them
3. snapshot each target file once immediately before its first real edit
4. apply edits
5. record the promotion result in the review log / ledger
6. only then advance review watermarks

If any write fails, do not advance the corresponding watermarks.
```

---

## 5. Add a constitution vs policy boundary

Recommended addition:

```md
## Self-improvement boundaries

You may improve:
- worker prompt templates
- extraction and ranking heuristics
- compaction heuristics
- your own operational memory and experiments

You may not silently rewrite your constitutional rules:
- secret handling
- transcript-delegation requirement
- scope restrictions
- write targets
- watermark discipline
- injected-memory budget discipline

Constitutional changes require explicit human direction or a separate reviewed change path.
```

This preserves the ability to self-improve without letting the system erode its own safety and reliability constraints.

---

## Worker Prompt Recommendations

## 1. Extraction worker should return normalized candidate findings

The current extraction worker output is too freeform.

### Recommended output schema
The worker can still write markdown, but it should embed a normalized block. Example:

```json
{
  "profile": "{{PROFILE_ID}}",
  "session": "{{SESSION_ID}}",
  "findings": [
    {
      "id": "F1",
      "statement": "Prefer concise, target-specific closeouts after direct reviews.",
      "type": "workflow_preference",
      "proposed_outcome": "inject",
      "proposed_target": "common",
      "scope": "common",
      "confidence": "high",
      "evidence_tier": "explicit_user",
      "audience": "manager",
      "sources": [
        { "kind": "session_message", "ref": "..." }
      ],
      "reason": "Explicit user preference affecting future interaction behavior."
    }
  ],
  "summary": {
    "high_signal_count": 1,
    "note_count": 0,
    "discard_count": 4,
    "blockers": []
  }
}
```

### Additional instructions worth adding
- return at most the top 8 highest-value findings
- prefer atomic statements
- do not promote agent-style observations unless user-confirmed
- if nothing is durable, return zero findings cleanly

---

## 2. Add a dedicated Session Memory Review Worker

Suggested purpose:
- review changes to `profiles/<profileId>/sessions/<sessionId>/memory.md`
- extract only durable signals
- treat session memory as supporting evidence, not authoritative truth

### Key rule
Session-local memory can suggest where to look or what patterns may be emerging, but it should not by itself create common injected lore.

---

## 3. Make the synthesis worker emit concrete change proposals

The synthesis worker should output actions like:
- add new note
- promote note to inject
- add reference entry
- update existing entry
- retire entry
- merge duplicate entries

And each action should include:
- target file
- target section
- reason
- supporting finding IDs
- confidence
- conflict status

This gives Cortex a clearer manifest to work from.

---

## 4. Remove or de-emphasize the scan worker

If Cortex can safely run the scan script directly, the scan worker adds little value and creates unnecessary indirection.

Keep the worker file focused on work that actually benefits from delegation:
- transcript extraction
- session-memory extraction
- feedback review
- large synthesis / reconciliation

---

## 5. Fix the feedback telemetry worker

At minimum:
- remove hardcoded absolute paths
- use env-relative placeholders
- align its outputs with the same classification schema used elsewhere
- let it recommend `note` as well as promotion/no-promotion

---

## Knowledge Surface Recommendations

## 1. Revised `common.md` philosophy

`common.md` should answer one question:

> What defaults should almost any future agent be glad were already loaded?

If the answer is “only in this profile,” “only sometimes,” or “mostly for background context,” it probably does **not** belong in common injected memory.

### Suggested structure

```md
# Common Knowledge
<!-- Maintained by Cortex. Last updated: {ISO timestamp} -->

## Interaction Defaults
## Workflow Defaults
## Cross-Project Technical Standards
## Cross-Project Gotchas
```

### Strong recommendation
Remove “Project Landscape” from the default injected common template.  
Put that in shared reference instead.

---

## 2. Revised profile memory philosophy

`profiles/<profileId>/memory.md` should be the profile’s **active runtime summary**, not its encyclopedia.

Suggested sections:

```md
# <profile-name>
<!-- Maintained by Cortex. Last updated: {ISO timestamp} -->

## Mission
## Architecture Snapshot
## Active Conventions
## Current Gotchas
## Active Decisions
## Reference Triggers
```

### Important
- “Active Decisions” should contain only currently behavior-shaping decisions
- history and rationale belong in `reference/decisions.md`
- “Reference Triggers” should say when to read which deep docs

Example:
- Read `reference/architecture.md` before changing service boundaries or data flow
- Read `reference/gotchas.md` when debugging dev environment or recurring build failures

That is much more actionable than generic pointers.

---

## 3. Add a shared reference surface

Because `common.md` should be sparse, shared cross-profile background knowledge needs somewhere else to live.

Suggested new surfaces:
- `shared/knowledge/reference/index.md`
- `shared/knowledge/reference/projects.md`
- optionally `shared/knowledge/reference/tooling.md`

This is where project landscape and broader cross-profile maps should go if they are useful at all.

---

## 4. Structure `.cortex-notes.md` more deliberately

If you keep notes as markdown, do not leave them as an amorphous scratchpad forever.

Suggested sections:
- Candidate patterns
- Contested observations
- Open questions
- Recently promoted
- Recently retired

Or, better yet, let the ledger hold this and keep `.cortex-notes.md` as a concise human-readable summary.

---

## Operational Recommendations

## 1. Queue prioritization should use more than delta size

Delta size is useful, but not enough.

Better priority signals:
- explicit user corrections
- feedback/downvotes
- new profile or new session with no prior history
- unresolved notes needing confirmation
- recency
- delta size

Large sessions should not automatically outrank small sessions with strong corrective signal.

---

## 2. Shard very large transcript deltas

“One worker per session delta” is good for normal cases. It is not enough for very large deltas.

### Recommendation
If a delta exceeds a threshold, shard it by:
- byte range
- message count range
- time window

Then synthesize those shards before promotion.

This keeps extraction bounded and improves reliability.

---

## 3. Add concurrency limits and singleton discipline

Since Cortex is supposed to be a singleton, protect that assumption operationally.

Recommendations:
- one active Cortex lease / lock
- bounded concurrent extraction workers
- bounded concurrent workers per profile
- no duplicate review on the same session delta while a prior review is in flight

Without this, large backlogs can turn into worker storms and duplicated promotions.

---

## 4. Add a review log

For every review cycle, store a concise outcome log:
- review ID
- timestamp
- reviewed sessions
- promoted items
- retired items
- changed files
- watermark result
- failures/blockers

This can live outside the hot path, but it will be invaluable for debugging and trust.

---

## What Cortex Should Measure

A self-improving system needs a few objective signals.

I would track at least:

1. **Promotion precision**  
   Of promoted entries, how many are later corrected, retired, or contradicted?

2. **Injected budget usage**  
   Token size of `common.md` and each profile memory file over time.

3. **Duplicate / overlap rate**  
   How often does Cortex try to add near-duplicate entries?

4. **Note-to-promotion ratio**  
   Are notes actually maturing into useful knowledge, or becoming a graveyard?

5. **Repeated-mistake rate**  
   After a gotcha is promoted, do related mistakes actually decrease?

6. **User correction rate**  
   If users often correct promoted knowledge, Cortex is overconfident.

### Important
Do not let Cortex grade itself only with self-generated signals.  
Weight user feedback and correction much more heavily than internal narrative confidence.

---

## Suggested Implementation Priority

## P0 — Do these first
These are the highest-value, lowest-regret changes.

1. Add `note` as a first-class outcome
2. Fix worker prompt inconsistencies and normalize findings
3. Add explicit evidence-tier rules
4. Tighten scope rules for `common.md`
5. Remove hardcoded paths from telemetry prompts
6. Add a session-memory review template

## P1 — Do these next
These will materially improve reliability.

1. Add an evidence / promotion ledger
2. Add promotion manifests and review logs
3. Add budget enforcement and compaction rules
4. Add staleness / retirement metadata
5. Add queue prioritization beyond delta size

## P2 — Add if the platform supports it
These are strong improvements but not required for v1.

1. Audience-aware injection (`manager | worker | all`)
2. Shared cross-profile reference surfaces
3. Prompt experiment workflow with tracked outcomes
4. Sharding for very large deltas
5. Singleton lock / lease if concurrent Cortex starts are possible

---

## Bottom Line

The design is already pointed in the right direction. Cortex should absolutely exist, and the current prompt shows good instincts about memory tiers, delegation, and continuous refinement.

My main advice is this:

> **Do not make Cortex remember more. Make it remember more selectively, with better evidence, clearer staging, and stronger separation between active memory and historical proof.**

If I had to reduce all of this to one operating principle, it would be:

> **Only promote what a future agent will be glad was preloaded — and preserve the evidence somewhere else.**

That principle keeps Cortex powerful, reliable, and elegantly simple at the same time.

---

## Appendix — Recommended Minimal Schema for Candidate Findings

This is a good minimum schema for worker outputs and ledger entries:

```json
{
  "id": "string",
  "statement": "string",
  "type": "preference | convention | decision | fact | gotcha | procedure | feedback",
  "proposed_outcome": "note | inject | reference | discard",
  "proposed_target": "common | profile_memory | reference:<file> | notes | none",
  "scope": "common | profile",
  "status": "tentative | active | contested | retired",
  "confidence": "high | medium | low",
  "evidence_tier": "explicit_user | trusted_doc | repeated_observation | agent_inference",
  "audience": "manager | worker | all",
  "sources": [
    {
      "kind": "session_message | session_memory | feedback | doc | repo_instruction",
      "ref": "string"
    }
  ],
  "first_seen": "ISO timestamp",
  "last_confirmed": "ISO timestamp",
  "review_after": "ISO timestamp or null",
  "reason": "short explanation"
}
```

Not all of this needs to appear in the human-facing markdown.  
But Cortex should know this much internally if it wants to improve reliably over time.

---

## Appendix — Specific Prompt Bugs to Fix

1. **Worker template 1 does not require the classification that the system prompt says is mandatory.**
2. **There is no dedicated session-memory extraction template even though the system prompt requires that workflow.**
3. **The scan worker duplicates a direct Cortex-safe action and may be needless complexity.**
4. **The feedback telemetry worker hardcodes absolute paths and breaks portability.**
5. **The core triage model omits notes even though notes are presented as a first-class stage elsewhere.**
6. **The common knowledge template encourages an injected “Project Landscape,” which is likely too broad for default runtime injection.**
7. **Model IDs are hardcoded in prompts; use stable config aliases or capability classes (`fast_extract_model`, `deep_synthesis_model`) so the system can evolve without prompt churn.**
