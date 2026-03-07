# Cortex Multi-Session — Sidebar UI Implementation Plan

> **Status:** Draft — awaiting review  
> **Date:** 2026-03-06  
> **Scope:** Frontend-only sidebar changes to support multi-session display for Cortex  
> **Prerequisite:** Multi-session backend infrastructure (already complete)  

---

## 1. Executive Summary

Cortex already has full multi-session backend support — it uses the same `ManagerProfile` + session-as-agent architecture as every other manager. The `createSession(profileId)` API works for `profileId = "cortex"` today. Sessions can be created, stopped, resumed, forked, renamed, and deleted.

**The only gap is the sidebar UI.** The Cortex section in `AgentSidebar.tsx` currently renders a flat one-level view: the Cortex icon + a collapsed/expanded list of workers (pooled from all sessions). It does not display individual sessions at all. This plan converts the pinned Cortex section to support the same session → worker tree that regular managers already have.

---

## 2. Current State Analysis

### 2.1 Backend: Already Complete ✅

- Cortex profile is auto-created at boot (`ensureCortexProfile()` in `swarm-manager.ts`) with `profileId = "cortex"`, `defaultSessionAgentId = "cortex"`, `archetypeId = "cortex"`.
- `createSession("cortex")` works through the same `prepareSessionCreation()` path as all other profiles. It clones the default session's model/CWD/archetype config. New sessions get ids like `cortex--s2`, `cortex--s3`, etc.
- Session lifecycle (stop/resume/delete/fork/rename/merge-memory) is profile-generic — no Cortex-specific restrictions beyond the standard "cannot delete the default session" guard.
- WS commands (`create_session`, `stop_session`, etc.) and the session-routes handler are fully generic — Cortex sessions route through the same code paths.
- **Conclusion: Zero backend changes required.**

### 2.2 Frontend Sidebar: Current Cortex Section

Located in `AgentSidebar.tsx`, lines ~1244–1420 (the `{/* Pinned Cortex entry */}` IIFE block).

**Current rendering logic:**
1. Finds the Cortex `ProfileTreeRow` via `treeRows.find(row => isCortexProfile(row))`.
2. Selects the **default session** agent as the single click target.
3. **Pools workers from ALL sessions** into a single flat list: `cortexRow.sessions.flatMap(s => s.workers)`.
4. Shows a single expand/collapse chevron that reveals the flat worker list underneath the Brain icon.
5. Context menu offers only "Settings" and "Stop Session" (for the root session).
6. **Does NOT render individual Cortex sessions at all** — additional sessions are invisible in the sidebar.
7. Unread counts only track the root session's unread count.

**State keys used:**
- `__cortex_workers__` in `expandedSessionIds` — controls worker list expand/collapse.
- `__cortex_workers_list__` in `expandedWorkerListSessionIds` — controls show-more/less for worker truncation.

### 2.3 Frontend Sidebar: Regular Manager Section (Reference Implementation)

The `ProfileGroup` component (lines ~482–860) renders multi-session managers with this tree structure:

```
▾ Profile Name          [+] [runtime badge]   ← profile header, collapsible
   ● Session 1 (Main)                         ← SessionRowItem
      ▸ worker-a                               ← WorkerRow (nested, collapsible per-session)
      ▸ worker-b
   ● Session 2 (Refactor)
      ▸ worker-c
   [Show N more]                               ← session list truncation (MAX_VISIBLE_SESSIONS = 8)
```

**Key behaviors:**
- Profile header click → selects default session.
- Profile collapse → hides entire session list.
- `[+]` button calls `onCreateSession(profileId)` → opens `CreateSessionDialog`.
- Each session has its own expand/collapse for workers.
- Session truncation at `MAX_VISIBLE_SESSIONS` with show-more/less.
- Worker truncation at `MAX_VISIBLE_WORKERS` per session with show-more/less.
- Context menus on sessions: Copy path, Rename, Fork, Stop/Resume, Merge Memory, Delete (not for default).

### 2.4 Cortex Dashboard Panel

