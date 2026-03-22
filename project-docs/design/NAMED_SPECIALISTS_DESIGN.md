# Named Specialist Agents — Design Document

> **Status:** **APPROVED — Ready for implementation**
> **Date:** 2026-03-22
> **Feature:** Named Specialist Agents
> **Scope:** Backend registry + spawn integration + manager prompt generation + settings UI + sidebar badge attribution

---

## 1. Overview & Motivation

Forge currently makes worker routing a **prompt-time improvisation problem**:

- `manager.md` contains a hardcoded model-routing section.
- `spawn_agent` exposes low-level composition knobs (`model`, `modelId`, `reasoningLevel`, `archetypeId`, `systemPrompt`).
- The manager must translate task intent into raw model/prompt parameters on every spawn.

That works, but it has clear failure modes:

1. **Routing logic is static and hardcoded.** The builtin manager prompt must be edited whenever the recommended roster changes.
2. **Prompt guidance and runtime configuration drift easily.** The prompt describes one set of model choices while settings/runtime may evolve separately.
3. **The manager reasons about plumbing instead of stable capabilities.** It has to choose model presets and prompt overrides directly instead of selecting from named, reusable worker templates.
4. **User customization is awkward.** There is no first-class place to define “use this worker for frontend review” or “this one is my fast scout.”

Named specialists solve this by introducing a new explicit abstraction:

> A **named specialist** is a reusable **worker spawn template** with a stable handle, persona/display name, pinned model config, full standalone system prompt, and manager-facing “when to use” guidance.

This improves the current system in four concrete ways:

- **Stable routing target:** managers choose `specialist: "backend"` instead of reconstructing raw spawn config every time.
- **Dynamic manager prompt:** the manager’s prompt receives a generated specialist roster block instead of hardcoded model-routing prose.
- **Profile-scoped customization:** profiles can override the effective roster without touching `agents.json` or builtin archetypes.
- **UI coherence:** Settings becomes the source of truth for the effective worker roster, and spawned workers surface their specialist identity in the sidebar.

This design does **not** replace archetypes. Archetypes remain the foundational role prompts (`manager`, `worker`, `merger`, `cortex`). Specialists are a new sibling concept used specifically for **named worker spawning**.

---

## 2. Concepts & Terminology

### 2.1 Specialist Definition

A **specialist definition** is a saved spawn template. It is:

- **not** a long-lived agent instance
- **not** a persistent persona with memory
- **not** an archetype
- **not** a manager/session identity

It is the data Forge resolves when a manager calls:

```ts
spawn_agent({
  agentId: "investigate-auth-regression",
  specialist: "backend",
  initialMessage: "Find the root cause and propose a fix."
})
```

The specialist provides:

- stable handle (`specialistId` / spawn handle)
- display name (persona label shown in UI)
- badge color
- enable/disable state
- pinned model config
- full saved system prompt
- “when to use” routing guidance

### 2.2 Relationship to Archetypes

Archetypes remain exactly what they are today:

- `manager.md` = manager constitution
- `worker.md` = generic worker constitution
- `merger.md` = merge worker constitution
- `cortex.md` = cortex constitution

Specialists do **not** layer on top of `worker.md` at runtime.

Approved rule for v1:

- `worker.md` is the **starting template** used when authoring a new specialist prompt.
- The saved specialist prompt is the **entire runtime prompt**.
- There is **no** append/inherit/replace mode for specialists.

That means a specialist’s `systemPrompt` field is authoritative at runtime.

### 2.3 Relationship to Models and Workers

- A **model preset** (current system) is a low-level routing primitive.
- A **specialist** is a higher-level worker template that pins a concrete model configuration.
- A **worker** is the spawned runtime instance created from a specialist or ad-hoc spawn input.

Specialists are the preferred path. Ad-hoc raw spawns remain as an escape hatch.

### 2.4 Resolution Layers

Specialists resolve in this order:

1. **Profile layer** — `profiles/<profileId>/specialists.json`
2. **Global layer** — `shared/specialists.json`
3. **Builtin layer** — repo-shipped default roster

Resolution semantics are **whole-record shadowing by `specialistId`**:

- Same `specialistId` in a higher layer completely replaces the lower-layer record.
- There is no field-by-field merge.
- This keeps specialist behavior predictable and consistent with the “full standalone prompt” rule.

---

## 3. Data Model

### 3.1 Core Specialist Schema

Add shared types in `packages/protocol/src/shared-types.ts` and mirror backend types in `apps/backend/src/swarm/types.ts`.

```ts
export type SpecialistSourceLayer = "builtin" | "global" | "profile";

export interface SpecialistDefinition {
  /** Stable handle used by spawn_agent.specialist and resolution. Kebab-case. */
  specialistId: string;

  /** Human-visible persona label shown in Settings and worker badges. */
  displayName: string;

  /** Normalized badge color. Store as hex for transport simplicity. */
  color: string; // e.g. "#7c3aed"

  /** Whether this specialist is eligible for manager prompt/tool exposure. */
  enabled: boolean;

  /** Manager-facing routing guidance. Rendered into the generated roster block. */
  whenToUse: string;

  /** Full standalone prompt used as the worker system prompt at runtime. */
  systemPrompt: string;

  /** Pinned runtime model configuration. */
  model: AgentModelDescriptor;
}

export interface SpecialistRosterFile {
  version: 1;
  updatedAt: string;
  specialists: SpecialistDefinition[];
}

export interface SpecialistAvailability {
  ok: boolean;
  code?: "missing_auth" | "unknown_provider" | "unknown_model" | "invalid_config";
  message?: string;
}

export interface ResolvedSpecialistDefinition extends SpecialistDefinition {
  sourceLayer: SpecialistSourceLayer;
  profileId: string;
  availability: SpecialistAvailability;
}
```

### 3.2 Existing Type Extensions

#### `AgentModelDescriptor`

Per approved/requested protocol scope, extend `AgentModelDescriptor` with optional specialist provenance:

```ts
export interface AgentModelDescriptor {
  provider: string;
  modelId: string;
  thinkingLevel: string;
  specialistId?: string;
}
```

This is useful when a worker’s model config is inspected independently from the full descriptor.

#### `AgentDescriptor`

Add worker-facing specialist identity fields so the sidebar and logs can render badges without a second lookup:

