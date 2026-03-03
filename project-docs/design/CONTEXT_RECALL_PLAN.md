# Middleman Context & Recall System — Synthesized Plan

**Date:** March 3, 2026  
**Status:** Design proposal, ready for review  
**Origin:** Three-worker brainstorm synthesis (Data Archeologist, Systems Architect, Interaction Designer)

---

## Executive Summary

Every AI conversation starts from zero. The QMD + Claude Code article solved this "cold start problem" for a single user in a CLI with BM25 search and a `/recall` skill. It was clever. But Middleman isn't a CLI — it's a **multi-agent orchestration platform** with a web dashboard, WebSocket real-time updates, multi-profile sessions, worker delegation, and integration channels. We can go dramatically further.

**The vision:** Build a system where the swarm develops *collective intelligence* over time. Not just "search your history" — every session makes the next one smarter, every worker's hard-won knowledge survives its termination, and the entire development history of a project becomes queryable as naturally as talking to a colleague who's been there since day one.

**What exists today:** 3.4 GB of rich structured data across 338 JSONL session files, 322 terminated workers, 16 manager sessions, comprehensive memory files, per-turn cost tracking, full tool call histories, and compaction summaries that are essentially free session abstracts. This data is currently write-only. The recall system makes it readable.

**What this unlocks that QMD can't do:**

| Capability | QMD (CLI) | Middleman |
|-----------|-----------|-----------|
| Search past sessions | ✅ BM25 + semantic | ✅ Hybrid search with knowledge graph |
| Visual timeline & dashboard | ❌ | ✅ Web UI with session heartbeat |
| Workers start with relevant context | ❌ Single agent | ✅ Proactive injection at delegation time |
| Cross-project intelligence | ❌ Single project | ✅ Multi-profile semantic linking |
| Knowledge survives worker death | ❌ | ✅ Knowledge contributions persist |
| Decision conflict detection | ❌ | ✅ Proactive contradiction flagging |
| Multi-channel recall (Telegram/Slack) | ❌ | ✅ Full intelligence from any channel |
| Autonomous knowledge maintenance | ❌ | ✅ Cartographer agent on cron |
| Real-time indexing | ❌ Close-time only | ✅ Live via WebSocket event stream |
| ⌘K omnibar search across everything | ❌ | ✅ Rich UI with provenance and context |

**The north star test:** Can you pick up any project after a two-week vacation and be productive within 5 minutes?

---

## Key Insights From Each Exploration

### Data Archeologist — "What We're Sitting On"

The data is **far richer than expected**. Five days of real usage produced 3.4 GB of structured, append-only JSONL with:

- **Full conversation replay** with per-turn cost tracking ($0.000015 granularity), token counts, cache hit rates, and stop reasons
- **Complete tool call histories** — every file read, edit, write, and bash command across every worker, with parent→child DAG chains enabling full causal reconstruction
- **Compaction summaries** — the system already generates high-level session abstracts when context windows fill up. These are free recall gold.
- **A 24KB profile memory file** (`feature-manager/memory.md`) that contains a comprehensive knowledge base: user preferences, a 4-track triage framework, architectural decisions with rationale, feature completion retrospectives, known bugs, and E2E testing references
- **Session meta.json files** with worker rosters, durations, and model choices — compact structured overviews perfect for a session catalog

**Critical finding:** Session memory files are mostly empty templates. Profile core memory carries all institutional knowledge. The session-level JSONL transcripts are the untapped resource — massive, structured, and currently unsearchable.

**Highest-value quick wins:**
1. Compaction summaries → instant session abstracts (already generated, just need indexing)
2. `conversation_message` events → searchable conversation corpus
3. Memory.md sections → structured decision/preference index
4. Meta.json → session catalog with worker counts, durations, labels

### Systems Architect — "How To Build It Right"

The architecture leverages Middleman's unique infrastructure:

- **Real-time indexing** via the existing `ConversationProjector` event system — the same events that drive WebSocket updates feed the search index. No batch delay.
- **Turn Groups** as the indexing unit — a user message plus all assistant responses, tool calls, and agent messages until the next user message. Preserves conversational coherence while keeping chunks retrievable.
- **Hybrid search** with BM25 (MiniSearch, zero external deps) + semantic embeddings (Ollama local or API fallback), fused with Reciprocal Rank Fusion and metadata boost factors (recency, same-profile, same-CWD).
- **Proactive context injection** at worker delegation time — before `SwarmManager.spawnAgent()` sends the initial message, search for relevant prior context and prepend it. This solves cold-start for *every agent*, not just the user.
- **The Cartographer Agent** — a dedicated agent running on cron that maintains the knowledge graph, extracts decisions and topic relationships, flags stale follow-ups, and generates activity digests. Uses the existing `CronSchedulerService`.
- **Knowledge contributions** — a new mechanism where workers can persist discoveries, pitfalls, and solutions that survive their termination and get surfaced to future workers.

**Key architectural principle:** The index is derived data. It can always be rebuilt from source JSONL files. This means no migration risk, no backup complexity, and multi-machine support is trivial (rebuild on each machine).

### Interaction Designer — "What Feels Magical"

The designer identified five interaction surfaces, ranked by impact:

1. **The Omnibar (⌘K)** — A universal search that finds anything across all sessions, profiles, and channels. Results show provenance (which profile, which session, when, what type). Click to jump to the exact point in conversation. This alone is a game-changer.

2. **Context Whispers** — Subtle, dismissable cards that appear when the system detects the current conversation relates to past decisions or learnings. Non-intrusive: never blocks input, never during streaming, at most once per topic per session.

3. **Session Preamble** — When you return to a session, a brief context card shows what happened, what's unresolved, and offers "Start from open items" to auto-populate the input with specific follow-ups.

4. **The `/recall` Command** — Explicit search with temporal ("yesterday"), topical ("topic:auth"), and relational ("decision:retry") modes. Returns structured, sourced results that can be injected into the current conversation as context.

5. **Decision Conflict Detection** — When the conversation implies something that contradicts a recorded decision, a gentle banner flags it with the original decision, source, and options to override or dismiss.

**Critical "what NOT to build" list:** No graph database visualizations (nobody uses them), no per-message auto-summarization (noise), no "did you know?" popups (annoying), no analytics dashboards (not a time tracker), no automated memory writing (memory is user-curated).

---

## The Synthesized Architecture

### Indexing Unit: Turn Groups

The fundamental unit is a **Turn Group** — everything that happens between two user messages:

```typescript
interface TurnGroup {
  id: string;                    // hash of session + first event timestamp
  sessionId: string;
  profileId: string;
  startedAt: string;             // ISO timestamp
  endedAt: string;

  // Searchable content
  userMessage: string;
  assistantMessages: string[];
  toolSummary: string;           // Condensed: "Read 3 files, edited 2, ran 1 command"
  decisions: string[];           // Extracted decision statements
  
  // Metadata (filterable)
  sessionLabel: string;
  modelId: string;
  channel: string;               // web | telegram | slack
  workerIds: string[];
  filesInvolved: string[];       // Extracted from tool call paths
  
  // Embedding
  embedding?: Float32Array;      // Dense vector for semantic search
}
```

Memory file sections, compaction summaries, and session metadata each become their own document types in the corpus. Heterogeneous search across all types.

### Search Engine: Hybrid BM25 + Semantic

```
Query → ┬→ BM25 (MiniSearch, <10ms) ──────────┬→ RRF Fusion → Metadata Boost → Results
        └→ Semantic (embeddings, <50ms) ───────┘
```

**BM25 field weights:** userMessage (3.0), decisions (2.5), assistantMessages (2.0), sessionLabel (2.0), toolSummary (1.0)

**Metadata boost factors:** Recency (exponential decay, 7-day half-life), same-profile (1.5x), same-CWD (1.3x), has-decisions (1.2x)

**Embedding strategy:** Ollama local (`nomic-embed-text`) if available, API fallback (user already has keys in `~/.middleman/shared/secrets.json`). Optional — BM25 works standalone for v1.

### Service Architecture

```
SwarmManager (existing)
  │
  ├── ConversationProjector (existing) ──events──→ IndexingService (NEW)
  │                                                  ├── TurnGroupParser
  │                                                  ├── BM25Index (MiniSearch)
  │                                                  ├── EmbeddingService (optional)
  │                                                  └── IncrementalState
  │
  ├── RecallService (NEW)
  │     ├── HybridSearch (BM25 + semantic fusion)
  │     ├── TemporalRecall (date filtering + summarization)
  │     ├── TopicalRecall (hybrid search + result clustering)
  │     └── PredictiveLoader (fast BM25 pre-fetch, <50ms)
  │
  └── CartographerAgent (NEW, Phase 5)
        └── Cron-scheduled knowledge graph maintenance
```

