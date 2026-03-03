# Middleman Context & Recall System — Architectural Brainstorm

> **Date:** 2026-03-03
> **Author:** Systems Architect (brainstorm session)
> **Inspiration:** QMD / Claude Code cold-start problem, adapted for multi-agent orchestration
> **Status:** Exploratory — nothing here is committed, everything is on the table

---

## The Problem (And Why Middleman Is Uniquely Positioned)

Every AI conversation starts from zero. QMD solved this for single-user CLI sessions with BM25 + semantic search + a `/recall` skill. But Middleman isn't a CLI — it's a **multi-agent orchestration platform** where:

- Multiple managers run simultaneously across different projects
- Workers spawn, execute, report, and terminate — their knowledge dies with them
- Session memory captures _distilled_ facts but loses the reasoning trail
- Decisions made in one session affect work in another, with no linking
- A worker that debugged a gnarly issue last week has zero ability to help the next worker hitting the same wall
- Integration messages (Slack, Telegram) contain context that never enters the searchable corpus
- Scheduled tasks fire with no awareness of what happened since they were created

**The opportunity:** Build a context system that doesn't just let you _search_ history — it makes the entire swarm _collectively intelligent_ over time. Every agent interaction becomes organizational memory. The swarm gets smarter the longer it runs.

---

## Part 1: The Search Layer

### What Gets Indexed

Everything. Not selectively — comprehensively. The JSONL session format is already structured enough to parse without preprocessing.

#### Corpus Sources

| Source | Location | Structure | Value Signal |
|--------|----------|-----------|--------------|
| **Manager conversations** | `profiles/<pid>/sessions/<sid>/session.jsonl` | `ConversationMessageEvent` (user ↔ assistant) | Primary — captures intent, decisions, outcomes |
| **Worker conversations** | `profiles/<pid>/sessions/<sid>/workers/<wid>.jsonl` | Same event types | Implementation detail — how things got done |
| **Agent-to-agent messages** | Embedded in session JSONL as `AgentMessageEvent` | Sender, receiver, delivery mode | Delegation patterns, handoff context |
| **Tool call logs** | `ConversationLogEvent` with tool metadata | Tool name, call ID, output text | What was executed, what failed |
| **Memory files** | `profiles/<pid>/memory.md` + session memory files | Markdown sections | Distilled knowledge — highest signal density |
| **Session manifests** | `profiles/<pid>/sessions/<sid>/meta.json` | `SessionMeta` with workers, stats, prompt components | Session metadata, worker roster, model choices |
| **Merge audit log** | `profiles/<pid>/merge-audit.log` | Timestamped merge records | Memory evolution over time |
| **Scheduled tasks** | `profiles/<pid>/schedules/schedules.json` | Cron expressions + messages | Recurring intent, automation patterns |
| **Integration threads** | Slack/Telegram message history | `MessageSourceContext` with channel/thread IDs | External communication context |
| **Agent registry** | `swarm/agents.json` | `AgentDescriptor[]` + `ManagerProfile[]` | Agent lifecycle, model choices, CWD history |

#### Document Segmentation Strategy

Raw JSONL lines are too granular. Entire sessions are too coarse. The indexing unit should be a **conversation turn group** — a user message plus all assistant responses, tool calls, and agent messages until the next user message. This preserves conversational coherence while keeping chunks retrievable.

```
Turn Group = {
  turnId: string              // hash of session + first event timestamp
  sessionId: string
  profileId: string
  managerId: string
  startedAt: ISO timestamp
  endedAt: ISO timestamp
  
  // Content fields (all searchable)
  userMessage: string
  assistantMessages: string[]
  toolCalls: { name: string, input: string, output: string }[]
  agentMessages: { from: string, to: string, text: string }[]
  
  // Metadata fields (filterable)
  workerIds: string[]
  modelId: string
  tags: string[]              // extracted topics
  decisions: string[]         // extracted decisions
  cwd: string
  
  // Embedding
  embedding: Float32Array     // dense vector for semantic search
}
```

For memory files, each markdown section becomes a separate document. For agent descriptors, the full descriptor is one document. This gives us heterogeneous search across all knowledge types.

### Search Approaches

#### BM25 (Keyword Search)

**Implementation:** Use a local BM25 index. Options:

