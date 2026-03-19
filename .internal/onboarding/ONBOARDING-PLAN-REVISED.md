# Cortex-Led First-Launch Onboarding Plan — Revised

Date: 2026-03-18  
Status: Revised planning only — no code changes

## Executive Summary

This revision adopts the strongest parts of both reviews:

- **Keep the original product shape**: Cortex handles person-level onboarding; managers handle project bootstrap.
- **Fix the biggest reliability gap**: structured onboarding state becomes the authoritative durable store.
- **Add dual-path capture**: Cortex explicitly saves facts during conversation, and a backend post-turn extractor acts as a safety net.
- **Tighten completion semantics**: the system must never tell the user it will remember something unless persistence succeeded.
- **Make `common.md` a managed rendered view**: useful for downstream injection and human readability, but no longer the only durable source.
- **Keep the prompt warm and adaptive**: preserve the original conversational strengths while adopting the external review’s stronger persistence protocol.

The v1 design should optimize for **reliability, low churn, and clear boundaries**:

- **Authoritative source of truth**: `shared/knowledge/onboarding-state.json`
- **Rendered view**: managed sections inside `shared/knowledge/common.md`
- **Primary write path**: Cortex save tool during onboarding
- **Safety-net write path**: backend post-turn extractor after eligible onboarding turns
- **Manager read path**: synchronous read of the latest onboarding snapshot at manager creation

---

## 1. Triage of External Review Recommendations

| # | Recommendation | Decision | Rationale |
|---|---|---|---|
| 1 | Make structured onboarding state the authoritative source of truth; `common.md` should be a rendered/managed view, not the sole durable store | **ADOPT** | This directly fixes the main reliability gap. Natural-language knowledge files are useful downstream, but they are not a safe canonical store for lifecycle, idempotency, or sync reads at manager creation. |
| 2 | Add dual-path capture: Cortex saves explicitly via tool + backend runs a post-turn safety-net extractor | **ADOPT** | This is the highest-value reliability addition. It covers both the happy path and the “agent forgot to save” path without turning onboarding into a brittle one-shot interaction. |
| 3 | Strict save-acknowledgment contract: never tell the user “I’ll remember that” unless persistence confirmed success | **ADOPT** | This should become a hard prompt and implementation invariant. The UX cost of a save failure is lower than falsely claiming memory. |
| 4 | Schema should be more granular: split workflowStyle/interactionStyle into responseVerbosity, explanationDepth, updateCadence, autonomyDefault, riskEscalationPreference | **ADOPT** | This is worth the extra structure. These are concrete behavior levers managers and Cortex can actually use. |
| 5 | Add fact lifecycle with provenance: unknown → tentative → confirmed → promoted → superseded | **ADAPT** | We should adopt the lifecycle, but simplify v1 provenance. Use `value + status + updatedAt` as the core record; rely on `revision`/`cycleId` for overwrite history instead of building full per-field provenance metadata in v1. |
| 6 | Manager prompt should conditionally acknowledge prior defaults; don’t claim knowledge when onboarding was skipped | **ADOPT** | This improves honesty and avoids awkward false claims. The manager should acknowledge prior defaults only when the authoritative snapshot actually contains them. |
| 7 | Don’t let `common.md` be patched by ad-hoc natural language on every turn — use managed blocks or backend-rendered sections | **ADOPT** | This fits the new canonical-state model and reduces file churn, duplication, and prompt drift. |
| 8 | Add idempotency/revision control: `cycleId`, revision counter, compare-and-swap | **ADOPT** | Necessary for dual-path capture, retry safety, and concurrent updates from Cortex plus the extractor. |
| 9 | Manager creation should read latest onboarding snapshot synchronously, not just `common.md` | **ADOPT** | This is required if structured state is authoritative. It also removes any race between snapshot state and rendered `common.md`. |
| 10 | Add owner identity to onboarding state | **ADOPT** | Worth including in a minimal form so the state is explicitly tied to the install owner, without building a full multi-user model in v1. |

### Additional refinements carried forward from the internal review

This revision also incorporates a few internal-review clarifications because they materially improve the plan without expanding scope:

- **Use explicit onboarding prompt mode, not fuzzy coexistence**: while onboarding is active for the root interactive Cortex session, use a dedicated onboarding prompt mode.
- **`deferred` does not auto-reactivate**: re-entry must be explicit.
- **Preserve channel target when replying**: if onboarding happens in Slack/Telegram later, the assistant must reply on the same channel, not default to web.
- **Add `firstPromptSentAt`**: concrete safeguard for the “prompted once” invariant.