`CortexDashboardPanel.tsx` is activated when the user views a Cortex agent (`activeAgent?.archetypeId === 'cortex'`). It replaces the artifacts sidebar. The panel shows Knowledge, Notes, Review Status, and Schedules tabs.

**Multi-session impact:** The dashboard takes `managerId` as a prop (resolved from the active agent's manager context). When the user clicks a Cortex session (root or additional), the active agent changes, so the dashboard naturally follows. **No changes needed to the dashboard panel itself.**

---

## 3. Requirements

1. Cortex keeps its **pinned position** at the top-left of the sidebar (above the "Agents" section header).
2. The Cortex section is **collapsed by default** (the profile-level collapse, hiding sessions).
3. When expanded, Cortex shows **a list of sessions** — each expandable to show its workers underneath.
4. The **root/default Cortex session does NOT appear** as a separate item in the session list. Clicking the Cortex Brain icon itself opens the root session (current behavior preserved).
5. Only **additional sessions** (non-default) appear in the expandable list below the Cortex header.
6. Existing **show-more/less truncation** applies to both the session list and per-session worker lists.
7. **"New Session" button** (`[+]`) appears on the Cortex header row (like regular managers).
8. **Context menus** on Cortex sessions match regular session context menus (Rename, Fork, Stop/Resume, Delete, Merge Memory, Copy path).
9. **Context menu on the Cortex header** adds "New Session" alongside existing "Settings" and "Stop Session".
10. **Unread counts** aggregate across all Cortex sessions when collapsed; per-session when expanded.
11. **Activity indicators** (streaming spinner, worker count) behave identically to regular managers.

---

## 4. Implementation Plan

### Phase 1: Refactor Cortex Section to Use ProfileGroup Pattern

**Complexity:** Medium (~150–200 lines changed)  
**Files:** `apps/ui/src/components/chat/AgentSidebar.tsx`

#### 4.1 Replace the Cortex IIFE Block

The current inline `{(() => { ... })()}` block (~170 lines) that renders the pinned Cortex entry will be replaced with a new `CortexProfileSection` component that follows the `ProfileGroup` rendering pattern but with these specializations:

1. **Filter out the default session from the rendered session list.** The default session is handled by the header row click.
2. **Keep the Brain icon** in the header row instead of the `UserStar` icon used by regular profiles.
3. **Start collapsed** — initialize `collapsedProfileIds` to include the Cortex profile id.
4. **Preserve the pinned position** — render in the existing border-b section above the "Agents" heading.

#### 4.2 Session List Rendering

When the Cortex section is expanded:

```
🧠 Cortex                [+]              ← Brain icon header (click → root session)
   ● Review pipeline                      ← additional session, with its own workers
      ▸ scan-worker-1
   ● Knowledge audit                      ← additional session
   [Show N more]                          ← if > MAX_VISIBLE_SESSIONS non-default sessions
```

When collapsed (default state):

```
▸ 🧠 Cortex   2/3  [runtime badge]       ← collapsed, shows active/total session count
```

When there are no additional sessions (only the root), the section looks exactly like today's current behavior — no expand arrow, just the Brain icon. The chevron only appears when there are additional sessions OR the root session has workers (preserving today's expand-for-workers behavior).

#### 4.3 Detailed Component Extraction

Extract a `CortexSection` component with this signature:

```tsx
function CortexSection({
  cortexRow,             // ProfileTreeRow
  statuses,
  unreadCounts,
  selectedAgentId,
  isSettingsActive,
  isCollapsed,           // profile-level collapse state
  collapsedSessionIds,   // Set<string> for worker-level collapse per session
  isSessionListExpanded, // for show-more/less
  expandedWorkerListSessionIds,
  onToggleCollapsed,
  onToggleSessionCollapsed,
  onToggleSessionListExpanded,
  onToggleWorkerListExpanded,
  onSelect,
  onDeleteAgent,
  onOpenSettings,
  onCreateSession,
  onStopSession,
  onResumeSession,
  onDeleteSession,
  onRequestRenameSession,
  onForkSession,
  onMergeSessionMemory,
}: CortexSectionProps)
```

This follows the same prop pattern as `ProfileGroup` so it plugs into the same state management hooks in the parent.

#### 4.4 State Changes

