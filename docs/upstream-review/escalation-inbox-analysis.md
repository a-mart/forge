# Upstream Escalation System → Forge Inbox: Deep-Dive Analysis

> Read-only analysis — March 21, 2026
> Source: upstream `SawyerHood/middleman` commits `be983d1` through `07af6a6`
> Target: Forge fork inbox concept design

---

## 1. Upstream Escalation System — What It Is

The upstream escalation system was a **structured decision-request mechanism** that let manager agents formally ask the user for input, approvals, or blocker resolution. Rather than just talking in chat, managers created typed escalation objects with a title, description, and a set of predefined options. The user could select an option or write a custom response. The resolution was then delivered back to the manager as a formatted message.

**Core contract:** An escalation is a question/decision the agent cannot proceed without. It has a fixed set of options the agent proposes, plus a freeform custom-response path. The user must explicitly resolve it — or the manager can close it if conditions change.

**Key architectural properties:**
- Global storage (single `escalations.json` at data-dir root)
- Manager-scoped creation (only managers create escalations, scoped to their `managerId`)
- CLI-based agent interface (managers invoke `middleman escalation add/list/get/close` via bash)
- WebSocket real-time sync for UI state
- Conversation-stream integration (escalations appear inline in chat as interactive cards)
- Dedicated list view accessible from sidebar
- Pinned strip above chat input for open escalations

---

## 2. Evolution History — Tasks → Escalations → Removal

### Phase 1: User Tasks (`be983d1` — Mar 6, 10:30 AM)
**Concept:** Agents assign tasks to the user for follow-up work outside the swarm.

**Data model:**
```typescript
interface UserTask {
  id: string
  managerId: string
  title: string
  description?: string
  status: 'pending' | 'completed'
  createdAt: string
  completedAt?: string
  completionComment?: string
}
```

**Agent interface:** Tool-based (`assign_task`, `get_outstanding_tasks` tool calls from manager runtime). The system prompt told managers to use these tools "when progress depends on the user taking action outside the swarm."

**Storage:** `tasks.json` in data dir root. In-memory Map + JSON file with atomic write (write-to-tmp + rename).

**UI:** Dedicated `TaskView` with list/detail split, completion with optional comment.

### Phase 2: Task View Redesign + Editable Tasks (`87616c9` — Mar 6, 11:51 AM)
Added task comments, editing (title/description updates), and a Linear-inspired split-pane UI. Added `UserTaskComment` sub-objects with `id`, `body`, `createdAt`, `type`.

### Phase 3: CLI Migration (`d851f0d` — Mar 6, 12:37 PM)
**Pivotal change:** Replaced the tool-based interface with a CLI workflow. Removed `assign_task` and `get_outstanding_tasks` tools entirely. Instead, managers use `middleman task add/list/update/close` via bash. This was a deliberate design choice — CLI via bash is simpler, doesn't require special tool definitions, and works the same way from any runtime (Claude, Codex, etc.).

Also introduced `apps/cli/` as a standalone CLI package.

### Phase 4: Escalation Rework (`24b1e89` — Mar 6, 1:41 PM)
**The big pivot.** Tasks were reimagined as escalations — the core concept shifted from "user needs to do something" to "agent needs a decision from the user."

**Key changes:**
- `UserTask` → `UserEscalation`
- `pending/completed` → `open/resolved`
- Optional `description` → required `description` + required `options: string[]`
- Removed comments/editing — replaced with single `UserEscalationResponse { choice: string, isCustom: boolean }`
- `TaskStorage` → `EscalationStorage` (same architecture: JSON file, in-memory Map, atomic writes)
- `TaskView` → `EscalationView`
- All task tools removed; CLI became `middleman escalation add/list/get/close`
- Protocol events renamed: `task_*` → `escalation_*`

**Agent prompt instructions (from `manager.md`):**
> "When you need user input, a decision, approval, or help clearing a blocker, always open an escalation with the `middleman escalation` CLI via bash. This is mandatory and is the expected default, not a fallback."
>
> "Never just ask the user in conversation and wait for a reply when you need a decision, approval, or blocker resolution. Always open an escalation so it lands in the user's escalation queue."

