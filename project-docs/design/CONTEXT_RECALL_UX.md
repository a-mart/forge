# Context, Memory & Recall — Interaction Design Brainstorm

> Designing the experience of a system that makes Middleman feel like it *knows you*.

## The Core Insight

Middleman already has an extraordinary amount of context. Right now across just two profiles (`middleman-project` and `feature-manager`), there are **300+ MB of session transcripts**, rich structured memory files with decisions/preferences/learnings, session metadata with worker histories, artifacts, and conversations spanning multiple days across web/Slack/Telegram channels.

**The problem isn't generating context — it's that context is write-only.** You write a memory entry, it goes into the void of a markdown file. You have a breakthrough conversation at 2am, it's buried in a 61MB JSONL. You made a critical architectural decision three sessions ago — good luck finding it when you need it.

The recall system should feel less like a search engine and more like a **brilliant colleague who was in every meeting, read every doc, and has perfect memory** — but knows when to speak up and when to stay quiet.

---

## Part 1: The Dashboard — "What's Been Happening"

### 1A. Session Timeline (The Heartbeat View)

**What it is:** A horizontal timeline visualization that shows your work across all profiles and sessions. Not a calendar — a *heartbeat*. Activity pulses show when sessions were active, what they were doing, and what came out of them.

**The feel:** You open Middleman in the morning. Instead of a blank chat with "What can I do for you?", you see a living dashboard that says: *"Here's what happened while you were away, and here's what matters now."*

**Concrete elements:**
- **Activity ribbon** — a horizontal band per profile, showing session activity over the last 7 days. Dense periods glow brighter. Hover a segment → tooltip with session label, duration, key outcomes.
- **Recent sessions cards** — the 3-5 most recent sessions, each showing:
  - Session label (editable inline, like now)
  - Duration and status (running/idle)
  - A 1-line AI-generated summary: *"Implemented multi-session data model across 6 phases, 16 workers"*
  - Key artifacts produced (files changed, design docs written)
  - Memory entries written (decisions made, preferences recorded)
  - Unmerged memory badge if session has unmerged knowledge
- **"Continue where you left off"** — the last active session for each profile, with a one-click resume that drops you into the chat with the last context visible.

**The magical moment:** You come back after a weekend and the dashboard *tells you a story* about what your agents accomplished. Not raw logs — a narrative. "Feature-manager completed the LiteLLM proxy integration (PR #282 merged to dev). 3 sessions ran, 32 files changed. Here's the code review summary."

### 1B. The Omnibar — "Find Anything"

**What it is:** A single search input (⌘K accessible) that searches across ALL context: session conversations, memory files, decisions, artifacts, worker logs, file paths. Not keyword search — **semantic search**.

**The feel:** You vaguely remember discussing something about "retry stacking" a few days ago but can't remember which session. You type "retry layers latency" into the omnibar and get:

```
🔍 3 results across 2 profiles

📝 Decision (feature-manager, memory.md)
   "Three hidden retry layers (chat-service + agent + model) can stack
    silently and multiply latency"
   Source: Latency Remediation learnings — Feb 28

💬 Session (feature-manager--s7, "latency-investigation")
   "...found three nested retry wrappers in the call path. chat-service
    retries 3x, then the agent runtime retries, then the model client..."
   ~2 days ago, 14 minutes into session

📄 Artifact (planning/latency-investigation/audit.md)
   Retry normalization section — reduced from 3 layers to 1
```

**Key design principles:**
- Results are ranked by **relevance**, not recency (but recency is a signal)
- Each result shows **provenance**: which profile, which session, when, what type
- Click a session result → jumps to that exact point in the conversation
- Click a memory result → shows the memory file with the entry highlighted
- Click an artifact → opens in the artifact panel

**Scoping:** The omnibar has filter chips: `in:feature-manager`, `type:decision`, `type:artifact`, `after:2026-02-27`, `from:telegram`. These can be typed or clicked.

**The magical moment:** You search for something you half-remember, and the system finds it in a session you'd completely forgotten about. It crosses profile boundaries — a decision made in `middleman-project` surfaces when relevant to `feature-manager` work.

### 1C. Knowledge Map — "What Does the System Know"

**What it is:** A visual representation of everything Middleman knows, organized by topic clusters rather than chronology.

**The feel:** Not a graph database visualization (those are never useful for actual work). Instead, a **topic mosaic** — tiles/cards clustered by theme, sized by how much knowledge exists in that area.

