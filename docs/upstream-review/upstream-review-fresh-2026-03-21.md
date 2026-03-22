# Fresh Upstream Review — 2026-03-21

**Reviewer:** upstream-review-fresh worker  
**Our main:** `80711d1`  
**Upstream:** `SawyerHood/middleman` at `f7208ce`  
**Total upstream commits since our fork point:** 347 (209 non-merge)  
**Previously cataloged:** ~183 commits in `.internal/upstream-review/UPSTREAM_CHANGES_MASTER.md`  
**New commits since last review (post-`f4d54c6`):** 156 (87 non-merge)

---

## 1. Summary

The upstream codebase has undergone **radical architectural restructuring** since our last review cycle. The 87 new non-merge commits fall into these high-level themes:

| Theme | Count | Impact on Our Fork |
|-------|-------|--------------------|
| **swarmd/SQLite migration + follow-ups** | ~12 | 🔴 Massive divergence — makes future cherry-picking nearly impossible |
| **Hono HTTP migration** | 1 | 🔴 All HTTP route handlers rewritten — no more shared code surface |
| **Jotai state migration** | 2 | 🔴 Frontend state management completely different |
| **Integrations removal** | 1 | 🔴 Upstream dropped Slack/Telegram — we need these |
| **Chat history pagination** | 1 | 🟡 High-value feature, but built on swarmd APIs we don't have |
| **WS event batching** | 1 | 🟢 Portable performance optimization |
| **Per-agent stop button** | 1 | 🟢 We have `stop_session` — this adds UI + completion-report suppression |
| **Thinking level support** | 1 | 🟢 We already have `reasoningLevel` — this is the upstream equivalent |
| **Collapsible chatter** | 1 | 🟢 Good UX improvement, relatively portable |
| **Image lightbox** | 1 | 🟢 We have `ContentZoomDialog` — this extends it to attachments |
| **Open-in dropdown for artifacts** | 1 | 🟡 We already have editor preference — this adds Obsidian/Notes detection |
| **Manager model switching** | 2 | ⚪ Added then immediately reverted — skip |
| **Archetype IDs in prompt** | 1 | 🟢 Small, valuable prompt improvement |
| **Bug fixes** | ~15 | Mixed applicability — many are swarmd-specific |
| **Tech debt / chore / formatting** | ~25 | Mostly not applicable (different codebase now) |
| **Dependency upgrades** | ~5 | SDK bumps we need to evaluate independently |
| **Notes-related fixes** | ~8 | We already adopted Notes — some fixes may be relevant |
| **E2E test infrastructure** | 1 | Interesting but built on swarmd scripted adapter |
| **Mobile fixes** | 3 | Potentially portable UI fixes |
| **npm packaging/release** | 3 | Not applicable to our deployment model |

**Key takeaway:** The upstream fork has diverged so fundamentally (SQLite persistence, Hono HTTP, Jotai state, integrations dropped) that **cherry-picking individual commits is no longer viable as a general strategy**. Future upstream adoption must be concept-level porting, not commit-level.

---

## 2. Major Architectural Changes

### 2.1 swarmd/SQLite Migration (`07af6a6` + ~10 follow-ups)

**What happened:** Upstream replaced the entire JSONL/in-process runtime stack with an embedded SQLite-based `swarmd` package (`packages/swarmd/`). This is a **ground-up rewrite** of the persistence and runtime layers:

- **Deleted:** `agent-runtime.ts`, `codex-agent-runtime.ts`, `claude-code-runtime.ts`, `runtime-factory.ts`, `runtime-types.ts`, `runtime-utils.ts`, `conversation-projector.ts`, `persistence-service.ts`, `conversation-history-cache.ts`, `session-custom-entry-persistence.ts`, `codex-jsonrpc-client.ts`, `codex-tool-bridge.ts`, `claude-code-tool-bridge.ts`, `agent-state-machine.ts`, `message-utils.ts`
- **Added:** `packages/swarmd/` with SQLite store, event bus, supervisor, session service, message store/capture, recovery manager, and per-provider runtime adapters (Pi, Codex, Claude)
- **SwarmManager** went from 8000+ LOC to ~1460 LOC, split into coordinator + lifecycle + transcript + runtime-context + SQL modules
- **Escalations removed** (they had just been added in the previous batch)
- **Archived session support** (kill_agent archives instead of deletes)
- **Lazy resurrection** on restart (agents start as stopped, activate on first message)
- **Real context usage tracking** persisted in SQLite