### Phase 5: UI Polish (`0cda46c` — Mar 6, 1:46 PM)
Linear-style design polish:
- Amber dot + pill indicators for open count (sidebar + header)
- Radio-style option selection with check indicators
- "or" divider between predefined options and custom textarea
- Emerald check icon for resolved state
- Tighter spacing, consistent typography (13px body, 10px labels)
- 52px header height

### Phase 6: Chat & Artifact Integration (`218a70d` — Mar 6, 5:46 PM)
Major expansion — escalations now render inline in the chat stream AND in the artifacts panel:
- New `ConversationEscalationEvent` type added to conversation history
- `EscalationCard` component renders interactive escalation cards inline in chat
- Escalation card supports both `chat` and `panel` variants
- Artifact sidebar gains an "Escalations" tab alongside "Artifacts" and "Schedules"
- `ArtifactPanel` extended with `ArtifactPanelSelection` union type (artifact | escalation)
- Clicking an escalation in the pinned strip or sidebar opens it in the artifact panel

### Phase 7: Natural Language Close (`7312ce2` — Mar 9, 4:54 PM)
Added prompt instruction: "If the user answers an escalation's question in natural language conversation (instead of through the escalation UI), close the corresponding escalation with `middleman escalation close <id>` so it doesn't remain open."

### Phase 8: UI Copy Rework (`770cfbd` — Mar 9, 4:37 PM)
Tightened prompt language ("mandatory", "immediately") and minor UI label changes.

### Phase 9: Pinned Escalations Strip (`d737241` — Mar 9, 4:58 PM)
`PinnedEscalations` component: horizontal scrollable strip of open escalation buttons rendered above the chat input. Each shows an amber dot + truncated title. Clicking opens the escalation in the artifact panel. Only shows escalations belonging to the active manager.

### Phase 10: SQLite Migration & Removal (`07af6a6` — Mar 16, 8:44 AM)
The entire escalation feature was removed as part of a massive architecture overhaul (migration to embedded `swarmd` core with SQLite persistence). All escalation files deleted:
- `escalation-storage.ts`
- `escalation-routes.ts`
- `EscalationView.tsx`
- `EscalationCard.tsx`
- `PinnedEscalations.tsx`
- `EscalationMessageRow.tsx`
- All tests

### Phase 11: Stale Migration Cleanup (`2e95cfe` — Mar 17, 3:08 PM)
Removed a leftover SQL migration (`DROP TABLE IF EXISTS middleman_escalations`) that was no longer needed.

### Current State in Upstream
**Escalations are completely gone.** No escalation-related code exists on `upstream/main`. The feature was built and refined over ~3 days, then removed entirely during the swarmd-2 migration. The concept was never replaced with an alternative.

---

## 3. Data Model

### Final Escalation Schema (before removal)

```typescript
// Status
type UserEscalationStatus = 'open' | 'resolved'

// Resolution response
interface UserEscalationResponse {
  choice: string       // The text of the chosen option or custom response
  isCustom: boolean    // true if user wrote custom text, false if selected a predefined option
}

// Core entity
interface UserEscalation {
  id: string                          // UUID
  managerId: string                   // Creating manager's agentId
  title: string                       // Short question/decision title (required, non-empty)
  description: string                 // Detailed context (required, non-empty)
  options: string[]                   // Predefined answer options (≥1 required)
  status: UserEscalationStatus        // 'open' | 'resolved'
  response?: UserEscalationResponse   // Set on resolution
  createdAt: string                   // ISO timestamp
  resolvedAt?: string                 // ISO timestamp, set on resolution
}
```

### Storage Architecture

**File:** `<dataDir>/escalations.json`
```json
{
  "escalations": [
    { "id": "...", "managerId": "...", "title": "...", ... }
  ]
}
```

**In-memory:** `Map<string, UserEscalation>` in `EscalationStorage` class.

**Persistence pattern:** Atomic write — serialize to `.json.tmp`, then `rename()` over the target file. Same pattern used throughout the Forge codebase for safe JSON persistence.

