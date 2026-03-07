# Upstream model/runtime analysis (GPT-5.4 + SDK + Claude runtime chain)

## Scope and method

Analyzed upstream commits from `SawyerHood/middleman`:

1. `5b79730` — Update pi SDKs and move pi-codex preset to gpt-5.4
2. `f0c0cd7` — Update codex-app preset model ID to gpt-5.4
3. `f237a7a` — chore: update pi and claude agent sdk deps
4. `b5f2099` — Trim list_agents output and add includeTerminated opt-in
5. `3f34b1a` — Add Claude Code runtime with MCP tool bridge
6. `66af36e` — Fix Claude runtime stop, stream-exit, and replay handling
7. `c3e9603` — Fix Claude Code tool completion + MCP bridge coverage + sidebar icon
8. `9c07f85` — Fix Claude Code tool lifecycle: emit tool_execution_end for all completion signals
9. `5b209f9` — Fix worker detail history for codex/claude runtimes

Comparison target: current local `main` (radopsai fork).

Commands used per commit:
- `git show <sha>` (full patch + file-level logic)
- `git diff <sha> HEAD -- <changed-files>` (equivalence/overlap vs current fork)

---

## Current fork baseline (important for applicability)

### Model/runtime state in current `main`
- `apps/backend/src/swarm/model-presets.ts`
  - `pi-codex` => `openai-codex/gpt-5.3-codex`
  - `codex-app` => `openai-codex-app-server/default`
  - no `claude-code` preset
- `apps/ui/src/lib/model-preset.ts`
  - infers `pi-codex` only from `gpt-5.3-codex`
  - infers `codex-app` only from `default`
- `apps/backend/src/config.ts`
  - default model still `openai-codex/gpt-5.3-codex`
- `apps/backend/src/swarm/runtime-factory.ts`
  - supports PI runtime + codex-app runtime only
  - no Claude Code runtime path
- `apps/backend/src/swarm/swarm-tools.ts`
  - `list_agents` returns full `AgentDescriptor` payload (includes heavy fields)
  - no `includeTerminated` parameter
- `apps/backend/src/ws/routes/settings-routes.ts`
  - still imports OAuth providers from `@mariozechner/pi-ai/dist/utils/oauth/...`

### Dependency baseline in current `main`
- `apps/backend/package.json`
  - `@mariozechner/pi-ai`: `^0.55.0`
  - `@mariozechner/pi-coding-agent`: `^0.55.0`
  - no `@anthropic-ai/claude-agent-sdk`
- `pnpm-lock.yaml`
  - `openai@6.10.0`

### Quick divergence snapshot (`git diff <sha> HEAD -- changed-files`)
- `5b79730`: all 5 changed files differ (`M5`)
- `f0c0cd7`: 7 files modified, 2 upstream test files missing in fork (`M7 D2`)
- `f237a7a`: all 4 changed files differ (`M4`)
- `b5f2099`: 2 files modified, 2 Claude bridge files missing (`M2 D2`)
- `3f34b1a`: 15 files modified, 6 newly introduced upstream files missing (`M15 D6`)
- `66af36e`: both changed files missing (`D2`)
- `c3e9603`: 2 files modified, 3 files missing (`M2 D3`)
- `9c07f85`: both changed files missing (`D2`)
- `5b209f9`: 2 files modified, 3 files missing (`M2 D3`)

---

## Commit-by-commit analysis

## 1) `5b79730` — Update pi SDKs and move pi-codex preset to gpt-5.4

### Upstream diff summary
**Files changed**
- `apps/backend/package.json`
  - `@mariozechner/pi-ai`: `^0.56.0` → `^0.56.2`
  - `@mariozechner/pi-coding-agent`: `^0.56.0` → `^0.56.2`
- `apps/backend/src/swarm/model-presets.ts`
  - introduces constants:
    - `PI_CODEX_MODEL_ID = "gpt-5.4"`
    - `LEGACY_PI_CODEX_MODEL_ID = "gpt-5.3-codex"`
  - `pi-codex` descriptor model changes to `gpt-5.4`
  - inference updated to accept both `gpt-5.4` and legacy `gpt-5.3-codex`
