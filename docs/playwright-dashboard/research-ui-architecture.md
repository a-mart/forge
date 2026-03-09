# Playwright Dashboard UI Architecture Research

Date: 2026-03-09

## Scope reviewed

Frontend + shared protocol files reviewed for this report:

- `apps/ui/src/router.tsx`
- `apps/ui/src/routeTree.gen.ts`
- `apps/ui/src/routes/__root.tsx`
- `apps/ui/src/routes/index.tsx`
- `apps/ui/src/hooks/index-page/use-route-state.ts`
- `apps/ui/src/hooks/index-page/use-ws-connection.ts`
- `apps/ui/src/hooks/index-page/use-visible-messages.ts`
- `apps/ui/src/hooks/index-page/use-context-window.ts`
- `apps/ui/src/lib/ws-client.ts`
- `apps/ui/src/lib/ws-state.ts`
- `apps/ui/src/lib/agent-hierarchy.ts`
- `apps/ui/src/lib/theme.ts`
- `apps/ui/src/lib/api-endpoint.ts`
- `apps/ui/src/styles.css`
- `apps/ui/src/components/chat/AgentSidebar.tsx`
- `apps/ui/src/components/chat/ChatHeader.tsx`
- `apps/ui/src/components/chat/SettingsDialog.tsx`
- `apps/ui/src/components/chat/ArtifactsSidebar.tsx`
- `apps/ui/src/components/chat/ArtifactPanel.tsx`
- `apps/ui/src/components/chat/SchedulesPanel.tsx`
- `apps/ui/src/components/chat/CreateManagerDialog.tsx`
- `apps/ui/src/components/chat/DeleteManagerDialog.tsx`
- `apps/ui/src/components/chat/ContentZoomDialog.tsx`
- `apps/ui/src/components/chat/AttachedFiles.tsx`
- `apps/ui/src/components/chat/ContextWindowIndicator.tsx`
- `apps/ui/src/components/chat/MessageList.tsx`
- `apps/ui/src/components/chat/MessageInput.tsx`
- `apps/ui/src/components/chat/message-list/EmptyState.tsx`
- `apps/ui/src/components/chat/message-list/ConversationMessageRow.tsx`
- `apps/ui/src/components/chat/message-list/AgentMessageRow.tsx`
- `apps/ui/src/components/chat/message-list/ToolLogRow.tsx`
- `apps/ui/src/components/chat/message-list/MessageAttachments.tsx`
- `apps/ui/src/components/chat/message-list/message-row-utils.tsx`
- `apps/ui/src/components/chat/cortex/CortexDashboardPanel.tsx`
- `apps/ui/src/components/chat/cortex/KnowledgeFileViewer.tsx`
- `apps/ui/src/components/chat/cortex/ReviewStatusPanel.tsx`
- `apps/ui/src/components/settings/SettingsLayout.tsx`
- `apps/ui/src/components/settings/SettingsGeneral.tsx`
- `apps/ui/src/components/settings/SettingsNotifications.tsx`
- `apps/ui/src/components/settings/SettingsAuth.tsx`
- `apps/ui/src/components/settings/SettingsIntegrations.tsx`
- `apps/ui/src/components/settings/SettingsSkills.tsx`
- `apps/ui/src/components/settings/settings-api.ts`
- `apps/ui/src/components/settings/settings-row.tsx`
- `apps/ui/src/components/settings/settings-types.ts`
- `apps/ui/src/components/ui/*`
- `apps/ui/vite.config.ts`
- `packages/protocol/src/shared-types.ts`
- `packages/protocol/src/server-events.ts`
- `packages/protocol/src/client-commands.ts`

---

## Executive recommendation

**Recommended placement:** implement the Playwright dashboard as a **new main-center app view inside the existing `IndexPage` shell**, not as the existing right-side drawer and not as a brand-new TanStack file route for v1.

### Why

1. **The UI is effectively a single-route app today.**
   - `apps/ui/src/routeTree.gen.ts` only contains `'/'`.
   - `apps/ui/src/routes/index.tsx` manually switches between chat/settings using URL search/path parsing via `useRouteState`.
2. **The right-side panel architecture is intentionally narrow and context-scoped.**
   - `ArtifactsSidebar` and `CortexDashboardPanel` are secondary panes tied to the active conversation/manager.
   - A Playwright session dashboard needs width for multi-column status rows, filtering, worktree paths, stale/active grouping, and bulk-ish actions.
3. **The sidebar + center-content shell is already the top-level UX pattern.**
   - Settings already replace the center pane while keeping the sidebar intact.
   - Playwright should follow that same pattern.

### Best v1 shape

- Add a new app view to `use-route-state.ts`, e.g. `view: 'playwright'`.
- Render a new `PlaywrightDashboardView` in the center column from `apps/ui/src/routes/index.tsx`.
- Keep `AgentSidebar` visible.
- Add navigation entry in the sidebar footer, near Settings.
- Use a right-side detail drawer *inside the dashboard* only if needed later.

### Not recommended for v1