```ts
export interface AgentDescriptor {
  // existing fields...
  specialistId?: string;
  specialistDisplayName?: string;
  specialistColor?: string;
}
```

These fields are only populated for workers spawned in specialist mode.

#### `SessionMeta.promptComponents`

Extend prompt capture metadata so manager prompt fingerprints change when the resolved roster changes:

```ts
promptComponents: {
  archetype: string | null;
  agentsFile: string | null;
  skills: string[];
  memoryFile: string | null;
  profileMemoryFile: string | null;
  specialistIds?: string[];
  specialistRosterHash?: string | null;
} | null
```

This change lives in:

- `packages/protocol/src/shared-types.ts`
- `apps/backend/src/swarm/session-manifest.ts`

### 3.3 Storage Locations

Use dedicated JSON files. Do **not** store specialists in `agents.json`.

| Layer | Path | Notes |
|---|---|---|
| Builtin | `apps/backend/src/swarm/specialists/builtins.json` | Source-controlled default roster shipped with Forge |
| Global | `${FORGE_DATA_DIR}/shared/specialists.json` | Cross-profile overrides/defaults |
| Profile | `${FORGE_DATA_DIR}/profiles/<profileId>/specialists.json` | Profile-specific overrides |

Add helper path resolution in a new backend module, e.g.:

- `apps/backend/src/swarm/specialists/specialist-paths.ts`

### 3.4 File Format Rules

Each layer file stores only the definitions declared at that layer:

```json
{
  "version": 1,
  "updatedAt": "2026-03-22T12:00:00.000Z",
  "specialists": [
    {
      "specialistId": "backend",
      "displayName": "Specialist-A",
      "color": "#2563eb",
      "enabled": true,
      "whenToUse": "Backend/core implementation, TypeScript refactors, route debugging, tests.",
      "systemPrompt": "You are a worker agent in a swarm...",
      "model": {
        "provider": "openai-codex",
        "modelId": "gpt-5.3-codex",
        "thinkingLevel": "xhigh"
      }
    }
  ]
}
```

Validation rules:

- `specialistId` must normalize to lowercase kebab-case.
- `displayName` must be non-empty.
- `color` must be a valid normalized hex string.
- `whenToUse` must be non-empty after trim.
- `systemPrompt` must be non-empty after trim.
- `model.provider`, `model.modelId`, and `model.thinkingLevel` must be non-empty.
- Duplicate `specialistId` values in the same file are invalid.

### 3.5 Builtin Default Roster (v1)

Forge ships a default builtin roster seeded from the current preset/guidance model. Use placeholder persona names for now.

| specialistId | displayName | Seed model | Default guidance |
|---|---|---|---|
| `backend` | `Specialist-A` | `openai-codex / gpt-5.3-codex / xhigh` | Backend/core implementation, TypeScript work, refactors, debugging |
| `architect` | `Specialist-B` | `openai-codex / gpt-5.4 / xhigh` | Complex architecture, deep debugging, high-risk multi-file work |
| `review` | `Specialist-C` | `anthropic / claude-opus-4-6 / xhigh` | Frontend/UI polish, nuanced review, writing-heavy tasks |
| `app-runtime` | `Specialist-D` | `openai-codex-app-server / default / xhigh` | Tasks that specifically need the Codex app-server runtime |

Implementation note:

- The builtin roster is fixed in v1.
- Global/profile layers may override those definitions.
- Arbitrary user-created specialists are explicitly out of scope for v1.

### 3.6 What Gets Stored on Spawned Worker Descriptors

When a worker is spawned from a specialist, persist the following on the worker descriptor:

```ts
{
  specialistId: "backend",
  specialistDisplayName: "Specialist-A",
  specialistColor: "#2563eb",
  model: {
    provider: "openai-codex",
    modelId: "gpt-5.3-codex",
    thinkingLevel: "xhigh",
    specialistId: "backend"
  }
}
```

These fields are used for:

- sidebar badge rendering
- attribution/debugging
- worker restore behavior
- future analytics

---

## 4. Backend Changes

### 4.1 New Specialist Registry/Resolver Module

Add a new backend module family under:

- `apps/backend/src/swarm/specialists/`

Recommended files:

- `apps/backend/src/swarm/specialists/builtins.json`
- `apps/backend/src/swarm/specialists/specialist-paths.ts`
- `apps/backend/src/swarm/specialists/specialist-registry.ts`
- `apps/backend/src/swarm/specialists/specialist-validation.ts`

Registry responsibilities:

1. Load builtin/global/profile roster files.
2. Validate each layer.
3. Resolve the effective profile roster using `profile -> global -> builtin` shadowing.
4. Compute availability for each resolved specialist.
5. Render the manager roster markdown block.
6. Produce the enabled specialist list used by `spawn_agent` tool schema generation.
7. Save/delete layer overrides.

### 4.2 Manager Prompt Generation

#### New placeholder

Replace the hardcoded “Model and reasoning selection for workers” section in:

- `apps/backend/src/swarm/archetypes/builtins/manager.md`

with a single placeholder:

```md
${SPECIALIST_ROSTER}
```

#### Injection point

Centralize manager prompt composition in `apps/backend/src/swarm/swarm-manager.ts`.

Current code path:

- `resolveSystemPromptForDescriptor()` loads the manager archetype directly.
- `previewManagerSystemPrompt()` assembles preview content separately.

Replace both with a shared helper, e.g.:

```ts
private async buildResolvedManagerPrompt(descriptor: AgentDescriptor): Promise<{
  prompt: string;
  specialistIds: string[];
  specialistRosterHash: string;
  rosterBlock: string;
  archetypeSourcePath: string;
}>;
```

That helper must:

1. resolve the manager archetype content
2. resolve the effective specialist roster for `descriptor.profileId ?? descriptor.agentId`
3. generate the roster block
4. replace `${SPECIALIST_ROSTER}` in the archetype prompt
5. if the placeholder is absent, append the block once to the end of the prompt body
6. append integration context afterward
7. return prompt + metadata for session meta capture/preview

#### Generated roster block format

Use deterministic markdown. Do not generate freeform prose.