- `apps/ui/src/lib/model-preset.ts`
  - same `pi-codex` inference update + legacy compatibility
- `apps/backend/src/test/swarm-manager.test.ts`
  - expected `pi-codex` manager/worker model ID changed from `gpt-5.3-codex` → `gpt-5.4`
- `pnpm-lock.yaml`
  - lock refresh for `0.56.2` SDKs
  - notable transitive bump: `openai@6.10.0` → `openai@6.26.0`

### Intent
Move canonical PI Codex preset to GPT-5.4 while keeping backward compatibility for persisted legacy descriptors.

### Comparison vs current fork
- Not present in fork:
  - current preset still canonical `gpt-5.3-codex`
  - current UI inference does **not** recognize `gpt-5.4` for `pi-codex`
  - backend SDKs still `0.55.0`
- Tests in fork still expect `gpt-5.3-codex`.

### Applicability
**ADAPT**
- High-value for GPT-5.4 migration.
- Needs conflict resolution with fork-specific model-preset extensions (`parseSwarmReasoningLevel`, etc.) and broad test expectation updates.

---

## 2) `f0c0cd7` — Update codex-app preset model ID to gpt-5.4

### Upstream diff summary
**Files changed**
- `apps/backend/src/swarm/model-presets.ts`
  - adds constants:
    - `CODEX_APP_MODEL_ID = "gpt-5.4"`
    - `LEGACY_CODEX_APP_MODEL_ID = "default"`
  - `codex-app` canonical descriptor becomes `gpt-5.4`
  - inference accepts both canonical and legacy IDs
- `apps/ui/src/lib/model-preset.ts`
  - same canonical+legacy infer logic for `codex-app`
- Tests updated across:
  - `apps/backend/src/test/codex-agent-runtime*.test.ts`
  - `apps/backend/src/test/swarm-manager.test.ts`
  - `apps/backend/src/test/ws-server.test.ts`
  - `apps/backend/src/test/runtime-factory.test.ts`
  - `apps/backend/src/test/model-presets.test.ts` (new codex-app canonical + legacy inference assertions)
  - `apps/ui/src/components/chat/AgentSidebar.test.ts`

### Intent
Switch canonical codex-app model ID to GPT-5.4 while preserving compatibility for old `default` records.

### Comparison vs current fork
- Not present in fork:
  - backend + UI still canonical `default`
  - no legacy dual-acceptance logic
- Fork also lacks upstream `model-presets.test.ts`/`runtime-factory.test.ts` files (those test suites are currently absent here).

### Applicability
**ADAPT**
- Needed for consistent GPT-5.4 codex-app preset identity.
- Requires re-homing upstream tests into fork’s current test layout.

---

## 3) `f237a7a` — chore: update pi and claude agent sdk deps

### Upstream diff summary
**Files changed**
- `apps/backend/package.json`
  - `@anthropic-ai/claude-agent-sdk`: `^0.2.63` → `^0.2.68`
  - `@mariozechner/pi-ai`: `^0.55.0` → `^0.56.0`
  - `@mariozechner/pi-coding-agent`: `^0.55.0` → `^0.56.0`
- `apps/backend/src/ws/routes/settings-routes.ts`
  - OAuth imports migrate from deep `dist/utils/oauth/...` paths to:
    - `import * as piAiOAuth from "@mariozechner/pi-ai/oauth"`
    - provider extraction via typed casts
  - OAuth types imported from `@mariozechner/pi-ai` root exports
- `apps/backend/src/test/ws-server-p0-endpoints.test.ts`
  - OAuth mock path updated to `@mariozechner/pi-ai/oauth`
- `pnpm-lock.yaml`
  - lock refresh for upgraded SDK stack

### Intent
Upgrade SDK versions and align OAuth imports with new pi-ai export surface.