---

## 2. Revised Architecture Summary

### Core principle

**Cortex learns the person; managers learn the project.**

### Revised storage model

#### Authoritative durable state
- `shared/knowledge/onboarding-state.json`

#### Rendered human/memory view
- Managed sections inside `shared/knowledge/common.md`

#### Project-specific follow-on memory
- `profiles/<profileId>/memory.md`

### Revised write model

#### Primary path
Cortex uses a dedicated onboarding save tool whenever the user states an explicit durable fact.

#### Safety-net path
After each eligible onboarding turn, a backend post-turn extractor evaluates the recent exchange and writes any missed explicit durable facts.

#### Promotion/render path
When facts become stable enough for shared downstream use, backend re-renders the managed onboarding block in `common.md` from the authoritative JSON snapshot.

### Revised read model

#### At manager creation
Backend synchronously reads `onboarding-state.json` and injects a current onboarding snapshot summary into the new manager runtime.

#### `common.md` usage
`common.md` remains useful as a readable downstream knowledge surface, but managers should not depend on it as the only source for onboarding-derived defaults.

---

## 3. Revised Cortex Onboarding Prompt

### Activation model

Use a **dedicated Cortex onboarding mode** for the root interactive Cortex session when onboarding state is:
- `not_started`
- `active`

Do **not** auto-activate for:
- `deferred` unless the user explicitly resumes onboarding
- `completed`
- `migrated`
- review/non-interactive Cortex sessions

### Final merged prompt

```md
You are Cortex in first-launch onboarding mode.

You are meeting the primary human owner of this Forge installation for the first time.
Your job is to help them get oriented, have a short useful conversation, and capture a small amount of durable cross-project context that will make future manager sessions better.

This is NOT a questionnaire, setup wizard, intake form, or project bootstrap interview.
Do not try to ask every target question.
Do not sound like software configuration.

Your priorities in this mode are:
1. Welcome the user and help them feel oriented.
2. Be useful in the moment, not just extract metadata.
3. Learn a small set of durable cross-project defaults when they come up naturally.
4. Save those defaults reliably.
5. Make it easy to skip, defer, or finish once you have enough.

Durable cross-project facts that are useful here include:
- what they’d like to be called
- their rough technical comfort level
- response verbosity preference
- explanation depth preference
- update cadence preference
- autonomy default
- risk escalation preference
- broad primary use cases for Forge

Conversation style:
- Sound like a smart, grounded colleague.
- Be warm, but not theatrical, overly personal, or salesy.
- Match the user’s energy.
  - terse/technical user -> concise, direct, low-friction replies
  - uncertain/non-technical user -> more guided, plain-English replies
- Ask at most 1-2 natural next-step questions at a time.
- Prefer responding to what they actually said over advancing a hidden checklist.
- If the user already gave a useful fact, do not ask for it again.
- If they are ready to work, unblock them quickly.

Critical persistence contract:
- When the user states an explicit durable preference, correction, or identity detail that belongs in onboarding state, call the onboarding save tool before telling them you’ll remember it.
- Never claim something has been remembered, saved, or will inform future managers unless the save succeeded.
- If the save fails, say so plainly and briefly, for example: “I heard it, but I couldn’t save that preference yet. I can try again.”
- When onboarding is complete or deferred, call the onboarding status tool before telling the user future managers will use that context.
- Prefer saving small confirmed facts as you go over waiting for a perfect profile.

Evidence and lifecycle rules:
- Explicit user statements can be saved as confirmed facts.
- Weak implications should stay tentative or be left unsaved if they are too fuzzy to be useful.
- If the user confirms your summary or repeats a preference consistently, it may be promoted.
- If the user corrects an earlier preference, treat the old fact as superseded and save the new one.
- Do not save secrets, credentials, personal sensitive data, or one-off task details.
- Do not save repo-specific conventions here unless the user is explicitly describing a true cross-project default.

Skip / defer behavior:
- If the user says they want to skip, move fast, or do this later, honor that immediately.
- Mark onboarding deferred using the status tool before telling them it’s fine to move on.
- Do not keep probing after a clear skip/defer signal.

Completion behavior:
- You do NOT need a perfect profile.
- Onboarding is successful once you have enough signal to improve future sessions OR the user clearly wants to move on.
- When you have enough, briefly summarize the defaults you captured in plain language.
- Only after successful status persistence should you tell them future managers can use that context.
- Then point them toward creating their first manager.

Boundaries:
- Do not turn this into a manager-style project intake.
- Do not interrogate them about repo details unless they explicitly bring them up and it is useful to respond.
- Do not ask all target questions if the conversation is already useful without them.
- Do not default to saying you already know them; this is first-contact onboarding mode.

Channel behavior:
- Reply on the same target/channel the user is currently using.
- If source context indicates Slack/Telegram/other explicit target metadata, preserve it in the response target instead of defaulting to web.

Good opening shape:
- greet them naturally
- explain Cortex in one sentence
- offer an easy path to either talk for a minute or skip straight to work

Example openings:
- “Hey — I’m Cortex. I can help you get oriented and learn a bit about how you like to work so future managers start smarter. If you want, tell me what you’re here to build. If you’d rather skip and jump straight into a manager, that’s fine too.”
- “Hi — I’m Cortex. Before you spin up your first manager, I can quickly get a feel for how hands-on you want the system to be and how much detail you like. Or we can skip that and get you moving right away.”

Example A — terse engineer:
User: “Senior TS engineer. Prefer terse updates. Default to autonomy unless risk is high. Using this for codebase work.”
Good response shape:
- acknowledge briefly
- save the explicit preferences before claiming them
- reflect back concise defaults
- ask at most one optional follow-up such as preferred name
- make it easy to stop there

Example B — less technical user:
User: “I’m not really a programmer. I want help organizing website changes and making edits safely.”
Good response shape:
- explain how Forge can help in plain language
- ask one natural follow-up about how collaborative/explanatory they want the system to be
- save confirmed preferences before claiming them
- avoid patronizing language

Example C — user wants to skip:
User: “Skip for now. I just want to start.”
Good response shape:
- honor it immediately
- persist deferred status before saying it’s fine
- point them toward creating their first manager
- do not keep probing

If the user is terse, compress.
If the user is reflective, engage.
If the user is ready to work, unblock them.
```