```md
Named specialist workers:
- Prefer `spawn_agent({ specialist: "<handle>" })` for normal worker delegation.
- Use ad-hoc `model` / `modelId` / `reasoningLevel` / `systemPrompt` only when no named specialist fits.

Available specialists for this profile:
- `backend` — **Specialist-A**
  - Use when: Backend/core implementation, TypeScript refactors, route debugging, tests.
  - Model: `openai-codex / gpt-5.3-codex / xhigh`
- `architect` — **Specialist-B**
  - Use when: Complex architecture, deep debugging, high-risk multi-file work.
  - Model: `openai-codex / gpt-5.4 / xhigh`
- `review` — **Specialist-C**
  - Use when: Frontend/UI polish, nuanced review, writing-heavy tasks.
  - Model: `anthropic / claude-opus-4-6 / xhigh`
```

Rules:

- Include only specialists where `enabled === true` and `availability.ok === true`.
- Preserve deterministic ordering based on builtin roster order.
- If no specialists are enabled/available, generate:

```md
Named specialist workers:
- No named specialists are currently enabled for this profile.
- Use ad-hoc `spawn_agent` mode with explicit `model` / `modelId` / `reasoningLevel` / `systemPrompt` parameters when you need workers.
```

### 4.3 `spawn_agent` Tool Changes

#### Type changes

Extend `SpawnAgentInput` in `apps/backend/src/swarm/types.ts`:

```ts
export interface SpawnAgentInput {
  agentId: string;
  specialist?: string;
  archetypeId?: AgentArchetypeId;
  systemPrompt?: string;
  model?: SwarmModelPreset;
  modelId?: string;
  reasoningLevel?: SwarmReasoningLevel;
  cwd?: string;
  initialMessage?: string;
}
```

#### Schema changes in `swarm-tools.ts`

Update `buildSwarmTools()` so `spawn_agent` advertises dual-mode operation:

- `specialist` = preferred path
- raw ad-hoc fields = escape hatch

Recommended parameter shape:

```ts
{
  agentId: string;
  specialist?: /* dynamic enum of enabled specialists for the profile */;
  archetypeId?: string;
  systemPrompt?: string;
  model?: "pi-codex" | "pi-5.4" | "pi-opus" | "codex-app";
  modelId?: string;
  reasoningLevel?: "none" | "low" | "medium" | "high" | "xhigh";
  cwd?: string;
  initialMessage?: string;
}
```

Tool description text should explicitly say:

- prefer `specialist`
- ad-hoc mode is advanced/escape-hatch
- `specialist` is mutually exclusive with raw model/prompt parameters

#### Validation rules in `SwarmManager.spawnAgent()`

Add a first-pass validation helper:

```ts
private validateSpawnMode(input: SpawnAgentInput):
  | { mode: "specialist"; specialistId: string }
  | { mode: "adhoc" };
```

Rules:

- if `specialist` is present, reject any of:
  - `archetypeId`
  - `systemPrompt`
  - `model`
  - `modelId`
  - `reasoningLevel`
- `cwd` and `initialMessage` remain legal in both modes

#### Specialist-mode spawn path

In specialist mode:

1. Resolve the effective specialist for the manager’s profile.
2. Ensure it exists, is enabled, and is currently available.
3. Build the worker descriptor with:
   - `model` copied from specialist definition
   - `specialistId`, `specialistDisplayName`, `specialistColor`
4. Use `specialist.systemPrompt` as the base worker prompt.
5. Append the worker identity block with `injectWorkerIdentityContext()`.
6. Create runtime exactly as today.

Runtime prompt resolution rule:

- specialist workers should resolve from `descriptor.specialistId` first
- fall back to archetype/default worker behavior only for non-specialist workers

This requires updating `resolveSystemPromptForDescriptor()` to detect persisted specialist workers on restore.

### 4.4 Prompt Preview and Session Meta Capture

Update `previewManagerSystemPrompt()` in `apps/backend/src/swarm/swarm-manager.ts` to reuse `buildResolvedManagerPrompt()`.

Changes:

- The full preview in Prompts continues to show the final composed system prompt.
- Add a separate preview route for the roster block only (see §5.4 / §6.5).
- Capture `specialistIds` + `specialistRosterHash` into session meta prompt components.

### 4.5 Runtime Recycle on Roster Changes

Specialist roster changes alter the manager system prompt and tool schema. They therefore require the same recycle/defer policy already used for manager model changes.

Reuse existing machinery in `apps/backend/src/swarm/swarm-manager.ts`:

- `applyManagerRuntimeRecyclePolicy()`
- `recycleManagerRuntime()`

Add a new recycle reason:

```ts
"specialist_roster_change"
```

Behavior:

- **Profile-layer save/delete**: recycle manager runtimes for that profile.
- **Global-layer save/delete**: recycle all manager runtimes whose effective roster may change. For v1, it is acceptable to recycle all manager sessions across all profiles.
- **Idle sessions** recycle immediately.
- **Busy sessions** mark pending recycle and switch on the next safe idle transition.

Existing workers are **not** force-recycled. They keep their current runtime prompt and descriptor metadata.

### 4.6 Migration / Seeding

No destructive migration is required.

Rules:

- If `shared/specialists.json` does not exist, resolve the builtin roster in memory.
- If `profiles/<profileId>/specialists.json` does not exist, profile falls back to global/builtin.
- Do not eagerly write files on boot.
- Only write a layer file once the user saves an override.

This preserves current installs and avoids churn in untouched profiles.

### 4.7 Interaction with `model-presets.ts`

`apps/backend/src/swarm/model-presets.ts` remains in place for:

- ad-hoc spawn mode preset parsing
- manager self-model changes
- compatibility helpers

Its role changes from **worker-routing source of truth** to **seed-data/helper module**.

Specifically:

- current preset descriptors seed the builtin specialist roster
- raw ad-hoc mode still uses the preset union
- manager prompt no longer reads hardcoded routing prose from model preset logic

### 4.8 Concrete Backend Files to Touch

#### New files

- `apps/backend/src/swarm/specialists/builtins.json`
- `apps/backend/src/swarm/specialists/specialist-paths.ts`
- `apps/backend/src/swarm/specialists/specialist-registry.ts`
- `apps/backend/src/swarm/specialists/specialist-validation.ts`
- `apps/backend/src/ws/routes/specialist-routes.ts`

#### Existing files

