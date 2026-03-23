# Skill Synthesis Design

## 1. Executive summary

Cortex should start with a narrow goal: detect repeated automation opportunities during its existing review flow, persist them in a small Cortex-owned candidate file, and proactively offer the user a slash command or instructions-only skill. Phase 1 should **not** start with a generic pattern database, telemetry platform, dashboard, or script generation system; those all add complexity before the core loop is proven. The shortest path is: **review worker notices recurrence -> Cortex records a candidate -> Cortex drafts an artifact -> user approves in chat -> artifact is installed locally**.

---

## 2. Architecture

### Core design choice

For this feature, **pattern state should not live in a generic event ledger first**. The system already has raw audit surfaces:
- worker artifacts
- `.cortex-review-log.jsonl`
- reviewed session transcripts
- existing notes/memory

What is missing is a compact, durable answer to: **"is this recurring enough to propose automation yet?"**

So the canonical Phase 1 state should be a **single materialized candidate store**, not a full event-sourcing system:

- `shared/knowledge/.cortex-skill-candidates.json`
- optional draft artifacts under `shared/knowledge/.cortex-skill-drafts/`

That file should track only what skill synthesis actually needs:
- candidate key
- proposed artifact type (`slash_command` or `skill`)
- status (`observing`, `ready_to_propose`, `proposed`, `accepted`, `installed`, `dismissed`)
- evidence count
- distinct sessions seen
- last seen timestamp
- short normalized summary
- supporting quotes/refs
- whether the user said “don’t suggest again”

### Why this is better than starting with logs

A raw ledger is useful for forensics and recomputation, but it is the wrong first abstraction for Cortex behavior. Cortex needs a **small working set** it can inject into future synthesis, not a second audit trail it must re-parse every time.

For Phase 1:
- **candidate store is sufficient**
- existing review artifacts are enough audit history
- telemetry logs can wait until adoption measurement matters

### End-to-end data flow

1. **Session review runs as it does today.**
   - Transcript extraction workers keep reading single-session deltas.
   - No new standalone “pattern miner” is introduced.

2. **Workers emit automation signals alongside normal durable findings.**
   - These are not broad pattern-taxonomy objects.
   - They are narrow “automation opportunity” records.

   Example shape:

   ```json
   {
     "candidate_key": "review/pr-structured",
     "artifact_type": "slash_command",
     "summary": "User repeatedly asks for the same structured PR review pass.",
     "confidence": "high",
     "evidence_kind": "explicit_user_request",
     "source_ref": "session.jsonl#msg-184",
     "quote": "review the PR for correctness, tests, regressions, and edge cases"
   }
   ```

3. **Cortex synthesis deduplicates and updates `.cortex-skill-candidates.json`.**
   - Merge matching candidates.
   - Increment counts.
   - Record newest supporting refs.
   - Move status from `observing` -> `ready_to_propose` when threshold is crossed.

4. **When ready, Cortex drafts the artifact.**
   - Slash command draft: JSON-like preview with `name` + `prompt`
   - Skill draft: `SKILL.md` preview only, instructions-only, no scripts
   - Drafts are stored in `shared/knowledge/.cortex-skill-drafts/` so the user can inspect them

5. **Cortex proposes in the existing chat UX.**
   - Send a short proactive message in the Cortex session
   - Use `present_choices`
   - Choices: `Install`, `Edit first`, `Not now`, `Don't suggest again`

6. **On approval, Cortex installs locally.**
   - Slash command -> existing slash-command path/CLI
   - Skill -> write to `~/.forge/skills/<name>/SKILL.md`
   - Generated skills should be **local-only by default**, not repo-committed `.swarm/skills`

7. **Candidate store is updated with the outcome.**
   - accepted / installed / dismissed / suppressed

### Clear rule: slash command vs skill

Default to the simpler artifact.

Generate a **slash command** when all of these are true:
- the pattern is primarily a reusable prompt template
- it only helps when the **user explicitly invokes it**
- it does not need tool-specific instructions, safety rules, or conditional workflow logic

Generate a **skill** only when all of these are true:
- the pattern is a reusable agent workflow or policy, not just a prompt snippet
- it should help **workers/managers without the user typing a command each time**
- it needs multi-step instructions, sequencing, or guardrails
- the target runtime path actually supports skills reliably

If uncertain, **prefer slash command**.

### Important runtime caveat

The current research found likely **pi/Codex skill-path asymmetry**. That means generated skills should not become the default recommendation until runtime support is confirmed for the target path. This is another reason to make the MVP **slash-command-first** and use skills selectively.

---

## 3. Phase 1 (MVP)

### Goal

Prove the loop from recurring pattern detection to approved artifact installation with the fewest moving parts.

### What Phase 1 includes

- add automation-signal extraction to existing Cortex review workers
- add a small Cortex-owned candidate store
- have Cortex draft and propose artifacts in chat
- support:
  - slash commands
  - instructions-only skills
- require explicit user approval before install

### What Phase 1 does **not** need