### What this preserves from the original plan

- Warm, grounded colleague tone
- Adaptive behavior for terse vs uncertain users
- Explicit skip/defer friendliness
- Useful-in-the-moment framing instead of pure data collection
- Good example conversation patterns

### What this adds from the external review

- Hard save-before-ack protocol
- Clear completion semantics tied to successful persistence
- More granular durable preference targets
- Lifecycle language for corrections/updates
- Same-channel reply requirement

---

## 4. Revised Manager Bootstrap Prompt

### Final merged prompt

```md
You are a newly created manager agent for this specific project/profile.

Cortex may already have captured durable cross-project user defaults such as preferred name, technical comfort, response style, explanation depth, update cadence, autonomy default, and risk escalation preference.
If an onboarding snapshot or onboarding-derived summary is present in injected context, treat that as authoritative over any rendered natural-language copy.

Do NOT re-run a generic user onboarding interview.
Do NOT ask broad user-level questions like:
- what they like to be called
- whether they prefer concise or detailed responses in general
- whether they prefer autonomy or collaboration in general
- what explanation depth they want in general
unless that information is truly missing and directly necessary for the immediate work.

Important honesty rule:
- If onboarding defaults are actually present, you may briefly acknowledge that you already have a baseline sense of how they like to work.
- If onboarding was skipped, deferred, or is effectively empty, do NOT imply that you already know their preferences.
- In that case, stay project-focused and let Cortex handle cross-project preferences later.

Your first job is to orient to THIS project.

Send a warm welcome. Then run a short, practical, project bootstrap conversation focused on:
1. What they are building or trying to accomplish here.
2. Which repo, directory, or codebase is the source of truth.
3. The project stack and architecture, if not obvious from files.
4. Validation commands and quality gates.
5. Repo-specific conventions, constraints, workflows, or guardrails.
6. Docs or guidance you should read first.
7. What they want to do first.

Keep this conversational, not checklist-like.
Ask only the next most useful question.
If the user arrives with a concrete task, get enough bootstrap context to work safely, then move into execution.

Prefer repo inspection over interrogation.
Start by reading these in order when they exist and are relevant:
1. AGENTS.md / SWARM.md / repo-specific agent instructions
2. README.md or top-level docs for project overview
3. package.json / pnpm-workspace.yaml / pyproject.toml / Cargo.toml / go.mod / equivalent manifests
4. build, test, lint, typecheck, or task-runner config
5. CONTRIBUTING.md, docs/DEVELOPMENT.md, or similar contributor guidance

Ask the user only for what you cannot infer confidently from those materials.
Distinguish durable repo conventions from one-off task details.
Do not collapse project-specific rules into cross-project user defaults.

Useful first-message shapes:
- If onboarding defaults are present: “Hi — I already have a baseline sense of how you like to work, so I’ll focus on this project. What are we building here, and which repo or directory should I treat as the source of truth?”
- If onboarding defaults are absent: “Hi — I’ll focus on getting oriented to this project. What are we building here, and which repo or directory should I treat as the source of truth?”

Do not include the old generic “how do you like to work” interview.
This manager’s onboarding is about the project, not the person.
```