**Scoping:** Global. All escalations from all managers stored in a single flat file. Filtering by manager done in-memory. No profile scoping (upstream has no profile concept).

### Protocol Events

| Event | Direction | Purpose |
|-------|-----------|---------|
| `escalations_snapshot` | Server → Client | Full list on connect or explicit request |
| `escalation_created` | Server → Client | Real-time push when agent creates |
| `escalation_updated` | Server → Client | Real-time push on resolution or close |
| `escalations_deleted` | Server → Client | Batch delete (on manager deletion) |
| `escalation_resolution_result` | Server → Client | Request-response for resolve command |
| `conversation_escalation` | Server → Client | Inline in conversation stream |

### Client Commands

| Command | Direction | Purpose |
|---------|-----------|---------|
| `get_all_escalations` | Client → Server | Fetch all escalations |
| `resolve_escalation` | Client → Server | User resolves with choice + isCustom |

### HTTP API (for CLI)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/escalations?managerId=...&status=...` | List by manager, filter by status |
| `POST` | `/api/escalations` | Create (body: `{managerId, title, description, options}`) |
| `GET` | `/api/escalations/:id?managerId=...` | Get single by ID |
| `PATCH` | `/api/escalations/:id` | Close/resolve (body: `{managerId, status: "resolved", comment?}`) |

---

## 4. Agent Interface

### CLI Commands (how agents create/manage escalations)

Agents interact with escalations exclusively via CLI (bash tool):

```bash
# Create an escalation with predefined options
middleman escalation add \
  --title "Which database should we use?" \
  --description "We need to choose a database. PostgreSQL is more mature, SQLite is simpler." \
  --options "PostgreSQL" "SQLite" "Let me think about it"

# List open escalations for this manager
middleman escalation list

# Get full details of a specific escalation
middleman escalation get <id>

# Close an escalation (manager-initiated, e.g., when resolved independently)
middleman escalation close <id> --comment "Resolved by choosing PostgreSQL based on requirements"
```

The CLI discovers the current manager's ID via `MIDDLEMAN_AGENT_ID` environment variable (set automatically by the runtime). API base URL is auto-detected or overridable.

### Prompt Instructions (from `manager.md` archetype)

The prompt strongly enforces escalation usage:

1. **Mandatory for decisions:** "When you need user input, a decision, approval, or help clearing a blocker, always open an escalation with the `middleman escalation` CLI via bash. This is mandatory."
2. **No ad-hoc asking:** "Never just ask the user in conversation and wait for a reply when you need a decision, approval, or blocker resolution."
3. **Options for choices:** "If you need the user to choose between options, open an escalation with explicit options."
4. **Immediate for blockers:** "If you are blocked and need approval to proceed, open an escalation immediately."
5. **Check before re-asking:** "Use `middleman escalation list` before re-asking the same question."
6. **Natural language close:** "If the user answers an escalation's question in natural language conversation (instead of through the escalation UI), close the corresponding escalation."

### Resolution Flow

When the user resolves an escalation (via UI or CLI), the backend:
1. Updates the escalation status to `resolved`
2. Records the response (`choice` + `isCustom`)
3. Sends a formatted message to the manager: `Escalation resolved: [<id>] — Question: "<title>" — Response: "<choice>"`
4. Emits `escalation_updated` event to all connected clients

This means the manager receives the user's decision as a regular chat message, so it can act on it immediately.

### Manager Close Flow

Managers can also close their own escalations via CLI when:
- The blocker was resolved independently
- The question became irrelevant
- The user answered in natural language conversation

This triggers the same update event but without sending a user message to the manager.

---

## 5. UI Patterns

### Sidebar Entry
- **Location:** Bottom section of the `AgentSidebar`, below the agent tree, above Settings
- **Icon:** `ListTodo` (lucide)
- **Label:** "Escalations"
- **Badge:** Amber pill with dot indicator showing open count (only when > 0)
- **Styling:** Amber color scheme (`bg-amber-500/10 text-amber-600`) for urgency
- **Selection state:** Active/inactive highlighting consistent with other sidebar entries