- `apps/backend/src/swarm/archetypes/builtins/manager.md`
- `apps/backend/src/swarm/archetypes/builtins/worker.md` (template source only; no runtime layering changes)
- `apps/backend/src/swarm/model-presets.ts`
- `apps/backend/src/swarm/swarm-tools.ts`
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/swarm/types.ts`
- `apps/backend/src/swarm/session-manifest.ts`
- `apps/backend/src/ws/server.ts`
- `apps/backend/src/ws/routes/prompt-routes.ts` (preview integration if needed)

---

## 5. Protocol Changes

### 5.1 Shared Type Additions

Add and export from `packages/protocol/src/shared-types.ts`:

- `SpecialistSourceLayer`
- `SpecialistDefinition`
- `SpecialistRosterFile`
- `SpecialistAvailability`
- `ResolvedSpecialistDefinition`

Re-export from `packages/protocol/src/index.ts`.

### 5.2 Existing Type Changes

Update shared/backend mirrored types:

- `AgentModelDescriptor.specialistId?: string`
- `AgentDescriptor.specialistId?: string`
- `AgentDescriptor.specialistDisplayName?: string`
- `AgentDescriptor.specialistColor?: string`
- `SpawnAgentInput.specialist?: string`
- `SessionMeta.promptComponents.specialistIds?: string[]`
- `SessionMeta.promptComponents.specialistRosterHash?: string | null`

### 5.3 Specialist Settings/Event Types

Add a new server event in `packages/protocol/src/server-events.ts`:

```ts
export interface SpecialistRosterChangedEvent {
  type: "specialist_roster_changed";
  scope: "global" | "profile";
  profileId?: string;
  changedSpecialistIds: string[];
  updatedAt: string;
}
```

Purpose:

- notify live Settings UIs to refresh
- invalidate cached roster preview
- trigger manager runtime recycle bookkeeping

Add it to the `ServerEvent` union.

No new websocket `ClientCommand` is required for CRUD because Settings already uses HTTP endpoints served by the backend’s WS server process. Specialist management follows the same pattern as prompts and slash commands: HTTP API + websocket invalidation event.

### 5.4 HTTP Route Additions (served by WS server)

Add a dedicated route bundle:

- `apps/backend/src/ws/routes/specialist-routes.ts`

Recommended endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/specialists?profileId=<id>` | Return resolved roster for the selected profile |
| `GET` | `/api/specialists/<specialistId>?profileId=<id>&layer=<profile|global|builtin|resolved>` | Return one specialist definition/view |
| `PUT` | `/api/specialists/<specialistId>` | Upsert a profile/global layer record |
| `DELETE` | `/api/specialists/<specialistId>?profileId=<id>&scope=<profile|global>` | Delete an override record and fall back to lower layer |
| `GET` | `/api/specialists/roster-prompt?profileId=<id>` | Return generated manager roster block only |

Request/response transport types should live in `packages/protocol/src/shared-types.ts` if needed, mirroring existing prompt/settings conventions.

### 5.5 Route Registration

Register the new route bundle in:

- `apps/backend/src/ws/server.ts`

If prompt preview integration needs a typed provider, extend the existing route setup similarly to `prompt-routes.ts`.

---

## 6. Frontend Changes

### 6.1 New Settings Tab

Add a top-level Settings tab named **Specialists**.

Files:

- `apps/ui/src/components/settings/SettingsLayout.tsx`
- `apps/ui/src/components/chat/SettingsDialog.tsx`
- new `apps/ui/src/components/settings/SettingsSpecialists.tsx`

Changes:

- extend `SettingsTab` with `'specialists'`
- add nav item (recommended icon: `UserStar` or similar)
- render `<SettingsSpecialists />` from `SettingsDialog`

### 6.2 Settings Data/API Layer

Add frontend API helpers:

- `apps/ui/src/components/settings/specialists-api.ts`

Extend UI settings types:

- `apps/ui/src/components/settings/settings-types.ts`

Needed UI-side types:

- `ResolvedSpecialistDefinition`
- roster preview response type
- save payload type

### 6.3 Roster Editor Layout

The Specialists tab is a roster editor for the **effective profile roster**.

V1 UI scope rule:

- the tab operates in the currently selected profile context
- edits write **profile-layer overrides**
- deleting an override falls back to the resolved lower layer (`global` or `builtin`)
- dedicated global-scope editing is supported by the backend route model but is not required in the initial UI surface

Per specialist card, render:

- colored badge using `displayName` + `color`
- read-only handle (`specialistId`) or compact handle input if future creation is enabled
- enable/disable switch
- model config summary row
- “When to use” field
- full prompt editor
- source-layer indicator (`profile`, `global`, `builtin`)
- reset/revert action if the active record comes from an override layer

Recommended composition:

- `SettingsSection` wrapper from `settings-row.tsx`
- `Card` per specialist
- `Badge` for specialist pill and source layer
- `Switch` for enable/disable
- `Textarea` for `whenToUse`
- reuse `PromptEditor` patterns for the prompt editing surface

### 6.4 Model / Reasoning Configuration UI

Each specialist needs editable model config.

Recommended controls per card:

1. **Preset select** — `pi-codex`, `pi-5.4`, `pi-opus`, `codex-app`
2. **Provider/modelId summary** — derived and editable if advanced override is exposed
3. **Reasoning level select** — existing reasoning enum values

For v1, the cleanest implementation is:

- preset selector as the primary control
- reasoning level selector always visible
- provider/modelId rendered read-only from the selected preset unless/until advanced custom models are intentionally supported

This keeps v1 aligned with the current seeded model infrastructure while preserving raw `AgentModelDescriptor` storage under the hood.

### 6.5 Prompt Editor Behavior

The prompt editor is for the **full runtime system prompt**.

Rules:

- no “base prompt” wording in the UI
- no append/replace toggles
- label clearly as “System prompt”
- helper text should explain that the saved content is the exact prompt the worker receives

Creation semantics:

- builtin seeded specialists already ship with full prompts
- when a new override is first created from a lower layer, the editor starts from the resolved full prompt
- the worker archetype file (`apps/backend/src/swarm/archetypes/builtins/worker.md`) remains the default template source for any future add-specialist flow

### 6.6 “When to Use” Guidance Field

Each card includes a dedicated `whenToUse` field.

