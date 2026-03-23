# Research: skill + slash command usage telemetry

## Executive summary

Today Forge has **inventory** for skills and slash commands, but almost no **first-class usage telemetry**.

What exists today:
- **Skills discovered/available** can be listed via backend metadata (`apps/backend/src/swarm/skill-metadata-service.ts`, `SwarmManager.listSkillMetadata()`), and manager `session meta` records which skill file paths were part of the session prompt context (`promptComponents.skills`).
- **Tool activity** is already captured in session history as durable `agent_tool_call` entries with `toolName`, `toolCallId`, timestamp, actor, and serialized args/results.
- **Feedback** is stored per session/message with timestamps, reason codes, comments, and channel.
- **Slash commands** are stored and editable, but their runtime usage is not tracked.

What does **not** exist today:
- No `skill_used` / `skill_loaded` / `slash_command_used` event.
- No central usage counter or `lastUsedAt` for skills or slash commands.
- No way to reliably know which configured slash command was used in chat.
- No direct join between feedback and skill/slash-command usage.

Important nuance:
- For **skills**, Cortex could already do a **heuristic** pass by mining session tool calls, especially `read` of `SKILL.md` and shell execution of scripts inside skill directories.
- For **custom slash commands**, Cortex **cannot reliably reconstruct usage** from existing session data, because the UI replaces the `/command` token with the command’s prompt text before the backend sees it.

Minimal viable telemetry:
1. Emit a durable `skill_used` event when an agent explicitly loads a skill (best low-churn trigger: `read` on a discovered `SKILL.md`).
2. Emit a durable `slash_command_used` event from the UI/backend message pipeline when a configured custom slash command is selected/submitted.
3. Store both as simple JSONL events under shared telemetry storage; derive counters offline instead of maintaining mutable aggregates.

---

## 1) Skill system internals

### 1.1 Discovery, registration, and precedence

The main entrypoint is:
- `apps/backend/src/swarm/skill-metadata-service.ts`

This service:
- scans skill locations,
- parses `SKILL.md` frontmatter,
- builds the list of available skills,
- exposes both human metadata and raw skill file paths.

### Skill search locations

Discovery order in `SkillMetadataService.scanSkillPathCandidates()`:
1. `${dataDir}/skills` (machine-local)
2. `${rootDir}/.swarm/skills` (repo-local overrides)
3. `apps/backend/src/swarm/skills/builtins` (repo built-ins)
4. backend package fallback built-ins

Required built-ins are hard-coded in `REQUIRED_SKILL_NAMES`:
- `memory`
- `brave-search`
- `cron-scheduling`
- `agent-browser`
- `image-generation`
- `slash-commands`
- `chrome-cdp`

Resolution behavior:
- required skills are forced to resolve,
- duplicates are de-duped by normalized skill name,
- machine-local overrides win over repo-local, which win over bundled built-ins.

This is also covered by tests in:
- `apps/backend/src/test/swarm-manager.test.ts`
  - auto-loads built-ins
  - prefers machine-local overrides over repo skills

### 1.2 What Forge parses from a skill

Forge frontmatter parsing is in:
- `apps/backend/src/swarm/skill-frontmatter.ts`

Fields Forge explicitly reads:
- `name`
- `description`
- `env` / `envVars`
  - `name`
  - `description`
  - `required`
  - `helpUrl`

Forge does **not** have a richer internal skill manifest. The important point is:
- skills are basically **instruction packages**, not code plugins.
- the runtime mostly needs the **path to `SKILL.md`** plus parsed metadata for listings/settings.

### 1.3 How skills are injected into agent context

#### Pi runtime

For the pi runtime, skills are explicitly wired through:
- `apps/backend/src/swarm/runtime-factory.ts`

`createPiRuntimeForDescriptor()` builds a `DefaultResourceLoader` with:
- `additionalSkillPaths: memoryResources.additionalSkillPaths`

Those paths come from:
- `SwarmManager.getMemoryRuntimeResources()`
- which calls `skillMetadataService.getAdditionalSkillPaths()`

Forge also records the skill file paths in session meta via:
- `apps/backend/src/swarm/swarm-manager.ts`
- `captureSessionRuntimePromptMeta()`

That writes `promptComponents.skills` into `meta.json`.

#### Actual loading behavior

Pi’s own docs (`node_modules/.../@mariozechner/pi-coding-agent/docs/skills.md`) say the model flow is:
1. startup scans skills and extracts name/description,
2. the system prompt includes the available skills list,
3. when the task matches, the agent uses `read` to load the full `SKILL.md`,
4. then it follows the instructions and uses referenced scripts/docs.