1. **MiniSearch** (npm package, pure JS) — zero external deps, runs in the Node.js backend process, ~50ms query time for 100k docs. Good enough for local-first.
2. **SQLite FTS5** — if we ever add SQLite for structured data, FTS5 gives us BM25 for free with excellent performance.
3. **Tantivy via wasm** — Rust-based full-text search compiled to WASM, serious performance for larger corpora.

**Recommendation for v1:** MiniSearch. It's a single npm dependency, runs in-process, supports field boosting (weight `userMessage` and `decisions` higher than `toolCalls`), and handles incremental updates well.

**Field weights:**
- `userMessage`: 3.0 (user intent is highest signal)
- `assistantMessages`: 2.0
- `decisions`: 2.5
- `tags`: 2.0
- `agentMessages`: 1.5
- `toolCalls.output`: 1.0 (noisy but sometimes essential)

#### Semantic Search (Embeddings)

**Implementation options for local-first:**

1. **Local embedding model via Ollama** — `nomic-embed-text` or `mxbai-embed-large`, runs on user's machine, zero API costs, ~50ms per embedding.
2. **Anthropic/OpenAI embedding API** — higher quality, requires API key (user already has one for the agent models), ~$0.0001 per embedding.
3. **Transformers.js** — run ONNX embedding models directly in Node.js without Ollama dependency.

**Recommendation:** Support both local (Ollama/Transformers.js) and API-based. Default to local if Ollama is detected, fall back to API. The user already has API keys configured in `~/.middleman/shared/secrets.json`.

**Vector storage:** For local-first with <1M vectors, a flat file with brute-force cosine similarity is fine. For production scale:
- **HNSWlib (via hnswlib-node)** — fast approximate nearest neighbor, single file persistence
- **SQLite with vector extension** — `sqlite-vss` or the newer `sqlite-vec`

**Recommendation for v1:** Flat numpy-style binary file + brute-force search. At the scale of a single user's session history (even heavy users produce maybe 50k turn groups over a year), brute-force cosine on Float32 arrays is <10ms. Don't over-engineer the vector store.

#### Hybrid Search (The Real Power)