### File System Layout

```
~/.middleman/
  index/                              # NEW — all derived, rebuildable
    config.json                       # Embedding model, index settings
    corpus/
      turn-groups.jsonl               # Parsed turn groups (all sessions)
      memory-docs.jsonl               # Parsed memory file sections
      compaction-docs.jsonl           # Compaction summaries
      session-catalog.jsonl           # Meta.json summaries
    bm25/
      index.bin                       # Serialized MiniSearch index
    vectors/                          # Optional — only if embeddings enabled
      embeddings.bin                  # Dense vector file
      id-map.json                     # Document ID → vector offset
    state/
      watermarks.json                 # Last indexed byte offset per JSONL file
      stats.json                      # Corpus statistics
```

### Data Flow

```
                    REAL-TIME PATH                          BATCH PATH
                    
  User message ──→ ConversationProjector ──→ WebSocket     BatchIndexer (startup + cron)
                          │                                      │
                          │ (same events)                        │ (reads JSONL from watermark)
                          ▼                                      ▼
                    TurnGroupParser ◄────────────────────── TurnGroupParser
                          │                                      │
                          ▼                                      ▼
                    ┌──────────┐                           ┌──────────┐
                    │ BM25     │                           │ Embedding │
                    │ Index    │                           │ Service   │
                    └──────────┘                           └──────────┘
                          │                                      │
                          └──────────────┬───────────────────────┘
                                         ▼
                                   RecallService
                                    │    │    │
                                    ▼    ▼    ▼
                              Search  Temporal  Predictive
                                    │    │    │
                                    ▼    ▼    ▼
                            HTTP API + WebSocket events + /recall skill
```

---

## The Five Interaction Surfaces

### 1. The Omnibar (⌘K) — "Find Anything"

A single search overlay accessible from anywhere in the UI. Searches across all indexed content with hybrid ranking.

**Result types with icons:** 💬 Conversations, 🏛️ Decisions, 📝 Memory entries, 📋 Session summaries, 📄 Files touched

**Each result shows provenance:** Profile → Session → Timestamp → Channel

**Filter chips:** `in:feature-manager`, `type:decision`, `after:2026-02-27`, `from:telegram`

**Actions on results:**
- Click → jump to that point in the session conversation
- "Add to context" → inject as recalled knowledge into current chat
- "View session" → open the full session

### 2. Session Preamble — "Picking Up Where You Left Off"

When you return to an idle session or start a new one, a context card appears at the top of the chat:

```
┌─────────────────────────────────────────────────────┐
│ 📋 Picking up where you left off                    │
│                                                     │
│ Last: Implemented multi-session data model (Phase 1)│
│ Open items:                                         │
│ • Memory Custodian manager design                   │
│ • Doc drift cleanup                                 │
│ • Integration thread-to-session binding             │
│                                                     │
│ [Start from open items]  [Fresh start]  [Dismiss]   │
└─────────────────────────────────────────────────────┘
```

**"Start from open items"** auto-populates the message input with a prompt referencing the specific follow-ups. One click to full productivity.

**For the manager (always, injected into system context):** A structured context block with the session's last activity, active decisions, open follow-ups, and related sessions.

### 3. Context Whispers — "It Noticed Before You Asked"

Subtle, dismissable cards that appear above the chat input when the system detects relevance to past context.

```
┌─────────────────────────────────────────────────────┐
│ 💡 Related context                                  │
│                                                     │
│ You addressed retry stacking in the latency         │
│ remediation (Feb 28). Normalized from 3 layers to 1.│
│                                                     │
│ [View session]  [Add to context]  [Dismiss]         │
└─────────────────────────────────────────────────────┘
```

**Strict constraints:**
- Never during streaming responses
- Never blocks input
- At most once per topic per session
- Only for high-confidence matches (BM25 score > 0.7)
- "Don't show for this topic" option

### 4. The `/recall` Skill — "Explicit Search"

A built-in skill at `apps/backend/src/swarm/skills/builtins/recall/` that any agent can invoke:

**Temporal:** `/recall yesterday` → Activity summary grouped by session  
**Topical:** `/recall topic:memory-system` → Hybrid search results with decisions, sessions, files  
**Decision:** `/recall decision:retry` → Decision-specific results with rationale and source  
**Agent:** `/recall @codex-worker-3` → Agent activity summary with tool calls and outcomes