- **Not** a replacement for the existing artifacts/cortex right drawer.
- **Not** a standalone file route `/playwright` unless you first extract the current shell from `IndexPage` into a reusable shared layout.

---

## 1. Routing system

### Current reality: only one generated route exists

File: `apps/ui/src/routeTree.gen.ts`

```ts
import { Route as rootRouteImport } from './routes/__root'
import { Route as IndexRouteImport } from './routes/index'

const IndexRoute = IndexRouteImport.update({
  id: '/',
  path: '/',
  getParentRoute: () => rootRouteImport,
} as any)

export interface FileRoutesByFullPath {
  '/': typeof IndexRoute
}
```

File: `apps/ui/src/router.tsx`

```ts
export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })

  return router
}
```

### Important finding

The app uses TanStack Router infrastructure, but **actual app-level view switching is mostly custom** inside `IndexPage`.

File: `apps/ui/src/hooks/index-page/use-route-state.ts`

```ts
export type ActiveView = 'chat' | 'settings'
export type AppRouteState =
  | { view: 'chat'; agentId: string }
  | { view: 'settings' }
```

```ts
function parseRouteStateFromPathname(pathname: string): AppRouteState {
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname

  if (normalizedPath === '/settings') {
    return { view: 'settings' }
  }

  const agentMatch = normalizedPath.match(/^\/agent\/([^/]+)$/)
  if (agentMatch) {
    return {
      view: 'chat',
      agentId: normalizeAgentId(decodePathSegment(agentMatch[1])),
    }
  }

  return {
    view: 'chat',
    agentId: DEFAULT_MANAGER_AGENT_ID,
  }
}
```

```ts
const navigateToRoute = useCallback(
  (nextRouteState: AppRouteState, replace = false) => {
    const normalizedRouteState = normalizeRouteState(nextRouteState)
    if (routeStatesEqual(routeState, normalizedRouteState)) {
      return
    }

    void navigate({
      to: '/',
      search: toRouteSearch(normalizedRouteState),
      replace,
      resetScroll: false,
    })
  },
  [navigate, routeState],
)
```

### Routing implications for Playwright

#### Option A — recommended: add a new internal app view

Integration points:

- `apps/ui/src/hooks/index-page/use-route-state.ts`
- `apps/ui/src/routes/index.tsx`
- `apps/ui/src/components/chat/AgentSidebar.tsx`

Suggested shape:

```ts
export type ActiveView = 'chat' | 'settings' | 'playwright'
export type AppRouteState =
  | { view: 'chat'; agentId: string }
  | { view: 'settings' }
  | { view: 'playwright' }
```

Then parse `?view=playwright` and render the dashboard from `IndexPage`.

This is the lowest-friction path because it matches how Settings already works.

#### Option B — possible but more invasive: true file route `/playwright`

Needed integration points:

- new file `apps/ui/src/routes/playwright.tsx`
- regenerated `apps/ui/src/routeTree.gen.ts`
- likely a new shared extracted shell component from current `IndexPage`

Why invasive:

- `IndexPage` currently owns the entire shell: sidebar, main column, WS connection, dialogs, selected agent logic, artifact panel, settings view switching.
- A real `/playwright` file route would either duplicate that shell or force a refactor.

### Recommendation

For v1, **do not start by adding a real generated route**. Add a new center-pane app view within the existing shell.

---

## 2. Layout architecture

### Root document is minimal; app shell lives in `IndexPage`

File: `apps/ui/src/routes/__root.tsx`

```tsx
export const Route = createRootRoute({
  ...
  notFoundComponent: IndexPage,
  shellComponent: RootDocument,
})
```

```tsx
<body className="overflow-hidden">
  <TooltipProvider>
    {children}
    <TanStackDevtools ... />
  </TooltipProvider>
  <Scripts />
</body>
```

Important:

- The root document does **not** contain the app layout.
- It enforces `overflow-hidden` at the body level.
- Any new dashboard must manage its own inner scrolling with `min-h-0`, `overflow-y-auto`, or `ScrollArea`.

### Main shell structure

File: `apps/ui/src/routes/index.tsx`

```tsx
<main className="h-dvh bg-background text-foreground">
  <div className="flex h-dvh w-full min-w-0 overflow-hidden bg-background">
    <AgentSidebar ... />

    <div className="relative flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {activeView === 'settings' ? (
          <SettingsPanel ... />
        ) : (
          <>
            <ChatHeader ... />
            <MessageList ... />
            <MessageInput ... />
          </>
        )}
      </div>

      {activeView === 'chat' ? (
        activeAgent?.archetypeId === 'cortex' ? (
          <CortexDashboardPanel ... />
        ) : (
          <ArtifactsSidebar ... />
        )
      ) : null}
    </div>
  </div>

  <ArtifactPanel ... />
  <CreateManagerDialog ... />
  <DeleteManagerDialog ... />
</main>
```

### Current view taxonomy

1. **Left sidebar**: `AgentSidebar`
2. **Center pane**:
   - chat UI, or
   - settings UI
3. **Right drawer**:
   - artifacts sidebar, or
   - Cortex dashboard sidebar