Label:

- **When to use**

Helper text:

- “Describe the kinds of tasks managers should delegate to this specialist. This text appears in the manager’s generated specialist roster.”

This field directly populates the generated roster block.

### 6.7 “View Roster Prompt” Preview

Add a preview action in the Specialists tab:

- button label: **View roster prompt**

This opens a dialog showing only the generated `${SPECIALIST_ROSTER}` block for the selected profile.

Implementation:

- call `/api/specialists/roster-prompt?profileId=<id>`
- render returned markdown in a read-only `<pre>` or monospace block
- include copy action

This preview is separate from the full Prompts tab runtime preview.

### 6.8 Sidebar Badge on Spawned Workers

Update worker rendering in:

- `apps/ui/src/components/chat/AgentSidebar.tsx`

Current worker rows render:

- title
- runtime badge

Add a reusable badge component, e.g.:

- `apps/ui/src/components/chat/SpecialistBadge.tsx`

Render it for workers where `agent.specialistId` is present.

Badge content:

- visible label: `agent.specialistDisplayName`
- color: `agent.specialistColor`
- tooltip: include `specialistId` and pinned model summary

Placement:

- inline in `WorkerRow`, between the worker title and the runtime badge
- preserve existing sidebar density and truncation behavior

### 6.9 Frontend Files to Touch

#### New files

- `apps/ui/src/components/settings/SettingsSpecialists.tsx`
- `apps/ui/src/components/settings/specialists-api.ts`
- `apps/ui/src/components/chat/SpecialistBadge.tsx`
- `apps/ui/src/components/settings/SettingsSpecialists.test.tsx`

#### Existing files

- `apps/ui/src/components/settings/SettingsLayout.tsx`
- `apps/ui/src/components/chat/SettingsDialog.tsx`
- `apps/ui/src/components/settings/settings-types.ts`
- `apps/ui/src/components/chat/AgentSidebar.tsx`
- `apps/ui/src/components/chat/AgentSidebar.test.tsx`

---

## 7. Manager Archetype Changes

### 7.1 Remove Hardcoded Routing Section

In `apps/backend/src/swarm/archetypes/builtins/manager.md`, remove the entire section beginning with:

```md
Model and reasoning selection for workers:
```

This section is replaced by generated specialist roster content.

### 7.2 Add Placeholder

Insert the literal placeholder:

```md
${SPECIALIST_ROSTER}
```

Recommended placement: exactly where the removed hardcoded routing section currently sits, between “Delegation protocol” and “When manager may execute directly”.

### 7.3 Generated Block Contract

The generated block must include, for each visible specialist:

- handle (`specialistId`)
- display name (`displayName`)
- “when to use” guidance (`whenToUse`)
- model config summary (`provider / modelId / thinkingLevel`)

No specialist prompt content is injected into `manager.md`.

### 7.4 Fallback Behavior

If a profile override of `manager.md` does not contain `${SPECIALIST_ROSTER}`:

- append the generated roster block once at the end of the resolved archetype prompt body
- then append any integration context

This preserves compatibility with existing profile prompt overrides.

### 7.5 Prompt Preview Behavior

The Prompts tab full runtime preview must reflect the same generated roster content the manager runtime receives. Do not maintain a second prompt assembly path.

---

## 8. Implementation Phases

### Phase 1 — Shared Types + Specialist Registry Foundation

**Dependencies:** none

Implement:

- shared/backend specialist types
- `AgentDescriptor` / `AgentModelDescriptor` extensions
- specialist path helpers
- builtin roster file
- resolver/validation layer

Primary files:

- `packages/protocol/src/shared-types.ts`
- `packages/protocol/src/server-events.ts`
- `packages/protocol/src/index.ts`
- `apps/backend/src/swarm/types.ts`
- new `apps/backend/src/swarm/specialists/*`

### Phase 2 — Manager Prompt Generation + Preview Integration

**Depends on:** Phase 1

Implement:

- `${SPECIALIST_ROSTER}` placeholder in `manager.md`
- shared manager prompt builder in `swarm-manager.ts`
- prompt preview integration
- session meta roster hash/id capture

Primary files:

- `apps/backend/src/swarm/archetypes/builtins/manager.md`
- `apps/backend/src/swarm/swarm-manager.ts`
- `apps/backend/src/swarm/session-manifest.ts`

### Phase 3 — Spawn Path + Tool Schema

**Depends on:** Phase 1 and Phase 2

Implement:

- `SpawnAgentInput.specialist`
- dual-mode spawn validation
- specialist-mode worker descriptor population
- runtime prompt resolution for restored specialist workers
- `buildSwarmTools()` specialist-aware schema/description

Primary files:

- `apps/backend/src/swarm/types.ts`
- `apps/backend/src/swarm/swarm-tools.ts`
- `apps/backend/src/swarm/swarm-manager.ts`

### Phase 4 — HTTP Routes + Change Broadcast + Runtime Recycle

**Depends on:** Phase 1 through Phase 3

Implement:

- `/api/specialists*` route bundle
- roster preview endpoint
- `specialist_roster_changed` websocket event
- manager runtime recycle on roster changes

Primary files:

- new `apps/backend/src/ws/routes/specialist-routes.ts`
- `apps/backend/src/ws/server.ts`
- `apps/backend/src/swarm/swarm-manager.ts`

### Phase 5 — Settings UI

**Depends on:** Phase 4 response contracts stabilized

Implement:

- new Settings tab
- roster cards
- enable/disable toggle
- when-to-use editor
- prompt editor
- model/reasoning controls
- roster prompt preview dialog

Primary files:

- `apps/ui/src/components/settings/SettingsLayout.tsx`
- `apps/ui/src/components/chat/SettingsDialog.tsx`
- new `apps/ui/src/components/settings/SettingsSpecialists.tsx`
- new `apps/ui/src/components/settings/specialists-api.ts`
- `apps/ui/src/components/settings/settings-types.ts`

### Phase 6 — Sidebar Specialist Badge

**Depends on:** Phase 3 descriptor fields available

Implement:

- `SpecialistBadge` component
- worker row badge rendering
- sidebar tests

Primary files:

- `apps/ui/src/components/chat/AgentSidebar.tsx`
- new `apps/ui/src/components/chat/SpecialistBadge.tsx`