**Impact on us:** 🔴 **Catastrophic divergence.** We retain the entire JSONL/in-process stack. Our swarm-manager.ts is 8011 lines built on our own multi-session + profile architecture. The files upstream deleted are files we actively maintain and extend. There is **zero path to adopting swarmd** without rewriting our entire backend, and doing so would lose our multi-session, profile-scoped, Cortex, feedback, and Playwright integrations.

**Recommendation:** **Do not adopt.** Treat upstream's backend as a different project from this point. Selectively port *concepts* (like archived sessions, lazy resurrection) but not code.

### 2.2 Hono HTTP Migration (`4f01bac`)

**What happened:** All backend HTTP route handlers migrated from raw Node.js `http.IncomingMessage`/`http.ServerResponse` to Hono framework. 14 files changed, ~3600 lines modified.

**Impact on us:** 🔴 **Complete route handler divergence.** Our HTTP routes still use raw Node.js patterns. Every route file is now incompatible.

**Recommendation:** **Skip.** We could independently evaluate Hono as a migration target, but adopting the upstream code as-is is impossible. If we want Hono, it's a separate project.

### 2.3 Jotai State Migration (`3bb2ad3`, `685fc8d`)

**What happened:** Frontend state management migrated from prop-drilling/hooks to Jotai atoms. `ws-state.ts` grew from a helper file to the central state atom store. 17 files changed, ~2000 lines modified. Follow-up moved `atomFamily` to `jotai-family` package.

**Impact on us:** 🔴 **Frontend state completely different.** Our UI still uses prop-based state management. Any upstream UI component that uses Jotai atoms won't work in our app without adaptation.

**Recommendation:** **Skip as a migration.** Could independently evaluate Jotai if we want to modernize our state management, but adopting upstream's specific atom structure is not feasible.

### 2.4 Integrations Removal (`cd99e78`)

**What happened:** Upstream **removed all Slack/Telegram integration code** — 7,719 lines deleted across 68 files. All integration services, config persistence, message delivery, routing, polling, and settings UI deleted. Voice transcription also removed.

**Impact on us:** 🔴 **We need integrations.** This is a permanent fork divergence point. We maintain Slack and Telegram integrations as core features.

**Recommendation:** **Ignore.** We keep our integrations. Note that this means any upstream code that was integration-aware is now integration-unaware, so future upstream UI/protocol work won't account for integration message routing.

---

## 3. Recommended Adoptions

### Priority 1: High Value, Portable

#### 3.1 WS Event Batching (`ade9b49`) — **ADOPT**
- **Category:** Performance
- **What:** Client-side batching of WebSocket events using `requestAnimationFrame`. Multiple rapid WS events are collected and flushed as a single state update per frame instead of triggering individual re-renders.
- **Backend change:** Removes redundant `emitAgentsSnapshot()` calls on every status change — only emits status events for live updates.
- **Value:** High — reduces re-render thrashing during heavy agent activity
- **Conflicts:** Medium — our `ws-client.ts` is diverged but the batching pattern (queue + rAF flush) is self-contained and can be ported conceptually
- **Effort:** Medium — need to adapt to our state management approach

#### 3.2 Collapsible Internal Chatter (`0d91c03`) — **ADOPT**
- **Category:** Feature / UX
- **What:** Agent-to-agent messages (internal chatter) are collapsed by default with an expand toggle. Shows delivery mode labels. Uses `isInternalAgentMessage()` classification.
- **Value:** High — reduces noise in busy multi-agent conversations
- **Conflicts:** Low-Medium — we don't have `agent-message-utils.ts` yet, but the concept maps cleanly to our `AgentMessageRow`
- **Effort:** Quick — conceptual port of the collapse logic and UI

#### 3.3 Archetype IDs Injected into Manager Prompts (`324b332`) — **ADOPT**
- **Category:** Feature
- **What:** Manager system prompt gets an appended line listing available archetype IDs. `spawn_agent` tool also gets archetype list. Helps managers know what archetypes exist when spawning workers.
- **Value:** High — directly improves agent spawning decisions
- **Conflicts:** Low — we have our own archetype registry; need to wire `listArchetypeIds()` into prompt resolution
- **Effort:** Quick

#### 3.4 Worker Completion Report: Remove Truncation Limit (`690edf4`) — **ADOPT**
- **Category:** Bug fix
- **What:** Removes the 1,000-char truncation limit on worker completion reports. Full report text is now sent to the manager.
- **Value:** High — truncated reports lose critical context, especially for analysis workers
- **Conflicts:** None — direct applicability if we have the same truncation (need to check)
- **Effort:** Quick

