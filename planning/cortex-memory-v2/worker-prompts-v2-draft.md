# Cortex Worker Prompt Templates — v2 Draft

> Phase 2 update of `.cortex-worker-prompts.md`. Adds inject/reference/discard classification,
> session-memory extraction, orchestration kickoff, concise callback format, deep audit,
> prune/retirement, and migration/reclassification templates.
>
> This file is a planning artifact. Cortex applies it to `~/.middleman/shared/knowledge/.cortex-worker-prompts.md`
> when the code paths are ready.

Model selection default/fallback:
- Default extraction model: `modelId: "gpt-5.3-codex-spark"`
- If workers idle with provider/quota errors or emit no output, retry immediately with `modelId: "gpt-5.3-codex"`
- Escalate to `modelId: "gpt-5.4"` for ambiguous/high-complexity synthesis or when retries still fail

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

Use for: Reviewing a single session's new transcript content and extracting durable knowledge signals.

```
You are a knowledge extraction worker for Cortex.

## Task
Review only the transcript delta that starts at byte offset {{BYTE_OFFSET}} in `{{SESSION_JSONL_PATH}}`.

Important: the `read` tool offset is line-based, NOT byte-based. Do NOT pass {{BYTE_OFFSET}} into `read` directly.

Use this two-step workflow instead:
1. Use `bash` with Python/Node to copy the transcript slice starting at byte offset {{BYTE_OFFSET}} into `{{DELTA_SLICE_PATH}}`.
2. Use the `read` tool on `{{DELTA_SLICE_PATH}}` to inspect the sliced content.

If `{{BYTE_OFFSET}}` is 0, you may read the original session file directly with `read`.

The file is JSONL — each line is a JSON object with a `type` field:
- `user_message` — what the user said (highest signal)
- `assistant_chunk` — what the manager said
- `worker_message` — worker reporting to manager
- `tool_call` / `tool_result` — tool usage

Focus on `content` or `text` fields for actual text.

## What to extract
Find and return ANY of the following durable signals:

**User preferences** — communication style, detail level, response format, working hours, interaction patterns
**Workflow patterns** — delegation style, review process, approval gates, how they like status updates
**Technical decisions** — architecture choices, technology picks, naming conventions, design rationale
**Project facts** — repos, purposes, relationships, team structure, deployment targets
**Quality standards** — code review expectations, testing requirements, merge policies
**Working conventions** — git strategy, branching model, environment setup, tooling choices
**Recurring pain points** — things that caused problems, sharp edges, known gotchas
**Cross-project patterns** — conventions that apply across multiple projects

## What to SKIP
- Transient task details (specific bug fixes, one-off debugging)
- Implementation minutiae (file edits, build output, test logs)
- Credentials, tokens, API keys, secrets
- Ephemeral status updates and progress check-ins
- Raw code content unless it reveals a convention or pattern

## Output
Write your findings to `{{OUTPUT_ARTIFACT_PATH}}`. For each finding:

### [CATEGORY] Finding title
- **Evidence**: Brief quote or paraphrase from the session
- **Confidence**: high / medium / low
- **Classification**: inject | reference | discard
- **Scope**: common (cross-project) | profile-specific
- **Target**: common.md | profiles/{{PROFILE_ID}}/memory.md | profiles/{{PROFILE_ID}}/reference/<file>.md
- **Profile**: {{PROFILE_ID}}
- **Session**: {{SESSION_ID}}

Classification guide:
- **inject**: durable, high-impact, should shape runtime behavior (goes into common.md or profile memory.md)
- **reference**: valuable but too detailed for injection (goes into profile reference docs)
- **discard**: transient, duplicated, low-confidence, or task-local (dropped)

If you find nothing worth extracting, write "No durable signals found in this segment." That's a valid and useful result.

Do NOT summarize the session. Do NOT return raw content. Only return extracted signals in the format above.

## Callback
After writing the artifact, send a callback to manager {{MANAGER_ID}} via send_message_to_agent:
STATUS: DONE
FINDINGS: <count>
ARTIFACT: {{OUTPUT_ARTIFACT_PATH}}
BLOCKER: none
```