4. **Global overlays/dialogs**:
   - artifact full panel
   - create/delete dialogs

### Sidebar architecture

File: `apps/ui/src/components/chat/AgentSidebar.tsx`

The sidebar is a complex profile/session/worker tree. It already has:

- profile groups
- special pinned Cortex section
- search
- footer-level Settings button
- mobile overlay mode

Footer snippet:

```tsx
<div className="shrink-0 border-t border-sidebar-border p-2">
  <div className="space-y-1">
    <button
      type="button"
      onClick={handleOpenSettings}
      className={cn(
        'flex min-h-[44px] w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors ...',
        isSettingsActive
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
      )}
    >
      <Settings ... />
      <span>Settings</span>
    </button>
  </div>
</div>
```

### Where Playwright should live

#### Best placement: center pane peer to Settings

Add a third branch in `apps/ui/src/routes/index.tsx`:

- `activeView === 'settings'` → `SettingsPanel`
- `activeView === 'playwright'` → `PlaywrightDashboardView`
- else → chat UI

This is the best fit because:

- it keeps the manager/session sidebar available
- it allows wide layouts, filters, summary cards, tables, worktree paths
- it matches the existing “main app surface” pattern used by Settings

#### Sidebar entry

Add a new button in `AgentSidebar` footer, near Settings.

Potential UX:

- Settings
- Playwright

or a small “Tools” group if more global views are planned later.

#### Why not a right drawer

The right drawer patterns (`ArtifactsSidebar`, `CortexDashboardPanel`) are intentionally narrow and contextual.

File: `apps/ui/src/components/chat/ArtifactsSidebar.tsx`

```tsx
isOpen
  ? '... md:w-[300px] ...'
  : 'w-0 opacity-0 overflow-hidden ...'
```

File: `apps/ui/src/components/chat/cortex/CortexDashboardPanel.tsx`

```tsx
const DEFAULT_WIDTH = 420
const MIN_WIDTH = 300
const MAX_WIDTH = 700
```

That is appropriate for artifacts and Cortex utilities, but not for a project-wide session-discovery dashboard.

---

## 3. Component architecture and reusable patterns

## 3.1 Main patterns used across chat/settings

### Pattern: hand-rolled card surfaces over shadcn primitives

There is no strong “Card” primitive actually in `apps/ui/src/components/ui/` right now. Instead, the code frequently uses plain divs with Tailwind tokens:

- `rounded-lg border border-border bg-card/50 p-4`
- `rounded-md border border-border/70 p-3`
- `bg-muted/30`, `bg-card/80`, `border-border/60`

Examples:

File: `apps/ui/src/components/settings/SettingsAuth.tsx`

```tsx
<div className="rounded-lg border border-border bg-card/50 p-4 transition-colors hover:bg-card/80">
```

File: `apps/ui/src/components/settings/SettingsIntegrations.tsx`

```tsx
<div className="flex items-start justify-between gap-3 rounded-md border border-border/70 p-3">
```

### Pattern: section wrappers

File: `apps/ui/src/components/settings/settings-row.tsx`

```tsx
export function SettingsSection({ label, description, children, cta }) {
  return (
    <div className="space-y-4 pb-4">
      <div className="border-b pb-2 flex items-start justify-between gap-4">
        ...
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  )
}
```

This is a very good pattern to reuse for a dashboard’s major blocks:

- Summary
- Filters
- Sessions list
- Agent correlation details
- Actions

### Pattern: compact list rows + hover affordances

File: `apps/ui/src/components/chat/ArtifactsSidebar.tsx`

```tsx
<button
  className={cn(
    'group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
    'transition-colors duration-100',
    'hover:bg-accent/70',
    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60',
  )}
>
```

File: `apps/ui/src/components/chat/cortex/ReviewStatusPanel.tsx`

```tsx
<div className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50">
```

This pattern fits Playwright session rows well.

### Pattern: status badges

File: `apps/ui/src/components/settings/SettingsAuth.tsx`

```tsx
<Badge
  variant="outline"
  className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 ..."
>
  <Check className="size-3" />
  Configured
</Badge>
```

File: `apps/ui/src/components/chat/cortex/ReviewStatusPanel.tsx`

```tsx
<Badge variant="outline" className="h-5 gap-1 border-amber-500/30 bg-amber-500/10 ...">
```

This is the established pattern for:

- active / stale / orphaned
- attached / unattached agent
- running / idle / failed
- local / remote / deleted worktree

### Pattern: empty/loading/error states

Files:

- `apps/ui/src/components/chat/SchedulesPanel.tsx`
- `apps/ui/src/components/chat/cortex/KnowledgeFileViewer.tsx`
- `apps/ui/src/components/chat/cortex/ReviewStatusPanel.tsx`
- `apps/ui/src/components/chat/message-list/EmptyState.tsx`

Common traits:

- centered icon + label + subdued helper text
- loader row with tiny spinner
- inline error banner above content, or centered retry empty state

Example:

```tsx
<div className="flex items-center justify-center py-12">
  <div className="flex items-center gap-2 text-xs text-muted-foreground">
    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
    Loading…
  </div>
</div>
```