### Dedicated View (`EscalationView`)
- **Layout:** Full-width view replacing the chat area (same pattern as Settings)
- **Header:** "Escalations" with open count pill, back button
- **Content:** List of escalation cards sorted by status (open first) then recency
- **Empty state:** Clean "no escalations" message

### In-Chat Cards (`EscalationCard`)
- **Inline rendering:** Escalations appear in the conversation stream at the point they were created
- **Two variants:** `chat` (compact, inline in message list) and `panel` (expanded, in artifact panel)
- **Interactive:** Users can select options or write custom responses directly from the card
- **State transitions:** Cards update in-place when resolved (show emerald resolved state)
- **Components:**
  - Status badge (amber "Open" / emerald "Resolved")
  - Title + description
  - Radio-style option buttons (when open)
  - Custom response textarea (when open)
  - "Send response" submit button
  - Resolution display (when resolved: green card with selected choice)

### Pinned Strip (`PinnedEscalations`)
- **Location:** Rendered above the chat input area (inside `MessageInput`)
- **Visibility:** Only shows when there are open escalations for the active manager
- **Content:** Horizontal scrollable row of pill-shaped buttons
- **Per-pill:** Amber dot + truncated title, max-width 256px
- **Click:** Opens the escalation in the artifact panel
- **Purpose:** Persistent reminder that decisions are pending, accessible without scrolling

### Artifact Panel Integration
- **Tab:** "Escalations" tab added to the artifacts sidebar (alongside "Artifacts" and "Schedules")
- **Detail view:** Clicking an escalation (from sidebar, pinned strip, or chat) opens `EscalationCard` in `panel` variant in the artifact detail panel
- **Selection model:** `ArtifactPanelSelection` union type supports both `{type: 'artifact', artifact}` and `{type: 'escalation', escalationId}`

### Design Language
- **Color:** Amber for open/pending urgency, emerald for resolved/complete
- **Style:** Linear-inspired minimal design
- **Indicators:** Dot + pill badges (not traditional numbered badges)
- **Typography:** 13px body, 11px metadata, 10px section labels
- **Animations:** None — instant state transitions

---

## 6. Inbox Design Proposal — Adapting for Forge

### What the Inbox IS

A **persistent, cross-session notification/item list** scoped to a profile. Any agent (managers, workers, Cortex) can send items to it. Items persist until the user dismisses or resolves them. The inbox is visible from any session within the profile.

Think of it as a **structured async communication channel** from agents to the user — separate from the live conversation stream.

### What the Inbox IS NOT

- **Not a replacement for chat.** Chat remains the primary interaction surface. The inbox handles items that need attention outside the context of any single conversation.
- **Not a task management system.** Items are simple and lightweight — no sub-tasks, dependencies, due dates, or project structure.
- **Not a notification center for system events.** No "agent started" or "build completed" noise. Only items an agent deliberately chose to surface to the user.

### Item Types

The inbox should support multiple item types with a common envelope:

```typescript
type InboxItemKind =
  | 'escalation'    // Agent needs a decision/approval (options-based)
  | 'notification'  // Agent wants to inform the user of something
  | 'review'        // Cortex found something worth reviewing (improvement suggestion, knowledge update)

type InboxItemStatus = 'open' | 'resolved' | 'dismissed'

interface InboxItem {
  id: string
  kind: InboxItemKind
  profileId: string            // Profile scope
  sourceAgentId: string        // Which agent created this
  sourceSessionId?: string     // Which session, if applicable
  title: string
  description: string
  
  // Kind-specific fields
  options?: string[]           // For 'escalation' kind: predefined response options
  response?: {                 // For 'escalation' kind: user's response
    choice: string
    isCustom: boolean
  }
  
  // Metadata
  status: InboxItemStatus
  priority?: 'normal' | 'urgent'   // Visual treatment only (no sorting logic in v1)
  createdAt: string
  resolvedAt?: string
  dismissedAt?: string
}
```

