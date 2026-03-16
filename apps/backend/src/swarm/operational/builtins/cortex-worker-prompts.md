# Cortex Worker Prompt Templates — v4
<!-- Cortex Worker Prompts Version: 4 -->

> Owned by Cortex. Refine these templates over time based on what produces good vs bad results from workers.

Use these templates when spawning workers. Copy the relevant template, fill in the placeholders (marked with `{{...}}`), and send as the worker's task message.

Model-selection guidance:
- Cortex chooses the actual runtime model.
- Default to a cheap/fast extraction model for narrow transcript work.
- Retry with a more reliable balanced model if the fast path idles or emits no output.
- Escalate to a deep-synthesis model for ambiguity, conflict resolution, or large reconciliation passes.

---

## Promotion Discipline (all templates)

Default to **precision over coverage**.

- A clean **no durable findings** result is good work.
- Prefer **discard** over weak promotion.
- Prefer **note** over weak `inject` / `reference` proposals.
- Prefer **reference** over **inject** for narrow procedures, command catalogs, troubleshooting flows, and task-local runbooks.
- Only use **inject** when the finding should change future agent behavior by default within its scope.
- Distill findings into future-facing guidance. Do not copy transcript chronology, long command sequences, or logs unless the exact string is itself the durable convention.
- Cap retained findings to the strongest few. Merge overlaps instead of emitting near-duplicates.
- Prioritize explicit user statements, trusted artifacts, explicit feedback, and repeated user-side patterns over assistant chatter.

## Evidence Discipline (all templates)

Prefer **exogenous evidence** over **endogenous evidence**.

Stronger evidence:
- explicit user instructions or corrections
- trusted source-of-truth artifacts (`AGENTS.md`, stable design docs, configs)
- explicit feedback telemetry
- repeated user-side patterns across sessions

Weaker evidence:
- manager/worker behavior that may have been shaped by existing memory
- assistant narrative claims
- session-memory text by itself
- one-off inferences from ambiguous context

Rules:
- Do not propose weak evidence directly for `common` injected memory.
- Treat session memory as supporting evidence, not authoritative truth.
- If a signal is interesting but weak, return it as `note`.

## Required Finding Schema (all extraction templates)

Write markdown, but include one fenced `json` block containing this normalized shape:

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

Schema rules:
- cap retained findings to the strongest 8 unless the task explicitly asks for fewer
- prefer atomic claims rather than bundled paragraphs
- return empty `findings` if nothing durable exists
- do not substitute a prose session summary for structured findings

---

## Callback Format (all templates)

Every worker MUST send a final callback to the manager via `send_message_to_agent` in this format:

```
STATUS: DONE | FAILED
FINDINGS: <count>
ARTIFACT: <path to output file>
BLOCKER: <none | brief description>
```

Detailed reasoning and full findings go in the output artifact file, NOT in the callback message.

---

## 1. Session Transcript Extraction Worker

Use for: Reviewing a single session's transcript delta and extracting durable knowledge signals.

```
You are a knowledge extraction worker for Cortex.

## Task
Review only the transcript delta that starts at byte offset {{BYTE_OFFSET}} in `{{SESSION_JSONL_PATH}}`.

Important: the `read` tool offset is line-based, NOT byte-based. Do NOT pass {{BYTE_OFFSET}} into `read` directly.

Use this workflow:
1. If `{{BYTE_OFFSET}}` is greater than 0, use `bash` with Python/Node to copy the transcript slice starting at byte offset {{BYTE_OFFSET}} into `{{DELTA_SLICE_PATH}}`.
2. Read `{{DELTA_SLICE_PATH}}` with the `read` tool.
3. If `{{BYTE_OFFSET}}` is 0, you may read the original session file directly.

The file is JSONL. Prioritize `user_message` entries, then explicit decisions or conventions stated elsewhere. Treat assistant behavior that may have been shaped by existing memory as weak evidence.

## Extract only durable signals
Examples:
- user preferences
- workflow patterns
- technical decisions
- project facts
- quality standards
- working conventions
- recurring gotchas
- cross-project patterns

## Skip
- transient task details
- implementation minutiae
- secrets
- ephemeral progress chatter
- raw code unless it clearly reveals a durable convention
- long runbooks unless the exact command/name is itself the durable convention

## Output
Write markdown to `{{OUTPUT_ARTIFACT_PATH}}` with:
1. `Outcome: promote | no-op | follow-up-needed`
2. `Why:` one short paragraph
3. `Candidate Findings (JSON)` containing the required normalized schema with:
   - `profile: "{{PROFILE_ID}}"`
   - `session: "{{SESSION_ID}}"`
   - `source_kind: "transcript"`
4. `Discarded candidates` with brief bullets for tempting but weak/transient signals
5. `Concise completion summary` with 1-3 bullets Cortex could reuse in a user closeout

Additional rules:
- At most 8 retained findings.
- Use `note` when the signal is plausible but not strong enough to promote.
- Do not promote weak evidence directly to `common`.
- Do not summarize the whole session.

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
```

---