**Concrete elements:**
- **Topic clusters** generated from memory entries and session content:
  - "Architecture & Data Model" (sessions-as-agents, memory hierarchy, JSONL persistence)
  - "Deployment & CI" (dev branch auto-deploy, worktree workflow)
  - "Frontend Patterns" (shadcn, Tailwind v4, TanStack Router)
  - "Integrations" (Slack, Telegram, provider routing)
  - "Work Process" (track 1-4 triage, autonomous pipelines, review cycles)
- Each cluster shows: number of related decisions, sessions that touched this topic, last activity date
- Click a cluster → expands to show the individual entries, with links to source sessions/conversations
- **Drift indicators** — when a topic has contradictory information or stale references, show a yellow indicator

**What this replaces:** Right now, understanding "what does the system know about X" requires reading through memory.md files manually. This makes the knowledge browsable.

---

## Part 2: In-Chat Context — "The Assistant That Remembers"

### 2A. Context Whispers (Proactive, Subtle)

**What it is:** Small, dismissable context cards that appear *above* the chat input or in a slim side rail when the system detects relevance to past context.

**The feel:** You start typing a message about changing the retry behavior, and a small card fades in:

```
┌─────────────────────────────────────────────────┐
│ 💡 Related context                              │
│                                                 │
│ You addressed retry stacking in the latency     │
│ remediation (Feb 28). The solution normalized   │
│ from 3 retry layers to 1.                       │
│                                                 │
│ [View session] [Dismiss] [Don't show for this]  │
└─────────────────────────────────────────────────┘
```

**Critical design constraint:** This must be **non-intrusive**. It should never:
- Block the input area
- Appear during rapid conversation flow (streaming responses)
- Appear more than once per topic per session
- Be wrong more than it's right (better to miss context than show irrelevant noise)

**When to show:**
- When the user types a message that has high semantic similarity to a past decision or learning
- When the user starts a session in a topic area where relevant decisions exist
- When a contradiction is detected between current conversation and past decisions