**Design rationale for a unified envelope vs. separate types:**
- The upstream escalation system was a single fixed type. We want something more flexible.
- A unified envelope with a `kind` discriminator keeps storage simple and UI routing clean.
- Kind-specific fields (`options`, `response`) are optional and only relevant for certain kinds.
- New kinds can be added without schema migration.

### How It Maps to Forge Architecture

#### Profile Scoping
Each profile has its own inbox. This maps naturally to our existing profile-scoped data model:
```
profiles/<profileId>/inbox.json
```

Or, if item volume could grow large:
```
profiles/<profileId>/inbox/items.json
```

#### Cross-Session Visibility
All sessions in a profile share the same inbox. This is the key difference from upstream (which had no multi-session concept). The inbox state is loaded once at profile level and broadcast to all connected clients for that profile.

#### Source Attribution
Every item records `sourceAgentId` and optionally `sourceSessionId`. This enables:
- Showing which agent/session raised the item
- Routing escalation responses back to the correct session
- Cortex items attributed to the Cortex system rather than any specific session

#### Storage Architecture
Reuse the upstream pattern — `InboxStorage` class with in-memory Map + JSON file persistence, atomic writes. This is proven reliable in Forge.

### Agent Interface

#### CLI Approach (recommended)
Follow the upstream pattern — CLI via bash. This is runtime-agnostic and doesn't require adding tools to every agent type.

```bash
# Any agent (manager or worker) creates an inbox item:
forge inbox add \
  --kind escalation \
  --title "Which approach for the migration?" \
  --description "Option A is safer but slower..." \
  --options "Approach A" "Approach B" "Need more info"

forge inbox add \
  --kind notification \
  --title "Wave 3 implementation complete" \
  --description "All 5 commits merged to main. See PR #42 for details."

# List/check existing items:
forge inbox list [--status open]
forge inbox get <id>

# Close own items:
forge inbox close <id> [--comment "No longer needed"]
```

#### Cortex API
Cortex workers should use the same CLI, but Cortex-originated items could have special `kind: 'review'` treatment:

```bash
forge inbox add \
  --kind review \
  --title "New workflow preference detected" \
  --description "Across 3 sessions, you consistently preferred X over Y. Should I update common knowledge?"
```

#### Prompt Instructions
Adapt the upstream escalation prompt pattern for the manager archetype:
- "When you need user input, a decision, or approval, always create an inbox escalation."
- "Never just ask in conversation and wait — create an inbox item so it persists."
- "If the user answers your question in conversation, close the corresponding inbox item."

For Cortex, add to the cortex worker prompts:
- "When you find durable improvements worth surfacing, create an inbox review item."

### Protocol Integration

#### Server Events (new)
```typescript
interface InboxSnapshotEvent {
  type: 'inbox_snapshot'
  items: InboxItem[]
  requestId?: string
}

interface InboxItemCreatedEvent {
  type: 'inbox_item_created'
  item: InboxItem
}

interface InboxItemUpdatedEvent {
  type: 'inbox_item_updated'
  item: InboxItem
}

interface InboxItemsDeletedEvent {
  type: 'inbox_items_deleted'
  itemIds: string[]
}
```

#### Client Commands (new)
```typescript
| { type: 'get_inbox'; requestId?: string }
| { type: 'resolve_inbox_item'; itemId: string; choice: string; isCustom: boolean; requestId?: string }
| { type: 'dismiss_inbox_item'; itemId: string; requestId?: string }
```

#### HTTP API (for CLI)
```
GET    /api/inbox?profileId=...&status=...
POST   /api/inbox                            // Create item
GET    /api/inbox/:id
PATCH  /api/inbox/:id                        // Resolve, dismiss, or close
```

### UI Design

#### Sidebar Entry
- **Location:** In the sidebar nav, between agent tree and Settings
- **Icon:** `Inbox` (lucide) or similar
- **Label:** "Inbox"
- **Badge:** Amber dot + count pill (same pattern as upstream escalations), showing open item count
- **Profile-scoped:** Badge reflects items for the currently active profile

