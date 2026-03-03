# Data Archeologist: ~/.middleman Findings Report

**Date**: 2026-03-03  
**Total data volume**: 3.4 GB  
**Date range**: 2026-02-27 → 2026-03-03 (5 days of usage)

---

## 1. Directory Structure Overview

```
~/.middleman/
├── swarm/agents.json            # Global agent registry (216KB)
├── shared/                      # Cross-profile shared config
│   ├── auth/auth.json           # OAuth tokens (Anthropic, OpenAI-Codex)
│   ├── secrets.json             # API keys (Brave Search)
│   └── integrations/telegram.json  # Shared Telegram bot config
├── uploads/                     # User-uploaded images (84 files, 8.8MB)
├── profiles/                    # Profile-scoped data (3.4GB)
│   ├── feature-manager/         # Profile for "newco/agent_stack" project (3.3GB)
│   │   ├── memory.md            # Profile core memory (24KB — MASSIVE)
│   │   ├── integrations/telegram.json
│   │   ├── schedules/schedules.json
│   │   └── sessions/            # 11 sessions + workers
│   └── middleman-project/       # Profile for self-referential Middleman work (152MB)
│       ├── memory.md            # Profile core memory (2KB)
│       ├── integrations/telegram-topics.json
│       ├── schedules/schedules.json
│       └── sessions/            # 5 sessions + workers
├── auth/auth.json               # Legacy auth location
├── agent/manager/               # Empty dir (placeholder?)
└── .migration-v1-done           # Migration marker (timestamp)
```

---

## 2. Agent Registry (`swarm/agents.json`)

**Richness: ★★★★★ — This is a goldmine.**

### Structure per agent
```json
{
  "agentId": "string",
  "displayName": "string",
  "role": "manager | worker",
  "managerId": "string",        // who spawned this worker
  "archetypeId": "manager",
  "status": "idle | streaming | terminated",
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp",
  "cwd": "/path/to/working/dir",
  "model": {
    "provider": "anthropic | openai-codex",
    "modelId": "claude-opus-4-6 | gpt-5.3-codex",
    "thinkingLevel": "xhigh"
  },
  "sessionFile": "path to JSONL",
  "profileId": "string",
  "sessionLabel": "string",      // human-readable session name
  "contextUsage": {
    "tokens": 107606,
    "contextWindow": 200000,
    "percent": 53.803
  }
}
```

### Key stats
- **16 manager sessions** across 2 profiles
- **322 worker agents** total (all terminated except 2 idle)
- **2 active profiles**: `feature-manager` (newco product), `middleman-project` (self-dev)
- **2 model providers**: Anthropic Claude Opus 4.6, OpenAI GPT-5.3 Codex
- **Model routing pattern**: Codex for backend/implementation, Opus for frontend/design/review

### Searchable signals
- Worker naming conventions reveal task taxonomy: `skills-impl`, `inbox-research`, `latency-backend-runtime`, `design-doc-writer`, `code-review`
- `cwd` field shows which codebase/worktree each agent operated in
- `createdAt`/`updatedAt` give precise task duration
- `contextUsage.percent` shows how deep each session went (some hit 90%+)
- Manager→worker relationships form a complete delegation graph

---

## 3. Session JSONL Files (Conversation Transcripts)

**Richness: ★★★★★ — The richest data source. Full conversation replay with tool calls, costs, and timing.**

### Volume
| Metric | Count |
|--------|-------|
| Manager session files | 16 |
| Worker JSONL files | 322 |
| Total JSONL files | 338 |
| Total JSONL data | 3.5 GB |
| Largest single file | 628 MB (fireworks-impl worker) |

### Event Types (from JSONL analysis)

| Event Type | Frequency | Description |
|------------|-----------|-------------|
| `custom/swarm_conversation_entry/agent_tool_call` | ~69% | Tool execution (start/end/update) |
| `message` | ~17% | LLM messages (assistant/user/toolResult) |
| `custom/swarm_conversation_entry/conversation_message` | ~2.3% | User-visible chat messages |
| `custom/swarm_conversation_entry/agent_message` | ~0.7% | Worker↔manager delegation messages |
| `compaction` | rare | Context window summaries |
| `session` | 1 per file | Session header (version, CWD) |
| `model_change` | rare | Model switch events |
| `thinking_level_change` | rare | Thinking budget changes |

