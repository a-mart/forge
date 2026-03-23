# Research: Cross-Session Pattern Detection for Cortex

## Bottom line

Cortex already has enough persistent state to **promote** durable knowledge, but it does **not** have a durable machine-readable layer for **accumulating weak or repeated signals across review cycles**.

Today the closest thing to cross-session pattern memory is:
- manual notes in `~/.forge/shared/knowledge/.cortex-notes.md`
- promoted end-state knowledge in `common.md` and profile `memory.md`
- audit trails in `.cortex-review-log.jsonl` and `.cortex-review-runs.json`

That means Cortex can *manually notice* recurrence, but it cannot reliably answer questions like:
- “Have I seen this correction in 3 other sessions?”
- “Is this the 4th time users asked for evidence-first debugging?”
- “Is this tool sequence becoming a standard workflow?”
- “Is this pain point getting worse or fading out?”

The lowest-churn design is to add a new shared pattern store under `shared/knowledge/.cortex-patterns/` with:
1. an append-only **signal ledger** (`events.jsonl`)
2. a compact **materialized candidate index** (`active.json`)
3. optional periodic **snapshots** for pruning/compaction

Workers should keep doing per-session review, but they should emit a second structured output: **pattern signals**. Synthesis should stop treating each review cycle as fresh and instead update/consult the pattern store before deciding what to promote.

---

## 1. Current state surfaces

### What Cortex persists today

#### 1) `~/.forge/shared/knowledge/.cortex-notes.md`
This is the real incubation surface today.

Observed behavior:
- Cortex stores tentative signals here.
- It already uses recurrence language manually, e.g.:
  - “needs repeat confirmation before common promotion”
  - “watch for recurrence”
  - “Confirmed as pattern — second sighting ...”
- This proves the product need already exists.

But `.cortex-notes.md` is:
- human-readable, not queryable
- freeform, not normalized
- not easy to score or decay over time
- not safe to use as the canonical intermediate representation

In other words: it is a good notebook, not a good pattern database.

#### 2) `~/.forge/shared/knowledge/.cortex-review-log.jsonl`
This is an audit ledger, not a pattern store.

Observed from the current file:
- 61 review entries
- 40 distinct top-level JSON shapes
- mixed field naming conventions (`changedFiles` vs `changed_files`, `recordedAt` vs `timestamp` vs `ts`)
- mixed semantics (`status`, `outcome`, `promoted`, `noted`, `discarded`, etc.)

That makes it useful for:
- audit/history
- debugging review runs
- knowing what changed

But poor for:
- clustering repeated findings
- counting recurrence by normalized pattern key
- stable scoring over time
- automated pattern matching

It should stay an audit trail, but should **not** be overloaded as the cross-session pattern substrate.

#### 3) `~/.forge/shared/knowledge/common.md`
This is the promoted global/common end-state.

It contains things that already crossed the bar into durable shared knowledge.
That means it is an **output surface**, not a working memory for emerging patterns.

Once something is here, Cortex has already decided it matters. The missing piece is what happens *before* that point.

#### 4) `~/.forge/profiles/*/memory.md`
These are the promoted per-profile end-state summaries.

Current top-level profile memory files exist for:
- `amd-migration`
- `cortex`
- `feature-manager`
- `middleman-project`
- `ortho-hr`
- `ortho-invoice`
- `radops`

These are also output surfaces, not candidate stores.

They are excellent for injected runtime guidance, but they intentionally discard a lot of uncertainty/history, including:
- how many times a signal was seen
- where it was seen first
- whether it was recently contradicted
- whether it is rising or fading

#### 5) `~/.forge/profiles/*/reference/`
Reference directories currently exist for:
- `amd-migration`
- `feature-manager`
- `middleman-project`
- `ortho-invoice`

These are pull-based docs for deeper project detail.
Again: great destination, not a recurrence tracker.

#### 6) `~/.forge/shared/knowledge/.cortex-review-runs.json`
This tracks run requests and interruptions.

It answers:
- what review was requested
- when it was requested
- which session handled it
- whether it was interrupted/requeued