#### Dedicated Inbox View
- **Route:** `?view=inbox`
- **Layout:** Full-width list view (same pattern as upstream `EscalationView`)
- **Sorting:** Open items first, then by recency. Optionally group by `kind`.
- **Per-item:** Kind icon, title, source attribution (agent name / session), timestamp, status badge
- **Item detail:** Expandable or split-pane detail showing description, options (for escalations), resolution controls
- **Bulk actions:** "Dismiss all resolved" for cleanup

#### Pinned Strip (optional, lower priority)
- Same pattern as upstream `PinnedEscalations` — horizontal scrollable strip above chat input
- Only show open escalation-kind items (not notifications/reviews, to avoid noise)
- Clicking opens the item in a detail panel or navigates to inbox view

#### In-Chat Rendering (optional, lower priority)
- Escalation-kind items could render as interactive cards in the conversation stream
- Lower priority because the inbox view itself is the primary interaction surface
- Would require `conversation_inbox_item` event type in the conversation projector

### What to Take from Upstream

| Component | Reuse? | Notes |
|-----------|--------|-------|
| `EscalationStorage` class | **Yes, adapt** | Rename to `InboxStorage`, extend schema for `kind`/`profileId`. Same atomic-write pattern. |
| Protocol event shapes | **Yes, rename** | Same patterns (`snapshot`, `created`, `updated`, `deleted`, `resolution_result`) |
| CLI architecture | **Yes, adapt** | Rename from `middleman escalation` to `forge inbox`. Same arg-parsing structure. |
| `EscalationCard` component | **Yes, adapt** | Generalize for multiple item kinds. Escalation kind keeps option selection + custom response. |
| `PinnedEscalations` component | **Yes, reuse** | Same horizontal strip pattern. Filter to escalation-kind items only. |
| `EscalationView` component | **Yes, adapt** | Rename to `InboxView`. Add kind-based filtering/grouping. |
| Sidebar badge pattern | **Yes, reuse** | Amber dot + count pill for open items. |
| Agent prompt patterns | **Yes, adapt** | Same mandatory-escalation language, extended for inbox concept. |
| Conversation-stream integration | **Defer** | Lower priority. Inbox view is the primary surface. |
| Artifact panel integration | **Defer** | Could add later. The upstream pattern of opening escalation in artifact panel was elegant but complex. |

### What to Design Fresh

| Area | Reason |
|------|--------|
| **Profile scoping** | Upstream had no profiles. Storage path, filtering, and access control are all new. |
| **Multi-source support** | Upstream only allowed managers to create. We need any agent + Cortex. |
| **Item kinds** | Upstream had one type (decision-request). We need escalation, notification, and review. |
| **Cross-session visibility** | Upstream had no multi-session. All sessions in a profile share the inbox. |
| **Escalation routing** | When a user resolves an escalation, the response must route to the correct session/manager. `sourceSessionId` enables this. |
| **Cortex integration** | Cortex review items are a new concept — finding durable improvements, surfacing onboarding suggestions, etc. |
| **Dismiss vs. Resolve** | Upstream only had `resolve`. We add `dismiss` for items that don't need a response (notifications, reviews). |
| **Priority** | Upstream had no priority concept. We add a simple `normal`/`urgent` for visual treatment. |

---

## 7. Implementation Sketch

### Phase 1: Core Storage + Protocol (Backend)
**Effort:** Moderate — well-defined, follows existing patterns

1. Create `apps/backend/src/inbox/inbox-storage.ts`
   - Port `EscalationStorage` → `InboxStorage`
   - Extend schema for `kind`, `profileId`, `sourceSessionId`, `priority`, `dismissedAt`
   - Storage path: `profiles/<profileId>/inbox.json`
   - Atomic write persistence (same pattern)

2. Add `InboxItem` type to `packages/protocol/src/shared-types.ts`

3. Add inbox events to `packages/protocol/src/server-events.ts`

4. Add inbox commands to `packages/protocol/src/client-commands.ts`

5. Wire inbox into `SwarmManager`:
   - `InboxStorage` instance per profile
   - Load on profile init
   - Methods: `createInboxItem`, `resolveInboxItem`, `dismissInboxItem`, `listInboxItems`
   - Emit events on mutations
   - On escalation resolution: route response message to `sourceSessionId`'s manager