### Message Event Structure (the richest event type)
```json
{
  "type": "message",
  "id": "hex-id",
  "parentId": "hex-id",        // DAG structure! Every event chains to parent
  "timestamp": "ISO",
  "message": {
    "role": "assistant | user | toolResult",
    "content": [
      {"type": "thinking", "thinking": "...", "thinkingSignature": "..."},
      {"type": "toolCall", "id": "...", "name": "read", "arguments": {"path": "..."}},
      {"type": "text", "text": "..."}
    ],
    "api": "anthropic-messages | openai-codex-responses",
    "provider": "anthropic | openai-codex",
    "model": "claude-opus-4-6 | gpt-5.3-codex",
    "usage": {
      "input": 3,
      "output": 717,
      "cacheRead": 0,
      "cacheWrite": 5357,
      "totalTokens": 6077,
      "cost": {
        "input": 0.000015,
        "output": 0.017925,
        "cacheRead": 0,
        "cacheWrite": 0.033481,
        "total": 0.051421
      }
    },
    "stopReason": "toolUse | stop"
  }
}
```

### Tool Call Event Structure
```json
{
  "type": "custom",
  "customType": "swarm_conversation_entry",
  "data": {
    "type": "agent_tool_call",
    "agentId": "codebase-explorer",
    "actorAgentId": "codebase-explorer",
    "timestamp": "ISO",
    "kind": "tool_execution_start | tool_execution_end | tool_execution_update",
    "toolName": "bash | read | edit | write | spawn_agent | ...",
    "toolCallId": "unique-id",
    "text": "{serialized arguments or results}",
    "isError": false
  }
}
```

### Conversation Message Structure (user-visible)
```json
{
  "type": "custom",
  "customType": "swarm_conversation_entry",
  "data": {
    "type": "conversation_message",
    "agentId": "middleman-project",
    "role": "assistant | user",
    "text": "full message text",
    "timestamp": "ISO",
    "source": "speak_to_user | user_input",
    "sourceContext": {"channel": "web | telegram"}
  }
}
```

### Compaction Events (Context Summaries)
```json
{
  "type": "compaction",
  "id": "hex",
  "parentId": "hex",
  "timestamp": "ISO",
  "summary": "## Goal\nEnhance and maintain the middleman platform..."
}
```
These are gold — they're automatic high-level summaries of what a session has been working on, generated when context window fills up.

### Extractable Signals

| Signal | Source | Potential Use |
|--------|--------|---------------|
| **Full conversation history** | conversation_message events | Search by topic, recall past discussions |
| **Every tool call + result** | agent_tool_call events | What files were read/written, what commands ran |
| **File paths touched** | read/edit/write tool args | Codebase activity map, file importance ranking |
| **Bash commands executed** | bash tool args | Build/test patterns, error frequency |
| **Per-turn cost tracking** | message.usage.cost | Cost-per-task analysis, budget forecasting |
| **Token usage patterns** | message.usage | Context efficiency, cache hit rates |
| **Thinking traces** | message.content[type=thinking] | Decision reasoning (Anthropic only) |
| **Delegation messages** | agent_message events | Task decomposition patterns |
| **Parent→child DAG** | parentId chains | Full causal trace of every action |
| **Session compactions** | compaction events | Pre-built session summaries |
| **User activity patterns** | timestamps on user_input | Time-of-day usage patterns |
| **Error patterns** | isError: true on tool results | Common failure modes |
| **Channel context** | sourceContext.channel | Web vs Telegram interaction patterns |

---

## 4. Memory Files

**Richness: ★★★★☆ (profile memory) / ★☆☆☆☆ (session memory)**

### Profile Memory (`profiles/<id>/memory.md`)

Two very different profiles:

#### `feature-manager/memory.md` — 24KB, EXTREMELY rich
A comprehensive knowledge base containing:
- **User preferences**: Communication style, execution style, code quality standards
- **Work triage framework**: 4-track system (Quick Fix → Standard → Full Pipeline → Investigation) with model routing rules
- **Project facts**: Architecture decisions, branching strategy, worktree tooling, Playwright testing setup
- **Completed work log**: 5 major features with detailed summaries (Skills, Inbox, Latency, Fireworks, LiteLLM)
- **Learnings**: Per-feature retrospectives on what worked, what didn't
- **Known bugs**: Active issues being tracked
- **E2E testing reference**: Canonical test approach documentation