### Pattern: fetch-on-open/fetch-on-view, not app-wide polling

Files:

- `apps/ui/src/components/chat/SchedulesPanel.tsx`
- `apps/ui/src/components/chat/cortex/ReviewStatusPanel.tsx`
- `apps/ui/src/components/chat/cortex/KnowledgeFileViewer.tsx`
- `apps/ui/src/components/chat/cortex/CortexDashboardPanel.tsx`

Pattern:

- local `useState`
- `useEffect`
- `AbortController`
- fetch when panel becomes active/open
- manual refresh button

Example:

```tsx
useEffect(() => {
  if (!isActive) return

  const abortController = new AbortController()
  setIsLoading(true)
  setError(null)

  void fetchSchedules(wsUrl, managerId, abortController.signal)
    .then(...)
    .catch(...)
    .finally(...)

  return () => {
    abortController.abort()
  }
}, [isActive, managerId, wsUrl])
```

**Important:** there is almost no true interval polling pattern in the UI. The app prefers **event-driven WS updates** plus **fetch on mount/open/refresh**. The Playwright dashboard should follow that.

---

## 3.2 Existing layouts closest to a Playwright dashboard

### Closest center-pane analogue: Settings

File: `apps/ui/src/components/settings/SettingsLayout.tsx`

- header bar
- left tab nav on desktop
- horizontal tabs on mobile
- scrollable content region

If the Playwright dashboard later grows multiple subviews (Sessions / Worktrees / Agents / Config), a similar layout is appropriate.

### Closest side-panel analogue: Cortex dashboard

File: `apps/ui/src/components/chat/cortex/CortexDashboardPanel.tsx`

Useful reusable ideas:

- panel-local tabs
- persisted width in `localStorage`
- fetch-on-open
- active-tab-specific content fetching

But again: overall placement is too narrow for the main Playwright dashboard.

### Closest “status board” analogue: Review Status panel

File: `apps/ui/src/components/chat/cortex/ReviewStatusPanel.tsx`

This is the most relevant UI style reference for Playwright rows:

- summary header
- counts
- grouped items
- status badges
- action button appearing on hover
- `ScrollArea`

---

## 4. WebSocket client and real-time state

## 4.1 State shape today

File: `apps/ui/src/lib/ws-state.ts`

```ts
export interface ManagerWsState {
  connected: boolean
  targetAgentId: string | null
  subscribedAgentId: string | null
  messages: ConversationHistoryEntry[]
  activityMessages: AgentActivityEntry[]
  agents: AgentDescriptor[]
  profiles: ManagerProfile[]
  statuses: Record<string, { status: AgentStatus; pendingCount: number; contextUsage?: AgentContextUsage }>
  lastError: string | null
  lastSuccess: string | null
  slackStatus: SlackStatusEvent | null
  telegramStatus: TelegramStatusEvent | null
  unreadCounts: Record<string, number>
}
```

### Key observation

This is the single global client state object for the current shell. There is no Zustand/Redux/Context store. `ManagerWsClient` is the data source; React subscribes to it.

## 4.2 React wiring

File: `apps/ui/src/hooks/index-page/use-ws-connection.ts`

```ts
const client = new ManagerWsClient(wsUrl)
clientRef.current = client
setState(client.getState())

const unsubscribe = client.subscribe((nextState) => {
  setState(nextState)
})

client.start()
```

This means a Playwright dashboard can either:

1. consume new fields added to `ManagerWsState`, or
2. own its own REST fetches and local component state

If the dashboard is meant to be live-updating across the whole app, **option 1 is better**.

## 4.3 Event handling pattern

File: `apps/ui/src/lib/ws-client.ts`

```ts
private handleServerEvent(raw: unknown): void {
  let event: ServerEvent
  try {
    event = JSON.parse(String(raw)) as ServerEvent
  } catch {
    this.pushSystemMessage('Received invalid JSON event from backend.')
    return
  }

  switch (event.type) {
    case 'ready':
    case 'conversation_message':
    case 'agent_status':
    case 'agents_snapshot':
    case 'profiles_snapshot':
    case 'slack_status':
    case 'telegram_status':
    ...
  }
}
```

Conversation events are scoped to the active agent; global snapshots are not.

Examples:

```ts
case 'agents_snapshot':
  this.applyAgentsSnapshot(event.agents)
  break

case 'profiles_snapshot':
  this.updateState({ profiles: event.profiles })
  break

case 'slack_status':
  this.updateState({ slackStatus: event })
  break
```

## 4.4 How to add Playwright real-time events

### Shared protocol types

Integration point:

- `packages/protocol/src/server-events.ts`

Add a new event type, preferably snapshot-style:

```ts
export interface PlaywrightSessionRecord {
  id: string
  projectId: string
  worktreePath: string
  browser: string
  status: 'active' | 'stale' | 'closed' | 'error'
  agentId?: string
  managerId?: string
  updatedAt: string
  ...
}

export interface PlaywrightSessionsUpdateEvent {
  type: 'playwright_sessions_update'
  sessions: PlaywrightSessionRecord[]
  updatedAt: string
}
```