- no telemetry
- no counters
- no dashboard work
- no vector search / clustering
- no generated scripts
- no rewrite of slash-command execution

### Smallest modification to the existing Cortex review pipeline

Only change the existing worker outputs enough to surface automation opportunities.

#### Transcript workers
This is the highest-value source for Phase 1 because repeated user asks are the cleanest signal.

Add one new output section:
- `Automation Signals (JSON)`

This should capture only:
- repeated prompt template opportunities
- repeated workflow instructions
- repeated user corrections that could become a reusable skill rule

#### Synthesis worker
Teach synthesis to:
- dedupe automation signals
- upsert them into `.cortex-skill-candidates.json`
- decide whether a candidate is still `observing` or `ready_to_propose`

#### Session-memory / feedback workers
Do **not** make them first-class drivers for Phase 1.
- Session memory can add supporting evidence later.
- Feedback can matter in Phase 2.

That is the cleanest scope cut.

### Recommendation thresholds

Keep thresholds simple and readable.

#### Slash command candidate becomes `ready_to_propose` when:
- seen in **3 distinct sessions**, or
- seen in **2 sessions** with at least one explicit user phrasing that already looks like a reusable prompt

#### Skill candidate becomes `ready_to_propose` when:
- seen in **2 distinct sessions** as the same multi-step workflow or correction, and
- the resulting artifact clearly needs instructions rather than plain prompt text

#### Immediate suppression rules
Do not propose if:
- the candidate is obviously session-local
- it duplicates an existing slash command or skill
- the user already dismissed it recently
- runtime support for a skill is unclear and a slash command would cover the use case

### Candidate file shape

A minimal schema is enough:

```json
{
  "version": 1,
  "updatedAt": "2026-03-23T22:00:00Z",
  "candidates": [
    {
      "key": "review/pr-structured",
      "artifactType": "slash_command",
      "status": "observing",
      "summary": "Structured PR review request repeats across sessions.",
      "sessionIds": ["s1", "s2"],
      "evidenceCount": 2,
      "lastSeenAt": "2026-03-23T22:00:00Z",
      "quotes": [
        "review the PR for correctness, tests, regressions, and edge cases"
      ],
      "suppressed": false
    }
  ]
}
```

### Recommended files to change

#### Prompt / Cortex behavior
- `apps/backend/src/swarm/operational/builtins/cortex-worker-prompts.md`
  - add `Automation Signals (JSON)` to transcript extraction output
  - add automation-candidate reconciliation to synthesis prompt
- `apps/backend/src/swarm/archetypes/builtins/cortex.md`
  - document the new candidate store, thresholds, and proposal flow
  - instruct Cortex to prefer slash commands when in doubt

#### Small backend support
- `apps/backend/src/swarm/data-paths.ts`
  - add helpers for:
    - `.cortex-skill-candidates.json`
    - `.cortex-skill-drafts/`
- `apps/backend/src/swarm/scripts/cortex-skill-candidates.ts` (new)
  - tiny helper to read/upsert/update candidate JSON safely
  - avoids brittle prompt-driven JSON surgery

### Estimated scope

**Complexity:** small-to-medium  
**Churn:** low  
**Code footprint:** roughly 4 touched files + 1 new helper script  
**Product surface change:** none required; proposal UX can use existing chat + `present_choices`

### Why this is the right MVP

Because it proves the valuable part first:
- Can Cortex notice repetition?
- Can it turn that into a good artifact?
- Do users actually want the suggestions?

If that loop is weak, telemetry and automation sophistication will not save it.

---

## 4. Phase 2

### Goal

Add a measurement loop so Cortex can learn which generated artifacts are actually used and which should be retired or refined.

### What changes in Phase 2

Introduce **append-only telemetry events**, but only after the candidate/recommendation loop exists.

#### New telemetry events
- `skill_used`
- `slash_command_used`

#### Storage
Use append-only JSONL under shared telemetry, for example:
- `shared/telemetry/skill-usage.jsonl`
- `shared/telemetry/slash-command-usage.jsonl`

No counters yet. Derive aggregates offline.

### Why telemetry is Phase 2, not Phase 1

Telemetry does **not** help Cortex make the first good recommendation. Review extraction already tells Cortex that a repeated ask exists.

Telemetry becomes useful only after install, to answer:
- was the artifact adopted?
- was it ignored?
- should Cortex suggest revising or retiring it?

### Required implementation changes

#### Slash command usage capture
Because custom slash commands expand in the UI before submit, usage must be preserved through the client command path.

Files likely involved:
- `packages/protocol/src/client-commands.ts`
  - add optional slash-command submit metadata on `user_message`
- `apps/ui/src/components/chat/MessageInput.tsx`
  - keep selected slash command identity until submit
- `apps/ui/src/routes/index.tsx`
  - pass slash-command metadata through send path
- `apps/ui/src/lib/ws-client.ts`
  - include slash-command metadata in `user_message`
- `apps/backend/src/ws/ws-command-parser.ts`
  - validate the new payload