#### `middleman-project/memory.md` — 2KB, focused
- User preferences, model routing rules
- Multi-session design decisions (approved architecture)
- Implementation phase plan
- Open follow-ups

### Session Memory (`sessions/<id>/memory.md`)
- **16 files exist** but most are **empty templates** — only the boilerplate structure with "(none yet)"
- Session memory is designed for session-specific working notes but isn't heavily used yet
- The profile core memory carries the real institutional knowledge

### Searchable Signals
- User preferences and work patterns
- Architectural decisions with rationale
- Feature completion history with technical details
- Lessons learned / retrospectives
- Known bugs and open follow-ups

---

## 5. Session Metadata (`meta.json`)

**Richness: ★★★★☆ — Compact but highly structured overview of each session.**

### Structure
```json
{
  "sessionId": "feature-manager--s7",
  "profileId": "feature-manager",
  "label": "knowledge-enhancements",
  "model": {"provider": "anthropic", "modelId": "claude-opus-4-6"},
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "cwd": "/path/to/project",
  "workers": [
    {
      "id": "worker-name",
      "model": "provider/modelId",
      "status": "terminated",
      "createdAt": "ISO",
      "terminatedAt": "ISO",
      "tokens": {"input": null, "output": null}
    }
  ],
  "stats": {
    "totalWorkers": 55,
    "activeWorkers": 0,
    "sessionFileSize": "61111000",
    "memoryFileSize": "140"
  }
}
```

### Session Catalog (from meta.json analysis)

| Profile | Session | Label | Period | Workers | JSONL Size |
|---------|---------|-------|--------|---------|------------|
| feature-manager | root | LiteLLM | Feb 27→Mar 02 | 85 | 13 MB |
| feature-manager | s2 | knowledge | Mar 01→Mar 02 | 38 | 37 MB |
| feature-manager | s3 | Skills | Mar 01→Mar 02 | 15 | 13 MB |
| feature-manager | s4 | MemViz | Mar 02→Mar 02 | 15 | 14 MB |
| feature-manager | s5 | worktrees | Mar 02→Mar 02 | 5 | 3 MB |
| feature-manager | s6 | releasenotes | Mar 02→Mar 02 | 3 | 1 MB |
| feature-manager | s7 | knowledge-enhancements | Mar 02→Mar 03 | 55 | 61 MB |
| feature-manager | s8 | Documentation Review | Mar 02→Mar 03 | 19 | 40 MB |
| feature-manager | s9 | delete agents | Mar 02→Mar 03 | 11 | 12 MB |
| feature-manager | s10 | code simplification | Mar 03→Mar 03 | 11 | 11 MB |
| feature-manager | s11 | Dashboard | Mar 03→Mar 03 | 10 | 15 MB |
| middleman-project | root | Main rewrite and fixes | Feb 28→Mar 03 | 32 | 39 MB |
| middleman-project | s2 | telegram_test | Mar 02→Mar 02 | 0 | 0 MB |
| middleman-project | s3 | config-viewers | Mar 02→Mar 03 | 16 | 18 MB |
| middleman-project | s4 | select models | Mar 02→Mar 03 | 4 | 4 MB |
| middleman-project | s5 | qmd | Mar 03→Mar 03 | 3 | 2 MB |

---

## 6. Integration Data

**Richness: ★★★☆☆**

### Telegram Configuration
- **Shared config** (`shared/integrations/telegram.json`): Bot token, allowed user IDs, polling config, delivery settings
- **Per-profile overrides** (`profiles/feature-manager/integrations/telegram.json`): Profile-scoped Telegram config with same structure
- **Topic routing** (`profiles/middleman-project/integrations/telegram-topics.json`): Maps sessions to Telegram forum topics

```json
{
  "mappings": [{
    "sessionAgentId": "middleman-project--s2",
    "chatId": "8423231579",
    "messageThreadId": 299,
    "topicName": "telegram_test"
  }]
}
```