Then include it in `ServerEvent`.

### UI state shape

Integration point:

- `apps/ui/src/lib/ws-state.ts`

Add fields such as:

```ts
playwrightSessions: PlaywrightSessionRecord[]
playwrightSessionsUpdatedAt: string | null
```

### WS client switch handling

Integration point:

- `apps/ui/src/lib/ws-client.ts`

Add:

```ts
case 'playwright_sessions_update':
  this.updateState({
    playwrightSessions: event.sessions,
    playwrightSessionsUpdatedAt: event.updatedAt,
  })
  break
```

### Component consumption

Integration point:

- `apps/ui/src/routes/index.tsx`
- or a new `apps/ui/src/components/playwright/PlaywrightDashboardView.tsx`

Use `state.playwrightSessions` from the existing `useWsConnection()` state.

## 4.5 Important recommendation: use full snapshots, not incremental patches

The existing UI favors **replace-whole-collection snapshot events**:

- `agents_snapshot`
- `profiles_snapshot`

That pattern is simpler and more resilient to reconnects.

For Playwright, I recommend either:

- keep the event name `playwright_sessions_update` but send the **entire snapshot**, or
- rename it to `playwright_sessions_snapshot`

Either is fine, but **full replacement** is strongly preferred over patch/delta logic.

## 4.6 Initial-load recommendation

Do not rely only on “changes after connection.” The dashboard needs a snapshot immediately.

Best approach:

- backend sends `playwright_sessions_update` soon after connection/subscription, and whenever the tracked sessions change
- optional REST endpoint still useful for manual refresh or initial fetch if backend WS timing is not guaranteed

---

## 5. Settings / toggle patterns

## 5.1 Current settings structure

File: `apps/ui/src/components/chat/SettingsDialog.tsx`

```tsx
export function SettingsPanel(...) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')

  return (
    <SettingsLayout activeTab={activeTab} onTabChange={setActiveTab} onBack={onBack}>
      {activeTab === 'general' && <SettingsGeneral wsUrl={wsUrl} />}
      {activeTab === 'notifications' && <SettingsNotifications managers={managers} />}
      {activeTab === 'auth' && <SettingsAuth wsUrl={wsUrl} />}
      {activeTab === 'integrations' && <SettingsIntegrations ... />}
      {activeTab === 'skills' && <SettingsSkills wsUrl={wsUrl} />}
    </SettingsLayout>
  )
}
```

Settings tabs live in:

- `apps/ui/src/components/settings/SettingsLayout.tsx`
- `apps/ui/src/components/chat/SettingsDialog.tsx`

### Recommendation for feature toggle placement

For a single “Playwright Dashboard enabled” toggle, **put it in `SettingsGeneral.tsx`** under a new section such as “Experimental features” or “Tools”.

If Playwright gets many controls later (scan roots, stale threshold, auto-refresh, show orphan sessions, etc.), create a dedicated settings tab/component later.

## 5.2 Existing toggle UI pattern

File: `apps/ui/src/components/settings/SettingsIntegrations.tsx`

```tsx
function ToggleRow({ label, description, checked, onChange }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-border/70 p-3">
      <div className="min-w-0 space-y-1">
        <Label ...>{label}</Label>
        {description ? <p className="text-[11px] text-muted-foreground">{description}</p> : null}
      </div>
      <Switch id={switchId} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}
```

File: `apps/ui/src/components/settings/SettingsNotifications.tsx`

```tsx
<Switch
  checked={store.globalEnabled}
  onCheckedChange={handleGlobalToggle}
/>
```

This is the right UI pattern to reuse.

## 5.3 Existing settings API pattern

Settings are not managed over WS. They use REST helpers in:

- `apps/ui/src/components/settings/settings-api.ts`

Examples:

```ts
export async function fetchSettingsEnvVariables(wsUrl: string): Promise<SettingsEnvVariable[]> {
  const endpoint = resolveApiEndpoint(wsUrl, '/api/settings/env')
  const response = await fetch(endpoint)
  ...
}
```

```ts
export async function updateSlackSettings(wsUrl: string, managerId: string, patch: Record<string, unknown>)
```

### Recommendation for Playwright toggle API

Add a tiny settings API helper, e.g.:

- `fetchPlaywrightSettings(wsUrl)`
- `updatePlaywrightSettings(wsUrl, patch)`

Possible endpoint:

- `/api/settings/playwright`

or a broader general settings endpoint if one is being introduced anyway.

## 5.4 Env var gotcha: Vite env is build-time only

Current UI env usage is very limited.

Files:

- `apps/ui/src/routes/index.tsx`
- `apps/ui/src/lib/feedback-client.ts`
- `apps/ui/vite.config.ts`

Main example:

```ts
const wsUrl = import.meta.env.VITE_MIDDLEMAN_WS_URL ?? resolveDefaultWsUrl()
```

### Important consequence

If you want a “Playwright Dashboard enabled” flag that the user can toggle in Settings, **do not make the UI depend directly on a new `VITE_*` env var** for runtime behavior. That would be build-time/static.