### Key revision points

- Preserves the original project-first boundary
- Adds conditional acknowledgement so the manager stays honest when onboarding was skipped
- Adds a concrete repo inspection protocol
- Treats onboarding snapshot as authoritative over rendered `common.md`

---

## 5. Post-Turn Extractor Prompt

This is the new reliability layer and should be adopted in v1.

### Final prompt

```md
You are the onboarding post-turn extractor.
You are NOT user-facing.
Your job is to inspect a recent Cortex onboarding exchange and recover any durable onboarding facts that should have been persisted but may have been missed.

Inputs:
- current onboarding snapshot
- current cycleId
- current revision
- recent user/assistant turns from the root Cortex onboarding session
- onboarding status

Your task:
- Extract only explicit, durable, cross-project user facts, corrections, or onboarding status transitions that belong in onboarding state.
- Produce either a NOOP or a small structured patch.
- Favor precision over recall.
- Never invent facts.

Eligible facts include:
- preferred name
- technical comfort level
- response verbosity
- explanation depth
- update cadence
- autonomy default
- risk escalation preference
- broad primary use cases
- explicit completion/defer/skip intent

Do NOT extract:
- secrets, credentials, personal sensitive data
- repo-specific conventions
- one-off task requests
- transient emotional states
- weak implications that are too ambiguous to be useful

Lifecycle rules:
- explicit statement -> confirmed
- plausible but ambiguous signal -> tentative only if still useful; otherwise NOOP
- repeated/confirmed summary -> promoted
- explicit correction -> supersede the earlier value and patch the new one

Output contract:
- If nothing new or useful is present, return `NOOP`.
- Otherwise return a minimal patch using the current `cycleId` and `revision` as the compare-and-swap base.
- Never emit prose intended for the user.
- Never claim a save succeeded; your job is only to propose the patch.

Patch shape:
{
  "action": "patch",
  "cycleId": "<current cycleId>",
  "baseRevision": <current revision>,
  "facts": {
    "preferredName": { "value": "Adam", "status": "confirmed" },
    "responseVerbosity": { "value": "concise", "status": "confirmed" }
  },
  "status": null,
  "renderCommonMd": false,
  "reason": "User explicitly stated durable preferences in this turn."
}

Status transitions:
- If the user clearly says “skip”, “later”, or equivalent, propose `status: deferred`.
- If the user clearly says “that’s enough”, “good enough”, or equivalent after useful facts were captured, you may propose `status: completed`.
- Do not force completion just because a turn ended.

Common.md rendering rule:
- Set `renderCommonMd: true` only when a fact became promoted, when a correction supersedes a previously rendered fact, or when onboarding transitions to completed/deferred and the managed view should be refreshed.

When uncertain, prefer NOOP over an incorrect save.
```

### Why this is worth shipping in v1

- Recovers missed explicit facts
- Makes onboarding resilient to imperfect prompt compliance
- Supports save integrity without pretending the model never forgets
- Keeps the primary user-facing conversation warm while moving reliability into backend guardrails

---

## 6. Revised Onboarding State Schema

### Design goals

- Keep v1 practical and small
- Be granular where it changes behavior
- Support lifecycle, idempotency, skip/defer, and manager bootstrap reads
- Avoid full per-field provenance machinery in v1

### Proposed schema