#### 3.5 Worker Completion Report: Role Recovery (`266cc6a`) — **ADOPT**
- **Category:** Bug fix  
- **What:** Fixes `message.completed` events from Codex/Claude runtimes that omit the `role` field. Falls back to looking up the role from the stored message by `sourceMessageId`.
- **Value:** Medium — prevents blank/broken completion reports from non-Pi runtimes
- **Conflicts:** Low — needs adaptation for our runtime's message storage model (JSONL-based vs SQLite)
- **Effort:** Medium

#### 3.6 `list_agents` Default Includes Stopped Agents (`a23ada7`) — **ADOPT**
- **Category:** Bug fix
- **What:** `list_agents` now includes `stopping` and `stopped` agents in default results (without needing `includeTerminated`). Only `errored` and `terminated` remain opt-in.
- **Value:** High — managers need to see stopped workers to understand team state
- **Conflicts:** Low — our `swarm-tools.ts` has the same `ACTIVE_AGENT_STATUSES` set pattern
- **Effort:** Quick — add `"stopping"`, `"stopped"` to the active set

#### 3.7 Per-Agent Stop Button (`faa893d`) — **ADOPT**
- **Category:** Feature
- **What:** Adds `interrupt_agent` WS command and `interrupt_agent_result` response. UI shows a stop button in the message input area when viewing a busy agent. Includes worker completion report suppression for manually stopped agents.
- **Value:** High — we already have `stop_session` backend support; this adds the user-facing UI and proper completion report suppression
- **Conflicts:** Medium — our WS protocol and UI are diverged, but the concept is straightforward
- **Effort:** Medium

#### 3.8 Broken-Pipe LineWriter Guard (`59f01d3`) — **EVALUATE**
- **Category:** Bug fix
- **What:** Hardens the worker-process `LineWriter` (stdout IPC) against EPIPE, ERR_STREAM_DESTROYED, and ERR_STREAM_WRITE_AFTER_END errors. Adds `#closed` tracking and error handlers.
- **Value:** Medium — prevents crashes when worker processes terminate unexpectedly
- **Conflicts:** N/A — this is in `packages/swarmd/` which we don't have. But the **concept** applies to our Codex JSONRPC client's stdin/stdout handling.
- **Effort:** Medium — need to apply similar guards to our own `codex-jsonrpc-client.ts`

### Priority 2: Good Value, More Effort

#### 3.9 Image Lightbox for Attachments (`fa97549`) — **ADOPT**
- **Category:** Feature / UI
- **What:** Extends the existing `ContentZoomDialog` to support image lightbox previews from message attachments and inline markdown images. Clicking images opens a zoom dialog.
- **Value:** Medium — nice UX improvement for image-heavy conversations
- **Conflicts:** Low — we already have `ContentZoomDialog`; this wires it into `MessageAttachments` and `MarkdownMessage`
- **Effort:** Quick-Medium

#### 3.10 Smart Reload on Build Mismatch (`3f2542f`) — **ADOPT**
- **Category:** Feature
- **What:** Backend sends `buildHash` (git rev or env override) in `ready` events. Client compares against its own build hash. Only triggers page reload when hashes mismatch, instead of reloading on every reconnect.
- **Value:** Medium — prevents unnecessary page reloads during WS reconnections
- **Conflicts:** Low — adds `BUILD_HASH` to backend config and `buildHash` field to ready event
- **Effort:** Quick

#### 3.11 Chat History Pagination (`d50c470`) — **CONCEPT PORT**
- **Category:** Feature
- **What:** Adds cursor-based pagination for conversation history (`getConversationHistoryPage` with `before` cursor + `limit`). WS command `get_conversation_page`. UI loads older messages on scroll-to-top. 16 files, ~6400 lines changed.
- **Value:** High — essential for long conversations
- **Conflicts:** High — built entirely on swarmd's `messageStore` and their Jotai state management. Cannot cherry-pick.
- **Effort:** Large — need to implement pagination against our JSONL/projector stack
- **Recommendation:** Port the concept and protocol shape, implement against our own backend

#### 3.12 Open-In Dropdown for Artifacts (`57e7ac6`) — **EVALUATE**
- **Category:** Feature
- **What:** ArtifactPanel gets a dropdown menu with options to open files in Notes editor, Obsidian (if vault detected), or external editor. Backend provides `resolveFileEditorTargets()` API.
- **Value:** Low-Medium — we already have editor preference (VS Code/Cursor). Obsidian detection is nice but niche.
- **Conflicts:** Medium — depends on Notes integration and upstream's specific routing
- **Effort:** Medium
- **Note:** We already have `EDITOR_LABELS`, `EDITOR_URL_SCHEMES`, `readStoredEditorPreference()` in `editor-preference.ts`. The upstream approach adds server-side editor detection which is more sophisticated.