## 2. Session-Memory Extraction Worker

Use for: Reviewing a session working-memory file for signals worth promoting or preserving as notes.

```
You are a session-memory review worker for Cortex.

## Task
Read the session memory file at `{{SESSION_MEMORY_PATH}}`.

For context, the current profile memory is:
{{PROFILE_MEMORY_CONTENT_OR "Profile memory is currently empty."}}

## Evidence rule
Session memory is supporting evidence, not authoritative truth. If a claim is interesting but not independently strong, return it as `note`.

## What to look for
- durable decisions or conventions
- corrections to existing profile memory
- architecture/gotcha signals worth remembering
- patterns not yet captured in profile memory

## What to skip
- active task state and in-progress work items
- duplicates of existing profile memory
- speculative notes without support
- Cortex-internal orchestration details
- long procedural detail better suited for reference

## Output
Write markdown to `{{OUTPUT_ARTIFACT_PATH}}` with:
1. `Outcome: promote | no-op | follow-up-needed`
2. `Why:` one short paragraph
3. `Candidate Findings (JSON)` containing the required normalized schema with:
   - `profile: "{{PROFILE_ID}}"`
   - `session: "{{SESSION_ID}}"`
   - `source_kind: "session_memory"`
4. `Discarded candidates`
5. `Concise completion summary`

Additional rules:
- Prefer `note` when the signal is not independently confirmed.
- Default target is `profile_memory`, `reference/<file>.md`, or `notes`.
- Do not create common injected lore from session memory alone.

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
```

---

## 3. Knowledge Synthesis Worker

Use for: Deduplicating multiple worker artifacts into promotion-ready actions.

```
You are a knowledge synthesis worker for Cortex.

## Task
Below are raw findings from multiple worker artifacts. Deduplicate, reconcile conflicts, and produce promotion-ready actions.

## Raw findings
{{PASTE_ALL_WORKER_FINDINGS_HERE}}

## Current knowledge state
{{PASTE_RELEVANT_EXISTING_KNOWLEDGE_OR "No existing entries — all findings are new."}}

## Instructions
1. Deduplicate overlapping findings.
2. Reconcile conflicts and flag tensions explicitly.
3. Keep only findings that add new durable signal.
4. Validate each retained finding's proposed outcome and target.
5. Prefer no-op over marginal promotion.

## Output
Write markdown to `{{OUTPUT_ARTIFACT_PATH}}` with:
1. `Outcome: promote | no-op | follow-up-needed`
2. `Recommended Actions (JSON)` in this shape:

```json
{
  "actions": [
    {
      "action": "add_note | promote_to_inject | promote_to_reference | update_entry | retire_entry | merge_duplicate | no_change",
      "target_file": "relative/path.md | notes | none",
      "target_section": "section name or managed block",
      "finding_ids": ["F1"],
      "confidence": "high | medium | low",
      "conflict_status": "none | tension | blocked",
      "proposed_text": "concise future-facing text",
      "reason": "why this action is appropriate"
    }
  ],
  "summary": {
    "promote_count": 0,
    "note_count": 0,
    "discard_count": 0,
    "blockers": []
  }
}
```

3. `Discarded / no-op findings`
4. `Open tensions or blockers`
5. `Concise completion summary` with 2-4 bullets Cortex can adapt into a short user-facing completion

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
```

---

## 4. Scan / Triage Worker (fallback only)

Use for: Optional fallback when Cortex cannot safely run the bounded scan directly.

```
You are a scan and triage worker for Cortex.

## Task
Only use this worker if Cortex explicitly asked for delegated scan help. Cortex normally runs the bounded scan itself.

1. Execute: `bash node {{SWARM_SCRIPTS_DIR}}/cortex-scan.js {{SWARM_DATA_DIR}}`
2. Parse transcript, memory, and feedback drift.
3. Sort by the requested priority rule.

## Output
Write results to `{{OUTPUT_ARTIFACT_PATH}}`:
- `Review Queue` table
- `Summary` bullets
- `Notable priority drivers`

Do NOT read any session files.

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
```

---

## 5. Feedback Telemetry Worker (programmatic-first)

Use for: Feedback-system reviews where you want structured signal without reading whole sessions manually.

```
You are a feedback telemetry worker for Cortex.

## Task
Use scripts and structured outputs first.

1. Run one or more telemetry scripts as needed:
   - `node {{SWARM_SCRIPTS_DIR}}/feedback-review-queue.js {{SWARM_DATA_DIR}}`
   - `node {{SWARM_SCRIPTS_DIR}}/feedback-session-digest.js {{SWARM_DATA_DIR}} --profile {{PROFILE_ID}} --session {{SESSION_ID}}`
   - `node {{SWARM_SCRIPTS_DIR}}/feedback-global-summary.js {{SWARM_DATA_DIR}}`
2. Identify high-signal anomalies.
3. Only if needed, run targeted context extraction:
   - `node {{SWARM_SCRIPTS_DIR}}/feedback-target-context.js {{SWARM_DATA_DIR}} --profile {{PROFILE_ID}} --session {{SESSION_ID}} --target {{TARGET_ID}}`

## Output
Write markdown to `{{OUTPUT_ARTIFACT_PATH}}` with:
1. `Outcome: promote | no-op | follow-up-needed`
2. `Programmatic digest`
3. `Candidate Findings (JSON)` containing the required normalized schema with:
   - `profile: "{{PROFILE_ID}}"`
   - `session: "{{SESSION_ID}}"`
   - `source_kind: "feedback"`
4. `Data quality issues`
5. `Concise completion summary`

Additional rules:
- Allow `note` when feedback reveals a plausible pattern but not a promotion-ready one.
- Treat explicit negative/positive feedback as stronger evidence than assistant narration.
- Never include secrets.

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
```

