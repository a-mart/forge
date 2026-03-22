# Deferred Upstream Items — Tracking Document

**Purpose:** Single artifact tracking upstream features and changes we've evaluated but deferred for later consideration.

**Last updated:** 2026-03-21

---

## Deferred Features

### Claude Code Runtime
- **Status:** Investigated, recommended ADOPT but deferred by user decision
- **What:** Third agent runtime provider using `@anthropic-ai/claude-agent-sdk`, bypasses Pi intermediary, MCP tool bridge for swarm tools
- **Why deferred:** Current Claude models work fine through Pi. No urgent need. SDK is 0.2.x pre-release.
- **Effort if adopted:** ~6 hours (mechanical adaptations)
- **Analysis:** [wave3-claude-runtime-analysis.md](wave3-claude-runtime-analysis.md)
- **Revisit when:** Anthropic ships SDK-only features we need, or Pi intermediary becomes a bottleneck

### Notes Feature
- **Status:** Fully implemented, reviewed, tested, then reverted from main
- **What:** Profile-scoped markdown notes with Lexical WYSIWYG editor, folders, image attachments, REST API
- **Why deferred:** Unclear value in our multi-session architecture. Agent-written notes lack organization metadata and become a "junk drawer" after compaction. Working directory and memory already cover the main use cases.
- **Effort if adopted:** Code exists in git history, needs SSR lazy-loading fix applied
- **Key issue:** Production SSR crash from `@lexical/code` requiring PrismJS — fixed via `React.lazy()` but needs the fix commit
- **Revisit when:** Clear use case emerges that memory + working directory don't cover

### Worker Detail Subscription (Task 3.4)
- **Status:** Evaluated, skipped by user decision
- **What:** On-demand inspection of individual worker conversations without switching primary subscription
- **Why deferred:** Not a priority right now
- **Upstream commits:** `c065381`, `5b209f9`

### Escalation System / Inbox (Task 3.1)
- **Status:** Under active investigation (2026-03-21)
- **What:** Structured agent-to-user notification system. Being evaluated for adaptation into a broader "inbox" concept.
- **Analysis:** [escalation-inbox-analysis.md](escalation-inbox-analysis.md) (in progress)

---

## Deferred Improvements

### Bootstrap History Overhaul (Task 2.1)
- **Status:** Explicitly DROPPED by user decision
- **What:** Progressive truncation for large conversation histories
- **Why dropped:** User wants current bootstrap behavior preserved

### Per-Agent Message Drafts (Task 2.7)
- **Status:** Skipped
- **What:** Jotai-based localStorage draft persistence per agent
- **Why skipped:** Low priority, adds Jotai dependency

### Sidebar Reordering (Task 3.5)
- **Status:** Skipped
- **What:** DnD-based manager/session reordering in sidebar
- **Why skipped:** Our sidebar structure (profiles → sessions → workers) is fundamentally different from upstream's flat manager list

### UI → Backend Consolidation
- **Status:** Discussed, tabled
- **What:** Have backend serve the built UI assets directly (single port, no SSR). Eliminates hardcoded port-detection logic that causes worktree data isolation issues.
- **Why tabled:** User wants to revisit later
- **Key context:** Production UI build has hardcoded port detection (port > 47188 → backend 47287). `VITE_MIDDLEMAN_WS_URL` only works in dev mode. Has caused data corruption in worktree testing.

---

## Completed Adoptions (for reference)

### Wave 1 (all complete)
- Atomic persistence race fix
- Chat submit auto-scroll
- Codex queued steer redelivery
- Schedule file cleanup on delete
- Merger prompt: always report back

### Wave 2 (selected items complete)
- Conversation history cache + render optimization
- Async filesystem hot-path fixes
- Dynamic streaming favicon
- Auto worker completion reporting
- Agent routing on delete fix

### Wave 3 Non-Features (all complete)
- Never-sleep prompt rule
- Cross-manager `includeManagers`
- Memory safety hardening
- Runtime status overhead reduction
- Reboot/control-PID lifecycle