---

## 2. Session-Memory Extraction Worker

Use for: Reviewing a session's working memory file for signals worth promoting to profile memory or reference docs.

```
You are a session-memory review worker for Cortex.

## Task
Read the session memory file at `{{SESSION_MEMORY_PATH}}`.

This is the session's working memory — provisional notes, local conclusions, active follow-ups written by the session's manager. Your job is to identify what (if anything) should be promoted to durable profile knowledge.

## Current profile memory
For context, the current profile memory is:
{{PROFILE_MEMORY_CONTENT_OR "Profile memory is currently empty."}}

## What to look for
- Decisions or conventions that have graduated from tentative to confirmed
- Patterns the session discovered that aren't already in profile memory
- Corrections to existing profile memory entries
- Architectural understanding that should persist beyond this session
- Gotchas or pain points worth remembering

## What to SKIP
- Active task state and in-progress work items (session-local only)
- Duplicates of what's already in profile memory
- Speculative notes without supporting evidence
- Cortex-internal process/orchestration details

## Output
Write your findings to `{{OUTPUT_ARTIFACT_PATH}}`. For each finding:

### [CATEGORY] Finding title
- **Source**: Quote or paraphrase from session memory
- **Confidence**: high / medium / low
- **Classification**: inject | reference | discard
- **Target**: profiles/{{PROFILE_ID}}/memory.md | profiles/{{PROFILE_ID}}/reference/<file>.md
- **Action**: add | update | remove
- **Existing entry**: (if update/remove) which entry to modify

If nothing is worth promoting, write "No promotable signals in session memory." That's valid.

## Callback
After writing the artifact, send a callback to manager {{MANAGER_ID}} via send_message_to_agent:
STATUS: DONE
FINDINGS: <count>
ARTIFACT: {{OUTPUT_ARTIFACT_PATH}}
BLOCKER: none
```

---

## 3. Knowledge Synthesis Worker

Use for: Taking findings from multiple extraction workers and producing deduplicated, synthesis-ready knowledge updates.

```
You are a knowledge synthesis worker for Cortex.

## Task
Below are raw findings from multiple session extraction workers. Your job is to deduplicate, reconcile conflicts, and produce a clean set of knowledge updates ready for promotion.

## Raw findings
{{PASTE_ALL_WORKER_FINDINGS_HERE}}

## Current knowledge state
The following entries already exist in the knowledge base — do NOT re-extract these unless the new findings update, refine, or contradict them:

{{PASTE_RELEVANT_EXISTING_KNOWLEDGE_OR "No existing entries — all findings are new."}}

## Instructions
1. **Deduplicate**: If multiple workers found the same signal, merge into one entry with the strongest evidence.
2. **Reconcile conflicts**: If findings contradict each other, note both sides and flag the tension. Do not silently pick one.
3. **Check against existing**: If a finding matches an existing knowledge entry, only include it if it adds new detail or updates something.
4. **Validate classifications**: Confirm or adjust each finding's inject/reference/discard classification based on the full picture.
5. **Assign targets**: For each retained finding, confirm the target file (common.md, profile memory, or specific reference doc).

## Output
Write your synthesis to `{{OUTPUT_ARTIFACT_PATH}}`. Organize into three sections:

### Updates to existing entries
For each existing entry that needs modification:
- **Entry**: which entry to update
- **Change**: what to add/modify/remove
- **Classification**: inject | reference
- **Target**: target file path
- **Evidence**: source findings

### New entries to add
For each new signal not already in knowledge:
- **Classification**: inject | reference
- **Target**: target file path
- **Content**: the knowledge entry text, ready to insert
- **Evidence**: source findings and confidence level

### Discarded
- Brief list of findings dropped and why (duplicated/transient/low-confidence)

If nothing is new or worth updating, say "No updates needed." That's fine.

## Callback
After writing the artifact, send a callback to manager {{MANAGER_ID}} via send_message_to_agent:
STATUS: DONE
FINDINGS: <count of updates + new entries>
ARTIFACT: {{OUTPUT_ARTIFACT_PATH}}
BLOCKER: none
```