### Comparison vs current fork
- Not present in fork:
  - still on `pi-*` `0.55.0`
  - no `@anthropic-ai/claude-agent-sdk` dependency
  - settings routes still use removed/deep import paths
  - tests still mock deep paths
- Fork’s `ws-server-p0-endpoints` suite has additional profile/integration assertions; upstream patch cannot be cleanly dropped in.

### Applicability
**ADAPT**
- Required prerequisite for later SDK/model updates.
- Must merge import-path fix into fork’s expanded settings/test code.

---

## 4) `b5f2099` — Trim list_agents output and add includeTerminated opt-in

### Upstream diff summary
**Files changed**
- `apps/backend/src/swarm/swarm-tools.ts`
  - `list_agents` now:
    - accepts optional `includeTerminated: boolean`
    - defaults to active statuses only (`idle`/`streaming`)
    - returns compact entries only: `{agentId, role, managerId, status, model}`
  - description updated to document default active filtering + opt-in inactive inclusion
- `apps/backend/src/swarm/claude-code-tool-bridge.ts`
  - Zod schema for `list_agents` updated from `{}` to `{ includeTerminated?: boolean }`
- `apps/backend/src/test/swarm-tools.test.ts`
  - adds extensive coverage for default active filtering + compact payload + includeTerminated behavior
- `apps/backend/src/test/claude-code-tool-bridge.test.ts`
  - asserts `includeTerminated` is accepted/forwarded through MCP bridge

### Intent
Reduce high-cardinality tool output and give explicit opt-in for terminated/stopped agents.

### Comparison vs current fork
- Partial overlap only:
  - fork has **manager/session scoping filter** in `list_agents` (not in upstream commit)
  - fork still returns full heavy descriptor payload and no `includeTerminated`
- Claude bridge files from upstream do not exist in fork yet.

### Applicability
**ADAPT**
- Strongly useful in this fork (token pressure from verbose `list_agents` output is a known issue).
- Must preserve fork’s session scoping behavior while adding compact payload + `includeTerminated`.

---

## 5) `3f34b1a` — Add Claude Code runtime with MCP tool bridge

### Upstream diff summary
**Major additions**
- New runtime: `apps/backend/src/swarm/claude-code-runtime.ts` (~1088 LOC)
  - integrates `@anthropic-ai/claude-agent-sdk` `query()` stream
  - supports MCP server + allowed tool names
  - supports persisted Claude session resume via custom runtime-state entries
  - emits runtime session events for user/assistant/tool lifecycle and compaction states
  - handles input queue + steer delivery semantics
  - tracks context usage from SDK `modelUsage`
- New MCP bridge: `apps/backend/src/swarm/claude-code-tool-bridge.ts`
  - wraps existing swarm tools as SDK MCP tools with per-tool Zod schemas
  - normalizes args and maps tool result/errors to SDK-safe text blocks
- Dependencies:
  - add `@anthropic-ai/claude-agent-sdk@^0.2.63`
  - add direct `zod@^4.3.6`

**Preset/protocol/UI wiring**
- `apps/backend/src/swarm/types.ts` and `packages/protocol/src/shared-types.ts`
  - add `claude-code` to model preset enums
- `apps/backend/src/swarm/model-presets.ts`
  - add `claude-code` => `anthropic-claude-code/claude-opus-4-6`
- `apps/backend/src/swarm/runtime-factory.ts`
  - route `provider === anthropic-claude-code` to new runtime
- `apps/backend/src/swarm/swarm-tools.ts`
  - allow `spawn_agent.model = claude-code`
- `apps/backend/src/swarm/swarm-manager.ts`
  - runtime error log classification includes `anthropic-claude-code`
- UI:
  - `apps/ui/src/lib/model-preset.ts` infers `claude-code`
  - `apps/ui/src/components/chat/AgentSidebar.tsx` icon + model label updates
  - `apps/ui/src/hooks/index-page/use-context-window.ts` adds `claude-code: 200_000`

