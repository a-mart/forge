# Manager Self-Improvement & Meta-Learning

How the manager agent learns, improves itself, and what boundaries exist. This is the most important document in this directory — it covers the agent's ability to evolve its own behavior across sessions and the architectural constraints on that evolution.

## The Self-Improvement Surface

The manager has five channels through which it can improve itself:

| Channel | Persistence | Runtime Modifiable | Effect Timing |
|---------|------------|-------------------|---------------|
| **Memory file** | Durable (disk) | Yes | Immediate (next context load) |
| **SWARM.md** | Durable (disk) | Yes | Next agent startup |
| **Custom skills** | Durable (disk) | Yes (write) | Next backend restart |
| **Custom archetypes** | Durable (disk) | Yes (write) | Next agent spawn |
| **Worker prompt tuning** | Per-session | Yes (spawn params) | Immediate (new worker) |

## Channel 1: Memory File (Primary Learning Loop)

The memory file is the manager's primary self-improvement mechanism. It persists across sessions, compactions, and restarts.

### How It Works

```
Session Start
    │
    ▼
Memory file loaded from disk
(~/.middleman/.swarm/memory/<managerId>/<agentId>.md)
    │
    ▼
Injected into agent context
    ├─ Pi runtime: merged into agentsFiles (loaded last = highest priority)
    └─ Codex runtime: appended to system prompt with markers:
         "Persistent swarm memory (path):"
         "----- BEGIN SWARM MEMORY -----"
         [content]
         "----- END SWARM MEMORY -----"
    │
    ▼
Agent operates with memory available
    │
    ▼
Agent updates memory via read/edit/write tools
(following memory skill workflow)
    │
    ▼
Updated memory persists to disk
    │
    ▼
Next session/compaction → memory reloaded fresh
```

### Default Template

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

### What to Store in Memory

- User preferences (communication style, tool preferences, coding conventions)
- Project facts (tech stack, directory structure, key files)
- Decisions made (architectural choices, rejected approaches, rationale)
- Open follow-ups (pending items, next steps, blockers)
- Worker patterns (which prompt styles work, what delegation strategies succeed)
- Lessons learned (errors encountered, recovery strategies)

### What NOT to Store

- Secrets (API keys, tokens, credentials) — explicitly forbidden
- Session-specific ephemeral data
- Large code blocks (wastes context budget)

### Key Properties

- **Shared with workers**: All workers under a manager read the manager's memory file
- **Workers can write to it**: Workers can update manager memory (enables delegation of learning)
- **Survives everything**: Not affected by compaction, `/new`, or agent restart
- **No versioning**: Overwrites are permanent — no undo history
- **No size limit enforcement**: Large memory files consume context budget silently
- **No auto-capture**: Agent must explicitly decide to write memory

### Limitations

- Memory only updates when the agent (or user) explicitly triggers a write
- No automatic lesson extraction from conversations
- No structured query — agent reads the full file every time
- No cross-manager memory sharing

---

## Channel 2: SWARM.md (Project-Level Policies)

A `SWARM.md` file in the working directory (or any parent directory) is automatically loaded into every agent's context. This is the project-level counterpart to per-agent memory.

### Discovery

```
Agent cwd: /Users/adam/repos/middleman/apps/backend
Search path (walks upward):
  /Users/adam/repos/middleman/apps/backend/SWARM.md
  /Users/adam/repos/middleman/apps/SWARM.md
  /Users/adam/repos/middleman/SWARM.md
  /Users/adam/repos/SWARM.md
  /Users/adam/SWARM.md
  ...
```

All found files are loaded (deduplicated by path), ordered general → specific. Memory file is loaded last (highest priority).

### Self-Improvement Use

The manager (or a worker) can write/modify SWARM.md to establish project-level conventions that persist across all agents:

```markdown
# SWARM.md

## Coding Standards
- Always run tests before reporting task complete
- Use TypeScript strict mode
- Prefer composition over inheritance

## Delegation Rules
- File changes > 3 files → spawn dedicated worker
- Test failures → spawn debug worker with error context

## Known Pitfalls
- The CI pipeline requires Node 22 (don't use Node 20 APIs)
- pnpm workspace links require `pnpm i` after adding packages
```

### Timing

Changes to SWARM.md take effect on the **next agent startup** (not mid-session for the writing agent, but immediately for newly spawned workers).