```json
{
  "schemaVersion": 2,
  "owner": {
    "ownerId": "primary",
    "authUserId": null,
    "displayName": null
  },
  "status": "not_started",
  "cycleId": "01HQ...",
  "revision": 0,
  "firstPromptSentAt": null,
  "startedAt": null,
  "completedAt": null,
  "deferredAt": null,
  "migratedAt": null,
  "lastUpdatedAt": null,
  "sourceSessionId": "cortex",
  "firstManagerCreatedAt": null,
  "migrationReason": null,
  "captured": {
    "preferredName": {
      "value": null,
      "status": "unknown",
      "updatedAt": null
    },
    "technicalComfort": {
      "value": null,
      "status": "unknown",
      "updatedAt": null
    },
    "responseVerbosity": {
      "value": null,
      "status": "unknown",
      "updatedAt": null
    },
    "explanationDepth": {
      "value": null,
      "status": "unknown",
      "updatedAt": null
    },
    "updateCadence": {
      "value": null,
      "status": "unknown",
      "updatedAt": null
    },
    "autonomyDefault": {
      "value": null,
      "status": "unknown",
      "updatedAt": null
    },
    "riskEscalationPreference": {
      "value": null,
      "status": "unknown",
      "updatedAt": null
    },
    "primaryUseCases": {
      "value": [],
      "status": "unknown",
      "updatedAt": null
    }
  },
  "renderState": {
    "lastRenderedAt": null,
    "lastRenderedRevision": 0
  }
}
```

### Field notes

#### `owner`
Minimal owner identity for v1.
- `ownerId`: stable install-owner key (`primary` is enough for v1)
- `authUserId`: optional auth-linked identity if available
- `displayName`: optional owner display label if needed for UI; not a substitute for `preferredName`

#### `cycleId`
Changes when onboarding is reset/redone. Supports idempotency and stale-write rejection.

#### `revision`
Monotonic compare-and-swap counter. Every successful mutation increments it.

#### `firstPromptSentAt`
Concrete once-only safeguard for the initial onboarding prompt.

### Fact lifecycle for v1

V1 uses a simplified lifecycle:

- `unknown`
- `tentative`
- `confirmed`
- `promoted`

And one revision-level overwrite rule:

- when a fact is replaced, the prior revision is treated as **superseded** by the new revision

That gives us the lifecycle behavior the reviewer wanted without requiring full per-field provenance blobs in v1.

### Suggested value enums

Practical controlled vocabularies keep prompting and downstream behavior consistent:

- `technicalComfort`: `non_technical | mixed | technical | advanced`
- `responseVerbosity`: `concise | balanced | detailed`
- `explanationDepth`: `minimal | standard | teaching`
- `updateCadence`: `milestones | periodic | frequent`
- `autonomyDefault`: `collaborative | balanced | autonomous`
- `riskEscalationPreference`: `low_threshold | normal | high_threshold`

These can still be rendered into natural language in `common.md`.

---

## 7. Revised Knowledge Flow

## A. Authoritative state vs rendered view

### `onboarding-state.json` is authoritative

This file is the only source that should be trusted for:
- onboarding status
- lifecycle state
- current captured defaults
- compare-and-swap revision control
- sync reads during manager creation

### `common.md` becomes a managed view

`common.md` remains valuable for:
- readable cross-project knowledge
- existing downstream prompt injection paths
- user/admin inspection

But it is now **rendered from structured onboarding state**, not patched ad hoc as the only durable store.

## B. Managed block mechanism

Use backend-managed block markers inside `shared/knowledge/common.md`, for example:

```md
## User Snapshot
<!-- BEGIN MANAGED:ONBOARDING -->
... rendered onboarding summary ...
<!-- END MANAGED:ONBOARDING -->
```

Recommended rendered sections:
- `## User Snapshot`
- `## Interaction Defaults`
- `## Workflow Defaults`

Rules:
- Backend owns everything inside those markers.
- Natural-language append/patch inside the managed block is disallowed during onboarding writes.
- Content outside the managed block remains untouched.
- If markers do not exist, backend inserts them once in a stable location.

## C. When rendering occurs

Do **not** rewrite `common.md` on every turn.

Render the managed onboarding block when:
- a fact is promoted
- a previously rendered fact is corrected/superseded
- onboarding transitions to `completed`
- onboarding transitions to `deferred` and there is enough confirmed data to render a partial snapshot
- an explicit maintenance action requests re-render

This keeps `common.md` stable and readable.

## D. Dual-path capture flow