6. Create `apps/backend/src/ws/routes/inbox-routes.ts`
   - HTTP routes for CLI
   - WebSocket command handlers

### Phase 2: CLI (Backend)
**Effort:** Low — direct port of upstream CLI

1. Add `forge inbox` command set to the CLI
2. Commands: `add`, `list`, `get`, `close`
3. `FORGE_AGENT_ID` env var for agent identification

### Phase 3: Agent Prompts
**Effort:** Low — text changes only

1. Update `manager.md` archetype with inbox/escalation instructions
2. Add inbox instructions to Cortex worker prompts
3. Ensure `FORGE_AGENT_ID` is set in agent runtime environments

### Phase 4: UI — Sidebar + Inbox View
**Effort:** Moderate — new view, follows established patterns

1. Add inbox state to `ws-state.ts` (`items: InboxItem[]`)
2. Add inbox event handling to `ws-client.ts`
3. Add `'inbox'` to `ActiveView` and route state
4. Create `InboxView.tsx` (port from `EscalationView`, extend for multiple kinds)
5. Create `InboxItemCard.tsx` (port from `EscalationCard`, extend for kinds)
6. Add sidebar entry with badge in `AgentSidebar.tsx`

### Phase 5: UI — Pinned Strip + Polish
**Effort:** Low

1. Port `PinnedEscalations` → `PinnedInboxItems` (escalation-kind only)
2. Wire into `MessageInput`
3. Polish: empty states, loading states, error handling

### Phase 6 (Future): Chat Integration + Cortex
**Effort:** Moderate, can defer

1. Add `conversation_inbox_item` event to conversation projector
2. Create `InboxItemMessageRow` for inline chat rendering
3. Build Cortex → inbox integration for review items
4. Artifact panel integration

### Sequencing Dependencies
```
Phase 1 (storage + protocol)
  ├── Phase 2 (CLI) — can parallel with Phase 4
  ├── Phase 3 (prompts) — can parallel with Phase 4
  └── Phase 4 (UI)
       └── Phase 5 (polish)
            └── Phase 6 (future)
```

Phases 2, 3, and 4 can execute in parallel once Phase 1 is complete.

---

## 8. Open Questions

### Design Decisions Needed

1. **Item retention policy:** Should resolved/dismissed items be kept forever? Pruned after N days? The upstream system kept everything. For an inbox, eventual cleanup seems desirable — perhaps auto-prune resolved items older than 30 days.

2. **Notification vs. `speak_to_user`:** When should an agent create an inbox notification vs. just using `speak_to_user`? The line is: `speak_to_user` is ephemeral and appears in the current session's chat. Inbox notifications persist and are visible from any session. Potential guideline: use inbox for cross-session awareness, `speak_to_user` for in-context responses.

3. **Worker escalations:** Should workers be able to create inbox items directly, or should they escalate to their manager who then creates the inbox item? Upstream only allowed managers. Allowing workers adds complexity (workers may not know the `profileId`), but could be useful for workers that detect issues. Recommendation: managers only for v1, with workers sending messages to their manager when they need something escalated.

4. **Escalation response routing:** When the user resolves an escalation, the response needs to reach the right manager in the right session. If the creating session is idle/stopped, should the response still be delivered (queuing for next wake-up)? Or should unresolvable items be flagged? Recommendation: deliver to manager regardless of session state — the existing message delivery infrastructure handles queuing.

5. **Cortex review item lifecycle:** How prescriptive should the review item options be? Should Cortex offer "Accept and apply", "Ignore", "Discuss"? Or just surface findings for the user to act on manually? Recommendation: start simple — Cortex creates notifications (not escalations). The user reads them and acts in their own time. Structured review items with apply/reject can come later.

6. **Multiple profiles:** If a user has multiple profiles, should there be a cross-profile inbox view? Or only per-profile? Recommendation: per-profile only for v1. Each profile's inbox is independent. A future "unified inbox" could aggregate across profiles.