#### 3.13 Context Usage Tracking and Clearing (`0913575`) — **EVALUATE**
- **Category:** Bug fix
- **What:** Fixes context usage tracking to properly clear between sessions and track across runtime adapters. UI properly resets context usage display on agent switch.
- **Value:** Medium — prevents stale context usage display
- **Conflicts:** High — implementation is swarmd-specific (session service, adapter-level tracking)
- **Effort:** Medium — concept applies but implementation must be our own

#### 3.14 Manager Internal Message History Replay (`c4f5da2`) — **EVALUATE**
- **Category:** Feature
- **What:** Adds "View Internals" toggle in chat header. When enabled, shows agent-to-agent messages and tool calls in the manager transcript. Persists preference per agent.
- **Value:** Medium-High — useful for debugging agent behavior
- **Conflicts:** Medium — we have similar "All" view concept; this is a refined per-agent toggle
- **Effort:** Medium

#### 3.15 Multimodal Image Upload Preservation (`bcc5cc3`) — **ADOPT**
- **Category:** Feature
- **What:** Image attachments in user messages are properly preserved as content parts for multimodal model prompts. Previously images might be dropped during content assembly.
- **Value:** Medium — enables reliable image-based prompting
- **Conflicts:** Medium — our content assembly pipeline differs
- **Effort:** Medium

#### 3.16 Local File Image URL Rewriting (`7888354`) — **ADOPT**
- **Category:** Feature
- **What:** Markdown images referencing local file paths are rewritten to use the `/api/read-file` endpoint, making them renderable in the browser.
- **Value:** Medium — fixes broken images in agent-generated markdown
- **Conflicts:** Low — self-contained UI utility (`read-file-url.ts`)
- **Effort:** Quick

### Priority 3: Notes-Related Fixes (if applicable)

We adopted Notes in Wave 3. Some of these fixes may be relevant:

#### 3.17 Prevent Duplicate Nested Notes Bullets (`e0837ee`) — **CHECK**
- Fixes note rendering regression with nested list items

#### 3.18 Notes Code Styling Alignment (`2835eb9`) — **CHECK**
- Aligns code block styling in notes editor with chat rendering

#### 3.19 Notes Tab Indent and Undo (`74b7d4c`) — **CHECK**
- Adds Tab/Shift-Tab indent support and proper undo in notes editor

#### 3.20 Notes Checkbox Editing Improvement (`768d2c5`) — **CHECK**
- Better checkbox toggle behavior in notes

#### 3.21 Notes Search Palette Rewrite (`783ec20`) — **CHECK**
- Rewrites notes command palette using cmdk library

#### 3.22 Notes Folder Collapse State Persistence (`29b312a`) — **CHECK**
- Persists folder expand/collapse state

#### 3.23 Notes Toolbar Polish (`383c90b`) — **CHECK**
- Visual refinements to the floating toolbar

#### 3.24 Notes Sidebar Scrollable (`caf7d6b`) — **CHECK**
- Makes notes sidebar tree scrollable when content overflows

---

## 4. Skip / Not Applicable

### 4.1 Manager Model Switching (`597b30a` + `4d027b6`) — **SKIP**
- Added then immediately reverted. Upstream decided against it.

### 4.2 React Virtuoso (added `c250982`, removed `9975f3f`) — **SKIP**
- Added virtualization then removed it. Net zero. The intermediary fixes (`4a85ec5`, `0781800`, `1c15236`, `e4053b4`) are also moot.

### 4.3 Hono Migration (`4f01bac`) — **SKIP**
- Incompatible with our HTTP stack. See Section 2.2.

### 4.4 Jotai Migration (`3bb2ad3`, `685fc8d`) — **SKIP**
- Incompatible with our state management. See Section 2.3.

### 4.5 Integrations Removal (`cd99e78`) — **SKIP**
- We need integrations. See Section 2.4.

### 4.6 swarmd/SQLite Migration + All Follow-ups — **SKIP**
- `07af6a6` (core migration), `976c9d7` (CI build fix), `cba8da8` (test data cleanup), `e1f4d56` (swarmd tech debt), `d38cb6c` (March 20 tech debt), `3c04823` (backend tech debt) — all swarmd-specific.