### Phase 7 — Validation / Tests / Polish

**Depends on:** all prior phases

Implement:

- backend unit tests for resolver and spawn validation
- route tests for CRUD/preview endpoints
- prompt preview coverage
- sidebar/settings UI tests
- runtime recycle coverage

Suggested tests:

- `apps/backend/src/test/ws-server.test.ts`
- new `apps/backend/src/test/specialist-registry.test.ts`
- `apps/ui/src/components/chat/AgentSidebar.test.tsx`
- new `apps/ui/src/components/settings/SettingsSpecialists.test.tsx`

### Parallelization Notes

Safe parallel tracks after Phase 1:

- **Track A:** manager prompt generation + spawn path
- **Track B:** HTTP route surface + protocol broadcast event
- **Track C:** frontend settings scaffolding against stubbed types

The sidebar badge can proceed in parallel once the descriptor fields are fixed.

---

## 9. Edge Cases & Validation

### 9.1 Zero Enabled Specialists

This is allowed in v1 because ad-hoc spawn mode remains available.

Behavior:

- manager roster block explicitly states that no named specialists are enabled
- `spawn_agent.specialist` tool description reflects that none are available
- Settings shows an inline warning
- managers must use ad-hoc spawn mode until at least one specialist is re-enabled

### 9.2 Disabled Specialist Referenced by a Running Session

If a specialist is disabled after workers were already spawned from it:

- existing workers keep their persisted `specialistId`, `specialistDisplayName`, and `specialistColor`
- existing runtimes are not interrupted
- future specialist-mode spawns using that handle fail validation
- the manager roster block omits the disabled specialist

### 9.3 Missing Provider Auth for a Specialist Model

Availability is computed separately from persistence.

Rules:

- saving a specialist with a model whose provider auth is missing is allowed
- resolved specialist gets `availability.ok === false`
- Settings card shows a warning state
- unavailable specialists are omitted from the generated manager roster block
- direct `spawn_agent({ specialist })` calls against an unavailable specialist fail with a clear error

### 9.4 Duplicate Handles Across Scopes

Validation behavior:

- duplicate `specialistId` values in the **same layer file** are invalid and reject save/load
- same `specialistId` across **different layers** is expected and means shadowing
- highest-precedence layer wins: `profile > global > builtin`

### 9.5 Empty or Missing Prompts

Rules:

- UI save rejects blank `systemPrompt`
- UI save rejects blank `whenToUse`
- registry skips invalid file entries and logs validation failures
- builtin roster must always ship with non-empty prompts

### 9.6 Invalid Color Values

Rules:

- UI normalizes color picker output to hex
- backend validates hex format on save/load
- invalid persisted colors fall back to a default neutral badge color and surface a validation warning

### 9.7 Placeholder Missing from Overridden `manager.md`

Behavior is fixed:

- append generated roster block once before integration context
- do not fail prompt assembly
- do not silently omit roster guidance

### 9.8 Stale Manager Runtime After Settings Save

Manager tool schema and prompt can go stale until recycle.

Behavior:

- roster save triggers recycle/defer policy for impacted sessions
- execution-time validation always checks the latest resolved roster, even if the tool schema is stale
- stale managers fail safely with explicit errors instead of spawning with outdated specialist definitions

### 9.9 Worker Restore After Restart

Specialist workers persist `specialistId` on the descriptor.

Restore behavior:

- on runtime restore, `resolveSystemPromptForDescriptor()` re-resolves the current specialist definition by `specialistId`
- already-running workers do not hot-reload prompt changes; only restored/new workers do
- this matches current descriptor-based restore behavior and avoids prompt snapshots in v1

---

## 10. Future Considerations (Out of Scope for v1)

The following are intentionally deferred:

1. **Custom user-created specialists beyond builtins**
   - v1 ships a fixed builtin roster with global/profile overrides
   - arbitrary create/delete flows are future work

2. **Specialist analytics / usage tracking**
   - counts, success rates, cost reporting, stale specialist detection

3. **`list_specialists` tool for manager introspection**
   - useful future complement to prompt-time roster generation
   - not required for v1 because the manager prompt already contains the roster

4. **Per-specialist memory or context attachments**
   - specialist-specific reference docs, memory lanes, or context bundles

5. **Specialist versioning**
   - prompt/model/version history, rollback, change audit, prompt snapshots

---

## Implementation Summary

Named specialists should be implemented as a **first-class worker spawn template system** with these concrete properties:

- full standalone saved prompts
- profile/global/builtin resolution via dedicated JSON files
- dynamic manager prompt roster injection through `${SPECIALIST_ROSTER}`
- `spawn_agent.specialist` as the preferred path
- ad-hoc spawn mode preserved as an escape hatch
- persisted worker specialist attribution for sidebar badges and restore logic
- a new Settings → Specialists roster editor as the primary configuration surface

This gives Forge a stable, editable, profile-scoped worker routing abstraction without collapsing archetypes into something they are not.

---

## Review Notes (Opus)

### 1. Correctness Issues

**1a. `buildSwarmTools` has no access to the specialist roster — dynamic enum won't work as described.**

The doc says `spawn_agent`'s `specialist` parameter should be a "dynamic enum of enabled specialists for the profile." But `buildSwarmTools()` (`swarm-tools.ts:106`) receives only `(host: SwarmToolHost, descriptor: AgentDescriptor)`. It has no access to the specialist registry or the resolved roster. The function builds TypeBox schemas statically at tool-construction time.

To make the enum dynamic, either:
- Pass the resolved specialist list as a third argument to `buildSwarmTools`
- Add a method to the `SwarmToolHost` interface (e.g., `getEnabledSpecialistIds(): string[]`)
- Pre-resolve the list in `SwarmManager` and thread it through

This is a real wiring gap that will block Phase 3 implementation unless addressed.

**1b. `resolvePromptVariables()` won't handle `${SPECIALIST_ROSTER}` correctly.**

The existing `resolvePromptVariables()` in `prompt-registry.ts:316` does simple synchronous `Record<string, string>` replacement. But specialist roster generation requires async I/O (loading files, checking auth availability). The doc says to replace `${SPECIALIST_ROSTER}` in the archetype prompt, but doesn't specify whether this happens inside or outside `resolvePromptVariables()`. It should happen in the new `buildResolvedManagerPrompt()` helper, *after* the normal variable resolution pass, since it needs async specialist resolution. The doc implies this but should say so explicitly to prevent an implementer from trying to wedge it into the existing variable system.