It does **not** answer:
- what repeated behavior was detected across runs
- which weak signals are approaching promotion thresholds

### Current-state summary

Cortex currently has:
- an audit trail
- curated/promoted memory
- freeform notes
- review-run scheduling history

What it lacks is:
- a **durable intermediate representation of candidate patterns**
- a **stable normalized key per pattern**
- a **score/recency/session-diversity model**
- a **way to rehydrate prior patterns into future workers**

---

## 2. What “pattern” should mean concretely

A pattern should be treated as:

> a normalized claim about repeated user behavior, repeated agent behavior, or repeated friction that has been observed in multiple sessions and can influence future Cortex behavior.

I’d use five primary families.

### Pattern taxonomy

| Family | What repeats | Typical evidence | Example normalized key |
|---|---|---|---|
| `repeated_request` | Same kind of ask across sessions | explicit user asks, planning requests, feature framing | `request/root-cause-before-fix` |
| `tool_sequence` | Same tools in same phase/order | programmatic tool-call extraction, worker logs | `toolseq/read>bash>edit>tsc` |
| `manual_workflow` | Same multi-step user-described process | explicit workflow descriptions, approval loops | `workflow/plan-review-implement-verify` |
| `repeated_correction` | Same correction to agent behavior | explicit user corrections, negative feedback comments | `correction/no-speculation-before-evidence` |
| `pain_point` | Same error/friction recurring | feedback, logs, repeated troubleshooting | `pain/workers-miss-callback` |

### 2.1 Repeated user requests
These are the easiest and highest-value patterns.

Examples:
- “Investigate root cause before proposing a fix.”
- “Use workers; managers should orchestrate, not do tool work inline.”
- “Keep responses concise.”
- “Use worktrees for risky changes.”

Best evidence:
- explicit user statements
- same direction across multiple sessions
- corrective feedback when violated

### 2.2 Repeated tool usage patterns
These are procedural patterns, not semantic preferences.

Examples:
- review workers repeatedly do `bash` slice extraction -> `read` -> artifact write
- coding workers repeatedly do `read` -> `bash rg/find` -> `edit` -> typecheck
- validation workers repeatedly do `tsc` in both backend and UI

Important distinction:
- semantic memory should not rely only on tool usage
- but repeated tool sequences can reveal stable workflows or missing productized tools

These patterns are best extracted **programmatically**, not purely by LLM inference.

### 2.3 Repeated manual workflows
These are multi-step processes the user keeps describing.

Examples:
- discovery -> plan -> review -> implementation -> remediation
- commit before merge, then cleanup
- isolated worktree + copied data dir + smoke tests

These often deserve promotion to profile memory or common knowledge once sufficiently repeated.

### 2.4 Repeated corrections
These are especially valuable because they often indicate behavior Cortex should actively change.

Examples:
- stop speculating before checking evidence
- stop repeating affirmations
- stop using overly long responses
- don’t present blocked options when constraints are already known

These should carry extra weight because they are direct behavior-correction signals.

### 2.5 Repeated pain points
These are recurring frictions, failures, or system weaknesses.

Examples:
- workers idling without callback
- status updates missing during long runs
- schema/contract mismatches
- repeated Windows path issues

These do not always belong in injected memory, but they are highly valuable for:
- product prioritization
- prompt refinement
- worker-template changes
- future audits

### Additional classification dimensions
Every pattern candidate should also carry:
- `scope`: `profile` or `common`
- `origin`: `user_behavior`, `agent_behavior`, `system_friction`
- `strength`: `weak`, `moderate`, `strong`
- `volatility`: `stable`, `emerging`, `incident-shaped`

---

## 3. Proposed intermediate representation

## Design goal

Keep this **simple, inspectable, and file-based**.
Do **not** jump straight to embeddings, a database, or opaque clustering.

Recommended location:

```text
~/.forge/shared/knowledge/.cortex-patterns/
  events.jsonl
  active.json
  snapshots/
    2026-03-23.json
    2026-04-01.json
```

This belongs under `shared/knowledge` because:
- patterns can be cross-profile
- Cortex already keeps its other review state there
- it matches the current data layout conventions