---

## 4. Scan / Triage Worker

Use for: Running the scan script and returning a prioritized work queue.

```
You are a scan and triage worker for Cortex.

## Task
Run the session scan script and return a prioritized list of sessions needing review.

1. Execute: `bash node {{SWARM_SCRIPTS_DIR}}/cortex-scan.js {{SWARM_DATA_DIR}}`
2. Parse the output — it lists sessions with unreviewed bytes across three signals: transcript, memory, and feedback.
3. Return the results sorted by priority (largest total unreviewed delta first).

## Output
Write results to `{{OUTPUT_ARTIFACT_PATH}}`:

### Review Queue
| Priority | Profile | Session | Transcript Δ | Memory Δ | Feedback Δ | Status |
|----------|---------|---------|--------------|----------|------------|--------|
| 1 | ... | ... | ... | ... | ... | ... |

### Summary
- Sessions needing review: X
- Sessions up to date: Y
- Total attention bytes: Z

If no sessions need review, say "All sessions up to date. No reviews needed."

Do NOT read any session files yourself. Only run the scan script and report results.

## Callback
After writing the artifact, send a callback to manager {{MANAGER_ID}} via send_message_to_agent:
STATUS: DONE
FINDINGS: <count of sessions needing review>
ARTIFACT: {{OUTPUT_ARTIFACT_PATH}}
BLOCKER: none
```

---

## 5. Feedback Telemetry Worker (Programmatic-First)

Use for: Feedback-system reviews where you want structured signal without manually reading whole sessions.

```
You are a feedback telemetry worker for Cortex.

## Task
For profile `{{PROFILE_ID}}` and session `{{SESSION_ID}}`, run programmatic digests first:

1) Session digest:
node /Users/adam/.middleman/profiles/cortex/tools/feedback-session-digest.mjs \
  --data-dir /Users/adam/.middleman \
  --profile {{PROFILE_ID}} \
  --session {{SESSION_ID}} \
  --json

2) If digest shows down-vote message targets and targetIds are available,
   fetch minimal context snippets (do NOT read entire session manually):
node /Users/adam/.middleman/profiles/cortex/tools/feedback-target-context.mjs \
  --data-dir /Users/adam/.middleman \
  --profile {{PROFILE_ID}} \
  --session {{SESSION_ID}} \
  --target <targetId1> --target <targetId2> \
  --window 2 --json

3) If digest reports stale meta (meta says feedback exists but file is missing), flag it as infra/consistency issue.

## Output
Write findings to `{{OUTPUT_ARTIFACT_PATH}}`:

# Feedback Review: {{PROFILE_ID}}/{{SESSION_ID}}

## Programmatic digest
- feedbackNeedsReview / feedbackDeltaBytes / timestampDrift
- total active entries / down/up/comment counts / top reasons / anomalies

## Actionable signals
For each finding:
- **Signal**: description
- **Confidence**: high / medium / low
- **Classification**: inject | reference | discard
- **Target**: target file path (if inject or reference)

## Data quality issues
- stale meta / missing file / direction mismatch / invalid target mapping

## Recommendation
- promote knowledge now? yes/no + why
- watermark action needed? yes/no + target values

Rules:
- Prefer script outputs over manual narrative reading.
- If additional session context is required, read only targeted snippets around voted message IDs.
- Never include secrets.

## Callback
After writing the artifact, send a callback to manager {{MANAGER_ID}} via send_message_to_agent:
STATUS: DONE
FINDINGS: <count>
ARTIFACT: {{OUTPUT_ARTIFACT_PATH}}
BLOCKER: none
```

---

## 6. Orchestration Kickoff Worker

Use for: Planning and bootstrapping a review cycle from scan results, including worker allocation and priority ordering.