**Tests added/updated**
- new suites:
  - `claude-code-runtime.test.ts`
  - `claude-code-tool-bridge.test.ts`
  - `model-presets.test.ts`
  - `runtime-factory.test.ts`
- existing suites updated for new preset acceptance/error strings.

### Intent
Introduce a full Claude Code runtime path using SDK query stream + MCP tool bridge and integrate it into preset/protocol/UI layers.

### Comparison vs current fork
- This entire feature is absent in fork:
  - no `claude-code-runtime.ts`
  - no `claude-code-tool-bridge.ts`
  - no `claude-code` preset in backend/protocol/UI
- Fork runtime factory and manager are heavily diverged (session-file guard hooks, Cortex tool filtering, profile/session architecture), so direct patching will conflict.

### Applicability
**ADAPT (major)**
- Not a clean cherry-pick.
- Requires full integration pass into fork-specific runtime abstractions.

---

## 6) `66af36e` — Fix Claude runtime stop, stream-exit, and replay handling

### Upstream diff summary
**Files changed**
- `apps/backend/src/swarm/claude-code-runtime.ts`
  - `sendMessage` now ensures query stream is available (`ensureQueryAvailable`)
  - `stopInFlight` clears pending queue + input queue
  - stream loop refactored to central `handleUnexpectedStreamExit(error)`
    - reports `runtime_exit`
    - clears queue/maps
    - emits `agent_end` when needed
    - transitions runtime to `terminated`
  - replayed user/assistant messages are skipped to avoid duplicate projection
- `apps/backend/src/test/claude-code-runtime.test.ts`
  - adds coverage for queue clearing, unexpected stream termination behavior, replay suppression

### Intent
Harden Claude runtime lifecycle handling for interruption/exit/replay correctness.

### Comparison vs current fork
- Both changed files are absent in fork.

### Applicability
**ADAPT (depends on `3f34b1a`)**
- Relevant only after Claude runtime base exists.

---

## 7) `c3e9603` — Fix Claude Code tool completion + MCP bridge coverage + sidebar icon

### Upstream diff summary
**Files changed**
- `apps/backend/src/swarm/claude-code-runtime.ts`
  - removes `isSynthetic === true` requirement when mapping tool completion from user messages with `parent_tool_use_id + tool_use_result`
- `apps/backend/src/test/claude-code-runtime.test.ts`
  - updates expectations for MCP-prefixed tool names and broader completion handling
  - verifies bridge builder invocation/allowed tools setup
- `apps/backend/src/test/claude-code-tool-bridge.test.ts`
  - adds end-to-end wiring test from MCP handlers → swarm host callbacks
- UI:
  - `apps/ui/src/components/chat/AgentSidebar.tsx`
    - introduces `ClaudeCodeIconPair` (double Claude icon treatment)
    - runtime icon check expanded for preset/provider
  - `apps/ui/src/components/chat/AgentSidebar.test.ts`
    - asserts dual icon rendering for Claude Code worker row

### Intent
Fix missed tool completion signal path and improve bridge + sidebar UX coverage.

### Comparison vs current fork
- Claude runtime/bridge test files absent.
- Sidebar file exists but currently has no Claude-code-specific icon pair logic.

### Applicability
**ADAPT (depends on `3f34b1a`)**
- Backend parts depend on Claude runtime introduction.
- UI icon tweak can be ported independently if desired.

---

## 8) `9c07f85` — Fix Claude Code tool lifecycle: emit tool_execution_end for all completion signals

### Upstream diff summary
**Files changed**
- `apps/backend/src/swarm/claude-code-runtime.ts`
  - adds `completedToolCallIds` dedupe set
  - emits `tool_execution_end` from additional signals:
    - `tool_use_summary`
    - user `tool_result` content blocks
    - `system.task_notification` when `tool_use_id` is present
  - maps `task_started/task_progress` with `tool_use_id` into updates for original tool call
  - safety fallback in `handleResultMessage` closes unresolved tool calls at turn end
  - clears tool tracking sets on stop/terminate/runtime-exit paths
  - introduces helper extract/dedupe utilities for tool-result completions