### Searchable Signals
- Session↔Telegram thread mapping (which sessions are reachable via Telegram)
- Integration channel usage patterns (from sourceContext in conversation events)

---

## 7. Schedules

**Richness: ★☆☆☆☆ — Empty for now.**

Both profiles have `schedules.json` with `{"schedules": []}`. The infrastructure exists but no cron jobs are configured yet.

---

## 8. Uploads

**Richness: ★★☆☆☆**

- **84 files** (82 JPG, 2 PNG), totaling 8.8 MB
- Date range: Feb 27 → Mar 03 (correlated with session activity)
- Naming: `{timestamp}-{uuid}.{ext}` — timestamp is epoch millis, UUID for uniqueness
- These are images the user sent in chat (screenshots, diagrams, etc.)
- No metadata beyond filename; the image content is the value
- Could be cross-referenced with session JSONL to find which session/conversation each upload belongs to

---

## 9. Auth & Secrets

**Richness: ★★☆☆☆ (structural only — sensitive data)**

- OAuth tokens for Anthropic (refresh + access + expiry) and OpenAI-Codex (JWT + refresh + account ID)
- Brave Search API key in secrets.json
- Legacy auth location (`auth/auth.json`) mirrors shared auth

---

## 10. Cost Analysis (from sampled session JSONL)

**Manager session costs (first 3000 events only — underestimates for large sessions):**

| Session | Sampled Cost | Tokens Out |
|---------|-------------|------------|
| feature-manager--s11 (Dashboard) | $17.86 | 67K |
| feature-manager--s3 (Skills) | $16.83 | 61K |
| middleman-project--s3 (config-viewers) | $15.28 | 57K |
| feature-manager (root/LiteLLM) | $14.09 | 55K |
| feature-manager--s4 (MemViz) | $12.82 | 52K |
| feature-manager--s2 (knowledge) | $9.48 | 47K |

**Note**: These are manager-only costs from sampled data. Worker JSONL files (up to 628MB each) contain vastly more token usage. True total cost across all 338 JSONL files would be significantly higher.

---

## 11. Data Path Resolution Logic (`data-paths.ts`)

The path resolution is hierarchical and well-documented:

```
~/.middleman/
├── profiles/{profileId}/
│   ├── memory.md                           # Profile core memory
│   ├── merge-audit.log                     # Memory merge audit trail
│   ├── integrations/                       # Profile-scoped integrations
│   ├── schedules/schedules.json            # Profile-scoped schedules
│   └── sessions/{sessionAgentId}/
│       ├── session.jsonl                   # Manager conversation log
│       ├── meta.json                       # Session metadata + worker list
│       ├── memory.md                       # Session-scoped memory
│       └── workers/{workerId}.jsonl        # Worker conversation logs
├── shared/
│   ├── auth/auth.json                      # OAuth tokens
│   ├── secrets.json                        # API keys
│   └── integrations/                       # Shared integration configs
├── swarm/agents.json                       # Global agent registry
└── uploads/                                # User-uploaded files
```

Key insight: **Memory resolution is role-aware**:
- Root sessions (agentId == profileId) read/write profile core memory
- Non-root sessions have their own session memory
- Workers inherit their manager session's memory (no own memory file)

---

## 12. Latent Value & Search Potential

### High-Value Search Indices

1. **Full-Text Conversation Search**
   - Index `conversation_message` events across all sessions
   - Fields: text, role, source, channel, agentId, timestamp
   - Enables: "What did we discuss about multi-session design?" / "Find where user asked about Telegram"

2. **Tool Activity Index**
   - Index every `agent_tool_call` event
   - Fields: toolName, arguments (file paths, commands), agentId, timestamp, isError
   - Enables: "Which files were modified in the skills feature?" / "Show all bash errors in the last week"

3. **Task/Worker Index**
   - Index agent registry + meta.json worker lists
   - Fields: agentId, managerId, model, status, duration, sessionLabel
   - Enables: "How long did the fireworks implementation take?" / "Show all review workers"

4. **Cost & Token Index**
   - Index every `message` event with usage data
   - Fields: provider, model, input/output/cache tokens, cost, agentId, sessionId
   - Enables: "Total cost this week?" / "Cost per feature?" / "Which model is most efficient?"

