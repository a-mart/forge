# Middleman Prompt Audit

> Generated: 2026-03-12  
> Purpose: Map every prompt source in the codebase for future centralization and frontend editor support.

---

## Summary

The Middleman codebase contains **~30 distinct prompt sources** across 7 categories:

| Category | Count | Location Pattern |
|----------|-------|-----------------|
| Archetype system prompts | 3 built-in `.md` files + override system | `apps/backend/src/swarm/archetypes/builtins/` |
| Default worker system prompt | 1 hardcoded string | `apps/backend/src/swarm/swarm-manager.ts` |
| Skill instruction files | 5 SKILL.md files | `apps/backend/src/swarm/skills/builtins/*/` |
| Memory/knowledge templates | 4 hardcoded templates | `apps/backend/src/swarm/swarm-manager.ts` |
| Prompt assembly logic | ~8 code paths | `swarm-manager.ts`, `runtime-factory.ts` |
| Integration context injection | 1 dynamic builder | `apps/backend/src/integrations/integration-context.ts` |
| LLM-facing operational prompts | 3 (merge, bootstrap, watchdog) | `swarm-manager.ts`, `memory-merge.ts` |
| Tool descriptions | 5 tool definitions | `apps/backend/src/swarm/swarm-tools.ts` |
| Protocol/metadata fields | 2 prompt tracking fields | `packages/protocol/src/shared-types.ts` |
| Agent identity injection | 1 code block | `swarm-manager.ts` |
| Context file auto-loading | 2 patterns (AGENTS.md, SWARM.md) | `runtime-factory.ts`, `swarm-manager.ts` |

**Key finding:** There is no single "prompt registry" — prompts are assembled from ~5 different sources at runtime (archetype file, AGENTS.md from CWD, skill files, memory file, integration context, SWARM.md) and merged in `RuntimeFactory` and `SwarmManager`. The archetype prompt registry is the closest thing to centralization but only covers archetype `.md` files.

---

## 1. Archetype System Prompts (Built-in)

These are the core personality/instruction files for different agent archetypes. They are loaded at boot via `ArchetypePromptRegistry` and served as the system prompt for the corresponding agent type.

### 1.1 Manager Archetype

- **File:** `/Users/adam/repos/middleman/apps/backend/src/swarm/archetypes/builtins/manager.md`
- **What:** Primary system prompt for all manager agents (including sessions)
- **When:** Loaded at boot, used when creating/resuming any manager runtime
- **Assembly:** Static `.md` file, loaded verbatim by `loadArchetypePromptRegistry()`. Integration context is appended dynamically at `resolveSystemPromptForDescriptor()`.
- **Consumer:** All manager agents (every session)
- **Size:** ~4.5 KB
- **Key content:** Delegation protocol, model selection tiers, communication rules, speak_to_user requirements, source metadata handling, artifact link format, memory workflow, safety rules

### 1.2 Cortex Archetype

- **File:** `/Users/adam/repos/middleman/apps/backend/src/swarm/archetypes/builtins/cortex.md`
- **What:** System prompt for the Cortex intelligence/knowledge manager
- **When:** Loaded at boot, used when Cortex manager runtime is created
- **Assembly:** Static `.md` file with `${SWARM_DATA_DIR}`, `${SWARM_MEMORY_FILE}`, `${SWARM_SCRIPTS_DIR}` variable placeholders (resolved by pi runtime)
- **Consumer:** Cortex manager agent only
- **Size:** ~12 KB
- **Key content:** Mandatory delegation rules, session review protocol, signal extraction guidelines, knowledge triage rules, common vs profile knowledge placement, maturity pipeline, knowledge file structure templates, scheduling instructions, reflection/self-improvement guidance

### 1.3 Merger Archetype

- **File:** `/Users/adam/repos/middleman/apps/backend/src/swarm/archetypes/builtins/merger.md`
- **What:** System prompt for merger worker agents
- **When:** Loaded at boot, used when a worker with `archetypeId: "merger"` is spawned
- **Assembly:** Static `.md` file
- **Consumer:** Merger worker agents
- **Size:** ~1 KB
- **Key content:** Branch merge workflow, safety rules (no force-push), memory handling, reporting protocol

### 1.4 Archetype Override System