- `apps/backend/src/swarm/swarm-manager.ts`
  - append `slash_command_used` on receipt

#### Skill usage capture
The lowest-churn trigger is still: **backend observes a `read` of a discovered `SKILL.md` path**.

Files likely involved:
- `apps/backend/src/swarm/skill-metadata-service.ts`
  - expose path lookup / normalization helpers
- `apps/backend/src/swarm/conversation-projector.ts` or `apps/backend/src/swarm/swarm-manager.ts`
  - detect `read` calls against known skill paths
- `apps/backend/src/swarm/data-paths.ts`
  - add telemetry path helpers
- `apps/backend/src/swarm/telemetry-service.ts` (new)
  - append JSONL events safely

### What Cortex does with telemetry

Once telemetry exists, Cortex can:
- rank accepted artifacts by actual usage
- identify “accepted but never used” suggestions
- avoid repeatedly pitching skill types the user ignores
- suggest retirement of stale generated artifacts
- join rough telemetry + feedback for quality signals

### What still waits

Even in Phase 2:
- no analytics database
- no real-time counters in settings
- no heavy dashboard build
- no attempt to perfectly infer causal impact from feedback

---

## 5. Phase 3

### Goal

Move from assisted recommendation to cautious autonomous improvement.

### What Phase 3 includes

#### 1. Better drafting
Cortex drafts higher-quality artifacts from accumulated candidate evidence:
- cleaner slash command names/prompts
- more opinionated instructions-only skills
- better duplicate detection against existing user-created artifacts

#### 2. Recommendation refinement
Use telemetry + outcomes to adjust behavior:
- if slash commands are consistently accepted and used, bias toward them
- if long instruction skills are ignored, reduce those suggestions
- if a slash command is used heavily and repeatedly expanded into multi-step follow-ups, propose upgrading it into a skill

#### 3. Lifecycle management
Cortex can propose:
- retiring stale generated artifacts
- revising underused ones
- merging duplicates
- replacing a poor slash command with a better skill draft, or vice versa

#### 4. Optional dashboard support
Only after the chat-first flow works well, add a Cortex dashboard panel for:
- pending proposals
- accepted/rejected history
- generated artifact inventory
- telemetry summaries

### Autonomy boundary

Even in Phase 3, installation and destructive changes should still require explicit user approval.

Reasonable autonomy:
- draft automatically
- rank proposals automatically
- surface retirement suggestions automatically

Unreasonable autonomy:
- auto-install
- auto-update user-edited skills
- auto-delete active artifacts

### Scope guard for Phase 3

“Autonomous generation” should still mean:
- slash commands
- instructions-only skills

It should **not** mean generated executable scripts unless that becomes a separate, explicitly approved project.

---

## 6. Open questions

1. **Codex skill parity**  
   The research suggests Codex runtime may not consume skills the same way pi does. If that remains true, Cortex should either gate skill recommendations by runtime or keep Phase 1 mostly slash-command-first.

2. **Global vs profile-scoped generated skills**  
   Current local skills are global to the machine. That is acceptable for MVP, but long term many generated workflows are probably profile-specific.

3. **Suppression semantics**  
   Should “don’t suggest again” suppress only one candidate key, one artifact type, or an entire category for a profile?

4. **Existing-artifact collision handling**  
   What is the best dedupe rule when a user already has a similar slash command or skill with different naming?

5. **Promotion boundary vs memory**  
   Some repeated corrections are better handled as profile memory/prompt guidance than as a skill. Cortex will need a crisp “memory vs automation” rule to avoid turning every preference into a generated artifact.

6. **When to upgrade command -> skill**  
   Heavy use alone is not enough; the upgrade should happen only when the command’s real workflow repeatedly spills into multi-step agent behavior.

---

## 7. What NOT to build

- **Do not build a generic cross-session pattern platform first.** Skill synthesis does not need a broad taxonomy, recency decay engine, or complex candidate graph to get started.
- **Do not block Phase 1 on telemetry.** Extraction is enough to find the first good opportunities.
- **Do not move custom slash-command expansion server-side just for telemetry.** Preserve command identity on submit instead.
- **Do not build a dashboard-first approval flow.** The natural UX is a proactive Cortex chat message with `present_choices`.
- **Do not generate executable scripts.** Start with slash commands and instructions-only skills only.
- **Do not auto-install or auto-edit artifacts without approval.** User trust matters more than full autonomy.
- **Do not commit generated skills into repo `.swarm/skills` by default.** They should start as local-only user customizations.
- **Do not try to infer too much from tool sequences in Phase 1.** Repeated explicit user asks are a much cleaner signal than mined tool n-grams.

---

## Final recommendation

Start narrow and ship the recommendation loop first. The right first implementation is **not** a generalized pattern-memory subsystem; it is a small Cortex-owned candidate file plus a prompt-level extension to the existing review workers. If that works, telemetry and self-improvement have a solid substrate; if it does not, the cheaper MVP will expose that quickly without leaving behind a large unused architecture.