### Best toggle model

Use a layered model:

1. **Server env var** controls availability/default:
   - e.g. `MIDDLEMAN_ENABLE_PLAYWRIGHT_DASHBOARD=true`
2. Backend exposes effective state to the UI via REST or WS.
3. UI toggle writes persisted runtime config through REST.

Suggested semantics:

- if env var is false/off: feature hidden or disabled with explanation
- if env var is true/on: feature may be toggled in Settings

### Best UI placement for toggle

`apps/ui/src/components/settings/SettingsGeneral.tsx`

Add a section like:

- Experimental Features
  - Playwright Dashboard [Switch]
  - helper text: “Discover browser sessions across worktrees and correlate them with agents.”

---

## 6. UI primitives available vs missing

## 6.1 Present in `apps/ui/src/components/ui/`

Installed/available now:

- `badge.tsx`
- `button.tsx`
- `checkbox.tsx`
- `context-menu.tsx`
- `dialog.tsx`
- `dropdown-menu.tsx`
- `input.tsx`
- `label.tsx`
- `popover.tsx`
- `scroll-area.tsx`
- `select.tsx`
- `separator.tsx`
- `switch.tsx`
- `tabs.tsx`
- `textarea.tsx`
- `tooltip.tsx`

## 6.2 Reusable for Playwright dashboard immediately

Good enough for v1:

- `Badge` for session status / stale / orphaned / attached
- `Button` for refresh / attach / inspect / kill / open
- `Input` for search/filter
- `Select` for status/worktree/grouping filters
- `Tabs` if you split Sessions / Worktrees / Agents
- `ScrollArea` for scrollable session lists
- `Switch` for feature toggle and maybe “show stale only” or “group by worktree” options
- `Checkbox` for multi-filter worktree or status selection
- `Dialog` for destructive/confirm actions
- `Popover` or `DropdownMenu` for row actions
- `Tooltip` for full paths / timestamps / agent correlation info

## 6.3 Missing primitives worth adding

Notably absent from `apps/ui/src/components/ui/`:

- `table.tsx`
- `card.tsx`
- `skeleton.tsx`
- `alert.tsx`
- `sheet.tsx` / `drawer.tsx`

### Recommendation

For a good dashboard implementation, I would add at least:

- `table`
- `card`
- `skeleton`

Potential command from `apps/ui`:

```bash
pnpm dlx shadcn@latest add table card skeleton
```

### Gotcha

Project docs in `AGENTS.md` mention `card` as already installed, but there is **no `apps/ui/src/components/ui/card.tsx` in the current tree**. Treat `card` as effectively missing.

---

## 7. State management model

## 7.1 No Zustand / Redux / global app context

There is no app-wide state library in use.

Current model:

- `IndexPage` owns shell-level React state
- `ManagerWsClient` is an external imperative store with subscribe/listener semantics
- feature-specific components own their own `useState`
- some preferences persist in `localStorage`

Files showing this:

- `apps/ui/src/routes/index.tsx`
- `apps/ui/src/hooks/index-page/use-ws-connection.ts`
- `apps/ui/src/lib/ws-client.ts`
- `apps/ui/src/lib/theme.ts`
- `apps/ui/src/components/chat/MessageInput.tsx`
- `apps/ui/src/components/chat/cortex/CortexDashboardPanel.tsx`
- `apps/ui/src/components/settings/SettingsNotifications.tsx`

## 7.2 Examples of local persisted UI state

- theme preference: `apps/ui/src/lib/theme.ts`
- message drafts: `apps/ui/src/components/chat/MessageInput.tsx`
- attachment drafts: `apps/ui/src/components/chat/MessageInput.tsx`
- Cortex panel width: `apps/ui/src/components/chat/cortex/CortexDashboardPanel.tsx`
- notification preferences: `apps/ui/src/lib/notification-service.ts` (indirectly via settings)

### Recommendation for Playwright dashboard state

Split state into two layers:

#### Global/live state in WS store

Put in `ManagerWsState` if any of the following are true:

- other views need it
- unread/summary badges may depend on it
- you want live updates even when dashboard is not mounted
- backend pushes updates frequently

Suggested WS-backed state:

- discovered sessions snapshot
- last updated timestamp
- maybe health/scan status

#### Local view state in the dashboard component

Keep local in the Playwright dashboard component:

- search query
- selected worktree filter
- selected session row
- sort mode
- collapsed groups
- transient dialog open state

This mirrors the current architecture well.

---

## 8. Theme/styling system

File: `apps/ui/src/styles.css`

### Core tokens available

```css
:root {
  --background: #f8f5f0;
  --foreground: #3e2723;
  --card: #f8f5f0;
  --primary: #2e7d32;
  --secondary: #b6d3b8;
  --muted: #f0e9e0;
  --accent: #8aba8e;
  --destructive: #c62828;
  --border: #e0d6c9;
  --sidebar: #fcfaf8;
  --sidebar-foreground: #3e2723;
  ...
}
```

Dark theme equivalents are also defined under `.dark`.

### Tailwind v4 theme mapping