---

## Channel 3: Custom Skills (Tool Evolution)

Agents can write new skill definitions to `.swarm/skills/`, but they won't be loaded until the backend restarts.

### Skill Creation Flow

```
Agent writes:
  .swarm/skills/my-new-skill/SKILL.md
  .swarm/skills/my-new-skill/run.js
    │
    ▼
Files exist on disk ✓
    │
    ▼
NOT loaded until backend restarts
(SkillMetadataService.reloadSkillMetadata() only runs at boot)
    │
    ▼
After restart: skill discovered, frontmatter parsed,
env requirements shown in UI, skill docs available to agents
```

### Current Limitation: No Hot-Reload

Skills are loaded once at `SwarmManager.boot()`. There is no API to trigger a skill reload at runtime. This means:

- Agent can create the files ✓
- Agent cannot use the new skill in the same session ✗
- Requires backend restart to take effect

### Potential Enhancement

Adding a `reloadSkillMetadata()` call to an HTTP endpoint would enable agents to create and immediately use new skills. This would require:
1. An HTTP route (e.g., `POST /api/reload-skills`)
2. Re-registration of tools in running agent sessions (complex)
3. Or simply: new workers spawned after reload get the new skills

---

## Channel 4: Custom Archetypes (Identity Evolution)

The manager can write archetype override files to `.swarm/archetypes/`, changing the system prompt for future agents.

### Override Mechanism

```
Built-in archetypes (always present):
  manager.md    → Manager system prompt
  merger.md     → Merger system prompt

Override directory:
  .swarm/archetypes/
    manager.md     → REPLACES built-in manager prompt
    merger.md      → REPLACES built-in merger prompt
    researcher.md  → NEW custom archetype (referenced as archetypeId: "researcher")
```

### Timing

Archetypes are loaded once at `SwarmManager` initialization. Changes take effect:
- **New custom archetypes**: Available after backend restart
- **Override of existing**: Available after backend restart
- **Current running agents**: NOT affected (prompt was set at creation)

### Self-Improvement Pattern

A manager could evolve its own future identity:

1. Manager analyzes what works well in its interactions
2. Spawns a worker to draft an improved `manager.md` archetype
3. Worker writes to `.swarm/archetypes/manager.md`
4. After backend restart, new manager instances use the improved prompt

**This is powerful but risky** — a bad archetype override could break the manager's core behavior.

---

## Channel 5: Worker Prompt Tuning (Immediate Effect)

The most flexible self-improvement channel. The manager can spawn workers with fully custom system prompts:

```typescript
spawn_agent({
  agentId: "optimized-coder",
  systemPrompt: "You are a senior TypeScript developer. Always: ..."
    + "Lessons from past sessions: ..."
    + "Project conventions: ...",
  model: "pi-opus",
  cwd: "/path/to/project",
  initialMessage: "Implement feature X following our conventions"
})
```

### What the Manager Can Customize Per Worker

| Parameter | Customizable | Notes |
|-----------|-------------|-------|
| System prompt | Full override | Complete control over worker personality |
| Model | Yes | pi-opus, pi-codex, or codex-app |
| Working directory | Yes | Different cwd per task |
| Archetype | Yes | Reference custom or built-in |
| Initial message | Yes | Context and instructions |

### Self-Improvement Pattern

```
Session 1: Manager spawns generic worker → worker struggles with testing
    │
    ▼
Manager updates memory: "Workers need explicit testing instructions"
    │
    ▼
Session 2: Manager spawns worker with custom prompt including testing rules
    │
    ▼
Manager updates memory: "Custom test-aware prompts work well"
    │
    ▼
Session N: Manager has refined library of worker prompt patterns in memory
```

---

## The Meta-Worker Pattern

The most powerful self-improvement approach: spawn a worker specifically to analyze and improve the manager's own configuration.

### Architecture

```
Manager
  │
  ├─ Spawn "meta-analyst" worker
  │     │
  │     ├─ Read manager memory file
  │     ├─ Read SWARM.md
  │     ├─ Analyze past worker patterns (via list_agents)
  │     ├─ Review project conventions
  │     │
  │     ├─ Write improvements:
  │     │   ├─ Update manager memory with lessons
  │     │   ├─ Update SWARM.md with conventions
  │     │   ├─ Draft new skill SKILL.md files
  │     │   └─ Draft improved archetype overrides
  │     │
  │     └─ Report findings to manager
  │
  └─ Manager incorporates findings
```