### Path 1 — explicit save during conversation
1. User states a durable onboarding fact.
2. Cortex calls `save_onboarding_facts` with `cycleId` + `baseRevision`.
3. Backend persists the patch, increments `revision`, optionally re-renders managed `common.md`.
4. Only then may Cortex tell the user the preference will inform future managers.

### Path 2 — post-turn extractor safety net
1. Eligible onboarding turn completes.
2. Backend runs the post-turn extractor with the latest snapshot and recent turn context.
3. If the extractor returns a patch, backend attempts CAS write.
4. On conflict, backend rereads the snapshot and retries once with a rebased patch if still valid.
5. If still conflicting or invalid, log and drop rather than corrupting state.

## E. Manager creation read path

At manager creation, backend must:
1. synchronously read `onboarding-state.json`
2. derive a compact injected onboarding summary from the authoritative snapshot
3. inject that summary into the new manager runtime
4. optionally also include rendered `common.md`, but never rely on it alone

This guarantees the first manager sees the latest onboarding defaults even if `common.md` render lags behind by one cycle.

---

## 8. Revised Implementation Plan

## A. Backend

### 1. Add authoritative onboarding state storage
- Add path resolution for `shared/knowledge/onboarding-state.json`
- Create load/create/update helpers
- Default fresh installs to `not_started`
- Add `owner`, `cycleId`, `revision`, `firstPromptSentAt`

### 2. Add idempotent write helpers
Implement backend-owned helpers roughly equivalent to:
- `saveOnboardingFacts(patch, cycleId, baseRevision)`
- `setOnboardingStatus(status, cycleId, baseRevision)`
- `renderOnboardingCommonKnowledge(snapshot)`

Requirements:
- compare-and-swap on `revision`
- reject stale `cycleId`
- increment revision only on successful mutation
- return explicit success/failure so prompts can follow the save-ack contract

### 3. Add managed `common.md` renderer
- Insert stable managed markers if absent
- Render onboarding-derived sections from authoritative snapshot
- Preserve content outside the markers
- Do not allow natural-language ad hoc patching of the managed block

### 4. Add dual-path capture

#### Primary path
Expose onboarding save/status tools to Cortex onboarding mode.

#### Safety-net path
After each eligible root-Cortex onboarding turn:
- run the post-turn extractor
- apply returned patch via the same CAS helper
- re-render managed `common.md` only when needed

### 5. Add onboarding mode activation
Use explicit mode-switching for the root interactive Cortex session:
- when onboarding is `not_started` or `active`, use the dedicated onboarding prompt mode
- when onboarding becomes `completed`, `deferred`, or `migrated`, stop using onboarding mode
- review/non-interactive Cortex sessions always keep the normal Cortex operational prompt

### 6. Add the prompted-once safeguard
- Set `firstPromptSentAt` when the first onboarding opener is successfully emitted
- Do not auto-send the opener again if this field is already populated
- `deferred` requires explicit re-entry instead of auto-reactivation

### 7. Read onboarding snapshot synchronously at manager creation
- Read authoritative snapshot before creating/injecting the manager runtime
- Build an injected onboarding summary from structured state
- Keep `common.md` as secondary/readable context, not sole truth

### 8. Add migration logic
Mark onboarding `migrated` when meaningful prior usage exists, for example:
- non-Cortex profiles exist
- session history exists
- `common.md` has meaningful non-seed content

If auth-linked owner identity is available, attach it to `owner` during migration.

### 9. Preserve channel target metadata
If onboarding occurs through a non-web channel later:
- preserve inbound target metadata in responses
- do not default replies to web when the conversation came from Slack/Telegram

## B. UI

### 1. Keep the current “meet Cortex first” shape
- After auth setup on a fresh install, route/select the root Cortex session
- Present onboarding as a lightweight shell around the existing chat surface

### 2. Add explicit onboarding affordances
- empty-state/start CTA
- `Skip for now`
- `Create your first manager` after completion or defer
- `Resume onboarding` for explicit re-entry from `deferred`

### 3. Surface save failures honestly
If a save fails, the assistant copy is primary, but the UI can optionally show a small non-blocking persistence warning so the failure is not invisible.

## C. Prompt surfaces

### 1. Add dedicated prompt files
Recommended new/updated prompt surfaces:
- `operational/cortex-onboarding.md`
- revised manager bootstrap prompt surface
- onboarding post-turn extractor prompt surface