```css
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-primary: var(--primary);
  --color-muted: var(--muted);
  --color-border: var(--border);
  --color-sidebar: var(--sidebar);
  ...
}
```

### Layout constraints

```css
html,
body {
  height: 100dvh;
  font-family: var(--font-sans), "Segoe UI", sans-serif;
  overflow: hidden;
}
```

### Styling recommendations for Playwright dashboard

Use existing tokens/classes rather than introducing custom colors:

- page/surface: `bg-background`, `bg-card/50`, `bg-card/80`
- borders: `border-border`, `border-border/60`, `border-border/80`
- secondary text: `text-muted-foreground`
- success-ish status: emerald classes already used throughout
- warning/stale: amber classes
- error: destructive/red classes
- info/linked: blue or primary

### Example palette already in use

- success badges: `border-emerald-500/30 bg-emerald-500/10`
- warning badges: `border-amber-500/30 bg-amber-500/10`
- destructive banners: `border-destructive/20 bg-destructive/10`
- subtle surfaces: `bg-muted/30`, `bg-muted/60`, `bg-card/50`

### Gotcha

Because the shell is `overflow-hidden`, every tall dashboard subregion must opt into its own scrolling with:

- `min-h-0`
- `overflow-y-auto`
- and/or `ScrollArea`

---

## 9. Specific implementation recommendations

## 9.1 Recommended file additions

### New UI view/component files

Suggested new files:

- `apps/ui/src/components/playwright/PlaywrightDashboardView.tsx`
- `apps/ui/src/components/playwright/PlaywrightSummaryCards.tsx`
- `apps/ui/src/components/playwright/PlaywrightSessionList.tsx`
- `apps/ui/src/components/playwright/PlaywrightSessionRow.tsx`
- `apps/ui/src/components/playwright/PlaywrightFilters.tsx`
- optional: `apps/ui/src/components/playwright/PlaywrightSessionDetailPanel.tsx`
- optional: `apps/ui/src/components/playwright/playwright-types.ts`
- optional: `apps/ui/src/components/playwright/playwright-api.ts`

### Existing files to modify

- `apps/ui/src/hooks/index-page/use-route-state.ts`
- `apps/ui/src/routes/index.tsx`
- `apps/ui/src/components/chat/AgentSidebar.tsx`
- `apps/ui/src/components/settings/SettingsGeneral.tsx`
- `apps/ui/src/components/settings/settings-api.ts`
- `apps/ui/src/lib/ws-state.ts`
- `apps/ui/src/lib/ws-client.ts`
- `packages/protocol/src/server-events.ts`
- optionally `packages/protocol/src/shared-types.ts` if the dashboard record types should be shared

## 9.2 Recommended center-pane integration in `index.tsx`

Today:

```tsx
{activeView === 'settings' ? (
  <SettingsPanel ... />
) : (
  <>
    <ChatHeader ... />
    <MessageList ... />
    <MessageInput ... />
  </>
)}
```

Recommended shape:

```tsx
{activeView === 'settings' ? (
  <SettingsPanel ... />
) : activeView === 'playwright' ? (
  <PlaywrightDashboardView
    wsUrl={wsUrl}
    sessions={state.playwrightSessions}
    agents={state.agents}
    profiles={state.profiles}
    statuses={state.statuses}
    connected={state.connected}
  />
) : (
  <>
    <ChatHeader ... />
    <MessageList ... />
    <MessageInput ... />
  </>
)}
```

And disable the existing right drawer while on the Playwright view, just like Settings already does.

## 9.3 Recommended route-state extension

File: `apps/ui/src/hooks/index-page/use-route-state.ts`

Add:

- `ActiveView = 'chat' | 'settings' | 'playwright'`
- `AppRouteState | { view: 'playwright' }`
- parsing for `search.view === 'playwright'`
- optionally pathname parsing if you want `/playwright` compatibility in the manual parser

### Strong recommendation

Use `?view=playwright` first, because current `navigateToRoute()` always navigates to `to: '/'`.

---

## 10. How to correlate Playwright sessions with agents

Relevant existing shared data is already available client-side through WS:

File: `packages/protocol/src/shared-types.ts`

```ts
export interface AgentDescriptor {
  agentId: string
  managerId: string
  displayName: string
  role: 'manager' | 'worker'
  status: AgentStatus
  cwd: string
  sessionFile: string
  profileId?: string
  sessionLabel?: string
  ...
}
```

This is enough for a first-pass correlation if backend emits Playwright sessions with:

- worktree/cwd-ish path
- maybe owning `agentId`/`managerId`
- maybe session file or manager cwd

### UI recommendation

Have backend do as much correlation as possible, then send the correlated fields directly. The UI should not have to reconstruct ownership heuristically from raw filesystem paths if avoidable.

Suggested dashboard row fields:

- browser/session id
- worktree path
- freshness / stale age
- manager name / profile name
- linked agent/session label
- agent status
- quick actions

---

## 11. Suggested quick actions UI

Existing reusable patterns:

- `DropdownMenu` from `apps/ui/src/components/ui/dropdown-menu.tsx`
- `ContextMenu` from `apps/ui/src/components/ui/context-menu.tsx`
- `Dialog` for confirm flows
- small icon buttons from `Button`

### Recommended action style

For each Playwright row:

- primary visible action(s): maybe `Open`, `Attach`, `Reveal`, `Inspect`
- overflow menu for secondary/destructive actions

Example inspiration:

- `ChatHeader` three-dot dropdown (`apps/ui/src/components/chat/ChatHeader.tsx`)
- row hover action buttons in `ReviewStatusPanel.tsx`

---

## 12. Constraints and gotchas

### 12.1 The app is not really route-driven yet

Even though TanStack Router is present, the app shell is effectively a single-page controller inside `IndexPage`.

**Consequence:** a brand-new file route is a larger refactor than it looks.

### 12.2 `routeTree.gen.ts` is generated

Do not hand-edit:

- `apps/ui/src/routeTree.gen.ts`

If you later add a real route file, regenerate route tree normally.

### 12.3 `body` and shell use overflow-hidden

If the new dashboard forgets `min-h-0`/scroll containers, it will clip or create broken nested scroll behavior.

### 12.4 WS reconnect forces page reload

File: `apps/ui/src/lib/ws-client.ts`

There is reconnect logic that can trigger a full window reload after reconnect:

```ts
if (shouldReload && typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
  window.location.reload()
}
```

**Consequence:** any purely in-memory Playwright dashboard filters/sort state will be lost on reconnect unless persisted in search params or `localStorage`.

### 12.5 Conversation events are agent-scoped; global events are not

Files like `ws-client.ts` ignore conversation entries unless `event.agentId === this.state.targetAgentId`.

**Consequence:** make Playwright events global snapshot events, not conversation-style agent events.

### 12.6 No React Query / SWR / data cache layer

Everything is manual `useEffect` + `fetch` + `AbortController`.

**Consequence:** follow the existing style; do not assume cache invalidation helpers already exist.

### 12.7 Right drawer is already occupied conceptually

The right side is currently reserved for:

- artifacts
- Cortex dashboard

Using it for Playwright would muddy the information architecture.

### 12.8 Sidebar tree is session-centric, not tool-centric

`AgentSidebar` is a profile/session/worker tree built via `buildProfileTreeRows()`.

**Consequence:** the Playwright entry should be a separate global nav affordance, not jammed into the session tree.

### 12.9 UI primitive mismatch in repo docs

Docs mention some installed shadcn components that are not actually present in `apps/ui/src/components/ui/` right now.

**Consequence:** verify before assuming a primitive exists.

---

## 13. Final recommendation summary

## Best architecture for the new Playwright dashboard

### Placement

- **Main center-pane app view** inside `apps/ui/src/routes/index.tsx`
- navigated via `use-route-state.ts`
- launched from a new footer/sidebar nav button in `AgentSidebar.tsx`

### Real-time data

- extend `packages/protocol/src/server-events.ts`
- extend `apps/ui/src/lib/ws-state.ts`
- handle new event in `apps/ui/src/lib/ws-client.ts`
- prefer full snapshot events over deltas

### Feature toggle

- add a new section to `apps/ui/src/components/settings/SettingsGeneral.tsx`
- use `Switch`
- store via new REST helpers in `apps/ui/src/components/settings/settings-api.ts`
- backend env var should gate/expose the runtime setting; do not rely on client `VITE_*` flags for this

### Reuse these patterns

- `SettingsSection` / `SettingsWithCTA` for structured blocks
- `ReviewStatusPanel` for compact status-list composition
- `ArtifactsSidebar` / `CortexDashboardPanel` for tabs + scrollable secondary surfaces
- `Badge` status colors used across auth/integrations/review
- `ScrollArea` for large lists
- `DropdownMenu` / `Dialog` for row actions

### Components likely worth adding

- shadcn `table`
- shadcn `card`
- shadcn `skeleton`

### Avoid

- implementing it as the existing right drawer
- starting with a fully separate file route without first extracting a shared shell
- using build-time-only `VITE_*` env flags as the primary feature toggle mechanism

---

## Minimal integration map

### Routing / shell
- `apps/ui/src/hooks/index-page/use-route-state.ts`
- `apps/ui/src/routes/index.tsx`
- `apps/ui/src/components/chat/AgentSidebar.tsx`

### Real-time data
- `packages/protocol/src/server-events.ts`
- `apps/ui/src/lib/ws-state.ts`
- `apps/ui/src/lib/ws-client.ts`
- `apps/ui/src/hooks/index-page/use-ws-connection.ts`

### Settings / feature flag
- `apps/ui/src/components/settings/SettingsGeneral.tsx`
- `apps/ui/src/components/settings/settings-api.ts`
- optionally `apps/ui/src/components/settings/settings-types.ts`

### New dashboard UI
- `apps/ui/src/components/playwright/*`

### Styling / primitives
- `apps/ui/src/styles.css`
- `apps/ui/src/components/ui/*`

This should give the design/implementation pass a stable path that fits the current frontend architecture without forcing a large routing rewrite first.