### 3.1 `events.jsonl` — append-only signal ledger

This is the raw pattern-signal log.
Each line is one signal emitted by a review worker or programmatic digest.

Example:

```json
{"eventId":"evt_2026-03-23T21:11:04Z_001","recordedAt":"2026-03-23T21:11:04Z","reviewId":"review-11c4f234-303d-4497-a06e-b40130353162","profileId":"middleman-project","sessionId":"slash-commands","sourceKind":"transcript","family":"repeated_correction","scope":"profile","candidateKey":"correction/no-speculation-before-evidence","patternId":"pat_profile_middleman-project_correction_no-speculation-before-evidence","action":"match","statement":"Investigate actual evidence before speculating about causes.","evidenceTier":"explicit_user","weight":5,"confidence":"high","quote":"start with evidence-first investigation... rather than speculative explanations","sourceRef":"session.jsonl#msg-184","artifactPath":"shared/knowledge/.cortex-worker-outputs/slash-commands__transcript.md"}
```

Required fields:
- `eventId`
- `recordedAt`
- `reviewId`
- `profileId`
- `sessionId`
- `sourceKind` (`transcript | session_memory | feedback | tool_digest | error_digest`)
- `family`
- `scope`
- `candidateKey`
- `action` (`new | match | contradict | split | merge_hint | retire_hint`)
- `statement`
- `evidenceTier`
- `weight`
- `confidence`
- `sourceRef`
- `artifactPath`

Optional fields:
- `patternId`
- `quote`
- `toolSequence`
- `errorSignature`
- `feedbackPolarity`

Why keep this file:
- auditability
- future recomputation of scores
- easy debugging
- append-only writes are simple and safe

### 3.2 `active.json` — materialized candidate store

This is the canonical intermediate representation Cortex should actually consult.
It is a compact summary of active and recently promoted patterns.

Example:

```json
{
  "version": 1,
  "updatedAt": "2026-03-23T21:15:00Z",
  "candidates": [
    {
      "patternId": "pat_profile_middleman-project_workflow_worktree-risk-tiering",
      "candidateKey": "workflow/worktree-risk-tiering",
      "family": "manual_workflow",
      "scope": "profile",
      "profileId": "middleman-project",
      "status": "promoted",
      "canonicalStatement": "Use worktrees for risky/non-trivial work; direct-on-main is acceptable for straightforward work.",
      "aliases": [
        "workflow/direct-on-main-exception",
        "workflow/worktree-required-only-for-risky-work"
      ],
      "counts": {
        "signals": 2,
        "sessions": 2,
        "profiles": 1,
        "explicitUser": 2,
        "feedbackSignals": 0,
        "corrections": 0,
        "contradictions": 0
      },
      "score": {
        "current": 10.5,
        "lifetime": 10.5,
        "promotionThreshold": 8,
        "commonThreshold": 12
      },
      "timeline": {
        "firstSeenAt": "2026-03-18T01:50:35Z",
        "lastSeenAt": "2026-03-20T19:12:09Z",
        "lastCompactedAt": "2026-03-23T21:15:00Z"
      },
      "recentEvidence": [
        {
          "profileId": "middleman-project",
          "sessionId": "chome-browser-skill",
          "recordedAt": "2026-03-18T01:50:35Z",
          "evidenceTier": "explicit_user"
        },
        {
          "profileId": "middleman-project",
          "sessionId": "fork-from-message",
          "recordedAt": "2026-03-20T19:12:09Z",
          "evidenceTier": "explicit_user"
        }
      ],
      "resolution": {
        "target": "profiles/middleman-project/memory.md",
        "promotedAt": "2026-03-20T19:12:09Z"
      }
    }
  ]
}
```

### 3.3 Why two files instead of one

Because they serve different jobs:

- `events.jsonl` = immutable raw evidence
- `active.json` = current best compact state

That keeps the system:
- debuggable
- compact
- easy to recompute if scoring changes later

### 3.4 Scoring model

Keep scoring understandable.

Suggested per-signal weights:

| Evidence tier | Weight |
|---|---:|
| `explicit_user` | 5 |
| `feedback_signal` | 4 |
| `repeated_user_pattern` | 4 |
| `trusted_artifact` | 3 |
| `agent_inference` | 1 |

Then apply:

```text
signalContribution = baseWeight * recencyDecay
recencyDecay = 0.5 ^ (ageDays / 45)
currentScore = sum(signalContribution) + sessionDiversityBonus + profileDiversityBonus - contradictionPenalty
```

Suggested bonuses:
- `+1` when seen in 2+ sessions
- `+2` when seen in 3+ sessions
- `+3` when seen in 2+ profiles

Suggested penalties:
- `-2` per explicit contradiction in the last 60 days
- if contradictions >= confirmations in recent window, mark `status: mixed`

### 3.5 Promotion thresholds

Recommended thresholds:

#### Promote to profile memory/reference
Require one of:
- 2+ sessions in same profile and `currentScore >= 8`
- 1 transcript signal + 1 feedback/correction signal and `currentScore >= 8`
- 1 very strong explicit user statement that is clearly future-facing and not session-local

#### Promote to common knowledge
Require all:
- 2+ profiles **or** 3+ sessions with cross-project phrasing
- at least one `explicit_user` or `feedback_signal`
- `currentScore >= 12`
- no unresolved contradiction

#### Keep as candidate only
Use when:
- it is plausible but only one sighting
- it feels incident-shaped
- it is profile-local but destination is unclear

#### Retire
Retire when:
- `currentScore < 2`
- no confirming signal for 120+ days
- contradicted by a newer stable pattern

### 3.6 Pattern evolution

Patterns change. The system needs to model that explicitly.

Add candidate lifecycle states:
- `candidate`
- `confirmed`
- `promoted`
- `mixed`
- `retired`
- `superseded`

And relationship fields:
- `supersedesPatternId`
- `supersededByPatternId`
- `mergedIntoPatternId`
- `splitFromPatternId`

Example:
- initial candidate: “always use worktrees”
- later evidence: “worktrees for risky work; direct-on-main is OK for straightforward work”
- result: older candidate becomes `superseded`

### 3.7 Avoiding unbounded growth

Keep growth bounded with three rules.

#### Rule 1: cap recent evidence retained per candidate
Store only the last:
- 8 evidence refs
- 3 exemplar quotes

#### Rule 2: compact raw events periodically
- keep `events.jsonl` append-only during the month
- write monthly snapshot in `snapshots/YYYY-MM-DD.json`
- optionally prune raw events older than 180 days **after** snapshotting

#### Rule 3: trim stale low-value candidates
On compaction:
- remove `retired` candidates older than 90 days from `active.json`
- keep only a small promoted stub for already-promoted patterns

This avoids turning the store into another bloated freeform notes file.

---

## 4. Worker pipeline changes

## Recommendation

Do **not** replace the current one-session-per-worker review model.
Keep it. Add cross-session awareness around it.

### 4.1 What workers should receive

Before Cortex spawns a review worker, it should load from `active.json`:
- top 5 profile-local active candidates for that profile
- top 5 common/global active candidates
- any `mixed` or unresolved candidates relevant to that profile

Worker prompt should include a compact context block like:

```json
{
  "knownPatterns": [
    {
      "patternId": "pat_profile_middleman-project_correction_no-speculation-before-evidence",
      "family": "repeated_correction",
      "scope": "profile",
      "canonicalStatement": "Investigate actual evidence before speculating.",
      "aliases": ["evidence-first debugging", "no speculative explanations"],
      "status": "confirmed"
    }
  ]
}
```

This lets workers report:
- direct match
- near-match / refinement
- contradiction
- new candidate

### 4.2 What workers should output

Yes: workers should output a structured **pattern signal** block alongside current findings.

Suggested addition to worker artifact schema:

```json
{
  "profile": "middleman-project",
  "session": "slash-commands",
  "source_kind": "transcript",
  "findings": [],
  "pattern_signals": [
    {
      "signalId": "PS1",
      "family": "repeated_correction",
      "action": "match",
      "patternId": "pat_profile_middleman-project_correction_no-speculation-before-evidence",
      "candidateKey": "correction/no-speculation-before-evidence",
      "statement": "Investigate actual routes/logs/behavior before speculating on causes.",
      "scope": "profile",
      "confidence": "high",
      "evidenceTier": "explicit_user",
      "sourceRef": "session.jsonl#msg-184",
      "quote": "investigate actual routes/logs/behavior before speculating"
    }
  ],
  "summary": {
    "finding_count": 1,
    "pattern_signal_count": 1,
    "blockers": []
  }
}
```

### 4.3 Should pattern extraction be separate?

**Default answer: no.**

A separate pass for every session would double review cost and complexity.
For most sessions, the same worker can emit:
- durable findings
- pattern signals

### 4.4 When a dedicated pattern pass *does* make sense

Use separate programmatic passes for the two families that LLMs are worst at extracting consistently:

#### A) Tool sequence mining
Run a script over session/worker logs to extract normalized tool n-grams.

Suggested output event:

```json
{
  "sourceKind": "tool_digest",
  "family": "tool_sequence",
  "candidateKey": "toolseq/read>bash>edit>tsc",
  "toolSequence": ["read", "bash", "edit", "bash:tsc"],
  "sessionSupport": 4
}
```

#### B) Pain-point/error aggregation
Run a script over feedback + error text to cluster recurring issues.

Suggested output event:

```json
{
  "sourceKind": "error_digest",
  "family": "pain_point",
  "candidateKey": "pain/workers-miss-callback",
  "errorSignature": "worker-completed-without-manager-callback",
  "sessionSupport": 3
}
```

So the pipeline should be:
- semantic patterns: extracted inline by review workers
- procedural/error patterns: optionally mined in batch by scripts

### 4.5 Concrete prompt changes

The transcript extraction template should gain a new section:

```text
## Known Pattern Candidates
{{KNOWN_PATTERNS_JSON_OR "No known pattern candidates yet."}}

For any durable signal you see, decide whether it:
1. matches an existing candidate
2. refines/splits an existing candidate
3. contradicts an existing candidate
4. seeds a new candidate

Include a `pattern_signals` JSON block in your output.
Prefer normalized candidate keys like:
- correction/no-speculation-before-evidence
- workflow/plan-review-implement-verify
- pain/workers-miss-callback
```

That is a low-churn prompt change and does not require redesigning the whole review system.

---

## 5. Synthesis evolution

Today synthesis mainly does:
- dedupe worker findings
- decide note vs memory vs reference vs no-op

With a pattern store, synthesis should do three jobs instead.

### 5.1 Job 1: update the candidate store

Before deciding promotion, synthesis should reconcile incoming pattern signals against `active.json`.

New synthesis actions should include:
- `create_candidate`
- `confirm_candidate`
- `merge_candidates`
- `split_candidate`
- `mark_mixed`
- `promote_candidate`
- `retire_candidate`

Suggested addition to synthesis output:

```json
{
  "pattern_actions": [
    {
      "action": "confirm_candidate",
      "patternId": "pat_profile_middleman-project_correction_no-speculation-before-evidence",
      "scoreBefore": 6.2,
      "scoreAfter": 11.1,
      "reason": "Second explicit user correction in a different session within 14 days."
    }
  ]
}
```

### 5.2 Job 2: use cross-session evidence when deciding promotion

Instead of asking “is this single session strong enough?”, synthesis should ask:

- is this already a known emerging pattern?
- did this sighting push it across threshold?
- is the new signal a contradiction that should weaken an old rule?
- does this belong in memory, reference, or still just candidate state?

This is the key behavior change.

### 5.3 Job 3: support cross-cycle synthesis without rereading sessions

Once pattern signals accumulate, Cortex should be able to run a periodic cross-session synthesis worker that reads only:
- `active.json`
- recent `events.jsonl`
- current `common.md`
- relevant profile `memory.md`

That worker can answer:
- what is emerging but not promoted yet?
- what promoted rules have gone stale?
- what repeated pain points should influence prompts or product work?

This is the biggest leverage gain: cross-session learning **without replaying every session again**.

### 5.4 Suggested periodic jobs