In the parent `AgentSidebar` component:

- **Initialize `collapsedProfileIds`** to include `"cortex"` so the Cortex section starts collapsed.
  - Alternative: use a separate `isCortexCollapsed` boolean state initialized to `true`. Cleaner since Cortex isn't in the regular profile list.
- **Remove the `__cortex_workers__` and `__cortex_workers_list__` synthetic keys** — workers are now tracked per-session using real session agent ids, same as `ProfileGroup`.
- **Wire `onCreateSession`** to use the existing `handleRequestCreateSession("cortex")` flow.

#### 4.5 Unread Count Aggregation

When collapsed, sum unread counts across all Cortex sessions (root + additional):
```ts
const totalCortexUnread = cortexRow.sessions.reduce(
  (sum, s) => sum + (unreadCounts[s.sessionAgent.agentId] ?? 0), 0
)
```
When expanded, each `SessionRowItem` shows its own unread count (already built into the component).

For the Cortex header row specifically (which represents the root session), show the root session's unread count when the section is expanded, and the aggregate when collapsed.

### Phase 2: Context Menu Enhancement

**Complexity:** Low (~20 lines)  
**Files:** `apps/ui/src/components/chat/AgentSidebar.tsx`

Update the Cortex header's `ContextMenuContent` from the current minimal menu:

```tsx
// Current
<ContextMenuContent>
  <ContextMenuItem onClick={handleOpenSettings}>Settings</ContextMenuItem>
  <ContextMenuItem onClick={() => onStopSession(targetId)}>Stop Session</ContextMenuItem>
</ContextMenuContent>

// New — matches ProfileGroup context menu
<ContextMenuContent>
  {onCreateSession && (
    <ContextMenuItem onClick={() => onCreateSession("cortex")}>
      <Plus /> New Session
    </ContextMenuItem>
  )}
  <ContextMenuItem onClick={handleOpenSettings}>
    <Settings /> Settings
  </ContextMenuItem>
  {cortexSessionRunning && onStopSession && targetId && (
    <ContextMenuItem onClick={() => onStopSession(targetId)}>
      <Pause /> Stop Root Session
    </ContextMenuItem>
  )}
</ContextMenuContent>
```

The individual session rows already get full context menus from `SessionRowItem`.

### Phase 3: Edge Case Handling & Polish

**Complexity:** Low (~30 lines)  
**Files:** `apps/ui/src/components/chat/AgentSidebar.tsx`, possibly `apps/ui/src/routes/index.tsx`

#### 3.1 Selection Auto-Expand

When the user creates a Cortex session or navigates to one (e.g., via a link or WS event), the Cortex section should auto-expand if it's currently collapsed. The same pattern is already needed for regular managers (where the selected agent guarantees visibility in truncated lists).

Implementation: Add a `useEffect` that watches `selectedAgentId` — if it belongs to a Cortex session, ensure `isCortexCollapsed` is set to `false`.

#### 3.2 New Session Button (Header Inline)

Add the `[+]` button to the Cortex header row, matching the `ProfileGroup` header pattern. This reuses the existing `handleRequestCreateSession` → `CreateSessionDialog` → `handleConfirmCreateSession` flow.

#### 3.3 handleNewChat for Cortex

The "New Chat" button in `ChatHeader.tsx` already calls `handleNewChat()` which calls `createSession(profileId)`. Since Cortex agents have `profileId = "cortex"`, this already works. When a user is viewing a Cortex session and clicks "New Chat", it creates a new Cortex session. **No change needed.**

#### 3.4 Deleted Session Navigation

When a Cortex session is deleted, if it was the active session, fall back to the root Cortex session. The existing `handleDeletedAgentSubscriptions` + fallback logic in `index.tsx` already handles this generically.

#### 3.5 Dashboard Panel Session Scoping

The `CortexDashboardPanel` currently takes `managerId`. When viewing a non-root Cortex session, the panel still shows correctly because the managerId resolves from the active agent. Review/scan operations are profile-scoped (they scan all sessions under the Cortex profile), so they remain correct regardless of which session is active. **No changes needed.**

---

## 5. What Does NOT Need to Change