Results render as structured cards in chat, with "Add to context" to inject as conversation context.

### 5. Dashboard Home — "The Morning Briefing"

Replaces the empty state when no chat is selected. Shows:

- **Recent sessions** — Cards with label, duration, 1-line AI summary, key artifacts, open follow-ups
- **Activity ribbon** — Horizontal band per profile showing session activity over the last 7 days
- **"Continue where you left off"** — One-click resume for last active session per profile
- **Unmerged memory badges** — Visual indicators for sessions with knowledge not yet merged to profile

---

## What Makes This Genuinely Transformative

### 1. Workers That Start Smart

This is the single biggest differentiator. QMD solves cold-start for one user. Middleman solves it for **every agent in the swarm**.

Before `SwarmManager.spawnAgent()` sends the initial message to a new worker, it runs a fast search on the task description:

```typescript
// In SwarmManager, before worker delegation
const relevant = await this.recallService.quickSearch(task.initialMessage, {
  mode: 'bm25',           // Fast path only, <10ms
  profileId: manager.profileId,
  limit: 3,
  minScore: 0.6
});

if (relevant.length > 0) {
  task.initialMessage = formatContextPreamble(relevant) + '\n\n---\n\n' + task.initialMessage;
}
```

**Result:** A worker assigned to modify the WebSocket server automatically receives summaries of past debugging sessions, known pitfalls, and relevant architectural decisions. Workers that would have spent 10 minutes rediscovering context start productive immediately.

### 2. Knowledge That Survives Worker Death

Currently, when a worker terminates, its knowledge dies. The recall system changes this in two ways:

**Passive:** The worker's JSONL transcript is indexed. Its discoveries become searchable by future workers (via proactive injection above).

**Active (Phase 4):** A new skill lets workers explicitly contribute knowledge:

```typescript
// Worker calls this before terminating
contribute_knowledge({
  type: 'pitfall',
  topic: 'ws-server',
  summary: 'Race condition in concurrent session creation — must lock on sessionId',
  relatedFiles: ['apps/backend/src/ws/server.ts']
});
```

Two weeks later, a new worker touching `server.ts` starts with: *"⚠️ Previous worker discovered: Race condition in concurrent session creation..."*

### 3. Cross-Project Intelligence

Multi-profile architecture enables something no single-project tool can do. When you're working in `feature-manager` on something that touches a pattern similar to what `middleman-project` solved, the system can surface it:

```
💡 Cross-profile note
middleman-project recently redesigned profile-scoped data paths
with a similar hierarchical pattern. 15+ path helpers added.
[View session summary] [Dismiss]
```

This is **semantic**, not keyword-based. Two different projects with similar architectural patterns get connected.

### 4. Decision Conflict Detection

The system tracks decisions from memory files and conversation patterns. When the current conversation implies something contradictory:

```
⚠️ Potential conflict with previous decision
"Session lifecycle: running / idle (no 'closed' state). Delete is
the only destructive action."
— Decided in session "config-viewers", Mar 2

[View original] [Override decision] [Ignore]
```

**"Override decision"** creates a proper supersession record with rationale, maintaining the decision audit trail.

### 5. Full Intelligence From Any Channel

You're at dinner, pull out your phone, send a Telegram message: *"what was the final verdict on retry handling?"*

The system searches across all web sessions, memory files, and past conversations, and sends back a complete, sourced answer. The full intelligence of the recall system is available from a 15-word message on a messaging app.

### 6. The Cartographer Agent (Phase 5)

A dedicated agent that runs on cron (every 6 hours) using the existing `CronSchedulerService`:

- Scans recent sessions for unextracted decisions and topics
- Identifies cross-session connections
- Flags stale follow-ups that haven't been addressed
- Generates activity digests
- Detects knowledge gaps (topics discussed but not documented in memory)

This evolves naturally from the already-planned "Memory Custodian" (currently Phase 7 in the multi-session design). The Cartographer is the Memory Custodian plus knowledge graph maintenance.

---

## Phased Implementation

### Phase 0: Foundation — Indexing + Basic Search (1-2 weeks)

**Goal:** Make all existing data searchable. This alone is transformative.