---

## 6. Orchestration Kickoff Worker

Use for: Planning a review cycle from scan results.

```
You are an orchestration planning worker for Cortex.

## Task
Given scan results, produce a concrete execution plan.

## Scan results
{{SCAN_RESULTS_OR_ARTIFACT_CONTENT}}

## Constraints
- Max concurrent workers: {{MAX_WORKERS | default: 5}}
- Use the current fast extraction default first.
- Prefer balanced fallback for reliability retries.
- Escalate to deep-synthesis model only for ambiguity/high-complexity work.

## Output
Write plan to `{{OUTPUT_ARTIFACT_PATH}}` with:
- execution batches
- risk flags
- synthesis plan
- likely no-op targets vs likely promotion/note targets

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
```

---

## 7. Deep Audit Worker

Use for: Auditing knowledge files for stale entries, scope drift, contradictions, and bloat.

```
You are a knowledge audit worker for Cortex.

## Task
Audit the listed knowledge files for quality and scope correctness.

## Files to audit
{{LIST_OF_FILES_TO_AUDIT}}

## Current file contents
{{PASTE_FILE_CONTENTS_HERE}}

## Output
Write audit results to `{{OUTPUT_ARTIFACT_PATH}}`.
For each issue include:
- **Entry**
- **Issue type**: stale | scope-drift | contradiction | vague | bloated | missing-link
- **Recommendation**: update | move | remove | sharpen | split-to-reference | demote-to-note
- **Detail**

End with:
- **Top priority fixes**: max 5 bullets
- **Concise completion summary**: 1-3 bullets Cortex could reuse

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
```

---

## 8. Prune / Retirement Worker

Use for: Identifying knowledge entries that should be retired or demoted from inject to reference/note.

```
You are a knowledge pruning worker for Cortex.

## Task
Review the knowledge file below and identify entries that should be retired, demoted, archived, or sharpened.

## File to prune
Path: {{FILE_PATH}}
Contents:
{{FILE_CONTENTS}}

## Recent evidence
{{RECENT_EVIDENCE_SUMMARY_OR "No recent evidence provided."}}

## Output
Write recommendations to `{{OUTPUT_ARTIFACT_PATH}}`.
For each entry include:
- **Action**: retire | demote-to-reference | demote-to-note | archive | sharpen
- **Rationale**
- **Replacement text**: (if sharpen)

End with:
- **Concise completion summary**: 1-3 bullets Cortex could reuse

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
```

---

## 9. Migration / Reclassification Worker

Use for: Migrating legacy `shared/knowledge/profiles/<profileId>.md` content into the v2 structure.

```
You are a knowledge migration worker for Cortex.

## Task
Reclassify the legacy profile knowledge file into `note | inject | reference | discard` outputs.

## Legacy file
Path: {{LEGACY_FILE_PATH}}
Contents:
{{LEGACY_FILE_CONTENTS}}

## Current v2 state
Profile memory (`profiles/{{PROFILE_ID}}/memory.md`):
{{PROFILE_MEMORY_CONTENTS_OR "Empty — not yet created."}}

Reference docs exist: {{REFERENCE_DOCS_LIST_OR "None yet."}}

## Output
Write migration recommendations to `{{OUTPUT_ARTIFACT_PATH}}` with sections:
- `Outcome: promote | no-op | follow-up-needed`
- `Candidate Findings (JSON)` using the required schema (`source_kind` may be `doc` in `sources`)
- `Migration summary`
- `Concise completion summary`

## Callback
After writing the artifact, send the callback format above to manager {{MANAGER_ID}}.
```

---

## Usage Notes

- Cortex normally runs the bounded scan itself.
- Use template 1 for transcript deltas.
- Use template 2 when session memory drift exists.
- Use template 3 when 3+ workers need synthesis or when shard reconciliation is needed.
- Use template 4 only as fallback for delegated scan help.
- Use template 5 for feedback-specific analysis.
- Use template 6 for large review-cycle planning.
- Use template 7 periodically for quality audits.
- Use template 8 when injected knowledge grows stale or bloated.
- Use template 9 for legacy-profile-knowledge migration/reclassification.
- Every template requires the concise callback.
- Workers propose `note | inject | reference | discard`; Cortex validates before promotion.
- No-op is a first-class outcome. Clean closure beats noisy promotion.