- `apps/backend/src/test/claude-code-runtime.test.ts`
  - adds scenarios for tool_result block completion, summary completion dedupe, and task_notification mapping

### Intent
Make tool lifecycle projection complete and idempotent across all SDK completion signal variants.

### Comparison vs current fork
- Changed Claude runtime/test files are absent in fork.

### Applicability
**ADAPT (depends on `3f34b1a` + `c3e9603`)**
- Important stability follow-up once Claude runtime is integrated.

---

## 9) `5b209f9` — Fix worker detail history for codex/claude runtimes

### Upstream diff summary
**Files changed**
- New helper: `apps/backend/src/swarm/session-custom-entry-persistence.ts`
  - `requiresManualCustomEntryPersistence(sessionManager)`
  - `persistSessionEntryForCustomRuntime(sessionManager, entryId)`
  - writes header+snapshot for empty files, append otherwise
- `apps/backend/src/swarm/codex-agent-runtime.ts`
  - adds `requiresManualCustomEntryPersistence` flag
  - `appendCustomEntry` persists custom entries immediately when required
- `apps/backend/src/swarm/claude-code-runtime.ts`
  - same custom-entry persistence fix
- tests:
  - `claude-code-runtime.test.ts` and `codex-agent-runtime-behavior.test.ts`
  - verifies custom entries survive to session JSONL even without assistant session messages

### Intent
Fix missing worker detail/history projection caused by non-persisted custom entries in codex/claude runtimes.

### Comparison vs current fork
- Fork has codex runtime but **no** equivalent manual-persistence helper.
- `session-custom-entry-persistence.ts` is missing.
- Fork runtime API differs: `appendCustomEntry` returns entry ID (`string`) and conversation projector depends on that; upstream runtime signatures were `void` in that timeline.
- Claude file side of patch cannot apply until Claude runtime exists.

### Applicability
**ADAPT**
- Codex half is applicable and likely valuable, especially after SDK upgrades.
- Needs adaptation to fork’s `appendCustomEntry(): string` contract.

---

## GPT-5.4 migration specifics

## Model ID changes (exact)

### Upstream canonical model ID transitions

1. **Codex App preset** (`f0c0cd7`)
- Backend: `apps/backend/src/swarm/model-presets.ts`
  - `openai-codex-app-server/default` → `openai-codex-app-server/gpt-5.4`
  - infer accepts both `gpt-5.4` and legacy `default`
- UI: `apps/ui/src/lib/model-preset.ts`
  - same dual acceptance
- Test updates expect `gpt-5.4` as canonical codex-app model ID

2. **PI Codex preset** (`5b79730`)
- Backend: `apps/backend/src/swarm/model-presets.ts`
  - `openai-codex/gpt-5.3-codex` → `openai-codex/gpt-5.4`
  - infer accepts both `gpt-5.4` and legacy `gpt-5.3-codex`
- UI: `apps/ui/src/lib/model-preset.ts`
  - same dual acceptance
- Test updates expect `gpt-5.4` as canonical pi-codex model ID

### Current fork values (still old)
- `pi-codex` canonical: `gpt-5.3-codex`
- `codex-app` canonical: `default`
- UI infer only recognizes those old exact IDs
- config default model still `gpt-5.3-codex`

## SDK/dependency version bumps (exact)

### Upstream
- `3f34b1a`
  - add `@anthropic-ai/claude-agent-sdk@^0.2.63`
  - add direct `zod@^4.3.6`
- `f237a7a`
  - `@anthropic-ai/claude-agent-sdk`: `^0.2.63` → `^0.2.68`
  - `@mariozechner/pi-ai`: `^0.55.0` → `^0.56.0`
  - `@mariozechner/pi-coding-agent`: `^0.55.0` → `^0.56.0`
  - OAuth import path migration to `@mariozechner/pi-ai/oauth`