### 4.7 Tech Debt Cleanups (`e7b1e39`, `a2204da`, `3c04823`, `d38cb6c`) — **SKIP**
- These clean up code that our fork doesn't share. The swarmd-specific changes are irrelevant. Some UI tech debt cleanup in `a2204da` removes patterns we still use.

### 4.8 Prettier Formatting (`8854632`) — **SKIP**
- 230 files reformatted. We have our own formatting conventions.

### 4.9 Pi Model Restriction for Managers (`bc2552c`) — **SKIP**
- We already have our own manager preset filtering and our preset list is different.

### 4.10 npm Release Workflow (`d890a64`, `169fabb`) — **SKIP**
- Our deployment model is different. Not publishing to npm.

### 4.11 MIDDLEMAN_HOST Vite Fix (`5f6a7b7`) — **SKIP**
- We handle `FORGE_HOST` / `MIDDLEMAN_HOST` differently in our dev scripts.

### 4.12 Stale Protocol JS Artifacts (`abd6dd9`) — **SKIP**
- .gitignore cleanup specific to their build output structure.

### 4.13 Remove Stale Escalation Migration (`2e95cfe`) — **SKIP**
- We never had escalations.

### 4.14 E2E Test Infrastructure (`2a3ef9a`) — **SKIP (for now)**
- Interesting concept but built on swarmd's `ScriptedBackendAdapter` which we don't have. The pattern of scripted test backends is worth studying separately.

### 4.15 Session Model Descriptor (`05d171e`) — **SKIP**
- swarmd-specific utility for resolving model descriptors from `SessionRecord`.

### 4.16 Worker Detail Messages in Transcript (`1c66e6e`) — **SKIP**
- swarmd-specific fix for projecting worker messages with `agentIdOverride`.

### 4.17 Prefix Unused Key Params (`981f0c6`) — **SKIP**
- Trivial lint fix in Jotai-specific code.

### 4.18 Docs Cleanup (`b47ee8b`) — **SKIP**
- Upstream docs reorganization. Not applicable.

### 4.19 AGENTS.md Updates (`49d0a81`, `e01e7e6`) — **SKIP**
- Upstream-specific documentation changes.

### 4.20 Format Swarm Manager (`f7208ce`) — **SKIP**
- Trivial whitespace cleanup of 4 lines.

---

## 5. Deferred for Later

### 5.1 Thinking Level as `thinkingLevel` (`9a1d182`)
- **What:** Adds `thinkingLevel` parameter to `spawn_agent` tool (off|low|medium|high|xhigh).
- **We have:** `reasoningLevel` which serves the same purpose.
- **Action:** Evaluate naming alignment. Upstream uses `thinkingLevel` to match Anthropic naming. Our `reasoningLevel` predates this. Consider whether to standardize.
- **Also adds:** `AGENT_THINKING_LEVELS` to protocol, `parseSwarmThinkingLevel`, and passes through to `resolveModelDescriptorFromPreset`.

### 5.2 Agent SDK Upgrades (`4600c05`, `556a053`, `e9bf943`)
- Pi packages bumped to 0.58.4, Claude Agent SDK to 0.2.77
- **Action:** We should evaluate these SDK bumps independently. The Claude SDK upgrade (`e9bf943`) adds new adapter changes for the swarmd Claude adapter that we don't use, but the SDK version itself may have useful fixes.

### 5.3 Loading State During Agent Switch (`92a65ff`)
- Shows a loading indicator while switching between agents in the UI.
- Low priority but nice UX polish. Deferred because it's built on Jotai atoms.

### 5.4 Schedules Panel UI Polish (`a0e2cdd`)
- 248 lines changed in `ArtifactsSidebar.tsx`. Visual improvements to schedule display.
- Worth reviewing if we're doing a schedules UI pass.

### 5.5 Mobile Layout Fixes (`150ffe2`, `8fa3240`, `655ae54`, `c736801`)
- Safe-area layout, viewport restore after submit, full-screen artifact panel on mobile, notes explorer mobile adaptation.
- Potentially valuable for mobile web experience, but built on diverged UI components.

### 5.6 Agent Switch Flicker Fix (`c112d7a`)
- Prevents flicker when switching between agents in the chat view.
- Jotai-specific implementation, but the concept may apply.

### 5.7 Live Message Flicker Fix (`503a263`)
- Prevents flicker on live streaming messages.
- Small fix, worth checking if we have the same issue.