**When NOT to show:**
- During active worker execution (don't distract from the flow)
- When the user has dismissed this topic before
- When the context is from the current session (they already know)

### 2B. Session Preamble (Proactive, Structured)

**What it is:** When you start a new session or return to an idle one, the system generates a brief context preamble that the manager sees (and optionally the user too).

**For the manager (always, in system prompt):**
```
== Session Context ==
Profile: middleman-project
Last session: "config-viewers" (1 day ago) — implemented profile-scoped
config viewers with 16 workers
Active decisions: Multi-session architecture approved (sessions-as-agents),
memory isolation with deferred merge
Open follow-ups: Memory Custodian design, integration thread-to-session binding
Related active work: feature-manager has similar data-path patterns
```

**For the user (optional, as a subtle top-of-chat card):**
```
┌─────────────────────────────────────────────────┐
│ 📋 Picking up where you left off                │
│                                                 │
│ Your last session implemented the multi-session │
│ data model. Open items:                         │
│ • Memory Custodian manager design               │
│ • Doc drift cleanup                             │
│ • Integration thread-to-session binding         │
│                                                 │
│ [Start from open items] [Fresh start] [Hide]    │
└─────────────────────────────────────────────────┘
```

**The magical moment:** "Start from open items" auto-populates the message input with a prompt that references the specific follow-ups, so you can just hit send and the manager picks up exactly where the last session left off.

### 2C. The Recall Command — "/recall" (Reactive, Explicit)

**What it is:** An explicit command for when the user wants to search their context, just like the QMD article describes — but adapted for Middleman's multi-agent, multi-channel world.

**Commands:**

**`/recall yesterday`** — Temporal recall
Shows a structured summary of all activity from yesterday across all profiles:
```
📅 Yesterday (Mar 2, 2026)

middleman-project
└─ Session "config-viewers" (6h 23m)
   • Ran memory audit across backend + data paths (2 workers)
   • Wrote design doc for multi-session architecture (Opus)
   • Codex finalized design doc
   • 16 workers spawned total
   • Key decision: sessions-as-agents architecture approved

feature-manager
└─ Session "latency-fix" (3h 10m)
   • Completed latency remediation PR
   • 32 files changed, merged to dev
   • Key learning: Three hidden retry layers were the root cause
```

**`/recall topic:memory-system`** — Topic recall
Searches all context semantically for a topic:
```
🔍 "memory system" — 12 matches across 2 profiles

Decisions:
• Session-scoped memory: sessions READ profile core, WRITE own session
• Deferred merge (on-demand for v1)
• Memory Custodian: future cron-based consolidation manager

Active Memory Entries:
• Memory hierarchy: profile/session/worker structure
• memory.md format: markdown with structured sections

Related Sessions:
• middleman-project--s3 "config-viewers" — designed memory isolation
• middleman-project--s2 — initial multi-session brainstorm

Files:
• apps/backend/src/swarm/data-paths.ts (memory path resolution)
• apps/backend/src/swarm/memory-merge.ts (LLM-based merge)
```

**`/recall decision:retry`** — Decision-specific recall
```
🏛️ Decisions matching "retry"

1. "Three hidden retry layers (chat-service + agent + model) can
    stack silently and multiply latency"
   → Resolved: normalized from 3 layers to 1
   Source: feature-manager latency remediation (Feb 28)

2. "Retry alignment: 0/0 for Fireworks provider"
   Source: feature-manager Fireworks provider work (Feb 28)
```

**`/recall @feature-manager topic:auth`** — Cross-profile recall
Search another profile's context from your current session.

### 2D. Inline Context Injection — "Pull It In"

**What it is:** When the system surfaces relevant past context (via whispers, recall, or search), the user can **inject** that context directly into the current conversation with one click.

**The feel:** You're discussing a new feature and /recall finds a relevant design doc from a past session. Instead of copy-pasting or hoping the manager remembers, you click "Add to context" and the recalled content appears as a special message:

```
📎 Injected context from session "config-viewers" (Mar 2):
[Collapsed by default, expandable]
Multi-session design decisions:
- Sessions as agents architecture
- Memory isolation with deferred merge
- Fork duplicates JSONL history
```

This context is now part of the conversation — the manager can reference it directly. It's different from an attachment (which is a file) — it's **recalled knowledge** with provenance.

---

## Part 3: Proactive Intelligence — "It Noticed Before You Did"

### 3A. Decision Conflict Detection

**What it is:** When the current conversation establishes or implies something that contradicts a past decision, the system flags it.

**Example:** You're in `middleman-project` discussing adding a "closed" state to sessions. The system knows you previously decided "running/idle only, no closed state. Delete is the only destructive action."

```
⚠️ Potential conflict with previous decision
"Session lifecycle: running / idle (no 'closed' state). Delete is
the only destructive action."
— Decided in session "config-viewers", Mar 2

This conversation seems to be introducing a "closed" state.
[View original decision] [Override decision] [Ignore]
```

**"Override decision"** updates the memory entry and adds a supersession note:
```
- Session lifecycle: **running / idle / closed** (updated Mar 3,
  originally no "closed" state — changed because [user provides reason])
```

**Key:** This only triggers for entries explicitly marked as "decisions" in memory. Not for every piece of context — just the important stuff.

### 3B. Cross-Profile Intelligence

**What it is:** When work in one profile is relevant to another profile, surface it.

**Example:** You're working in `feature-manager` on something that touches `data-paths.ts`. The system knows that `middleman-project` recently refactored that file heavily in the multi-session work.

```
💡 Cross-profile note
middleman-project recently made significant changes to
data-paths.ts (session hierarchy, profile-scoped paths).
The session "config-viewers" added 15+ new path helpers.

You may want to pull from that branch or check for conflicts.
[View session summary] [Dismiss]
```

### 3C. Pattern Surfacing (Deferred — v2)

**What it is:** Over time, the system notices patterns in how you work and surfaces them gently.

Examples (gentle, once per pattern, dismissable forever):
- *"You've used the Track 3 pipeline for the last 4 features. Want me to default to that for new feature requests?"*
- *"Sessions in feature-manager average 3.5 hours. This one is at 6 hours — want to split remaining work into a new session?"*
- *"You typically review code with Opus and implement with Codex. Want me to auto-route new workers that way?"*

**Critical:** This is the most dangerous feature in terms of being annoying. It should:
- Only surface patterns with very high confidence
- Only show each pattern once
- Have a clear "never show this type of suggestion" option
- Be off by default, opt-in

---

## Part 4: Multi-Channel Continuity — "It's All One Brain"

### 4A. Channel-Aware Recall

**What it is:** When you message from Telegram, the system knows your full web history. When you're on web, you can see what happened via Telegram.

**Telegram scenario:**
You message from Telegram at 11pm: "what did we decide about the memory merge approach?"

The manager recalls from web sessions:
```
From your session "config-viewers" (web, yesterday):

Decision: Session-scoped memory — sessions READ profile core
memory, WRITE to their own session memory. Deferred merge
(on-demand for v1). Future Memory Custodian manager on cron
for automated consolidation.

Want me to elaborate on any part?
```

**Web scenario:**
You open the web UI and see a Telegram conversation happened overnight. The channel toggle (existing: Web/All) already shows this. The recall system adds: when you start a new web session, the preamble includes "Note: user discussed X via Telegram at 11pm."

### 4B. Channel-Aware Context Cards

In the session timeline on the dashboard, each session segment shows which channel(s) were active:
- 🌐 Web only
- 📱 Telegram only
- 🌐📱 Both (multi-channel session)
- 💬 Slack

This matters because the *channel* tells a story about the user's context. Telegram at 11pm = quick check-in from phone. Web at 2pm = deep work session. The system should adapt its response style accordingly — but that's a runtime concern, not a recall concern.

### 4C. Unified Memory Across Channels

Memory writes from any channel go to the same place. A decision made via Telegram is just as durable as one made in the web UI. When you /recall, results include the source channel as metadata:

```
📱 Decision via Telegram (Mar 2, 11:14 PM):
"Let's defer the Memory Custodian to Phase 7"

🌐 Decision via Web (Mar 2, 3:30 PM):
"Sessions-as-agents architecture approved"
```

---

## Part 5: The "Wow" Moments — What Gets Shown to Friends

### 5A. "It Connected Two Things I Didn't"

You're working on a new feature in `feature-manager` and mention something about "session isolation." The system surfaces a decision from `middleman-project` about memory isolation that's architecturally relevant — even though the two profiles are for completely different projects. The connection is semantic, not keyword-based.

*"Wait, it pulled context from my OTHER project because the architectural pattern was similar?"*

### 5B. "It Remembered What I Forgot"

Two weeks from now, you start a session to design the Memory Custodian (currently an open follow-up). The session preamble says:

```
📋 This topic has existing context:
• Originally planned as Phase 7 follow-up (decided Mar 2)
• Should be a dedicated manager on cron
• Scans for unmerged sessions and consolidates into profile core memory
• Related: memory-merge.ts already has LLM-based merge logic
• Related: data-paths.ts has merge audit log support
```

You didn't ask for this. You just started a session. But the system recognized the topic and pre-loaded everything relevant. The session is productive from message one.

### 5C. "It Showed Me My Own Patterns"

After a month of use, you visit the Knowledge Map and see that your decision-making has a clear structure: architectural decisions get made in `middleman-project`, implementation patterns get established in `feature-manager`, and they cross-pollinate. The system visualizes this as a flow.

### 5D. "I Asked From My Phone and Got a Full Answer"

You're at dinner, pull out your phone, send a Telegram message: "what was the final verdict on retry handling?"

You get back a complete, sourced answer with session references, the specific decision, and the code files involved — all from a 15-word message on a messaging app. No switching to a laptop. No opening a browser. The full intelligence of the system is available from a tiny text input.

### 5E. "It Caught Me Contradicting Myself"

You're about to make a decision that contradicts something you decided last week. But you'd forgotten. The system gently flags it. You realize it's right — the old decision still holds. You saved yourself from a bad path.

---

## Part 6: Implementation Considerations

### What Gets Indexed

Not everything. Indexing should be **selective and incremental**:

1. **Always indexed:** Memory file entries (decisions, preferences, facts, learnings, follow-ups)
2. **Always indexed:** Session metadata (labels, creation dates, worker counts, models used)
3. **Indexed on write:** Conversation messages from user and assistant (not tool execution logs)
4. **Indexed on write:** Artifact metadata (paths, types, creation context)
5. **NOT indexed:** Raw tool execution logs (too noisy, too large)
6. **NOT indexed:** Worker-to-manager internal messages (implementation details)

### Embedding Strategy

- Chunk session conversations into semantically meaningful segments (not fixed-size)
- Each chunk gets: profile ID, session ID, timestamp range, channel, a summary line
- Memory entries get per-entry embeddings (each bullet point or section)
- Use the profile's memory structure as a taxonomy for topic clustering

### Storage

Local-first, matching Middleman's architecture:
- Embeddings in a local vector store (sqlite-vec or similar)
- Index files live alongside session data in `~/.middleman/profiles/<profileId>/index/`
- No cloud dependency for recall — works offline

### Indexing Trigger

- **Realtime:** Memory file changes trigger immediate re-indexing of changed entries
- **Post-session:** When a session goes idle, generate a summary and index the conversation
- **Background:** Periodic full re-index for consistency (daily cron, using Middleman's own scheduler)

### Privacy

- All data stays local (no cloud vector DB)
- Per-profile isolation by default (cross-profile recall is opt-in)
- Users can exclude specific sessions from indexing
- Memory entries marked `[private]` are excluded from recall results surfaced to others

---

## Part 7: UI Component Inventory

### New Components Needed

1. **`<RecallOmnibar />`** — ⌘K search overlay with result types, filters, provenance
2. **`<SessionTimeline />`** — Horizontal activity timeline per profile
3. **`<ContextWhisper />`** — Dismissable context card above chat input
4. **`<SessionPreamble />`** — Top-of-chat context brief for returning sessions
5. **`<KnowledgeMap />`** — Topic cluster visualization
6. **`<RecallResults />`** — Structured results display for /recall commands
7. **`<DecisionConflictBanner />`** — Inline conflict warning
8. **`<CrossProfileNote />`** — Cross-profile relevance card
9. **`<ContextInjection />`** — Special message type for recalled context
10. **`<UnmergedMemoryBadge />`** — Visual indicator for sessions with unmerged knowledge
11. **`<DashboardHome />`** — New home view replacing the EmptyState

### Modified Components

- **`EmptyState`** → Replaced by `DashboardHome` for first load
- **`ChatHeader`** → Add recall search icon, context indicator
- **`AgentSidebar`** → Add unmerged memory indicators, session summaries on hover
- **`MessageInput`** → Handle /recall commands with autocomplete
- **`MessageList`** → Render `ContextInjection` messages and `RecallResults`
- **`ArtifactsSidebar`** → Could evolve into a more general "Knowledge" panel

### Routes

- `/` (dashboard home) — shows timeline + recent sessions + knowledge overview
- `/?view=chat&agent=X` (existing) — chat with recall features embedded
- `/?view=recall` (new) — full recall search interface
- `/?view=knowledge` (new) — knowledge map visualization

---

## Part 8: What NOT to Build

Equally important — things that sound cool but would be annoying or useless:

1. **Full graph visualization of sessions** — Nobody actually uses these. They look cool in demos and never get opened again. The knowledge map is topic-based, not graph-based.

2. **Auto-summarization of every message** — Summaries should be session-level, not message-level. Per-message summaries add noise.

3. **Proactive "did you know?" popups** — If it's not directly relevant to the current task, don't show it. Serendipitous discovery happens through search, not interruption.

4. **Complex filtering UIs** — The omnibar with typed filters is enough. Don't build a SQL query builder for context search.

5. **Analytics dashboards** — "You spent 47 hours this month" type metrics. This isn't a time tracker. Token usage and session counts are already in the sidebar metadata.

6. **Automated memory writing** — The system should never write to memory.md without the user explicitly asking. Memory is the user's curated knowledge, not an auto-generated dump.

---

## Part 9: Phased Rollout

### Phase 1: Foundation (Backend Indexing + Omnibar)
- Implement embedding-based indexing of memory files and session summaries
- Build the ⌘K omnibar with basic search
- Modify EmptyState to show recent sessions instead of generic suggestions
- **This alone is a game-changer** — just being able to search across all sessions

### Phase 2: In-Chat Recall (/recall commands + context injection)
- Implement /recall temporal, /recall topic, /recall decision
- Build the RecallResults renderer
- Build context injection messages
- Wire recall into the chat as a first-class message type

### Phase 3: Proactive Intelligence (Whispers + Preambles)
- Session preamble generation on session start/resume
- Context whispers based on semantic similarity to current conversation
- Decision conflict detection
- Cross-profile relevance (opt-in)

### Phase 4: Dashboard & Visualization
- Full dashboard home with timeline
- Knowledge map
- Session-level AI summaries
- Channel metadata visualization

### Phase 5: Multi-Channel Polish
- Telegram-native recall commands
- Slack-native recall commands
- Channel-aware context in preambles
- Unified search across channels

---

## The North Star

The ultimate test: **Can you pick up any project after a two-week vacation and be productive within 5 minutes?**

Today, that requires re-reading memory files, scrolling through old sessions, and hoping you remember which conversation had the important decision. With this system, you open Middleman, see what happened, search for what you need, and the manager already has the context it needs. You're back up to speed before you finish your coffee.

That's the product. That's what makes someone say *"I could never go back."*