So the model sees:
- **description always**, as prompt-time inventory,
- **full skill instructions on demand**, typically via `read`.

This means skill usage is **not a first-class runtime invocation** today; it is usually a pattern of:
- skill description available in prompt,
- then a normal `read` tool call on the skill file,
- then normal `bash` / `read` / `write` / other tool calls.

#### Codex runtime

I did **not** find equivalent skill injection for the Codex app-server runtime.

In `runtime-factory.ts`:
- `createPiRuntimeForDescriptor()` passes `additionalSkillPaths`
- `createCodexRuntimeForDescriptor()` does **not**

The Codex path builds a system prompt from:
- base system prompt
- swarm context files
- memory context

but not skill paths/content.

So, based on current code, skills appear to be a **pi-runtime feature path**, while Codex runtime does **not** currently get the same skill wiring.

That matters for telemetry because:
- `promptComponents.skills` may suggest skills were part of the session metadata snapshot,
- but Codex runtime does not appear to consume them the same way.

### 1.4 Skill anatomy: what Cortex would need to generate

A skill is just a directory with `SKILL.md` plus any helper files.

Example structure from pi docs and current built-ins:

```text
my-skill/
├── SKILL.md
├── scripts/
│   └── helper.mjs
├── references/
│   └── api.md
└── assets/
    └── template.json
```

What matters operationally:
- `SKILL.md` is the only required file.
- Supporting files are freeform.
- The agent is expected to use normal tools (`read`, `bash`, etc.) to access them.
- Relative paths in the markdown are intended to resolve from the skill directory.
- There is **no separate registry file**, DB row, or compiled plugin step.

### 1.5 Built-in skill examples

#### Memory
- File: `apps/backend/src/swarm/skills/builtins/memory/SKILL.md`
- Pure workflow instructions
- No helper script
- Uses `${SWARM_MEMORY_FILE}`

#### Brave Search
- Files:
  - `apps/backend/src/swarm/skills/builtins/brave-search/SKILL.md`
  - `search.js`
  - `content.js`
- Declares env requirement:
  - `BRAVE_API_KEY`
- Skill tells agent when to run helper scripts

#### Slash Commands
- Files:
  - `apps/backend/src/swarm/skills/builtins/slash-commands/SKILL.md`
  - `slash-commands.js`
- Skill is only a management workflow for stored commands
- It does **not** make slash commands first-class runtime commands

#### Chrome CDP
- File: `apps/backend/src/swarm/skills/builtins/chrome-cdp/SKILL.md`
- Good example of a skill referencing helper scripts relative to the skill dir (`scripts/cdp.mjs`)

### 1.6 What is already measurable about skills today

Today you can measure:
- which skills are installed/discovered,
- which env-backed skills are configured,
- which skill paths were included in manager session prompt metadata.

You cannot directly measure:
- whether the agent actually loaded a skill,
- whether the agent followed the skill instructions,
- whether a skill produced a good outcome.

---

## 2) Slash command system today

## 2.1 Storage

Slash command path helpers exist in:
- `apps/backend/src/swarm/data-paths.ts`

Paths:
- legacy profile path: `profiles/<profileId>/slash-commands.json`
- current global path: `shared/slash-commands.json`

Current storage is global via:
- `getGlobalSlashCommandsPath(dataDir)`

HTTP CRUD is implemented in:
- `apps/backend/src/ws/routes/slash-command-routes.ts`

Stored shape:

```json
{
  "commands": [
    {
      "id": "uuid",
      "name": "summary",
      "prompt": "Summarize the latest changes.",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

There is also a one-time migration at startup that merges legacy profile-scoped slash command files into the global shared file.

### 2.2 CRUD paths

Slash commands can be:
- listed: `GET /api/slash-commands`
- created: `POST /api/slash-commands`
- updated: `PUT /api/slash-commands/:id`
- deleted: `DELETE /api/slash-commands/:id`

There is also a built-in management skill/CLI:
- `apps/backend/src/swarm/skills/builtins/slash-commands/slash-commands.js`

That CLI reads/writes the same shared JSON file.

### 2.3 How slash commands are actually executed

This is the most important finding.

#### Custom stored slash commands are UI prompt expansion, not backend commands

Flow:
1. UI loads commands from `/api/slash-commands`
   - `apps/ui/src/components/settings/slash-commands-api.ts`
   - `apps/ui/src/routes/index.tsx`
2. `MessageInput` shows autocomplete when the input starts with `/`
   - `apps/ui/src/components/chat/MessageInput.tsx`
3. When the user selects a slash command, `selectSlashCommand()` does:
   - `setInputWithDraft(command.prompt)`
4. On submit, the UI sends the resulting text via `sendUserMessage()`
   - not the original `/command` token

So custom slash commands are currently:
- **stored prompt snippets**,
- **expanded in the frontend**,
- **not executed by the backend as named commands**.

That means the backend generally sees only:
- the expanded prompt text
- not the slash command id/name that produced it

#### Built-in `/compact` is different

`/compact` is a separate hard-coded flow:
- parsed in UI: `apps/ui/src/routes/index.tsx`
- parsed again in backend: `apps/backend/src/swarm/swarm-manager.ts`
- triggers `compactAgentContext(... trigger: "slash_command")`

Important behavior from tests:
- `/compact` does **not** get forwarded as a normal user prompt,
- the raw `/compact` user message is **not** persisted as a normal conversation message,
- history instead gets system messages like “Compacting manager context...” and “Compaction complete.”

So there are really **two different slash-command concepts** in Forge:
1. **Stored custom slash commands** = frontend prompt expansion snippets
2. **Hard-coded manager slash commands** like `/compact` = actual command handling logic

### 2.4 Existing slash-command usage logging

I did not find any first-class usage logging for either:
- custom stored slash commands
- built-in `/compact`

For custom stored slash commands:
- no `useCount`
- no `lastUsedAt`
- no usage event
- no message metadata preserving the originating command id/name

For `/compact`:
- no explicit slash-command usage log/event
- only indirect evidence in conversation history/system messages

---

## 3) Session JSONL format and what it already records

## 3.1 Durable conversation entries

Forge persists its own durable conversation layer via:
- `apps/backend/src/swarm/conversation-projector.ts`

Persisted durable entries are written into `session.jsonl` as:

```json
{
  "type": "custom",
  "customType": "swarm_conversation_entry",
  "data": { ... actual event ... },
  "id": "...",
  "parentId": "...",
  "timestamp": "..."
}
```

The file also has a session header line:

```json
{
  "type": "session",
  "version": 1,
  "id": "...",
  "timestamp": "...",
  "cwd": "..."
}
```

### 3.2 Tool calls are already logged with tool names

Protocol shape:
- `packages/protocol/src/server-events.ts`
- `apps/backend/src/swarm/types.ts`

Relevant event:
- `type: "agent_tool_call"`

Fields:
- `agentId`
- `actorAgentId`
- `timestamp`
- `kind` (`tool_execution_start`, `tool_execution_update`, `tool_execution_end`)
- `toolName`
- `toolCallId`
- `text` (serialized args/result)
- `isError`

Projection from runtime events happens in:
- `conversation-projector.ts` -> `captureToolCallActivityFromRuntime()`

Persistence behavior:
- `tool_execution_start` and `tool_execution_end` are durable
- `tool_execution_update` is **not** persisted to `session.jsonl`
- transient `conversation_log` events are in-memory/cache only

So yes: **tool calls are already logged with tool names**.

### 3.3 Are skill invocations distinguishable from regular tool calls?

Not directly.

There is no event like:
- `skill_used`
- `skill_loaded`
- `skill_completed`

However, skills are often inferable heuristically from ordinary tool calls:
- `read` on a known `.../SKILL.md`
- `read` on files under a known skill directory
- `bash` commands invoking known skill helper scripts
  - e.g. `slash-commands.js`
  - `schedule.js`
  - `search.js`
  - `content.js`

This is usable, but imperfect.

### 3.4 Are slash command executions logged?

#### Custom stored slash commands
No, not reliably.

Because the UI replaces `/name` with `command.prompt` before submit, the session only contains the expanded prompt text.

Result:
- you cannot tell which slash command generated that prompt,
- you cannot distinguish typed prompt text from slash-command-expanded prompt text,
- you cannot calculate slash command adoption from session JSONL.

#### Built-in `/compact`
Only indirectly.

You can infer that compaction happened from system messages / compaction effects, but not treat it as a clean `slash_command_used` event.

### 3.5 Can Cortex extract skill/slash usage from existing session data today?

#### Skills
**Yes, heuristically.**

Cortex could mine:
- `agent_tool_call` entries where `toolName = read` and args path matches a discovered skill file
- `agent_tool_call` entries where `toolName = bash` and the command references known skill helper scripts
- session meta `promptComponents.skills` to know which skills were available in that session

This would give a rough answer to:
- which skills were probably loaded,
- which were available but apparently never touched.

But it would still miss cases where:
- the model used the skill based only on description and did not explicitly read `SKILL.md`,
- the agent manually performed equivalent steps without loading the skill,
- the agent used a skill via another runtime path.

#### Custom slash commands
**No, not reliably.**

The originating slash command identity is lost before backend persistence.

---

## 4) Feedback system today

Main implementation:
- `apps/backend/src/swarm/feedback-service.ts`

## 4.1 What feedback data is collected

Each stored feedback event contains:
- `id`
- `createdAt`
- `profileId`
- `sessionId`
- `scope` (`message` or `session`)
- `targetId`
- `value` (`up`, `down`, `comment`)
- `reasonCodes`
- `comment`
- `channel` (`web`, `slack`, `telegram`)
- `actor` (`user`)

Reason codes come from `packages/protocol/src/feedback.ts`, including:
- `accuracy`
- `instruction_following`
- `autonomy`
- `speed`
- `verbosity`
- `formatting`
- `product_ux_direction`
- `needs_clarification`
- `over_engineered`
- `great_outcome`
- `poor_outcome`

Session meta is also updated with:
- `feedbackFileSize`
- `lastFeedbackAt`

## 4.2 Important nuance: this is current-state storage, not a full event history

Despite using JSONL, `FeedbackService.submitFeedback()`:
- reads the whole file,
- replaces/removes prior entries for the same `(actor, scope, targetId, kind)`,
- rewrites the file.

So this is effectively a **latest-state store**, not an append-only audit log.

Implication:
- you can see the **current/latest** feedback state per target,
- but not the full sequence of changes over time.

That limits telemetry analysis.

## 4.3 Can feedback be correlated with skill usage?

### Message-level correlation
Message feedback targets a specific assistant message id/timestamp.

The UI resolves feedback targets from the conversation message id, or falls back to timestamp:
- `apps/ui/src/components/chat/MessageList.tsx`
- `apps/ui/src/components/chat/message-list/ConversationMessageRow.tsx`

There is already a helper script for matching feedback targets back into session JSONL context:
- `apps/backend/src/swarm/scripts/feedback-target-context.ts`

So if skill usage were detectable, you could correlate:
- feedback target message
- nearby preceding tool calls
- possibly preceding skill loads

### Limits today
- No direct foreign key from feedback -> skill usage
- No direct foreign key from feedback -> slash command usage
- Custom slash-command identity is lost
- Feedback history is latest-state only

So correlation is currently possible only as an **offline heuristic timeline join**.

---

## 5) What is missing

## 5.1 Skill telemetry gaps

Missing today:
- per-skill usage counter
- per-skill last-used timestamp
- per-session list of actually used skills
- distinction between:
  - skill available
  - skill loaded
  - skill completed successfully
  - skill likely helped produce the final answer
- clean way to know “installed but never used”

What exists but is not enough:
- installed skill list (`/api/settings/skills`)
- prompt component skill paths in session meta
- heuristic tool-call traces

## 5.2 Slash command telemetry gaps

Missing today:
- per-command usage counter
- per-command last-used timestamp
- message/session linkage to originating command
- adoption reporting
- differentiation between command selection and actual submission

Biggest gap:
- the backend does not know which custom slash command was used

## 5.3 Distinguishing “manual work” vs “skill use” today

Today, not reliably.

Examples:
- If an agent directly runs `search.js`, that looks similar to using the Brave skill.
- If an agent manually edits memory without reading the memory skill first, that is not visibly “skill usage”.
- If a user writes a prompt that resembles a slash command expansion, it is indistinguishable from selecting the stored slash command.

## 5.4 Can we know which skills are installed but never used?

### Today
Only approximately.

Possible heuristic:
- inventory installed skills from `listSkillMetadata()` / promptComponents
- scan session logs for matching `read SKILL.md` or skill-script invocations
- mark others as “apparently unused”

But this is not first-class telemetry and will produce false negatives.

---

## 6) Minimal viable telemetry addition

The smallest useful change is to add **event logging**, not counters.

Why event logging first:
- lower churn
- append-only and debuggable
- easy for Cortex to mine
- derived counters can be computed later

## 6.1 Proposed event storage

Add a shared JSONL file, e.g.:

```text
${SWARM_DATA_DIR}/shared/telemetry/skill-usage.jsonl
```

or separate files:
- `shared/telemetry/skill-usage.jsonl`
- `shared/telemetry/slash-command-usage.jsonl`

I would prefer append-only JSONL over mutable counters.

## 6.2 Proposed `skill_used` event

Trigger (minimal/low-churn):
- when a runtime `read` tool call targets a discovered `SKILL.md` path

Why this is a good MVP trigger:
- it matches pi’s progressive-disclosure model,
- it is already observable from tool call args,
- no skill format redesign required,
- no UI changes required.

Suggested payload:

```json
{
  "type": "skill_used",
  "timestamp": "2026-03-23T21:00:00.000Z",
  "profileId": "feature-manager",
  "sessionId": "feature-manager--s12",
  "managerId": "feature-manager--s12",
  "agentId": "worker-3",
  "agentRole": "worker",
  "runtime": "pi",
  "skillName": "brave-search",
  "skillPath": "/abs/path/.../brave-search/SKILL.md",
  "detection": "read_skill_file",
  "toolCallId": "tool-123"
}
```

Optional later enrichment:
- `turnId`
- `model`
- `sourceToolName`
- `sourceArgs`
- `success` / `error`

### Where to emit it

Best place:
- near existing runtime tool-call capture in the backend
- likely adjacent to `agent_tool_call` handling / conversation projection path

Reason:
- tool args are already available,
- skill metadata path index already exists,
- backend has session/profile/agent context.

### What this enables immediately

- skill adoption counts over time
- “installed but never loaded” reports
- per-session/per-profile skill usage
- rough feedback joins by timestamp + session + target message timeline

## 6.3 Proposed `slash_command_used` event

Because custom slash commands are expanded in the UI, the telemetry hook must be in the message input/send path.

Suggested payload:

```json
{
  "type": "slash_command_used",
  "timestamp": "2026-03-23T21:00:00.000Z",
  "profileId": "feature-manager",
  "sessionId": "feature-manager--s12",
  "agentId": "feature-manager--s12",
  "channel": "web",
  "commandId": "uuid",
  "commandName": "summary",
  "submissionKind": "expanded_prompt"
}
```

### Where to emit it

Minimal-change option:
- in the UI, preserve selected slash-command metadata until submit,
- send that metadata alongside `sendUserMessage`,
- backend appends telemetry event.

This is less invasive than moving slash-command expansion server-side.

### Caveat
Because selection currently rewrites the textbox to raw prompt text, telemetry should be tied to **submit**, not mere selection, to avoid false positives.

## 6.4 Do we need counters in storage?

Not initially.

Derive these offline:
- total uses
- last used at
- per-profile counts
- per-session counts
- used/unused skill inventory

If a dashboard later needs instant aggregates, materialize them from JSONL.

---

## 7) What Cortex can do today vs after MVP telemetry

## Today

### Skills
Cortex can approximate:
- installed skills
- skills available in a session
- likely skill loads by mining `agent_tool_call` entries

### Slash commands
Cortex can measure:
- configured commands

Cortex cannot reliably measure:
- which custom commands were actually used
- which sessions/messages came from them

### Feedback
Cortex can correlate:
- session/message feedback targets
- nearby tool activity

But only heuristically, and only against latest-state feedback.

## After MVP telemetry

Cortex could answer cleanly:
- Which skills are installed but never used?
- Which skills are most/least adopted?
- Which profiles/sessions use which skills?
- Which custom slash commands are actually used?
- Does using a given skill/slash command correlate with positive feedback?

---

## 8) Recommended lowest-churn implementation plan

1. **Add append-only telemetry JSONL storage** under shared telemetry.
2. **Emit `skill_used`** when `read` hits a discovered `SKILL.md` path.
3. **Emit `slash_command_used`** when a selected custom slash command is actually submitted.
4. **Do not add counters yet**.
5. Optionally add a small analysis script later to compute:
   - per-skill counts
   - per-command counts
   - never-used inventory
   - feedback correlation summaries

This is the smallest change that gives Cortex real adoption data without redesigning the skill system or slash command execution model.

---

## Bottom line

- **Skills today:** discoverable, injected into pi-runtime context, and partially inferable from session tool logs — but not explicitly measured.
- **Slash commands today:** configurable and stored, but custom command usage is effectively invisible after frontend expansion.
- **Feedback today:** useful, but latest-state only and not directly linked to skills/commands.
- **MVP telemetry:** add first-class append-only `skill_used` and `slash_command_used` events; compute everything else from those.