**Backend:**
- [ ] Define `TurnGroup`, `MemoryDocument`, `CompactionDocument` types
- [ ] Implement `TurnGroupParser` — streams JSONL, emits turn groups
- [ ] Implement `IndexingService` with MiniSearch BM25 index
- [ ] Real-time indexing: subscribe to `ConversationProjector` events
- [ ] Batch indexer: process historical JSONL files from watermarks
- [ ] Incremental state tracking (byte offsets per JSONL file)
- [ ] Index memory.md sections and compaction summaries
- [ ] Build session catalog from meta.json files
- [ ] HTTP endpoint: `GET /api/recall/search?q=...&profile=...&type=...`
- [ ] WebSocket command: `{ type: 'recall_search', query, filters }`

**Frontend:**
- [ ] `<RecallOmnibar />` component — ⌘K overlay with search input, filter chips, results
- [ ] Result type renderers (conversation, decision, memory, session summary)
- [ ] Click-to-navigate: results link to session at the relevant point
- [ ] Add search icon to `ChatHeader`

**Files touched:**
- New: `apps/backend/src/recall/` (IndexingService, TurnGroupParser, BM25Index, types)
- New: `apps/ui/src/components/chat/RecallOmnibar.tsx`
- Modified: `apps/backend/src/swarm/swarm-manager.ts` (event subscription hookup)
- Modified: `apps/backend/src/ws/server.ts` (new WS command + HTTP endpoint)
- Modified: `apps/ui/src/components/chat/ChatHeader.tsx` (search icon)

**Validation:** Search "retry stacking" and find the conversation + memory entry. Search "multi-session" and find design decisions across sessions.

---

### Phase 1: The `/recall` Skill + Session Preamble (1 week)

**Goal:** Agents can search context. Sessions start with relevant history.

**Backend:**
- [ ] `/recall` skill definition at `apps/backend/src/swarm/skills/builtins/recall/`
- [ ] Temporal recall: parse natural language dates → filter turn groups by range
- [ ] Topical recall: hybrid search with result clustering by session
- [ ] Decision recall: filter to decision-type results
- [ ] Session preamble generator: on session resume, build context brief from memory + recent activity + open follow-ups
- [ ] Inject preamble into manager system context

**Frontend:**
- [ ] `<RecallResults />` component — structured results in chat
- [ ] `<SessionPreamble />` component — top-of-chat context card
- [ ] "Start from open items" → auto-populate MessageInput
- [ ] "Add to context" action on recall results → inject as special message

**Files touched:**
- New: `apps/backend/src/swarm/skills/builtins/recall/SKILL.md`
- New: `apps/backend/src/recall/temporal-recall.ts`
- New: `apps/backend/src/recall/session-preamble.ts`
- New: `apps/ui/src/components/chat/RecallResults.tsx`
- New: `apps/ui/src/components/chat/SessionPreamble.tsx`
- Modified: `apps/ui/src/components/chat/MessageList.tsx` (render recall results)
- Modified: `apps/ui/src/components/chat/MessageInput.tsx` (auto-populate support)

**Validation:** Start a new session, see relevant preamble. Use `/recall yesterday` and get structured activity summary. Use `/recall topic:auth` and get relevant results.

---

### Phase 2: Semantic Search + Proactive Context (1-2 weeks)

**Goal:** Semantic understanding. Workers start smart. Context whispers appear.

**Backend:**
- [ ] `EmbeddingService` with Ollama detection + API fallback
- [ ] Vector store (flat binary file + brute-force cosine for v1)
- [ ] Hybrid search: BM25 + semantic with RRF fusion
- [ ] Background embedding pipeline (batch historical, real-time new)
- [ ] Predictive context loader: fast BM25 search on user messages before processing
- [ ] Proactive worker injection: search before `spawnAgent()` sends initial message

**Frontend:**
- [ ] `<ContextWhisper />` component — dismissable cards above chat input
- [ ] Whisper trigger: when user message has high similarity to past decisions
- [ ] Whisper controls: dismiss, "don't show for this topic", "add to context"
- [ ] Index settings in Settings panel (embedding model, local vs API)

**Files touched:**
- New: `apps/backend/src/recall/embedding-service.ts`
- New: `apps/backend/src/recall/vector-store.ts`
- New: `apps/backend/src/recall/hybrid-search.ts`
- New: `apps/ui/src/components/chat/ContextWhisper.tsx`
- Modified: `apps/backend/src/swarm/swarm-manager.ts` (proactive injection in spawnAgent)
- Modified: `apps/ui/src/components/chat/MessageInput.tsx` (whisper display area)