### 5.8 Claude Code Auth Mapping and Error Reporting (`51a9ee9`)
- Maps Claude Code auth errors and surfaces worker errors to transcript.
- swarmd-specific but the error reporting pattern is worth studying.

### 5.9 Stop Button Muted Color (`9463e5d`)
- Uses muted secondary color for stop button instead of bright color.
- Trivial UI polish, applicable if we adopt per-agent stop.

### 5.10 Checklist Shortcuts in List Items (`006e326`)
- Keyboard shortcuts for creating/toggling checklists in notes.

### 5.11 Sidebar Live Indicator Removal (`e510a42`)
- Removes live indicator from sidebar header.

### 5.12 Ordered List Gutter Width (`684839c`)
- Widens gutter for double-digit list numbers in markdown rendering.
- Small CSS fix, potentially applicable.

---

## 6. Risk Notes

### 6.1 🔴 Fork Divergence is Now Permanent and Structural

The swarmd/SQLite migration, Hono migration, and Jotai migration together mean that **upstream and our fork share almost no code in common anymore** beyond the protocol package (which has also diverged). Future upstream changes will be written against their new architecture and will require concept-level porting, not commit-level cherry-picking.

**Quantifying the divergence:**
- Backend: ~15 files we maintain have been **deleted** upstream. Their swarm-manager is 1,463 LOC; ours is 8,011 LOC.
- HTTP routes: All rewritten for Hono — zero shared handler code.
- Frontend state: All rewritten for Jotai — zero shared state management code.
- Persistence: They use SQLite; we use JSONL. Completely different data access patterns.

### 6.2 🟡 Upstream Dropped Escalations (After Adding Them)

Escalations were added in the previous batch (Wave 3 in our catalog) and **removed** in the swarmd migration (`07af6a6`). If we were considering adopting escalations, upstream no longer maintains them.

### 6.3 🟡 Upstream Integrations Dead

With integrations removed, upstream won't be maintaining or fixing integration-related code paths. Any integration bugs or features are now entirely our responsibility.

### 6.4 🟢 Protocol Package Still Partially Shared

The `packages/protocol/` types are still somewhat aligned, though upstream has added/removed types (e.g., added `AGENT_THINKING_LEVELS`, removed integration-related events). We should keep our protocol package as the source of truth and selectively adopt upstream type additions that we want.

### 6.5 🟢 Notes Still Shared

Both forks have the Notes feature. Notes-specific fixes from upstream are likely applicable since the Lexical editor, storage format, and basic API shape are similar.

### 6.6 🟡 SDK Version Drift

Upstream is now on Pi packages 0.58.4 and Claude Agent SDK 0.2.77. We need to track these bumps but can't blindly adopt them — the SDK changes may include APIs that our fork doesn't use or that conflict with our runtime architecture.

---

## 7. Adoption Priority Matrix

| # | Change | Value | Effort | Recommendation |
|---|--------|-------|--------|----------------|
| 3.1 | WS event batching | High | Medium | **Wave 1** |
| 3.2 | Collapsible chatter | High | Quick | **Wave 1** |
| 3.3 | Archetype IDs in prompt | High | Quick | **Wave 1** |
| 3.4 | Remove completion report truncation | High | Quick | **Wave 1** |
| 3.5 | Completion report role recovery | Medium | Medium | **Wave 1** |
| 3.6 | list_agents includes stopped | High | Quick | **Wave 1** |
| 3.7 | Per-agent stop button | High | Medium | **Wave 1** |
| 3.8 | LineWriter broken-pipe guard | Medium | Medium | **Wave 2** |
| 3.9 | Image lightbox for attachments | Medium | Quick | **Wave 2** |
| 3.10 | Smart reload on build mismatch | Medium | Quick | **Wave 2** |
| 3.11 | Chat history pagination | High | Large | **Wave 2 (concept port)** |
| 3.15 | Multimodal image preservation | Medium | Medium | **Wave 2** |
| 3.16 | Local file image URL rewriting | Medium | Quick | **Wave 2** |
| 3.14 | Internal message history replay | Medium-High | Medium | **Wave 3** |
| 3.17-24 | Notes fixes (batch) | Medium | Quick each | **Wave 2** |

**Estimated waves:**
- **Wave 1 (quick wins):** Items 3.1–3.7 — ~1 worktree branch, focused on portable improvements
- **Wave 2 (medium effort):** Items 3.8–3.16 + notes fixes — ~1 worktree branch
- **Wave 3 (concept ports):** Chat history pagination, internal message replay — need design work first