- `5b79730`
  - `@mariozechner/pi-ai`: `^0.56.0` → `^0.56.2`
  - `@mariozechner/pi-coding-agent`: `^0.56.0` → `^0.56.2`
  - lockfile transitive notably bumps `openai` to `6.26.0`

### Current fork
- `@mariozechner/pi-ai@^0.55.0`
- `@mariozechner/pi-coding-agent@^0.55.0`
- no `@anthropic-ai/claude-agent-sdk`
- lockfile still `openai@6.10.0`

---

## Applicability summary

| Commit | Recommendation | Why |
|---|---|---|
| `5b79730` | **ADAPT** | Core pi-codex GPT-5.4 migration + legacy compat; conflicts with fork deltas and tests. |
| `f0c0cd7` | **ADAPT** | Core codex-app GPT-5.4 migration + legacy compat; missing upstream test files in fork. |
| `f237a7a` | **ADAPT** | Required SDK bump + OAuth import migration; fork has expanded settings/test code to merge carefully. |
| `b5f2099` | **ADAPT** | High-value list_agents token reduction; must preserve fork’s manager/session scoping. |
| `3f34b1a` | **ADAPT (major)** | Entire Claude runtime stack absent; large integration required with fork runtime architecture. |
| `66af36e` | **ADAPT (dependent)** | Claude runtime lifecycle hardening; only after `3f34b1a`. |
| `c3e9603` | **ADAPT (dependent)** | Claude completion fix + UI icon tweak; backend part depends on Claude runtime. |
| `9c07f85` | **ADAPT (dependent)** | Critical Claude tool lifecycle completeness; depends on earlier Claude commits. |
| `5b209f9` | **ADAPT** | Codex custom-entry persistence fix likely valuable; requires adapting to fork’s appendCustomEntry return contract. |

---

## Recommended adoption order + dependency chains

## Track A — GPT-5.4 + SDK modernization (recommended first)
1. **`f237a7a`** (SDK bumps + OAuth import path fix)
2. **`f0c0cd7`** (codex-app canonical model ID to `gpt-5.4` + legacy infer)
3. **`5b79730`** (pi-codex canonical model ID to `gpt-5.4` + legacy infer + `0.56.2` SDKs)
4. **`b5f2099` (partial)** for `list_agents` compact output + `includeTerminated` (keep fork scoping)
5. **`5b209f9` (codex portion)** if/when custom-entry persistence issue appears after SDK upgrade

## Track B — Claude runtime introduction (optional/major)
1. **`3f34b1a`** base runtime + protocol/preset/UI wiring
2. **`66af36e`** stream/stop/replay hardening
3. **`c3e9603`** tool completion signal broadening + icon behavior
4. **`9c07f85`** lifecycle completeness + dedupe logic (important)
5. **`b5f2099` Claude side** custom-entry persistence
6. **`b5f2099` bridge-side includeTerminated schema** (if not already ported)

### Hard dependencies
- `66af36e`, `c3e9603`, `9c07f85` require `3f34b1a` files.
- `9c07f85` builds on prior Claude runtime lifecycle semantics (`c3`/`66`).
- `5b79730` assumes prior codex-app constants introduced by `f0c0cd7` in `model-presets.ts` for clean application.

### Fork-specific integration cautions
- Preserve fork runtime-factory custom behavior:
  - session-file guard + rotation hooks
  - Cortex tool filtering in `buildRuntimeTools`
- Preserve fork security/scope behavior in `list_agents` (same-manager/session filtering).
- Adapt custom-entry persistence patch to runtime interface returning entry IDs.
- Reconcile missing upstream test files (`model-presets.test.ts`, `runtime-factory.test.ts`) with current fork test organization.

---

## Bottom line

For the user’s **GPT-5.4 transition** goal, the highest-leverage upstream ports are:
- `f237a7a` → `f0c0cd7` → `5b79730`, then
- `b5f2099` list_agents trimming, and likely
- `5b209f9` codex custom-entry persistence adaptation.

The Claude runtime chain (`3f34` + follow-ups) is a separate, larger integration project in this fork and should be treated as its own scoped migration workstream.