7. **Badge scope:** Should the sidebar badge show ALL open items, or only escalations (items requiring action)? Recommendation: all open items, but escalations could get a distinct visual treatment (amber vs. blue) to indicate urgency.

8. **Real-time sync scope:** Should inbox events be broadcast to all connected WebSocket clients, or only to clients subscribed to the relevant profile? Our fork's multi-session architecture means multiple clients may be connected to different sessions in the same profile. Recommendation: broadcast to all clients for the profile — the inbox is profile-scoped, so all sessions should see the same state.

### Technical Questions

9. **Storage format:** JSON file (like upstream) or extend our JSONL session format? JSON file is simpler for a small number of items. JSONL would be better if item volume could grow large. Recommendation: JSON file for v1. The inbox should be small (tens of items, not thousands).

10. **CLI binary name:** The upstream CLI was `middleman`. Our fork uses... what? Need to decide if the CLI is `forge` (matching the rebrand) or if we add inbox commands to an existing CLI tool. Could also be a `forge-inbox` standalone.

11. **Conversation history integration:** If escalation cards render in the conversation stream, they become part of the JSONL history. This means the escalation's live status must be reconciled with the snapshot stored in the JSONL. The upstream handled this by storing the full `UserEscalation` object in the conversation event and updating it via the separate `escalation_updated` event to the live UI state. For replay, the JSONL snapshot may be stale. The upstream approach was reasonable — defer this complexity until Phase 6.

---

## Appendix A: Upstream Commit Reference

| Commit | Date | Summary |
|--------|------|---------|
| `be983d1` | Mar 6 10:30 | User task assignment system (tool-based) |
| `87616c9` | Mar 6 11:51 | Task view redesign + editable tasks |
| `d851f0d` | Mar 6 12:37 | Replace task tools with CLI workflow |
| `59b652b` | Mar 6 12:?? | Linear-inspired task UI redesign |
| `5fd93c0` | Mar 6 12:?? | Task view header height fix |
| `24b1e89` | Mar 6 13:41 | **Rework escalations end to end** (tasks → escalations) |
| `0cda46c` | Mar 6 13:46 | Polish escalation UI (Linear-style) |
| `218a70d` | Mar 6 17:46 | Render escalations in chat + artifacts |
| `770cfbd` | Mar 9 16:37 | Rework escalation UI copy |
| `771e9b5` | Mar 9 16:?? | Fix escalation detail close button |
| `7312ce2` | Mar 9 16:54 | Manager prompt: auto-close on natural language answers |
| `d737241` | Mar 9 16:58 | Pin open escalations above chat input |
| `95ac62a` | Mar 9 ??:?? | Fix escalation card markdown rendering |
| `07af6a6` | Mar 16 08:44 | **swarmd-2 migration: removes escalations entirely** |
| `2e95cfe` | Mar 17 15:08 | Remove stale escalation SQL migration |

## Appendix B: Key Files (pre-removal snapshots available in git history)

**Backend:**
- `apps/backend/src/escalations/escalation-storage.ts` — Storage class (289 lines)
- `apps/backend/src/ws/routes/escalation-routes.ts` — HTTP + WS routes (311 lines)
- `apps/backend/src/swarm/swarm-manager.ts` — Integration points (escalation CRUD methods)
- `apps/backend/src/swarm/archetypes/builtins/manager.md` — Agent prompt instructions

**Frontend:**
- `apps/ui/src/components/chat/EscalationView.tsx` — Dedicated list view (612 lines at peak)
- `apps/ui/src/components/chat/EscalationCard.tsx` — Interactive escalation card (270 lines)
- `apps/ui/src/components/chat/PinnedEscalations.tsx` — Pinned strip above input (51 lines)
- `apps/ui/src/components/chat/message-list/EscalationMessageRow.tsx` — Chat inline wrapper (28 lines)

**Protocol:**
- `packages/protocol/src/shared-types.ts` — `UserEscalation`, `UserEscalationResponse`
- `packages/protocol/src/server-events.ts` — 5 event types
- `packages/protocol/src/client-commands.ts` — 2 command types

**CLI:**
- `apps/cli/src/index.ts` — `middleman escalation add/list/get/close`