#### After each review batch
- append new pattern events
- recompute/update `active.json`

#### Nightly
- run a cross-session pattern synthesis pass
- propose promotions/retirements
- compact stale candidates

#### Weekly
- snapshot pattern state
- prune very old raw events

---

## 6. Recommended file formats and data model

## Minimal viable design

If the goal is low churn, start with exactly two new files:

```text
~/.forge/shared/knowledge/.cortex-patterns/events.jsonl
~/.forge/shared/knowledge/.cortex-patterns/active.json
```

That is enough for v1.

### `events.jsonl` is the source of truth for raw pattern evidence
Good for:
- append-only writes
- debugging
- recomputing scores later

### `active.json` is the source of truth for current candidate state
Good for:
- worker context injection
- promotion thresholds
- nightly synthesis
- bounded size

### What not to do in v1
Avoid in the first version:
- embeddings/vector search
- fuzzy clustering via external service
- a new database
- per-pattern markdown files
- a giant always-growing notes document

Those can come later if needed, but they are unnecessary for the observed scale.

---

## 7. Concrete rollout plan

### Phase 1 — pattern memory foundation
Add the new pattern store and keep everything file-based.

Deliverables:
- `shared/knowledge/.cortex-patterns/events.jsonl`
- `shared/knowledge/.cortex-patterns/active.json`
- worker prompt update to emit `pattern_signals`
- manager logic to append events and refresh `active.json`

Value:
- Cortex finally knows “I’ve seen this before”
- no session rereads required for recurrence tracking

### Phase 2 — threshold-aware synthesis
Update synthesis so it consults the candidate store.

Deliverables:
- synthesis reads known candidate state
- promotion decisions use score/session/profile diversity
- contradiction handling and supersede logic

Value:
- promotions stop being purely per-session
- Cortex can promote patterns earlier and more confidently

### Phase 3 — batch digests for tool/error patterns
Add programmatic pattern mining.

Deliverables:
- tool-sequence digest
- error/pain-point digest
- periodic compaction/snapshot job

Value:
- catches patterns LLM review workers will miss or inconsistently phrase

---

## 8. Recommended answer to each investigation question

### 1) Current state surfaces
Cortex currently has:
- freeform note-taking (`.cortex-notes.md`)
- audit history (`.cortex-review-log.jsonl`)
- run history (`.cortex-review-runs.json`)
- promoted common knowledge (`common.md`)
- promoted profile memory (`profiles/*/memory.md`)
- pull-based reference docs (`profiles/*/reference/`)

It does **not** currently have a machine-readable candidate-pattern layer.

### 2) What “pattern” means concretely
Use five families:
- repeated requests
- tool sequences
- manual workflows
- repeated corrections
- repeated pain points

### 3) Intermediate representation design
Use:
- `shared/knowledge/.cortex-patterns/events.jsonl`
- `shared/knowledge/.cortex-patterns/active.json`
- optional `snapshots/`

with weighted recurrence, recency decay, session/profile diversity, contradiction handling, and bounded compaction.

### 4) Worker pipeline changes
Workers should:
- receive compact known-pattern context
- emit structured `pattern_signals`
- continue doing normal per-session findings

Do **not** add a separate pattern pass by default.
Use dedicated programmatic passes only for:
- tool sequence mining
- pain/error aggregation

### 5) Synthesis evolution
Synthesis should:
- update candidate state first
- then decide promotion/demotion based on cross-session evidence
- support periodic cross-session synthesis from pattern state alone

---

## 9. Final recommendation

The best next step is **not** to redesign Cortex review from scratch.
It is to insert one missing layer between review artifacts and promoted memory:

> a persistent, normalized, scored pattern-candidate store.

That gives Cortex an explicit answer to:
- “I’ve seen this once”
- “I’ve seen this twice in the same profile”
- “I’ve seen this across multiple profiles”
- “This old rule is being contradicted by newer evidence”

In practice, the v1 solution should be:
- file-based
- append-only at the event layer
- compact/materialized at the candidate layer
- injected into workers as lightweight context
- consulted by synthesis before promotion

That is concrete, incremental, and aligned with the current Cortex architecture.