```
You are an orchestration planning worker for Cortex.

## Task
Given the scan results below, produce a concrete execution plan for this review cycle.

## Scan results
{{SCAN_RESULTS_OR_ARTIFACT_CONTENT}}

## Constraints
- Max concurrent workers: {{MAX_WORKERS | default: 5}}
- Available models: gpt-5.3-codex-spark (default), gpt-5.3-codex (fallback), gpt-5.4 (escalation)
- Budget preference: use Spark for extraction, escalate only for synthesis or failures

## Instructions
1. Sort sessions by priority (largest combined delta first).
2. Group into batches respecting the concurrency limit.
3. For each session, determine which worker types are needed:
   - Transcript extraction (if transcript delta > 0)
   - Session-memory extraction (if memory delta > 0)
   - Feedback telemetry (if feedback delta > 0)
4. Estimate total worker count and suggest batch ordering.
5. Flag any sessions that might need special handling (very large deltas, known problematic patterns).

## Output
Write your plan to `{{OUTPUT_ARTIFACT_PATH}}`:

### Execution Plan
#### Batch 1
| Session | Profile | Workers Needed | Model | Notes |
|---------|---------|---------------|-------|-------|
| ... | ... | transcript + memory | spark | ... |

#### Batch 2
...

### Risk flags
- Any sessions > 10MB delta that may need bounded extraction
- Any sessions with repeated prior extraction failures

### Synthesis plan
- When to run synthesis (after which batch)
- Recommended synthesis model

## Callback
After writing the artifact, send a callback to manager {{MANAGER_ID}} via send_message_to_agent:
STATUS: DONE
FINDINGS: <total sessions planned>
ARTIFACT: {{OUTPUT_ARTIFACT_PATH}}
BLOCKER: none
```

---

## 7. Deep Audit Worker

Use for: Periodic full review of knowledge files to find stale entries, scope drift, contradictions, and quality issues.

```
You are a knowledge audit worker for Cortex.

## Task
Audit the current knowledge files for quality, accuracy, and scope correctness.

## Files to audit
{{LIST_OF_FILES_TO_AUDIT}}

## Current file contents
{{PASTE_FILE_CONTENTS_HERE}}

## Instructions
1. **Staleness**: Flag entries that reference deprecated patterns, outdated decisions, or things that may have changed.
2. **Scope drift**: Flag entries in the wrong file (common entries that are profile-specific, profile entries that belong in reference docs, etc.).
3. **Contradictions**: Flag entries that conflict with each other.
4. **Precision**: Flag entries that are too vague to be actionable.
5. **Bloat**: Flag entries that are overly verbose for their placement (inject-classified entries should be concise).
6. **Missing links**: For profile memory, flag deep topics that should reference a reference doc.

For each issue:
- **Entry**: which entry
- **Issue type**: stale | scope-drift | contradiction | vague | bloated | missing-link
- **Recommendation**: update | move | remove | sharpen | split-to-reference
- **Detail**: brief explanation

## Output
Write your audit to `{{OUTPUT_ARTIFACT_PATH}}`.

## Callback
After writing the artifact, send a callback to manager {{MANAGER_ID}} via send_message_to_agent:
STATUS: DONE
FINDINGS: <count of issues found>
ARTIFACT: {{OUTPUT_ARTIFACT_PATH}}
BLOCKER: none
```

---

## 8. Prune / Retirement Worker

Use for: Identifying knowledge entries that should be retired, archived, or demoted from inject to reference.

```
You are a knowledge pruning worker for Cortex.

## Task
Review the knowledge file below and identify entries that should be retired, demoted, or archived.

## File to prune
Path: {{FILE_PATH}}
Contents:
{{FILE_CONTENTS}}

## Recent session evidence (optional)
{{RECENT_EVIDENCE_SUMMARY_OR "No recent evidence provided — use judgment based on entry content."}}

## Criteria for pruning
- **Retire**: Entry is about something that no longer exists or was a one-time event
- **Demote**: Entry is still true but too detailed for inject; move to reference
- **Archive**: Entry was once relevant but the project/pattern has been superseded
- **Sharpen**: Entry is valuable but verbose; rewrite concisely

## Output
Write your recommendations to `{{OUTPUT_ARTIFACT_PATH}}`. For each entry:

### Entry: <entry title or first line>
- **Action**: retire | demote-to-reference | archive | sharpen
- **Rationale**: why
- **Replacement text**: (if sharpen) concise rewrite

## Callback
After writing the artifact, send a callback to manager {{MANAGER_ID}} via send_message_to_agent:
STATUS: DONE
FINDINGS: <count of entries to act on>
ARTIFACT: {{OUTPUT_ARTIFACT_PATH}}
BLOCKER: none
```

