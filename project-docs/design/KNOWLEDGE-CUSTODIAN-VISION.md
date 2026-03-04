# Knowledge Custodian Vision — Post-Recall Conversation Summary

**Date:** 2026-03-03  
**Session:** middleman-project--s5 (qmd)  
**Status:** Vision/direction captured pre-compaction for continuity

---

## What We Built (Context & Recall System)

### Implementation Complete
- Full BM25 search index over conversation history (MiniSearch, in-process)
- Canonical JSONL parser, watermark-based incremental indexing, atomic persistence
- ⌘K Omnibar UI, `/recall` slash command, `recall_search` agent tool
- Privacy-safe WS routing, memory file watching, redaction at index time
- System prompt updates teaching agents about recall
- 48 files, +6,124 lines, 240 tests, validated against 3.5GB real data
- Worktree: `/Users/adam/repos/middleman-recall` (branch `feat/context-recall`)
- Isolated test env: `~/.middleman-recall-test`, backend on port 47387, UI on 47388

### Key Artifacts
- Final plan: `/tmp/recall-implementation-plan-FINAL-v2.md`
- Test plan: `/tmp/recall-test-plan.md`
- Reviews: `/tmp/recall-review-opus.md`, `/tmp/recall-review-codex.md`

### Pipeline We Followed
Full Track 3: brainstorm (3 Opus workers) → synthesize → draft plan (Opus) → review plan (Codex) → reality check (Codex) → implement (2 Codex backend + 1 Opus frontend) → dual code review (Opus + Codex) → remediation (Codex) → real-data validation (Codex)

---

## The Honest Assessment

### What recall does well
- Search infrastructure is solid — fast (p50 11ms), reliable, handles edge cases
- Agent tool works — when agents use it, they get useful results
- Compaction boundary crossing is genuine capability gap filled
- Memory file watching, corruption recovery, watermark reconciliation all work

### Where it falls short of the real goal
Adam's actual need isn't search — it's a **co-pilot that already knows things without being asked**. The difference:

- **Search** = agent realizes it doesn't know → decides to search → formulates query → interprets results
- **Knowledge** = agent already has it in context, acts on it naturally

The recall system requires agents to *decide* to use it. In real testing, an agent in a live conversation **chose not to use recall** because:
1. The memory file was rich enough for the task at hand
2. It didn't have confidence in what recall would return vs. filesystem tools it already trusts
3. The question was forward-looking, and prompt guidance was too narrowly framed around backward-looking retrieval

### Recall's place in the ecosystem
Recall is **supporting infrastructure, not the headline feature**. It's piece #3 or #4, useful for:
- Finding specific past decisions across sessions
- Bootstrapping new sessions with prior context
- Agent recovery after compaction when memory file is insufficient

But it's not what makes agents feel like a real co-pilot.

---

## Adam's Vision: The Knowledge Custodian Agent

### The core idea
**A dedicated agent whose sole purpose is keeping memory and knowledge current** — not leaving it to the working agents who are focused on tasks.

### How Adam described it
- A new level/type of agent in the system
- Dedicated prompt, solely tasked with reviewing conversations
- Extracts patterns about how to work together, preferences, approaches
- Has its own memory files and working notes
- Can chat with Adam to bounce ideas and refine understanding
- **Always constantly injecting the right things into the core memory files** that get loaded into other agents
- Creates a "massive brain" feel — collective intelligence that grows automatically

### Key design principles (from the conversation)
1. **Working agents still have memory capabilities** — Custodian supplements, doesn't replace
2. **Custodian reviews conversations after the fact** — not blocking real-time work
3. **Custodian can interact with Adam** — it's not just a background process, it can ask clarifying questions
4. **Output goes into core memory files** — the same files already loaded into agent context
5. **Focus on relationship knowledge** — how Adam works, preferences, patterns, feedback themes — not just task facts

### What this solves that recall doesn't
- **Auto-growing memory** — patterns extracted from experience, not just manually curated facts
- **Relationship context** — "Adam pushed back on whispers because he values concrete value over speculative features"
- **Working style knowledge** — what kinds of tasks get delegated vs. collaborated on, what feedback patterns emerge
- **Always-in-context** — knowledge goes into memory files that are always loaded, no search required

---

## Where This Connects to Existing Design

### Memory Custodian was already in the multi-session design
From the session memory, the multi-session design doc (`MULTI_SESSION_DESIGN_FINAL.md`) already included a "Memory Custodian" as Phase 7:
- Cron-scheduled manager that scans for unmerged session memory
- Consolidates session-scoped memory into profile core memory
- Was conceived as a maintenance task, not a relationship intelligence agent

### This vision is much bigger
Adam's vision goes beyond merge maintenance:
- Active conversation review and pattern extraction
- Relationship modeling (not just fact consolidation)  
- Interactive refinement with the user
- Continuous injection into working agent context
- Own working notes and evolving understanding

### Recall infrastructure supports it
The BM25 index, session parsers, and memory watchers we just built are useful foundation for the Custodian:
- Custodian can use recall to search across sessions when reviewing
- Memory file watchers already detect changes the Custodian writes
- Canonical parsers can feed conversation data to the Custodian for analysis

---

## Recommended Next Steps

1. **Design the Knowledge Custodian** — new dedicated design process
   - What triggers Custodian runs (cron? session completion? user request?)
   - What it reads (completed session transcripts, memory files, agent registry)
   - What it writes (profile memory updates, working notes, pattern files)
   - How it interacts with Adam (own chat session? proactive messages?)
   - How its outputs get into working agent context

2. **Recall system status** — implementation is complete in worktree, not yet merged
   - Can merge as supporting infrastructure
   - Or hold until Custodian design clarifies how recall fits
   - Omnibar UX needs polish regardless (results display is "wall of text")

3. **Prompt strengthening** — regardless of Custodian, the recall tool prompt guidance should be a triage step, not a soft nudge

4. **Don't lose the good parts** — the indexing infrastructure, parsers, memory watchers, and search are real building blocks. They just shouldn't be marketed as the main feature.

---

## Open Questions for Next Conversation
- Should Custodian be a new manager profile, a special agent type, or a cron-scheduled worker?
- What's the interaction model — does Adam chat with it in a dedicated session?
- How does it avoid overwriting curated memory that Adam intentionally wrote?
- Should it have read-only access to all profiles, or scoped to one?
- What's the MVP — start with post-session memory consolidation, or go straight to pattern extraction?