### Example Spawn

```
spawn_agent({
  agentId: "meta-analyst",
  systemPrompt: `You are a meta-analyst for this swarm.

Your job:
1. Read the manager memory file at ${SWARM_MEMORY_FILE}
2. Read SWARM.md in the project root if it exists
3. Analyze what patterns work and what doesn't
4. Propose specific improvements to:
   - Memory file organization
   - SWARM.md conventions
   - Worker delegation strategies
5. Write your improvements directly to the memory file
6. Report a summary to the manager

Guidelines:
- Be specific and actionable
- Don't delete existing memory entries without good reason
- Focus on patterns that will improve future sessions`,
  initialMessage: "Analyze our current memory and conventions. Suggest improvements."
})
```

### What the Meta-Worker Can Access

| Resource | Access | Via |
|----------|--------|-----|
| Manager memory file | Read + Write | File tools (auto-loaded in context) |
| SWARM.md | Read + Write | File tools (auto-loaded in context) |
| Agent list + descriptors | Read | `list_agents` tool |
| Other agents' session files | Read | Bash (but discouraged by manager prompt) |
| `.swarm/skills/` | Read + Write | File tools |
| `.swarm/archetypes/` | Read + Write | File tools |
| Backend source code | Read + Write | File tools (unrestricted) |

---

## What Survives What

Understanding the persistence model is critical for effective self-improvement:

```
                        Memory   SWARM.md   Session   System    Workers
                        File                History   Prompt
                        ─────    ────────   ───────   ──────    ───────
Compaction (/compact)     ✅        ✅       Summary    ✅      Unaffected
New session (/new)        ✅        ✅       Wiped      ✅      Unaffected
Backend restart           ✅        ✅       ✅ (.jsonl) Reload   Terminated
Agent kill                ✅        ✅       ✅ (.jsonl) N/A      Terminated
Context overflow          ✅        ✅       Preserved  ✅      Error state

✅ = Preserved    Summary = Summarized/compressed    Wiped = Deleted
```

### The Memory File Is the Only Reliable Long-Term Store

Everything else is either ephemeral (session, workers), read-only at runtime (system prompt, archetypes), or requires restart to take effect (skills, archetypes). **Memory is the only channel that is both durable and immediately effective.**

---

## Boundary Analysis: Current Issues & Risks

### 1. No Auto-Learning

**Problem**: Memory only updates when explicitly triggered. The manager doesn't automatically extract lessons from successful or failed interactions.

**Impact**: Most sessions produce no lasting learning unless the user says "remember this."

**Mitigation**: Instruct the manager (via archetype or SWARM.md) to proactively update memory after significant events:
```markdown
## Self-Learning Protocol
After completing a significant task:
1. Note what worked well
2. Note what failed and why
3. Update memory with actionable lessons
```

### 2. No Memory Size Management

**Problem**: Memory files grow without bound. Large files consume context budget, reducing space for conversation.

**Impact**: Eventually, a bloated memory file crowds out the working context.

**Mitigation**: Periodically spawn a meta-worker to prune/compress the memory file. Or set a convention in SWARM.md:
```markdown
## Memory Hygiene
- Keep memory under 200 lines
- Prune stale entries quarterly
- Consolidate repetitive lessons into principles
```

### 3. Skills Require Restart

**Problem**: New skills written to `.swarm/skills/` aren't loaded until backend restart.

**Impact**: An agent can't create and immediately use a new tool.

**Enhancement opportunity**: Add a `POST /api/reload-skills` endpoint that calls `skillMetadataService.reloadSkillMetadata()` and reconstructs tool lists.

### 4. Archetype Changes Require Restart

**Problem**: Writing to `.swarm/archetypes/manager.md` doesn't affect the running manager.

**Impact**: The manager can plan its own evolution but can't apply it immediately.

**Note**: This is arguably a safety feature — prevents runaway self-modification.

### 5. No Memory Versioning

**Problem**: Memory overwrites are permanent. A bad edit (by agent or user) can corrupt important learning.

**Impact**: Accidental memory corruption with no recovery path.

**Mitigation**: Use git to track `.swarm/` directory, or periodically back up memory files.

### 6. Unrestricted Filesystem Access