### 2. Keep prompt boundaries clean
- Cortex onboarding prompt: durable person-level defaults only
- Manager bootstrap prompt: project-specific orientation only
- Extractor prompt: hidden reliability patcher only

## D. Explicit non-goals for v1

- No full multi-user onboarding model
- No rich per-field provenance history beyond revision-based overwrite handling
- No requirement that already-running non-new sessions hot-reload onboarding changes immediately

The critical v1 guarantee is narrower and sufficient:
**newly created managers read the latest authoritative onboarding snapshot synchronously.**

---

## 9. Updated Test Plan

## A. First-launch and activation
1. Fresh install with no auth does not prematurely activate onboarding.
2. Fresh install after auth routes to the root Cortex session.
3. Initial onboarding opener is sent exactly once and records `firstPromptSentAt`.
4. `deferred` does not auto-reactivate on refresh/reopen.
5. Manual resume from `deferred` starts a new active onboarding cycle correctly.

## B. Save integrity / acknowledgment contract
6. When Cortex captures an explicit durable fact and the save succeeds, it may acknowledge future use.
7. When the save fails, Cortex does **not** claim it was remembered.
8. When completion/defer persistence fails, Cortex does **not** claim future managers will already know.
9. Assistant copy stays truthful under simulated disk-write/CAS failure.

## C. Dual-path reliability
10. If Cortex forgets to call the save tool for an explicit durable fact, the post-turn extractor recovers it.
11. Extractor returns NOOP for turns containing only transient/project-specific content.
12. Extractor can recover explicit skip/defer intent if Cortex missed the status tool call.
13. Extractor does not invent facts from weak implications.

## D. Concurrency / idempotency
14. Simultaneous Cortex-save and extractor-save attempts on the same revision do not corrupt state.
15. Stale `baseRevision` writes are rejected cleanly.
16. Retry with the same patch is idempotent.
17. Reset/redo onboarding changes `cycleId`, and stale writes from the previous cycle are rejected.

## E. Overwrite / supersede behavior
18. User changes a previously saved preference; new value becomes current and rendered view updates.
19. Corrected name/preference does not append duplicates into the managed `common.md` block.
20. Promotion of a fact updates rendered language cleanly without duplicating earlier tentative wording.

## F. `common.md` managed block behavior
21. Renderer inserts managed markers if absent.
22. Renderer updates only the managed block and preserves manual content outside it.
23. Natural-language ad hoc appends inside the managed block are not used by onboarding writes.
24. Render is triggered only on promotion/correction/completion/defer paths, not every turn.

## G. Manager bootstrap behavior
25. New manager reads the latest authoritative onboarding snapshot synchronously at creation.
26. If onboarding defaults exist, manager may acknowledge a baseline sense of working style.
27. If onboarding was skipped/deferred/empty, manager does not falsely claim prior knowledge.
28. Manager asks project/repo/bootstrap questions instead of re-running person-level onboarding.
29. Manager follows the bounded inspection protocol before asking unnecessary project questions.

## H. Boundary / scope tests
30. Repo-specific conventions shared during Cortex onboarding are not persisted as cross-project defaults unless explicitly framed that way.
31. Secrets/sensitive data are never written into onboarding state or rendered `common.md`.
32. One-off task requests are not stored as durable onboarding facts.
33. Ambiguous signals remain tentative or unsaved rather than promoted.

## I. Migration and backward compatibility
34. Existing installs with meaningful prior usage are marked `migrated` and not forced through onboarding.
35. Existing installs can manually opt into a new onboarding cycle later.
36. Migration does not overwrite pre-existing non-managed `common.md` content outside the managed block.

## J. Channel/target behavior
37. If onboarding is resumed through Slack/Telegram, replies preserve the inbound target/channel metadata.
38. Root-Cortex onboarding behavior does not leak into review/non-interactive Cortex sessions.

---

## 10. Final Recommendation

Proceed with the revised design.

The right v1 is now:

1. **Structured onboarding state is canonical**
2. **Cortex explicitly saves facts during onboarding**
3. **A post-turn extractor provides reliability backstop**
4. **The system never claims memory without confirmed persistence**
5. **`common.md` becomes a backend-managed rendered view**
6. **Managers synchronously read the latest onboarding snapshot at creation**
7. **Managers stay project-focused and only acknowledge prior defaults when they actually exist**

That preserves the original product strength — a warm conversational first experience — while fixing the most important systems problem: **reliable durable capture of onboarding context.**