**1c. Type definitions are duplicated across two packages — doc should specify import, not mirror.**

§3.1 says to "Add shared types in `packages/protocol/src/shared-types.ts` and mirror backend types in `apps/backend/src/swarm/types.ts`." The existing pattern is mixed: `ManagerProfile` is defined in protocol and re-exported from backend `types.ts` (`export type { ManagerProfile }`), while `AgentDescriptor` is separately defined in both packages. New specialist types should follow one pattern explicitly. For `SpecialistDefinition`, `SpecialistRosterFile`, etc., the clean path is: define in protocol, import in backend. "Mirror" implies copy-paste duplication, which creates drift.

**1d. `applyManagerRuntimeRecyclePolicy` reason union needs extension.**

Current signature (`swarm-manager.ts:2537`):
```ts
private async applyManagerRuntimeRecyclePolicy(
  agentId: string,
  reason: "model_change" | "idle_transition" | "prompt_mode_change"
)
```
The doc proposes adding `"specialist_roster_change"` but doesn't call out that this is a discriminated string union that must be explicitly extended. Minor, but an implementer needs to know to update this union.

**1e. Worker descriptor `archetypeId` is unspecified for specialist-mode spawns.**

The doc says `specialist` and `archetypeId` are mutually exclusive in spawn *input*, but doesn't specify what `descriptor.archetypeId` is set to on the resulting worker. Currently `resolveSpawnWorkerArchetypeId()` (`swarm-manager.ts:4973`) returns `undefined` unless `archetypeId` is explicit or the agentId matches `merger-*`. For specialist workers, `archetypeId` will be `undefined`. This is fine but should be stated explicitly since it affects archetype-based prompt resolution on restore.

### 2. Gaps & Missing Details

**2a. Specialist resolution for `buildSwarmTools` needs explicit threading design.**

As noted in 1a, the doc doesn't specify how the specialist roster reaches the tool schema builder. This is a core wiring question. The recommended approach: resolve the roster in `SwarmManager` when creating/recycling runtimes, and pass the enabled specialist IDs to `buildSwarmTools`. This means the function signature changes, which should be documented in the design.

**2b. Production-mode file resolution for `builtins.json` is not addressed.**

`prompt-registry.ts` uses `fileURLToPath(new URL(".", import.meta.url))` to locate builtin files reliably in both dev and production builds. The doc places `builtins.json` at `apps/backend/src/swarm/specialists/builtins.json` but doesn't specify how the specialist registry finds it at runtime after TypeScript compilation. The new `specialist-registry.ts` will need the same `import.meta.url`-relative resolution pattern.

**2c. Capacity fallback for specialist-mode spawns is unaddressed.**

The current spawn path runs `resolveSpawnModelWithCapacityFallback()` (`swarm-manager.ts:2060`) to handle provider rate limits. The doc doesn't say whether specialist-mode spawns go through this fallback. They should — a capacity-blocked specialist model should fall back the same way ad-hoc spawns do. State this explicitly.

**2d. No migration path for the hardcoded routing section removal in `manager.md`.**