**Problem**: The Codex runtime runs with `danger-full-access` sandbox mode. Agents can read/write anywhere the user can.

**Impact**: A meta-worker could modify backend source code, read credentials, or corrupt system state.

**What agents can access**:
```
✅ Read/write: Entire home directory via bash
✅ Read/write: ~/.middleman/ (all data, auth, secrets)
✅ Read/write: Backend source code
✅ Read/write: .swarm/ (skills, archetypes)
✅ Read/write: auth.json (API keys in plaintext)
✅ Execute: Any bash command
```

**Current guard**: Only the manager archetype prompt instructions (advisory, not enforced). The manager prompt explicitly says "don't read session files directly" — but nothing prevents it.

### 7. No Cross-Manager Learning

**Problem**: Each manager has isolated memory. Lessons learned in one project don't transfer to another.

**Impact**: Starting a new manager means starting from scratch.

**Workaround**: A meta-worker in Manager A could read Manager B's memory file (they're adjacent on disk) and cross-pollinate. But this isn't a built-in feature.

### 8. Workers Share Manager Memory (Contention)

**Problem**: All workers read and can write the same manager memory file.

**Impact**: Two workers editing memory simultaneously could overwrite each other's changes.

**Mitigation**: The memory skill says "read before editing" but doesn't enforce locking. Workers should use `edit` (targeted) rather than `write` (full overwrite) to minimize conflicts.

### 9. Codex Agents Can't Compact

**Problem**: Codex runtime explicitly throws on `compact()`. When a Codex agent fills its context, it enters error state with no recovery except `/new`.

**Impact**: Long-running Codex managers will eventually hit context limits with no graceful degradation.

**The only defense**: Proactive memory updates before context fills. Once context overflows, everything not in the memory file is gone.

---

## Recommended Self-Improvement Architecture

Based on the analysis above, here's the most reliable approach:

### Tier 1: Memory-Driven Learning (Works Now)

```
SWARM.md (project root):
  - Self-learning protocol
  - Memory hygiene rules
  - Worker prompt patterns

Manager Memory:
  - User preferences (from bootstrap)
  - Project facts
  - Delegation strategies that work
  - Worker prompt templates
  - Lessons from failures

Workflow:
  1. Manager reads memory at session start
  2. Applies learned patterns to delegation
  3. After significant events → updates memory
  4. Periodically spawns meta-worker to prune/organize memory
```

### Tier 2: SWARM.md Conventions (Works Now)

```
SWARM.md:
  - Coding conventions
  - Testing requirements
  - File organization rules
  - Common error patterns and fixes

Updated by: meta-worker or manager directly
Effect: All new workers pick up conventions immediately
```

### Tier 3: Custom Archetypes (Requires Restart)

```
.swarm/archetypes/
  - manager.md (improved manager prompt)
  - researcher.md (specialized research worker)
  - tester.md (specialized test worker)

Created by: meta-worker
Effect: After backend restart, new agents use improved prompts
```

### Tier 4: Custom Skills (Requires Restart)

```
.swarm/skills/
  - project-deploy/SKILL.md (custom deployment skill)
  - code-review/SKILL.md (custom review checklist)

Created by: meta-worker
Effect: After backend restart, agents have new tools
```

---

## Key Files

| File | Role in Self-Improvement |
|------|------------------------|
| `apps/backend/src/swarm/skills/builtins/memory/SKILL.md` | Memory skill definition |
| `apps/backend/src/swarm/persistence-service.ts` | Memory file creation and paths |
| `apps/backend/src/swarm/runtime-factory.ts` | Memory + SWARM.md injection into context |
| `apps/backend/src/swarm/swarm-manager.ts` | Agent spawn, memory resolution, bootstrap |
| `apps/backend/src/swarm/skill-metadata-service.ts` | Skill discovery and loading |
| `apps/backend/src/swarm/archetypes/archetype-prompt-registry.ts` | Archetype loading and override |
| `apps/backend/src/swarm/archetypes/builtins/manager.md` | Default manager identity |
| `apps/backend/src/swarm/codex-agent-runtime.ts` | Codex sandbox settings |
| `apps/backend/src/swarm/agent-runtime.ts` | Pi compaction, delivery modes |
| `apps/backend/src/swarm/swarm-tools.ts` | spawn_agent, kill_agent, send_message |