| Component | Reason |
|---|---|
| **Backend (swarm-manager.ts)** | `createSession("cortex")` already works. All session lifecycle ops are profile-generic. |
| **WS session routes** | Fully generic — no Cortex-specific paths. |
| **ws-client.ts** | `createSession(profileId, name?)` already works for any profile. |
| **agent-hierarchy.ts** | `buildProfileTreeRows` already correctly groups Cortex sessions under the Cortex profile. `isCortexProfile()` already identifies the Cortex row. |
| **CortexDashboardPanel.tsx** | Panel is profile-scoped, not session-scoped. Works for any active Cortex session. |
| **ChatHeader.tsx** | "New Chat" and "Dashboard" button already work generically. |
| **index.tsx (route)** | `handleNewChat`, `handleCreateSession`, and Cortex panel rendering are already session-aware. |
| **Protocol types** | No new types or events needed. |
| **ProfileGroup component** | Stays as-is for regular managers. Cortex gets its own specialized section. |

---

## 6. Risks & Mitigations

### 6.1 Root Session Visibility

**Risk:** Users might be confused that the root session doesn't appear in the session list when expanded.

**Mitigation:** The Cortex header row itself acts as the root session — it has the status dot, unread badge, and full click behavior. This matches how `ProfileGroup` works for regular managers where clicking the profile header selects the default session. The pattern is already established in the UI.

### 6.2 Collapse Default State

**Risk:** Users who create Cortex sessions might not find them because the section is collapsed by default.

**Mitigation:** Auto-expand when a new session is created or when the selected agent is a Cortex session (Phase 3.1). The `handleCreateSession` callback already navigates to the new session, which triggers the auto-expand.

### 6.3 Cortex Worker Pooling Regression

**Risk:** The current UI pools workers from ALL Cortex sessions into one flat list. Switching to per-session worker display changes the visual hierarchy.

**Mitigation:** This is the desired behavior — it matches how regular managers work. Workers belong to their session. The old pooled view was a simplification for the single-session era.

### 6.4 Large Number of Cortex Sessions

**Risk:** Cortex sessions could accumulate (especially if the user creates sessions for different review/audit tasks).

**Mitigation:** The `MAX_VISIBLE_SESSIONS` truncation with show-more/less applies here, same as regular managers. Session cleanup UX is a broader follow-up (not Cortex-specific).

---

## 7. Complexity Estimate

| Phase | Lines Changed | Effort |
|---|---|---|
| Phase 1: Core refactor | ~180 net (replace ~170 old, add ~180 new) | 2–3 hours |
| Phase 2: Context menu | ~20 | 15 min |
| Phase 3: Edge cases & polish | ~30 | 30 min |
| **Total** | **~230 net** | **~3–4 hours** |

This is purely frontend work in a single file (`AgentSidebar.tsx`) with minor coordination in the parent route. The heavy lifting is the component extraction and state wiring, both of which follow established patterns in the same file.

---

## 8. Testing Checklist

- [ ] Cortex section starts collapsed
- [ ] Clicking Brain icon opens root Cortex session (same as today)
- [ ] Expanding shows only non-default sessions
- [ ] When no additional sessions exist, section looks identical to today (no chevron unless workers exist)
- [ ] `[+]` button creates a new Cortex session via `CreateSessionDialog`
- [ ] New session appears in list immediately after creation
- [ ] Each session expands to show its own workers
- [ ] Context menus work on Cortex sessions (rename, fork, stop, resume, delete, merge memory)
- [ ] Root session cannot be deleted (no "Delete" option in header context menu)
- [ ] Unread counts aggregate when collapsed, show per-session when expanded
- [ ] Activity spinner shows when collapsed (aggregate streaming worker count)
- [ ] Show-more/less works for sessions (if > 8) and workers (if > 15)
- [ ] Deleting active Cortex session falls back to root Cortex session
- [ ] Dashboard panel works correctly for any selected Cortex session
- [ ] "New Chat" header button creates a new Cortex session when viewing Cortex
- [ ] Auto-expand Cortex section when navigating to a non-root Cortex session
- [ ] TypeScript: `pnpm exec tsc --noEmit` passes