- **Registry:** `/Users/adam/repos/middleman/apps/backend/src/swarm/archetypes/archetype-prompt-registry.ts`
- **Override dir:** `<repo-root>/.swarm/archetypes/` (any `.md` file; filename becomes archetype ID)
- **What:** Allows per-repository archetype prompt overrides. If a file `my-archetype.md` exists in `.swarm/archetypes/`, it overrides the built-in archetype with the same normalized ID.
- **When:** Loaded at boot, merged over built-in prompts
- **Assembly:** Built-in prompts are loaded first, then repo overrides overlay them by normalized archetype ID
- **Consumer:** Any agent whose `archetypeId` matches

---

## 2. Default Worker System Prompt

- **File:** `/Users/adam/repos/middleman/apps/backend/src/swarm/swarm-manager.ts` (line ~107)
- **Constant:** `DEFAULT_WORKER_SYSTEM_PROMPT`
- **What:** Fallback system prompt for workers that don't have a custom systemPrompt or archetype
- **When:** Used in `resolveSystemPromptForDescriptor()` when no archetype prompt resolves
- **Assembly:** Hardcoded template string with `${SWARM_MEMORY_FILE}` placeholder
- **Consumer:** All generic worker agents
- **Content:**
  ```
  You are a worker agent in a swarm.
  - You can list agents and send messages to other agents.
  - Use coding tools (read/bash/edit/write) to execute implementation tasks.
  - Report progress and outcomes back to the manager using send_message_to_agent.
  - You are not user-facing.
  - End users only see messages they send and manager speak_to_user outputs.
  - Your plain assistant text is not directly visible to end users.
  - Incoming messages prefixed with "SYSTEM:" are internal control/context updates, not direct end-user chat.
  - Persistent memory for this runtime is at ${SWARM_MEMORY_FILE} and is auto-loaded into context.
  - Workers read their owning manager's memory file.
  - Only write memory when explicitly asked to remember/update/forget durable information.
  - Follow the memory skill workflow before editing the memory file, and never store secrets in memory.
  ```

---

## 3. Agent Identity Injection

- **File:** `/Users/adam/repos/middleman/apps/backend/src/swarm/swarm-manager.ts` (line ~3338)
- **Method:** `injectWorkerIdentityContext()`
- **What:** Appends agent/manager ID block to every worker's system prompt
- **When:** At worker spawn, after the base system prompt is resolved
- **Assembly:** Dynamically built from `descriptor.agentId` and `descriptor.managerId`
- **Consumer:** All worker agents
- **Template:**
  ```
  # Agent Identity
  - Your agent ID: `{agentId}`
  - Your manager ID: `{managerId}`
  - Always use your manager ID above when sending messages back via send_message_to_agent.
  - Do NOT guess the manager ID from list_agents — use the ID provided here.
  ```

---

## 4. Skill Instruction Files

These are loaded as additional context files by the pi runtime resource loader. They are NOT part of the system prompt — they are injected as separate context documents.

### 4.1 Memory Skill

- **File:** `/Users/adam/repos/middleman/apps/backend/src/swarm/skills/builtins/memory/SKILL.md`
- **What:** Instructions for when/how to use persistent memory
- **When:** Auto-loaded into every agent's context at runtime creation
- **Assembly:** Static `.md` file with frontmatter (name, description) and `${SWARM_MEMORY_FILE}` placeholder
- **Consumer:** All agents (managers and workers)

### 4.2 Brave Search Skill

- **File:** `/Users/adam/repos/middleman/apps/backend/src/swarm/skills/builtins/brave-search/SKILL.md`
- **What:** Web search and content extraction instructions
- **When:** Auto-loaded into every agent's context
- **Assembly:** Static `.md` file with frontmatter including env requirements (`BRAVE_API_KEY`)
- **Consumer:** All agents

### 4.3 Cron Scheduling Skill

- **File:** `/Users/adam/repos/middleman/apps/backend/src/swarm/skills/builtins/cron-scheduling/SKILL.md`
- **What:** Schedule management instructions with CLI commands
- **When:** Auto-loaded into every agent's context
- **Assembly:** Static `.md` file with `${SWARM_DATA_DIR}` placeholder
- **Consumer:** All agents

### 4.4 Agent Browser Skill

- **File:** `/Users/adam/repos/middleman/apps/backend/src/swarm/skills/builtins/agent-browser/SKILL.md`
- **What:** Interactive browser automation instructions
- **When:** Auto-loaded into every agent's context
- **Assembly:** Static `.md` file (documentation-only, no wrapper scripts)
- **Consumer:** All agents