5. **Decision & Memory Index**
   - Parse memory.md files for structured sections
   - Index decisions, preferences, learnings, follow-ups
   - Enables: "What architectural decisions have been made?" / "What are open follow-ups?"

6. **File Activity Heatmap**
   - Extract file paths from read/edit/write tool calls across all workers
   - Enables: "Most-touched files in the codebase" / "Files related to Telegram integration"

### Hidden Signals Worth Mining

| Signal | How to Extract | Value |
|--------|---------------|-------|
| **Task decomposition patterns** | Manager spawn_agent messages | Learn how complex tasks get broken down |
| **Model selection heuristics** | Correlate task type with model choice | Auto-recommend models for new tasks |
| **Worker duration distribution** | createdAt→terminatedAt per worker | Estimate task completion times |
| **Error→fix chains** | isError tool results → subsequent tool calls | Common failure recovery patterns |
| **Thinking traces** | content[type=thinking] in Anthropic messages | Raw decision-making reasoning |
| **Context window pressure** | contextUsage.percent over time per session | Predict when compaction will be needed |
| **Parallel execution patterns** | Overlapping worker timestamps | Understand concurrency efficiency |
| **User interaction cadence** | Time gaps between user messages | Busy/idle cycle patterns |
| **Codebase knowledge graph** | File paths from tool calls + relationships | Which files are always modified together |
| **Feature lifecycle timing** | Session create→last update with label | How long features take end-to-end |
| **Cross-session topic continuity** | Topics that span multiple sessions | Thread tracking across session boundaries |
| **Compaction summaries** | compaction.summary events | Pre-built session abstracts (free recall!) |
| **Upload→conversation links** | Timestamps of uploads vs nearby messages | What screenshots relate to what discussions |
| **Delegation graph depth** | manager→worker→(sub-delegation?) | Orchestration complexity per task |

### Creative Possibilities

1. **"What happened while I was away?"** — Aggregate all conversation_message events between two timestamps, summarize by session
2. **"Find that thing we decided"** — Full-text search over decisions in memory + compaction summaries + conversation messages
3. **"How much did feature X cost?"** — Roll up all costs from a session and its workers
4. **"Show me the code review findings"** — Extract worker messages that contain review/finding keywords
5. **"Which patterns keep failing?"** — Aggregate isError tool results by tool name and argument patterns
6. **"Replay a task"** — Reconstruct the full delegation chain: user request → manager plan → worker spawn → tool calls → result
7. **"Time machine"** — Given any timestamp, show what all sessions and workers were doing at that moment

---

## 13. Data Quality Notes

- **JSONL files are append-only** — no risk of data loss from overwrites
- **ParentId chains form a DAG** — enables full causal reconstruction
- **Some worker JSONL files are enormous** (628MB) due to large tool outputs (full file reads, build logs)
- **Cost data is per-turn granular** including cache read/write breakdown
- **Session memory files are mostly unused** — profile memory carries all institutional knowledge
- **Token counts in worker meta.json are null** — this data is tracked per-turn in JSONL but not aggregated in metadata
- **Codex thinking traces are encrypted** (thinkingSignature contains opaque encrypted blob) — Anthropic traces have readable summaries
- **Migration marker** (`.migration-v1-done`) indicates data was migrated from flat to profile-scoped layout

---

## 14. Recommendations for Search/Recall System

### Immediate Wins (index what exists)
1. Parse all `conversation_message` events into a searchable store with session/profile/timestamp metadata
2. Index memory.md files (they're small, structured, and high-signal)
3. Build a session catalog from meta.json files (labels, worker counts, date ranges, sizes)
4. Index compaction summaries as session abstracts

### Medium-Term (derived data)
5. Aggregate per-session and per-worker costs from JSONL usage data
6. Build a file-activity index from tool call arguments
7. Extract and index delegation messages (spawn_agent + agent_message events)
8. Parse tool error patterns for debugging assistance

### Architecture Considerations
- JSONL files are large; need streaming parsers, not load-into-memory
- The DAG structure (parentId chains) is powerful but expensive to traverse across files
- Profile memory is the authoritative knowledge source; session transcripts are the evidence
- Compaction summaries are free abstracts — always index these first
- Consider SQLite or similar for the index (local-first, matches Middleman's philosophy)