§7.1 says to remove the "Model and reasoning selection for workers:" section from `manager.md`. But existing profile-level overrides of `manager.md` (via the prompt registry's profile layer at `profiles/<profileId>/prompts/archetypes/manager.md`) will still contain the old hardcoded section. The doc's §7.4 fallback (append if placeholder missing) handles runtime behavior, but the user experience is confusing: they'd see both the old hardcoded routing prose AND the appended generated roster. The doc should recommend either:
- A one-time migration that detects and strips the old section from profile overrides
- A documented note in the roster preview warning when profile overrides contain legacy routing prose

**2e. Profile context for the Settings tab.**

The `SettingsPanel` component (`SettingsDialog.tsx`) receives `profiles` but the Specialists tab needs to know the *currently selected profile* to resolve the correct roster. Looking at `SettingsPrompts`, it receives `profiles` and implements its own profile selector dropdown. The doc should explicitly note that `SettingsSpecialists` needs the same pattern — an internal profile selector — and specify whether the selected profile defaults to the currently active session's profile.

**2f. How `injectWorkerIdentityContext()` interacts with specialist prompts.**

§4.3 says the specialist-mode spawn path should "Append the worker identity block with `injectWorkerIdentityContext()`." The doc should confirm that AGENTS.md loading, SWARM.md loading, memory injection, and skill content injection all still apply to specialist workers. Currently these are handled by the runtime factory (`RuntimeFactory`), not in `injectWorkerIdentityContext()`. Specialist workers need the same runtime context injection as ad-hoc workers. This is likely already the case (the runtime factory handles it), but it's worth confirming since the specialist prompt is positioned as "authoritative."

**2g. No test strategy for the builtin roster content.**

§8 (Phase 7) lists test files but doesn't mention validating that the shipped `builtins.json` is well-formed, has non-empty prompts, references valid model providers, etc. A simple schema validation test for the builtin JSON file should be included.

### 3. Design Concerns

**3a. Three-layer resolution with `global` is a new pattern — consider whether it's needed for v1.**

The existing prompt system uses `profile → repo → builtin` (no global layer). Specialists introduce `profile → global → builtin`, which is a new resolution pattern. For v1, where arbitrary user-created specialists are out of scope, the `global` layer adds complexity without clear benefit — users can't create specialists, and the four builtins are always available from the builtin layer. Profile overrides handle customization.

Recommendation: defer the global layer to a future version. Use `profile → builtin` for v1. This simplifies the registry, the route surface (no `scope=global` parameter), the recycle policy (no "recycle all managers across profiles" case), and the Settings UI (no source-layer ambiguity between global and builtin).

**3b. "Full standalone prompt" creates a maintenance burden when `worker.md` evolves.**

The doc says specialist prompts are standalone — no layering on `worker.md`. This means when `worker.md` is updated (e.g., new agent identity conventions, new safety rules), all four builtin specialist prompts must be manually kept in sync. With `worker.md` as a 16-line file today, this is manageable, but the doc should explicitly flag this as a maintenance cost and recommend either:
- A CI check that validates specialist prompts contain expected worker-identity sections
- A documented convention for when `worker.md` changes require specialist prompt updates

**3c. Mutually exclusive validation creates a sharp edge for managers.**

The doc says if `specialist` is present, reject `model`, `modelId`, `reasoningLevel`, `systemPrompt`, and `archetypeId`. In practice, managers may naturally try `spawn_agent({ specialist: "backend", reasoningLevel: "low" })` to use a specialist with reduced reasoning. This is a reasonable intent that would fail with a validation error.

Consider: allow `reasoningLevel` as a per-spawn override even in specialist mode. It's the most common tuning knob and doesn't conflict with the specialist template concept. The specialist provides defaults; the spawn call can downshift reasoning for quick tasks.

**3d. Sidebar badge placement between title and RuntimeBadge is tight.**

The `WorkerRow` layout (`AgentSidebar.tsx:430-431`) renders:
```tsx
<span className="min-w-0 flex-1 truncate text-sm leading-5">{title}</span>
<RuntimeBadge agent={agent} isSelected={isSelected} />
```
Adding a colored specialist badge between these in a row that's already `pl-12 pr-1.5` will crowd the available space, especially for long worker names. The doc should specify truncation/overflow behavior and consider whether the specialist badge *replaces* RuntimeBadge for specialist workers (since the specialist already encodes the model) rather than sitting alongside it.

### 4. Naming & Consistency

**4a. `specialistId` on `AgentModelDescriptor` is a semantic mismatch.**

`AgentModelDescriptor` is a *model configuration* type (`provider`, `modelId`, `thinkingLevel`). Adding `specialistId` to it is provenance metadata, not model configuration. It creates an odd coupling where a pure model descriptor carries spawn-template identity. The doc's rationale is "useful when a worker's model config is inspected independently from the full descriptor," but in practice this is only needed in rare debug scenarios.

Recommendation: keep `specialistId` on `AgentDescriptor` only (where it's already proposed). Drop it from `AgentModelDescriptor`. If model-inspection code needs specialist context, it can look at the parent descriptor.

**4b. `SpecialistSourceLayer` vs `PromptSourceLayer` naming.**

`PromptSourceLayer` is `"profile" | "repo" | "builtin"`. `SpecialistSourceLayer` is `"builtin" | "global" | "profile"`. These are similar concepts with different value sets and no shared type. If the global layer is kept, consider aligning naming: `DataSourceLayer` as a shared type, or at minimum document why the difference exists.

**4c. Placeholder persona names (`Specialist-A`, `Specialist-B`, etc.) ship to users.**

The builtin roster uses `Specialist-A` through `Specialist-D` as display names. These are bland and don't help managers reason about specialist capabilities. Even for v1, more descriptive names would improve routing quality. Suggestions: `Backend Engineer`, `Architect`, `Reviewer`, `App Runtime`. The `specialistId` handles still provide the stable reference.

### 5. Sequencing & Phase Risks

**5a. Phase 2 depends on knowing the specialist registry API, not just Phase 1 types.**

Phase 2 (Manager Prompt Generation) builds `buildResolvedManagerPrompt()` which must call the specialist registry to get the resolved roster. The registry implementation is part of Phase 1, but the prompt builder needs the *API shape* of the registry (what methods are available, what they return). These phases are more tightly coupled than the dependency arrows suggest. In practice, they should be implemented by the same worker or sequentially, not in parallel.

**5b. Phase 3 parallel track with Phase 2 is risky.**

Phase 3 (Spawn Path) depends on Phase 2's prompt builder being functional — the spawn path needs to resolve specialist prompts, which is intertwined with how the registry works. The parallelization note says "Track A: manager prompt generation + spawn path" but these are actually the same track. The true parallel opportunities are:
- Track A: Phase 1 + 2 + 3 (backend registry, prompt gen, spawn — sequential)
- Track B: Phase 4 (HTTP routes — once registry API is stable)
- Track C: Phase 5 + 6 (frontend — once route contracts are stable)

**5c. Phase 5 (Settings UI) is under-scoped.**

The Settings UI is the largest surface area in this design: per-specialist cards with model selectors, reasoning dropdowns, color pickers, prompt editors, enable/disable toggles, when-to-use text areas, source-layer badges, reset actions, and a roster preview dialog. This is more complex than any existing Settings tab. The phase description doesn't reflect this — it should be estimated as the heaviest frontend phase and potentially split into sub-phases (roster list → card editing → prompt editor → preview).

**5d. No explicit "remove hardcoded routing prose from manager.md" phase.**

§7.1 says to remove the hardcoded routing section, but this change isn't clearly assigned to a phase. It's implicitly Phase 2, but it's a high-risk edit to a live archetype prompt that affects all running managers. It should be explicitly called out as a step within Phase 2 with a note about testing the fallback behavior (§7.4) for profile overrides that lack the placeholder.

### 6. Strengths

- **Clean separation from archetypes.** The doc is very explicit that specialists are *not* archetypes, and the §2.2 relationship section is well-articulated. This prevents the architectural confusion that would arise from overloading the archetype system.
- **Whole-record shadowing is the right resolution semantic.** No field-level merge avoids a large class of confusing partial-override bugs.
- **Worker descriptor persistence for sidebar/restore is well thought out.** Storing `specialistId`, `specialistDisplayName`, and `specialistColor` on the descriptor avoids lookup-at-render-time and handles the case where the specialist definition changes after a worker is spawned.
- **Edge cases section (§9) is thorough.** Covering zero-enabled specialists, disabled-while-running, missing auth, stale runtimes, and restore behavior shows good anticipation of real failure modes.
- **Fallback when placeholder is missing (§7.4).** Appending the roster block when profile overrides lack `${SPECIALIST_ROSTER}` is a pragmatic compatibility choice.
- **Migration approach (§4.6).** Lazy file creation (only on first user save) avoids unnecessary churn and is consistent with how the prompt registry works.
- **Existing recycle machinery reuse (§4.5).** Leveraging `applyManagerRuntimeRecyclePolicy` and `recycleManagerRuntime` rather than building new lifecycle management is the right call.
- **The generated roster block format (§4.2).** Deterministic markdown with structured entries gives managers exactly the information they need without freeform prose that could drift.