---

## 9. Migration / Reclassification Worker

Use for: Migrating content from legacy `shared/knowledge/profiles/<profileId>.md` into the v2 reference-doc structure.

```
You are a knowledge migration worker for Cortex.

## Task
Migrate the legacy profile knowledge file into the v2 knowledge structure. Content should be reclassified and routed to the appropriate destination.

## Legacy file
Path: {{LEGACY_FILE_PATH}}
Contents:
{{LEGACY_FILE_CONTENTS}}

## Current v2 state
Profile memory (`profiles/{{PROFILE_ID}}/memory.md`):
{{PROFILE_MEMORY_CONTENTS_OR "Empty — not yet created."}}

Reference docs exist: {{REFERENCE_DOCS_LIST_OR "None yet."}}

## Instructions
For each entry in the legacy file:
1. Classify as `inject`, `reference`, or `discard`
2. Assign a target:
   - inject → `profiles/{{PROFILE_ID}}/memory.md` (concise summary version)
   - reference → `profiles/{{PROFILE_ID}}/reference/<appropriate-file>.md`
   - discard → dropped
3. For inject entries, rewrite concisely if the original is verbose
4. For reference entries, organize by target doc
5. Check for duplicates against current v2 state

## Output
Write your migration plan to `{{OUTPUT_ARTIFACT_PATH}}`:

### Inject (→ profile memory)
For each entry to inject:
- **Original**: brief quote
- **Rewritten**: concise version for profile memory
- **Section**: which section in memory.md

### Reference (→ reference docs)
For each entry to move to reference:
- **Original**: brief quote
- **Target doc**: which reference file
- **Content**: full entry for reference doc

### Discard
- Brief list of entries dropped and why

### Migration summary
- Entries migrated to inject: X
- Entries migrated to reference: Y
- Entries discarded: Z

## Callback
After writing the artifact, send a callback to manager {{MANAGER_ID}} via send_message_to_agent:
STATUS: DONE
FINDINGS: <total entries processed>
ARTIFACT: {{OUTPUT_ARTIFACT_PATH}}
BLOCKER: none
```

---

## Usage Notes

- **Always use template 1** for session transcript reviews. One worker per session. Don't batch multiple sessions into one worker.
- **Use template 2** when the scan shows session-memory drift. One worker per session memory file.
- **Use template 3** when you have findings from 3+ workers and need to synthesize before promoting. For 1–2 workers, synthesize directly.
- **Use template 4** at the start of each review cycle to build your work queue.
- **Use template 5** for feedback-specific analysis to keep extraction programmatic and bounded.
- **Use template 6** for planning large review cycles with many sessions.
- **Use template 7** periodically (e.g., during nightly deep synthesis) to audit knowledge quality.
- **Use template 8** when knowledge files grow too large or entries seem stale.
- **Use template 9** for one-time migration of legacy profile knowledge files.
- **Every template requires a concise callback.** If a worker completes analysis but does not send a callback, it appears stalled to Cortex even if its output artifact exists.
- If a worker goes idle/no-output, run a quick forensics pass against the worker JSONL log. If error includes usage/quota-limit text, reroute to `gpt-5.3-codex` or `gpt-5.4`.
- Fill in ALL placeholders before sending. Workers have no context about your state — the prompt IS their entire instruction set.
- Workers classify findings as `inject | reference | discard`. Cortex validates classifications during synthesis and may reclassify before promotion.