Neither BM25 nor semantic alone is sufficient:
- BM25 misses semantic similarity ("fixed the authentication bug" won't match "resolved the login issue")
- Semantic search misses exact identifiers ("AgentDescriptor" or "session--s5" or error codes)

**Hybrid approach:**
1. Run both BM25 and semantic queries in parallel
2. Normalize scores to [0, 1] range
3. Combine with Reciprocal Rank Fusion (RRF): `score = Σ 1/(k + rank_i)` where k=60
4. Apply metadata boost factors (recency, same-profile, same-cwd)

**Metadata boost factors:**
- Recency: exponential decay with half-life of 7 days
- Same profile: 1.5x
- Same working directory: 1.3x
- Same model family: 1.1x
- Has decisions: 1.2x

### Index Architecture

```
~/.middleman/
  index/                           # NEW — search index directory
    corpus/
      turn-groups.jsonl            # Serialized turn groups
      memory-docs.jsonl            # Parsed memory sections
      agent-docs.jsonl             # Agent descriptors as docs
    bm25/
      index.bin                    # MiniSearch serialized index
    vectors/
      embeddings.bin               # Dense vector file
      id-map.json                  # turnId -> vector offset mapping
    meta/
      index-state.json             # Last indexed positions per session file
      stats.json                   # Corpus stats, index health
```

The `index-state.json` tracks the byte offset of the last indexed line in each JSONL session file. This enables incremental indexing — on each pass, we only read new lines appended since last index.

### Indexing Pipeline

#### Real-time Indexing (via WebSocket Events)

The `SwarmManager` already emits events for every conversation entry via `ConversationProjector`. We hook into this:

```typescript
// New: IndexingService listens to SwarmManager events
class IndexingService {
  constructor(private swarmManager: SwarmManager) {
    // Listen to the same events the WebSocket server does
    swarmManager.on('conversation_message', (event) => this.handleConversationEvent(event));
    swarmManager.on('conversation_log', (event) => this.handleConversationEvent(event));
    swarmManager.on('agent_message', (event) => this.handleAgentMessage(event));
  }
  
  // Buffer events into turn groups, flush to index on turn boundary
  private turnGroupBuffer = new Map<string, TurnGroupBuilder>();
  
  handleConversationEvent(event: ConversationEntryEvent) {
    // A new user message starts a new turn group
    if (event.type === 'conversation_message' && event.role === 'user') {
      this.flushTurnGroup(event.agentId); // flush previous
      this.turnGroupBuffer.set(event.agentId, new TurnGroupBuilder(event));
    } else {
      this.turnGroupBuffer.get(event.agentId)?.addEvent(event);
    }
  }
  
  async flushTurnGroup(agentId: string) {
    const builder = this.turnGroupBuffer.get(agentId);
    if (!builder) return;
    
    const turnGroup = builder.build();
    await this.bm25Index.add(turnGroup);
    
    // Embedding can be async/batched — don't block the event loop
    this.embeddingQueue.enqueue(turnGroup);
  }
}
```

This gives us **live indexing** — the search index updates within seconds of events happening, not just on session close. This is a major advantage over QMD's close-time indexing.

#### Background Batch Indexing

For initial setup (indexing historical sessions) and catch-up after crashes:

```typescript
class BatchIndexer {
  async indexAllSessions(dataDir: string) {
    // Walk all profile dirs
    for (const profileDir of await readdir(getProfilesDir(dataDir))) {
      const sessionsDir = getSessionsDir(dataDir, profileDir);
      for (const sessionDir of await readdir(sessionsDir)) {
        await this.indexSessionFile(
          getSessionFilePath(dataDir, profileDir, sessionDir),
          profileDir,
          sessionDir
        );
        // Also index worker files
        const workersDir = getWorkersDir(dataDir, profileDir, sessionDir);
        for (const workerFile of await readdir(workersDir)) {
          await this.indexSessionFile(join(workersDir, workerFile), profileDir, sessionDir);
        }
      }
    }
  }
  
  async indexSessionFile(filePath: string, profileId: string, sessionId: string) {
    const lastOffset = this.indexState.getOffset(filePath);
    // Read only new lines since last index
    const stream = createReadStream(filePath, { start: lastOffset });
    // ... parse JSONL, build turn groups, add to index
  }
}
```

#### Cron-Based Index Maintenance

Leverage the existing `CronSchedulerService`:

```typescript
// Register an internal maintenance schedule
const REINDEX_CRON = '0 3 * * *';  // 3 AM daily

// Tasks:
// 1. Rebuild any stale index segments
// 2. Re-embed documents if embedding model changed
// 3. Compact the vector store
// 4. Generate corpus statistics
// 5. Extract and update the knowledge graph (see Part 3)
```

---

## Part 2: Context Recall Modes

### Temporal Recall: "What was I doing yesterday?"

**Query processing:**
1. Parse natural language time references into date ranges
   - "yesterday" → [start of yesterday, end of yesterday]
   - "last week" → [7 days ago, now]
   - "before the holidays" → fuzzy, use LLM to resolve
2. Filter turn groups by `startedAt` within the date range
3. Group results by session, show session labels and profiles
4. Summarize activity per session using the manager's assistant messages

**UI presentation:**
```
📅 Yesterday (March 2, 2026)
  
  middleman-project / Session 5 (13 turns, 4 workers)
    • Implemented multi-session data model (Phase 1)
    • Spawned codex-worker for backend changes
    • Reviewed memory merge logic
    
  side-project / Session 2 (6 turns, 1 worker)  
    • Fixed authentication bug in API gateway
    • Updated deployment config
```

**Implementation hook:** New HTTP endpoint + WebSocket command:
```typescript
// Client command
{ type: 'recall', mode: 'temporal', query: 'yesterday', limit: 20 }

// Server event
{ type: 'recall_results', mode: 'temporal', results: RecallResult[], summary: string }
```

### Topical Recall: "Find everything about authentication"

**Query processing:**
1. Run hybrid search (BM25 + semantic) on the query string
2. Apply RRF to merge results
3. Cluster results by session to show context
4. Optionally filter by profile, date range, agent

**Advanced: Topic Expansion**
Before searching, expand the query with related terms using the knowledge graph (Part 3):
- "authentication" → also search "login", "auth", "JWT", "session tokens", "OAuth"
- This happens automatically from co-occurrence analysis

**UI presentation:** Search results with highlighted matches, grouped by session, with relevance scores and time context.

### Relational Recall: "What decisions led to Y?"

This is where Middleman can go far beyond QMD.

**Decision extraction:** During indexing, use pattern matching + LLM classification to identify decision events:
- Memory file entries in the `## Decisions` section
- Assistant messages containing decision language ("decided to", "chose to", "going with", "approved")
- Fork points (session forks represent explicit decision branches)
- Merge audit entries (merging memory = consolidating decisions)

**Decision graph:**
```typescript
interface Decision {
  id: string;
  text: string;
  sessionId: string;
  profileId: string;
  timestamp: string;
  
  // Graph edges
  precededBy: string[];    // decisions that came before
  followedBy: string[];    // decisions that followed
  supersedes: string[];    // decisions this one overrules
  relatedTo: string[];     // topically related decisions
  
  // Context
  turnGroupId: string;     // link to full conversation context
  rationale: string;       // why this was decided (extracted)
  participants: string[];  // which agents were involved
}
```

**Query:** "What decisions led to the sessions-as-agents architecture?"
1. Semantic search finds the decision about sessions-as-agents
2. Walk backward through `precededBy` edges
3. Present as a timeline or dependency graph
4. Each node links to the full conversation context

### Agent-Aware Recall: "What did codex-worker-3 accomplish?"

**Unique to multi-agent platforms.** QMD can't do this because there's only one agent.

**Query processing:**
1. Filter turn groups by `workerIds` containing the target agent
2. Extract the agent's `AgentMessageEvent` entries (reports back to manager)
3. Extract tool calls made by the agent
4. Summarize accomplishments by looking at the assistant messages in the worker's session file

**Deeper: Agent Performance Profiles**
Over time, build profiles of what each agent (by model/archetype) excels at:
```typescript
interface AgentPerformanceProfile {
  archetypeId: string;
  modelId: string;
  
  // Aggregated stats
  totalTasks: number;
  avgTaskDuration: number;
  topToolsUsed: { name: string, count: number }[];
  topicAffinity: { topic: string, successRate: number }[];
  
  // Useful for manager delegation decisions
  strengths: string[];   // "backend implementation", "test writing"
  weaknesses: string[];  // "CSS styling", "complex SQL"
}
```

The manager could use this to make smarter delegation decisions: "Last time I gave a CSS task to codex, it took 3 iterations. Route to opus instead."

### Cross-Session Recall: "Link related work across sessions"

**Session lineage tracking:**
- Fork relationships are already tracked (session memory headers note parent)
- Add explicit "related session" links when the same topic appears across sessions
- Track when a decision in session A is referenced or modified in session B

**Cross-session context injection:**
When a user starts a new session and mentions a topic, automatically surface:
- Previous sessions that worked on the same topic
- Unresolved follow-ups from those sessions
- Decisions that might constrain the current work

```
🔗 Related Context (auto-surfaced)
  
  This topic was discussed in 3 previous sessions:
  
  1. middleman-project/Session 3 (Feb 28) — Initial design discussion
     Key decision: "Sessions as agents" architecture approved
     Open follow-up: Memory Custodian design (unresolved)
     
  2. middleman-project/Session 4 (Mar 1) — Phase 1 implementation started  
     3 workers spawned, data model implemented
     
  3. middleman-project/Session 5 (Mar 2) — Continued Phase 1
     Memory merge logic completed
     Open follow-up: Doc drift cleanup needed
```

---

## Part 3: The Knowledge Graph

### Why a Graph?

Flat search finds documents. A graph finds _relationships_. In a multi-agent system, the relationships between decisions, sessions, agents, topics, and codebases are the most valuable thing to capture.

### Graph Schema

```
Nodes:
  - Session (id, profileId, label, dateRange, model)
  - Decision (id, text, rationale, timestamp)
  - Topic (id, name, aliases)
  - Agent (id, archetypeId, modelId, managerId)
  - CodeEntity (file path, function/class name, last modified)
  - Integration (channel, thread, platform)

Edges:
  - Session --contains--> Decision
  - Session --covers--> Topic
  - Session --spawned--> Agent
  - Session --forked-from--> Session
  - Decision --preceded-by--> Decision
  - Decision --supersedes--> Decision
  - Decision --affects--> CodeEntity
  - Agent --worked-on--> Topic
  - Agent --modified--> CodeEntity
  - Topic --related-to--> Topic
  - Integration --linked-to--> Session
```

### Implementation: Lightweight Local Graph

Don't bring in Neo4j. For a local-first tool, the graph is small enough (<100k nodes for even heavy users) that an in-memory adjacency list serialized to JSON works:

```typescript
interface KnowledgeGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  
  // Query methods
  getNeighbors(nodeId: string, edgeType?: string): GraphNode[];
  shortestPath(fromId: string, toId: string): GraphNode[];
  subgraph(rootId: string, depth: number): { nodes: GraphNode[], edges: GraphEdge[] };
  
  // Update methods  
  addDecision(decision: Decision, sessionId: string): void;
  linkTopics(topicA: string, topicB: string, weight: number): void;
  recordAgentWork(agentId: string, topic: string, codeEntities: string[]): void;
}
```

**Persistence:** `~/.middleman/index/graph/knowledge-graph.json`

**Graph Construction:**
1. **Automatic extraction during indexing** — Use regex + heuristics to extract topics (nouns/phrases that appear >3 times), decisions (language patterns), code entities (file paths in tool calls).
2. **Periodic LLM enrichment** — Use a cron job to run an LLM over recent turn groups, extracting structured relationships. This is expensive but high-value. Run it nightly.
3. **Manual annotation** — The memory skill already lets users declare facts/decisions. Extend it to create graph nodes.

---

## Part 4: What Middleman Can Do That Nobody Else Can

### 4.1 — Proactive Context Injection (Manager Pre-Loading)

**The idea:** Before a manager delegates a task to a worker, it automatically searches the corpus for relevant context and includes it in the worker's `initialMessage`.

```typescript
// In SwarmManager.spawnAgent(), before sending initialMessage:
async spawnAgent(callerAgentId: string, input: SpawnAgentInput) {
  // ... existing spawn logic ...
  
  if (input.initialMessage) {
    // Search for relevant prior context
    const relevantContext = await this.indexingService.search({
      query: input.initialMessage,
      filters: { profileId: manager.profileId },
      limit: 5
    });
    
    if (relevantContext.length > 0) {
      const contextBlock = formatContextForWorker(relevantContext);
      input.initialMessage = `${contextBlock}\n\n---\n\n${input.initialMessage}`;
    }
  }
}
```

**Result:** Workers start with relevant context from previous sessions. A worker debugging a problem automatically gets summaries of past debugging sessions on related topics. The cold-start problem is solved not just for the user, but for every agent in the swarm.

### 4.2 — The Cartographer Agent (Living Knowledge Graph Maintainer)

**Not just a "Memory Custodian" — a dedicated agent that maintains the collective intelligence of the entire swarm.**

```typescript
// New agent type: Cartographer
// Runs on cron (e.g., every 6 hours) or on-demand
// Uses a specialized archetype prompt

const CARTOGRAPHER_SYSTEM_PROMPT = `
You are the Cartographer — a knowledge graph maintenance agent.
Your job is to analyze recent session activity and update the 
swarm's collective knowledge graph.

You have access to:
- The search index (via search_index tool)
- The knowledge graph (via graph_query / graph_update tools)
- All session memory files (via read tool)
- The merge audit log

Your tasks:
1. Extract decisions, topics, and relationships from recent sessions
2. Identify cross-session connections (same topic discussed in multiple sessions)
3. Detect stale decisions (superseded by newer ones)
4. Flag unresolved follow-ups that have gone stale
5. Generate a daily digest of swarm activity
6. Update topic co-occurrence weights in the graph
7. Identify knowledge gaps (topics discussed but not documented in memory)
`;
```

**Cron integration:**
```json
{
  "id": "cartographer-maintenance",
  "name": "Knowledge Graph Maintenance",
  "cron": "0 */6 * * *",
  "message": "Run knowledge graph maintenance cycle",
  "oneShot": false,
  "timezone": "America/Chicago"
}
```

**This goes far beyond QMD's static indexing.** The Cartographer actively curates and enriches the knowledge base. It's like having a librarian who reads every book and maintains the card catalog.

### 4.3 — Cross-Agent Context Sharing (Collective Memory)

**Currently:** Workers read their manager's memory file. That's it. When they terminate, their knowledge dies.

**Proposed:** Workers can contribute to a shared knowledge pool that persists beyond their lifetime.

```typescript
// New skill: contribute_knowledge
// Workers call this to add learnings to the shared pool

interface KnowledgeContribution {
  type: 'discovery' | 'pattern' | 'pitfall' | 'solution';
  topic: string;
  summary: string;
  details: string;
  confidence: 'high' | 'medium' | 'low';
  relatedFiles: string[];
  agentId: string;
  sessionId: string;
  timestamp: string;
}

// Stored in: profiles/<pid>/knowledge/contributions.jsonl
// Searchable via the main index
// Surfaced to future workers via proactive context injection
```

**Example flow:**
1. Worker A debugs a tricky race condition in the WebSocket server
2. Worker A calls `contribute_knowledge({ type: 'pitfall', topic: 'ws-server', summary: 'Race condition in concurrent session creation...' })`
3. Two weeks later, Worker B is assigned to modify the WebSocket server
4. Manager's proactive context injection finds Worker A's contribution
5. Worker B starts with: "⚠️ Previous worker discovered a race condition in this area. See details..."

### 4.4 — Integration Context Weaving

**Currently:** Slack/Telegram messages are routed to managers but don't enter the searchable corpus in a structured way.

**Proposed:** Integration messages are first-class search documents with bidirectional links.

```typescript
// When a Slack message arrives via integration:
handleSlackMessage(event: SlackMessageEvent) {
  // ... existing routing logic ...
  
  // Also index the message with integration context
  this.indexingService.addIntegrationDocument({
    source: 'slack',
    channelId: event.channelId,
    threadTs: event.threadTs,
    userId: event.userId,
    text: event.text,
    timestamp: event.timestamp,
    linkedSessionId: routedToSession.agentId,
    linkedProfileId: routedToSession.profileId
  });
}
```

**Result:** "Find the Slack thread where we discussed the API design" works. Cross-referencing between Slack discussions and session work becomes searchable.

### 4.5 — Predictive Context Loading

**The boldest idea.** Don't wait for a search query — predict what context will be needed.

**How it works:**
1. When a user sends a message, before the manager starts processing, run a fast BM25 search on the message text
2. If high-confidence results are found, inject them into the manager's context as a system message
3. The manager sees: "📋 Potentially relevant prior context: [...]" before even reading the user's message

**Implementation:**
```typescript
// In SwarmManager.handleUserMessage():
async handleUserMessage(text: string, options: UserMessageOptions) {
  // Predictive search — fast BM25 only, <10ms
  const predictions = await this.indexingService.quickSearch(text, {
    mode: 'bm25-only',  // fast path, no embedding lookup
    limit: 3,
    minScore: 0.7,      // high confidence only
    excludeCurrentSession: true
  });
  
  if (predictions.length > 0) {
    const contextNote = formatPredictiveContext(predictions);
    // Inject as a system-level context update
    await this.injectSystemContext(targetAgentId, contextNote);
  }
  
  // ... proceed with normal message handling
}
```

**Key constraint:** This must be FAST (<50ms) to not add perceptible latency. BM25-only is fine for prediction; the user can explicitly search for deeper semantic recall.

### 4.6 — The `/recall` Skill

Expose all of this as a natural-language skill that any agent can use:

```markdown
# /recall Skill

## Usage

The user or any agent can invoke recall in natural language:
- "recall what we decided about the database schema"
- "recall everything from last week"
- "recall what worker-codex-3 did on the auth migration"
- "show me the decision graph for multi-session design"

## Modes (auto-detected from query)

### Temporal
Triggers: "yesterday", "last week", "in February", "before the release"
Returns: Timeline of activity grouped by session

### Topical  
Triggers: Any topic search without time qualifiers
Returns: Ranked search results across all indexed content

### Relational
Triggers: "what led to", "why did we", "decisions about", "history of"
Returns: Decision chain from the knowledge graph

### Agent
Triggers: "what did [agent-name]", "[agent-name]'s work on"
Returns: Agent activity summary with tool calls and outcomes

### Graph
Triggers: "show graph", "map of", "connections between"
Returns: Subgraph visualization data (rendered in UI as interactive graph)
```

**Implementation as a built-in skill:**
```
apps/backend/src/swarm/skills/builtins/recall/
  SKILL.md
  recall-tool.ts
```

The skill calls the `IndexingService` backend, which is a native service — not an external tool. This means:
- Zero latency overhead vs. shelling out to an external search engine
- Access to the full structured index, not just text
- Can return rich structured results that the UI can render specially

---

## Part 5: UI Integration

### Dashboard: Knowledge Overview

New dashboard panel showing:
- **Activity heatmap** — calendar view of session activity (like GitHub contribution graph)
- **Topic cloud** — most frequently discussed topics, sized by recurrence
- **Decision timeline** — chronological list of key decisions with session links
- **Open follow-ups** — aggregated from all memory files, ranked by staleness
- **Agent performance** — which models/archetypes performed best on which tasks

### Search Interface

Full-page search with:
- **Unified search bar** — hybrid search across everything
- **Faceted filters** — by profile, session, date range, agent, topic
- **Result types** — conversations, decisions, memory entries, code changes
- **Inline preview** — expand a result to see surrounding conversation context
- **"Jump to session"** — click to open the full session at that point in the conversation

### Graph Visualization

Interactive knowledge graph view (using something like `react-force-graph` or `d3-force`):
- Nodes colored by type (session=blue, decision=orange, topic=green, agent=purple)
- Edge thickness by connection strength
- Click a node to see details + linked documents
- Filter by time range, topic, profile
- Export as image or structured data

### Real-Time Context Indicator

In the chat view, show a subtle indicator when the system has surfaced relevant context:
```
┌─────────────────────────────────────┐
│ 💡 3 related past discussions found │
│    Click to review context          │
└─────────────────────────────────────┘
```

---

## Part 6: Architecture & Implementation Plan

### Service Architecture

```
SwarmManager (existing)
  │
  ├── IndexingService (NEW)
  │     ├── TurnGroupParser      — JSONL → TurnGroup conversion
  │     ├── BM25Index            — MiniSearch-based keyword index  
  │     ├── EmbeddingService     — Local/API embedding generation
  │     ├── VectorStore          — Dense vector storage + search
  │     ├── HybridSearchEngine   — BM25 + semantic fusion
  │     ├── KnowledgeGraph       — In-memory graph with JSON persistence
  │     └── TopicExtractor       — Automatic topic/decision extraction
  │
  ├── RecallService (NEW)
  │     ├── TemporalRecall       — Date-based filtering + summarization
  │     ├── TopicalRecall        — Hybrid search with context expansion
  │     ├── RelationalRecall     — Graph traversal for decision chains
  │     ├── AgentRecall          — Agent-scoped activity summaries
  │     └── PredictiveLoader     — Pre-emptive context surfacing
  │
  └── CartographerAgent (NEW)    — Cron-scheduled knowledge maintenance
```

### Data Flow

```
Events (real-time)           Batch (periodic)           Cron (scheduled)
       │                           │                          │
       ▼                           ▼                          ▼
  TurnGroupParser ◄────── BatchIndexer ◄──────── CartographerAgent
       │                       │                        │
       ▼                       ▼                        ▼
  ┌─────────┐           ┌──────────┐            ┌──────────────┐
  │ BM25    │           │ Embedding │            │ Knowledge    │
  │ Index   │           │ Service   │            │ Graph        │
  └─────────┘           └──────────┘            └──────────────┘
       │                       │                        │
       └───────────┬───────────┘                        │
                   ▼                                    ▼
            HybridSearchEngine ◄──── Topic Expansion ───┘
                   │
                   ▼
             RecallService
              │    │    │
              ▼    ▼    ▼
           Temporal  Topical  Relational
              │         │         │
              └────┬────┘─────────┘
                   ▼
            Client Response
         (WS event or HTTP)
```

### File System Layout (Addition to ~/.middleman)

```
~/.middleman/
  index/                              # Search & knowledge index
    config.json                       # Index configuration (embedding model, etc.)
    corpus/
      turn-groups/
        <profileId>/
          <sessionId>.jsonl           # Parsed turn groups per session
      memory-docs.jsonl               # Parsed memory file sections
      integration-docs.jsonl          # Integration message documents
      knowledge-contributions.jsonl   # Worker knowledge contributions
    bm25/
      index.bin                       # Serialized MiniSearch index
    vectors/
      embeddings.bin                  # Float32 embedding vectors
      id-map.json                     # Document ID → vector offset
    graph/
      knowledge-graph.json            # Full knowledge graph
      topics.json                     # Extracted topic registry
      decisions.json                  # Extracted decision registry
    state/
      index-state.json                # Incremental indexing watermarks
      stats.json                      # Corpus statistics
      last-maintenance.json           # Last Cartographer run info
```

### Phased Implementation

**Phase 0: Foundation (1–2 weeks)**
- [ ] Define `TurnGroup` type and parser for JSONL → turn groups
- [ ] Implement `IndexingService` with real-time event subscription
- [ ] Add MiniSearch-based BM25 index with incremental updates
- [ ] Add `search` HTTP endpoint and WebSocket command
- [ ] Basic search results UI (search bar + results list)

**Phase 1: Semantic Search (1 week)**
- [ ] Add `EmbeddingService` with Ollama + API fallback
- [ ] Implement flat vector store with cosine similarity
- [ ] Hybrid search with RRF fusion
- [ ] Background batch indexer for historical sessions

**Phase 2: Recall Modes (1–2 weeks)**
- [ ] Temporal recall with NLP date parsing
- [ ] Topical recall with result clustering
- [ ] Agent-aware recall with activity summaries
- [ ] `/recall` skill definition

**Phase 3: Knowledge Graph (2 weeks)**
- [ ] Graph data structure with JSON persistence
- [ ] Automatic topic/decision extraction during indexing
- [ ] Relational recall (decision chains)
- [ ] Graph visualization in UI

**Phase 4: Proactive Intelligence (1–2 weeks)**
- [ ] Predictive context loading in message handling
- [ ] Manager pre-loading for worker delegation
- [ ] Cross-agent knowledge contributions
- [ ] Context indicator in chat UI

**Phase 5: Cartographer Agent (1 week)**
- [ ] Cartographer archetype prompt
- [ ] Cron schedule for graph maintenance
- [ ] Daily digest generation
- [ ] Stale follow-up detection

**Phase 6: Polish & Scale (ongoing)**
- [ ] Integration context weaving (Slack/Telegram)
- [ ] Dashboard knowledge overview panels
- [ ] Export/import of knowledge graphs
- [ ] Performance optimization for large corpora

---

## Part 7: What This Unlocks (The Vision)

### Day 1
You set up Middleman. It's blank. Every conversation starts from zero.

### Week 1  
The index has 50 turn groups. Basic search works. You can find "that thing I did yesterday."

### Month 1
The knowledge graph has 200 nodes. The Cartographer has identified 15 recurring topics and 40 decisions. Workers start getting pre-loaded context. Delegation gets smarter.

### Month 6
The swarm has collective memory. A new worker assigned to modify the auth system automatically receives:
- The 3 most relevant past debugging sessions
- A "pitfall" contribution from a worker that hit a race condition
- The decision chain that led to the current auth architecture
- Links to the Slack thread where the API design was discussed

**The cold-start problem is gone — not just for the user, but for every agent in the system.**

### Year 1
The knowledge graph is rich. The manager makes delegation decisions based on agent performance profiles. The Cartographer generates weekly insight reports. Cross-session decision tracking catches contradictions ("You decided X in January but Y in March — should I reconcile?"). The entire development history of a project is queryable as naturally as talking to a colleague who's been there since day one.

**This isn't just search. It's organizational memory for an AI swarm.**

---

## Open Questions

1. **Privacy/scoping:** Should search be profile-scoped by default, or cross-profile? (Probably profile-scoped with explicit cross-profile opt-in.)
2. **Embedding model updates:** When the user switches embedding models, do we re-embed everything? (Yes, as a background job.)
3. **Storage limits:** At what corpus size do we need to move beyond flat files? (Probably >500k turn groups, which is 2+ years of heavy use.)
4. **LLM costs for Cartographer:** How often should LLM-based extraction run? (Nightly is probably the sweet spot — immediate extraction uses heuristics only.)
5. **Multi-machine sync:** If Middleman ever supports syncing across machines, how does the index travel? (Rebuild from source JSONL on each machine — the index is derived data.)
6. **Memory file conflicts:** If the Cartographer updates the knowledge graph while a session is modifying memory, how do we handle conflicts? (Graph is append-only with timestamps; memory merge already has the LLM merge + audit trail.)

---

*This system turns Middleman from a tool you use into a tool that remembers. Every session makes the next one better. Every worker's hard-won knowledge survives its termination. The swarm becomes genuinely, measurably smarter over time.*