**Validation:** Workers for a repeated topic start with relevant context. Typing about a previously-decided topic triggers a context whisper.

---

### Phase 3: Dashboard Home + Session Intelligence (1 week)

**Goal:** The morning briefing. You open Middleman and know what happened.

**Frontend:**
- [ ] `<DashboardHome />` component — replaces empty state
- [ ] Recent sessions cards with AI-generated 1-line summaries
- [ ] Activity ribbon per profile (last 7 days)
- [ ] "Continue where you left off" per profile
- [ ] Unmerged memory badges on sessions
- [ ] Session catalog view (sortable by date, size, workers, label)

**Backend:**
- [ ] Session summary endpoint: generate/cache 1-line summaries from compaction events or conversation_message extracts
- [ ] Activity timeline endpoint: aggregate session activity by day/hour

**Files touched:**
- New: `apps/ui/src/components/chat/DashboardHome.tsx`
- New: `apps/ui/src/components/chat/ActivityRibbon.tsx`
- New: `apps/ui/src/components/chat/SessionCard.tsx`
- New: `apps/backend/src/recall/session-summary.ts`
- Modified: `apps/ui/src/components/chat/MessageList.tsx` (render DashboardHome when no session selected)

**Validation:** Open Middleman in the morning. See what happened overnight across all profiles. One-click resume.

---

### Phase 4: Knowledge Contributions + Decision Tracking (1-2 weeks)

**Goal:** Workers contribute lasting knowledge. Decisions are tracked and conflicts detected.

**Backend:**
- [ ] `contribute_knowledge` skill for workers
- [ ] Knowledge contribution storage: `~/.middleman/index/contributions.jsonl`
- [ ] Contributions indexed and surfaced via proactive worker injection
- [ ] Decision extraction: pattern matching on memory entries + conversation content
- [ ] Decision conflict detection: when new conversation implies contradiction with stored decision
- [ ] Decision conflict WebSocket event

**Frontend:**
- [ ] `<DecisionConflictBanner />` component — inline conflict warning
- [ ] Override/ignore/view actions on conflict banner
- [ ] Decision override creates supersession record in memory

**Files touched:**
- New: `apps/backend/src/swarm/skills/builtins/recall/contribute-knowledge.ts`
- New: `apps/backend/src/recall/decision-tracker.ts`
- New: `apps/ui/src/components/chat/DecisionConflictBanner.tsx`
- Modified: `apps/backend/src/recall/indexing-service.ts` (index contributions)

**Validation:** Worker contributes a pitfall. Future worker on same topic receives it in context. Make a contradicting statement about a recorded decision → conflict banner appears.

---

### Phase 5: The Cartographer Agent (1 week)

**Goal:** Autonomous knowledge maintenance. The swarm's librarian.

**Backend:**
- [ ] Cartographer archetype prompt (specialized for knowledge maintenance)
- [ ] Cron schedule: every 6 hours via existing `CronSchedulerService`
- [ ] Tasks: extract decisions from recent sessions, flag stale follow-ups, generate activity digests, detect knowledge gaps
- [ ] Activity digest stored as a special document type, accessible via `/recall digest`
- [ ] Stale follow-up alerts surfaced in dashboard and session preambles

**Integration with existing plans:**
- This subsumes the "Memory Custodian" from the multi-session Phase 7 design
- Uses the same merge infrastructure (`memory-merge.ts`, merge audit log)
- Runs as a regular manager agent with a specialized archetype

**Validation:** After Cartographer runs, new decisions appear in the index. Stale follow-ups (>7 days untouched) get flagged. Activity digest is available via `/recall digest`.

---

### Phase 6: Cross-Profile + Multi-Channel Polish (ongoing)

**Goal:** Full intelligence across profiles and channels.

- [ ] Cross-profile search (opt-in): `/recall @feature-manager topic:auth`
- [ ] Cross-profile relevance whispers (when work in one profile relates to another)
- [ ] Telegram-native recall (search from Telegram, get sourced answers)
- [ ] Integration messages indexed as first-class documents
- [ ] Channel metadata in search results and timeline
- [ ] Knowledge map visualization (topic mosaic, not graph — Designer was right about this)

---

## Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| BM25 engine | MiniSearch (npm) | Zero deps, in-process, <10ms queries, incremental updates |
| Embedding model | Ollama local, API fallback | Local-first philosophy, user already has API keys |
| Vector storage | Flat binary + brute-force cosine | <50k vectors for years of use; don't over-engineer |
| Index storage | `~/.middleman/index/` | Derived data, rebuildable from source JSONL |
| Real-time indexing | Subscribe to ConversationProjector events | Same event stream as WebSocket — zero new infrastructure |
| Incremental indexing | Byte offset watermarks per JSONL file | Append-only files make this trivial and robust |
| Search protocol | New WS command + HTTP endpoint | Matches existing backend patterns |
| Skill interface | Built-in skill at `skills/builtins/recall/` | Matches existing skill architecture exactly |
| Graph visualization | Topic mosaic, NOT graph database | Graph DBs look cool in demos, never get used in practice |
| Memory writing | Never automated | Memory is user-curated knowledge. System reads, never writes. |

## What We Explicitly Won't Build

1. **Neo4j or any external graph database** — A JSON adjacency list is sufficient for <100k nodes
2. **Full graph visualization** — Topic mosaic instead. Nobody uses force-directed graphs for real work.
3. **Per-message auto-summarization** — Session-level only. Per-message adds noise.
4. **Proactive "did you know?" popups** — If it's not relevant to the current task, don't show it.
5. **Analytics dashboards** — This isn't a time tracker. Token/cost data is already in session metadata.
6. **Automated memory writing** — The system surfaces context; only the user (or user-approved agents) write to memory.

---

## Success Metrics

| Metric | Phase 0 | Phase 2 | Phase 5 |
|--------|---------|---------|---------|
| Search latency (BM25) | <10ms | <10ms | <10ms |
| Search latency (hybrid) | — | <100ms | <100ms |
| Index coverage | Memory + compactions + conversation_messages | + embeddings | + knowledge contributions |
| Cold-start context for workers | None | 3 relevant prior results injected | + knowledge contributions + pitfalls |
| Time to productivity after break | Manual memory reading | Session preamble + omnibar search | Morning briefing dashboard + auto-preamble |
| Decision conflicts caught | None | None | Active detection + alerting |

---

## The 12-Month Vision

**Week 1:** You install the recall system. Your 3.4 GB of session data becomes searchable. You find conversations you'd completely forgotten about. The omnibar becomes muscle memory (⌘K, type, find).

**Month 1:** Workers start with relevant context. A new worker on the WebSocket server gets summaries of past debugging sessions. Delegation becomes noticeably more efficient. Session preambles mean you never start from zero.

**Month 3:** Context whispers catch you before you contradict a past decision. The Cartographer runs every 6 hours, flagging stale follow-ups and extracting decisions you made in conversation but forgot to record in memory. Knowledge contributions from workers create a growing pool of institutional knowledge.

**Month 6:** You start a new project profile. Within the first week, cross-profile intelligence surfaces patterns from your other projects that are architecturally relevant. The swarm is developing taste — it knows what patterns work for you.

**Year 1:** The system has thousands of indexed turn groups, hundreds of decisions, and a rich web of connections between topics, sessions, and agents. You onboard a colleague to work on the same codebase. They connect to the same Middleman instance, and within minutes they have access to the entire project history as naturally as asking a question. The cold-start problem is solved not just for you, not just for your agents, but for anyone who joins.

**This isn't just search. It's organizational memory for an AI swarm — and it gets smarter every day you use it.**

---

## Appendix: Data Inventory Summary

| Data Source | Count | Size | Index Priority |
|-------------|-------|------|----------------|
| Manager session JSONL | 16 | ~260 MB | Phase 0 — conversation_messages only |
| Worker session JSONL | 322 | ~3.2 GB | Phase 0 — compactions only; Phase 2 — full |
| Profile memory files | 2 | 26 KB | Phase 0 — immediate, highest signal |
| Session memory files | 16 | ~2 KB | Phase 0 — scan for any content |
| Session meta.json | 16 | ~50 KB | Phase 0 — session catalog |
| Agent registry | 1 | 216 KB | Phase 0 — agent/model/task index |
| Compaction summaries | ~20 | embedded | Phase 0 — free session abstracts |
| Uploads | 84 | 8.8 MB | Phase 6 — cross-reference with sessions |
| Integration configs | 3 | ~2 KB | Phase 6 — channel metadata |
| Schedules | 2 | ~200 B | Not indexed (empty) |