### 4.5 Image Generation Skill

- **File:** `/Users/adam/repos/middleman/apps/backend/src/swarm/skills/builtins/image-generation/SKILL.md`
- **What:** Google Gemini image generation instructions
- **When:** Auto-loaded into every agent's context
- **Assembly:** Static `.md` file with frontmatter env requirements (`GEMINI_API_KEY`)
- **Consumer:** All agents

### 4.6 Skill Override System

- **Service:** `/Users/adam/repos/middleman/apps/backend/src/swarm/skill-metadata-service.ts`
- **Override dir:** `<repo-root>/.swarm/skills/` (each skill is a subdirectory with `SKILL.md`)
- **Built-in fallback dir:** `apps/backend/src/swarm/skills/builtins/`
- **Memory skill special path:** `<repo-root>/.swarm/skills/memory/SKILL.md` (explicit override via `config.paths.repoMemorySkillFile`)
- **What:** Skills are resolved with priority: repo override → built-in directory → fallback built-in directory
- **Consumer:** All agents via `getAdditionalSkillPaths()`

---

## 5. Context File Auto-Loading

### 5.1 AGENTS.md (Repository Agent Instructions)

- **File pattern:** `<cwd>/AGENTS.md` (where CWD is the agent's working directory)
- **What:** Repository-specific agent instructions automatically loaded by the pi runtime's `DefaultResourceLoader`
- **When:** At runtime creation, loaded by pi's `DefaultResourceLoader` as an "agents file"
- **Assembly:** The pi runtime scans upward from CWD for `AGENTS.md` files and includes them as context
- **Consumer:** All agents via pi runtime (both managers and workers)
- **Note:** This is handled by the upstream `@mariozechner/pi-coding-agent` library, not Middleman code. Middleman's `AGENTS.md` at the repo root serves as instructions for agents working on the Middleman codebase itself.

### 5.2 SWARM.md (Swarm Context Files)

- **Constant:** `SWARM_CONTEXT_FILE_NAME = "SWARM.md"` in `swarm-manager.ts` (line 363)
- **Method:** `getSwarmContextFiles()` in `swarm-manager.ts` (line ~3602)
- **What:** Optional per-directory swarm policy files. The system walks from the agent's CWD upward to root, collecting all `SWARM.md` files found.
- **When:** At runtime creation
- **Assembly:** Files are read from disk and merged into the runtime context. For pi runtimes, they are merged into `agentsFiles`. For codex runtimes, they are injected into the system prompt wrapped in `Repository swarm policy ({path}):` delimiters.
- **Consumer:** All agents

---

## 6. Memory & Knowledge Context

### 6.1 Session/Profile Memory File

- **Method:** `getMemoryRuntimeResources()` in `swarm-manager.ts` (line ~3522)
- **What:** The memory file is assembled from up to 4 sources and injected as a context file
- **Assembly (multi-source):**
  1. **Session memory** — the session's own memory file (`profiles/<profileId>/sessions/<sessionId>/memory.md`)
  2. **Profile memory** — the parent profile's core memory (`profiles/<profileId>/memory.md`)
  3. **Common knowledge** — Cortex-maintained cross-profile knowledge (`shared/knowledge/common.md`)
  4. **Profile knowledge** — Cortex-maintained per-profile knowledge (`shared/knowledge/profiles/<profileId>.md`)
- **Composite structure:** Built by `buildSessionMemoryRuntimeView()`:
  ```
  # Manager Memory (shared across all sessions — read-only reference)
  
  {profile memory content}
  
  ---
  
  # Session Memory (this session's working memory — your writes go here)
  
  {session memory content}
  
  ---
  
  # Common Knowledge (maintained by Cortex — read-only reference)
  
  {common knowledge content}
  
  # Project Knowledge for {profileId} (maintained by Cortex — read-only reference)
  
  {profile knowledge content}
  ```
- **When:** At runtime creation (both initial and resume)
- **Consumer:** All agents (managers and workers read their owning manager's memory)

### 6.2 Default Memory Template

- **File:** `swarm-manager.ts` (line ~380)
- **Constant:** `DEFAULT_MEMORY_TEMPLATE_NORMALIZED_LINES`
- **What:** Initial content for new memory files
- **Content:**
  ```markdown
  # Swarm Memory
  ## User Preferences
  - (none yet)
  ## Project Facts
  - (none yet)
  ## Decisions
  - (none yet)
  ## Open Follow-ups
  - (none yet)
  ```

### 6.3 Common Knowledge Initial Template

- **File:** `swarm-manager.ts` (line ~161)
- **Constant:** `COMMON_KNOWLEDGE_INITIAL_TEMPLATE`
- **What:** Initial content for `shared/knowledge/common.md` when Cortex profile is first created
- **Content:**
  ```markdown
  # Common Knowledge
  > Maintained by Cortex. Injected into all agents.
  ## User Profile
  ## Working Patterns
  ## Quality Standards
  ```

### 6.4 Cortex Worker Prompts Initial Template

- **File:** `swarm-manager.ts` (line ~172)
- **Constant:** `CORTEX_WORKER_PROMPTS_INITIAL_TEMPLATE`
- **What:** Initial content for `.cortex-worker-prompts.md` — templates Cortex uses when spawning extraction workers
- **Size:** ~6 KB
- **Content:** 4 worker prompt templates:
  1. Session Review / Extraction Worker
  2. Knowledge Synthesis Worker
  3. Scan / Triage Worker
  4. Feedback Telemetry Worker
- **Note:** Cortex owns this file and can refine the templates over time

### 6.5 Forked Session Memory Header

- **Method:** `writeForkedSessionMemoryHeader()` in `swarm-manager.ts`
- **What:** Header written to new session memory file when forking
- **Template:**
  ```markdown
  # Session Memory
  > Forked from session "{sourceLabel}" ({sourceAgentId}) on {timestamp}
  > Parent session conversation history was duplicated at fork time.
  ```

---

## 7. LLM-Facing Operational Prompts

### 7.1 Memory Merge System Prompt

- **File:** `/Users/adam/repos/middleman/apps/backend/src/swarm/memory-merge.ts`
- **Constant:** `MEMORY_MERGE_SYSTEM_PROMPT`
- **What:** System prompt for the LLM call that merges session memory into profile memory
- **When:** When `mergeSessionMemory()` is called
- **Assembly:** Static string constant
- **Consumer:** Internal LLM call (not a user-facing agent)
- **Content:**
  ```
  You are a memory file editor. You receive two memory files and must produce one consolidated memory file.
  
  Rules:
  - Preserve the existing markdown structure and section headers from the base profile memory.
  - Integrate new facts, decisions, preferences, and follow-ups from the session memory.
  - Deduplicate repeated information.
  - If session memory contradicts base memory, prefer session memory because it is newer.
  - Remove stale or completed follow-ups that session memory explicitly marks as completed.
  - Output ONLY the final merged markdown content.
  - Do not include explanations.
  - Do not include code fences.
  ```

### 7.2 Memory Merge User Prompt

- **File:** `memory-merge.ts`
- **Function:** `buildMemoryMergeUserPrompt()`
- **What:** Structured user message containing both memory files for the merge LLM
- **Template:**
  ```
  Profile memory (base):
  ----- BEGIN PROFILE MEMORY -----
  {profileContent}
  ----- END PROFILE MEMORY -----
  
  Session memory (new updates):
  ----- BEGIN SESSION MEMORY -----
  {sessionContent}
  ----- END SESSION MEMORY -----
  ```

### 7.3 Manager Bootstrap Interview Message

- **File:** `swarm-manager.ts` (line ~131)
- **Constant:** `MANAGER_BOOTSTRAP_INTERVIEW_MESSAGE`
- **What:** First message sent to a newly created manager to trigger user onboarding
- **When:** After `createManager()` completes successfully
- **Assembly:** Static string constant, sent as an internal message
- **Consumer:** Newly created manager agents
- **Content:** ~1 KB message instructing the manager to welcome the user, run a 5-question onboarding interview, describe "The Delegator" workflow example, and offer to save preferences to memory

### 7.4 Idle Worker Watchdog Message

- **File:** `swarm-manager.ts` (line ~4340)
- **What:** Warning message sent to the manager when workers go idle without reporting
- **When:** When the idle worker watchdog detects unreported worker completions
- **Assembly:** Dynamic template with worker IDs and counts
- **Consumer:** Manager agents (via internal message) and users (via system publish)
- **Template:**
  ```
  ⚠️ [IDLE WORKER WATCHDOG — BATCHED]
  
  {count} worker(s) went idle without reporting this turn.
  Workers: {workerIds}
  
  Use list_agents({"verbose":true,"limit":50,"offset":0}) for a paged full list.
  ```

---

## 8. Integration Context Injection

- **File:** `/Users/adam/repos/middleman/apps/backend/src/integrations/integration-context.ts`
- **Function:** `formatIntegrationContext()`
- **What:** Dynamic context block appended to manager system prompts with active integration info
- **When:** At manager runtime creation, appended after archetype prompt in `resolveSystemPromptForDescriptor()`
- **Assembly:** Dynamic — queries integration registry for Telegram/Slack connection status, bot username, known chat/channel IDs
- **Consumer:** Manager agents only
- **Wired in:** `apps/backend/src/index.ts` (line ~94) via `swarmManager.setIntegrationContextProvider()`
- **Template output:**
  ```markdown
  # Active Integrations
  ## Telegram
  - Status: connected/disconnected
  - Bot username: @{botUsername}
  - Known chat IDs: {chatIds}
  - You can proactively message Telegram via speak_to_user with target: { channel: "telegram", channelId: "<chat_id>" }
  
  ## Slack
  - Status: connected/disconnected
  - Known channel IDs: {channelIds}
  - You can proactively message Slack via speak_to_user with target: { channel: "slack", channelId: "<channel_id>" }
  ```

---

## 9. Message Formatting Prompts

### 9.1 Source Context Metadata Line

- **File:** `swarm-manager.ts` (line ~5144)
- **Function:** `formatInboundUserMessageForManager()`
- **What:** Prepends source metadata to every user message delivered to managers
- **When:** On every inbound user message
- **Template:** `[sourceContext] {"channel":"...","channelId":"...","userId":"...",...}`
- **Consumer:** Manager agents

### 9.2 Internal Message Prefix

- **File:** `swarm-manager.ts` (line ~129)
- **Constant:** `INTERNAL_MODEL_MESSAGE_PREFIX = "SYSTEM: "`
- **What:** Prefix added to internal/agent-to-agent messages to signal they are not direct user input
- **When:** On every non-user-origin message delivery in `prepareModelInboundMessage()`
- **Consumer:** All agents

### 9.3 Scheduled Task Message Format

- **File:** `/Users/adam/repos/middleman/apps/backend/src/scheduler/cron-scheduler-service.ts` (line ~237)
- **What:** Format for scheduled task messages dispatched to managers
- **Template:**
  ```
  [Scheduled Task: {scheduleName}]
  [scheduleContext] {"scheduleId":"...","cron":"...","timezone":"...","oneShot":...,"scheduledFor":"..."}
  
  {userMessage}
  ```
- **Consumer:** Manager agents (via normal message delivery)

---

## 10. Codex Runtime Prompt Assembly

- **File:** `/Users/adam/repos/middleman/apps/backend/src/swarm/runtime-factory.ts`
- **Method:** `buildCodexRuntimeSystemPrompt()`
- **What:** For codex-app-server runtimes, the system prompt is assembled differently than pi runtimes. Memory and SWARM.md content are concatenated into the system prompt string (since codex doesn't have a separate agents-files mechanism).
- **Assembly:**
  ```
  {base system prompt}
  
  Repository swarm policy ({swarmContextFile.path}):
  ----- BEGIN SWARM CONTEXT -----
  {swarmContextFile.content}
  ----- END SWARM CONTEXT -----
  
  Persistent swarm memory ({memoryContextFile.path}):
  ----- BEGIN SWARM MEMORY -----
  {memoryContextFile.content}
  ----- END SWARM MEMORY -----
  ```
- **When:** At codex runtime creation
- **Consumer:** Agents using the `codex-app` model preset

### Pi Runtime Prompt Assembly

- **File:** `runtime-factory.ts`, method `createPiRuntimeForDescriptor()`
- **What:** For pi runtimes (Claude/OpenAI models), the prompt is split across multiple channels:
  - **Managers:** The archetype prompt is passed as `systemPrompt` to `DefaultResourceLoader`, which sets it as the system prompt. No `appendSystemPromptOverride`.
  - **Workers:** The system prompt is passed via `appendSystemPromptOverride`, which appends it after the base system prompt from the resource loader.
  - **AGENTS.md, skills, memory, SWARM.md:** These are all merged into the `agentsFiles` array via `agentsFilesOverride`.
- **Consumer:** All pi-runtime agents

---

## 11. Tool Descriptions

- **File:** `/Users/adam/repos/middleman/apps/backend/src/swarm/swarm-tools.ts`
- **What:** Tool definitions with name, label, description, and parameter schemas
- **Consumer:** All agents (tool descriptions become part of the LLM context)

| Tool | Description | Available To |
|------|------------|-------------|
| `list_agents` | "List swarm agents with ids, roles, status, model, and workspace." | All agents |
| `send_message_to_agent` | "Send a message to another agent by id. Returns immediately with a delivery receipt. If target is busy, queued delivery is accepted as steer." | All agents |
| `spawn_agent` | "Create and start a new worker agent. agentId is required and normalized to lowercase kebab-case; if taken, a numeric suffix (-2, -3, …) is appended. archetypeId, systemPrompt, model, modelId, reasoningLevel, cwd, and initialMessage are optional. model accepts pi-codex\|pi-5.4\|pi-opus\|codex-app." | Managers only |
| `kill_agent` | "Terminate a running worker agent. Manager cannot be terminated." | Managers only |
| `speak_to_user` | "Publish a user-visible manager message into the websocket conversation feed. If target is omitted, delivery defaults to web. For Slack/Telegram delivery, set target.channel and target.channelId explicitly." | Managers only |

Tool parameter descriptions and enum values also serve as prompt content (e.g., `reasoningLevel` description, `modelId` override examples).

---

## 12. Emergency Context Trim

- **File:** `/Users/adam/repos/middleman/apps/backend/src/swarm/emergency-context-trim.ts`
- **What:** When context overflows, middle messages are replaced with a stub
- **Default stub:** `"[content removed - emergency context trim]"`
- **Template:** `"{stubText} Removed {count} middle message(s), including {toolCount} tool-related message(s)."`
- **Consumer:** Any agent undergoing emergency context recovery

---

## 13. Protocol & Metadata Fields

- **File:** `/Users/adam/repos/middleman/packages/protocol/src/shared-types.ts`
- **Fields in `SessionMeta`:**
  - `promptFingerprint: string | null` — SHA hash of the prompt components for change detection
  - `promptComponents` — structured record tracking which prompt sources are active:
    - `archetype: string | null`
    - `agentsFile: string | null`
    - `skills: string[]`
    - `memoryFile: string | null`
    - `profileMemoryFile: string | null`
- **Computed by:** `captureSessionRuntimePromptMeta()` in `swarm-manager.ts` and `computePromptFingerprint()` in `session-manifest.ts`
- **Purpose:** Tracks which prompt sources are contributing to a session's agent context, enabling change detection and debugging

---

## 14. User-Configurable Prompt-Adjacent Settings

These are not prompts themselves, but user-adjustable settings that affect prompt composition:

| Setting | Where Configured | Effect on Prompts |
|---------|-----------------|-------------------|
| Model preset | UI settings, `createManager()` | Determines which runtime (pi vs codex) processes the prompt |
| Reasoning level | UI settings, `spawn_agent` | Affects model behavior but not prompt content |
| CWD (working directory) | UI settings, `createManager()` | Determines which `AGENTS.md` and `SWARM.md` files are found |
| Archetype ID | Set at manager/worker creation | Selects which archetype `.md` prompt file is used |
| Custom system prompt | `spawn_agent.systemPrompt` parameter | Overrides the entire base system prompt for a worker |
| Integration config | Settings UI (Telegram/Slack) | Affects integration context injected into manager prompts |
| Memory content | User-directed via memory skill | Directly part of the prompt context |
| Environment variables | Settings UI | Affects skill availability (e.g., `BRAVE_API_KEY`) |

---

## Prompt Assembly Flow Diagram

```
Manager Agent Prompt Assembly:
  ┌─────────────────────────────────────────────────────────┐
  │ 1. Archetype prompt (.md file)                          │ ← archetype-prompt-registry.ts
  │    └─ Override: .swarm/archetypes/{id}.md               │
  │ 2. + Integration context (Telegram/Slack status)        │ ← integration-context.ts
  │ = System Prompt                                         │
  ├─────────────────────────────────────────────────────────┤
  │ 3. AGENTS.md (from CWD, walking upward)                 │ ← pi runtime DefaultResourceLoader
  │ 4. SWARM.md (from CWD, walking upward)                  │ ← getSwarmContextFiles()
  │ 5. Skill files (5x SKILL.md)                            │ ← skill-metadata-service.ts
  │ 6. Memory composite (profile + session + knowledge)     │ ← getMemoryRuntimeResources()
  │ = Context Files (agentsFiles)                           │
  └─────────────────────────────────────────────────────────┘

Worker Agent Prompt Assembly:
  ┌─────────────────────────────────────────────────────────┐
  │ 1. Base prompt: custom systemPrompt OR archetype OR     │
  │    DEFAULT_WORKER_SYSTEM_PROMPT                         │
  │ 2. + Agent Identity block (agentId, managerId)          │ ← injectWorkerIdentityContext()
  │ = System Prompt (appended via appendSystemPromptOverride)│
  ├─────────────────────────────────────────────────────────┤
  │ 3. AGENTS.md (from CWD)                                 │
  │ 4. SWARM.md (from CWD)                                  │
  │ 5. Skill files (5x SKILL.md)                            │
  │ 6. Memory composite (manager's memory)                  │
  │ = Context Files (agentsFiles)                           │
  └─────────────────────────────────────────────────────────┘

Codex Runtime (alternative assembly):
  ┌─────────────────────────────────────────────────────────┐
  │ All of the above concatenated into a single             │
  │ developerInstructions string (no separate agentsFiles)  │
  │ with delimited sections for SWARM context and memory    │
  └─────────────────────────────────────────────────────────┘
```

---

## Centralization Considerations

### Good Candidates for Centralization

| Prompt Source | Why Centralize | Difficulty |
|--------------|---------------|-----------|
| **Archetype prompts** (manager.md, cortex.md, merger.md) | Already file-based; moving to a registry with UI editor would be straightforward | Low — already in a registry |
| **DEFAULT_WORKER_SYSTEM_PROMPT** | Hardcoded string that could be an archetype file (e.g., `worker.md`) | Low — extract to `.md` file |
| **Memory merge prompt** | Isolated LLM prompt that could be user-customizable | Low — single constant |
| **Bootstrap interview message** | Could be customizable per-profile onboarding flow | Low — single constant |
| **Tool descriptions** | Static strings that could be editable | Medium — coupled to TypeScript tool definitions |
| **Integration context template** | Template structure could be user-customizable | Medium — dynamic data injection |
| **Cortex worker prompt templates** | Already designed to be editable (Cortex owns the file) | Low — already file-based |
| **Default memory template** | Could be customizable per profile | Low — single constant |

### Should Stay in Code

| Prompt Source | Why Keep in Code |
|--------------|-----------------|
| **Agent identity injection** | Purely structural, derived from runtime state |
| **Source context metadata format** | Wire protocol concern, not a creative prompt |
| **Internal message prefix (`SYSTEM: `)** | Protocol convention, not user-editable |
| **Emergency trim stub** | Operational recovery mechanism |
| **Codex prompt assembly logic** | Runtime-specific concatenation, not a prompt itself |
| **Prompt fingerprint computation** | Metadata tracking, not prompt content |
| **Scheduled task message format** | Structural envelope, not creative content |

### Architecture for a Prompt Editor

A centralized prompt editor would need to:

1. **Registry layer:** Extend `ArchetypePromptRegistry` to cover all prompt sources (not just archetypes), with a unified `PromptRegistry` that can resolve by category + ID.
2. **Storage:** Prompts could live in `~/.middleman/shared/prompts/` with a category-based layout.
3. **Override chain:** Built-in defaults → repo-level overrides (`.swarm/`) → user-level overrides (`~/.middleman/shared/prompts/`).
4. **Variable system:** Standardize the `${SWARM_MEMORY_FILE}` / `${SWARM_DATA_DIR}` variable placeholder pattern across all prompts.
5. **Protocol extension:** Add prompt listing/editing endpoints to the WS protocol.
6. **UI surface:** Prompt editor in settings with categories, live preview of variable resolution, and diff against defaults.
7. **Validation:** Prompt changes should trigger prompt fingerprint updates and could optionally warn about missing required patterns (e.g., `speak_to_user` in manager prompts).

### Migration Path

1. Extract `DEFAULT_WORKER_SYSTEM_PROMPT` to `worker.md` archetype file.
2. Move `MANAGER_BOOTSTRAP_INTERVIEW_MESSAGE` to a configurable template file.
3. Move `MEMORY_MERGE_SYSTEM_PROMPT` to a template file.
4. Create a `PromptRegistry` that wraps `ArchetypePromptRegistry` and adds skill/template resolution.
5. Add WS protocol endpoints for prompt CRUD.
6. Build the UI editor.
