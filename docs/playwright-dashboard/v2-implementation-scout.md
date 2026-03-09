# Playwright Dashboard V2 Implementation Scout

## Executive summary

Two separate tracks are clear from the current codebase:

1. **Immediate UX tweak:** hide `inactive` and `stale` dashboard rows by default, with explicit toggles to reveal them.
2. **Future V2 live preview:** there is already a solid discovery/data foundation, but no preview transport, no preview-specific protocol/events, and no session-detail UI surface yet.

My recommendation: **implement the small default-filter tweak immediately, in the same dashboard-focused branch as this research artifact**, because it is isolated, frontend-only, and does not constrain the V2 preview architecture.

---

## 1) Exact files for the current default-filter tweak

### Primary files to change

#### `apps/ui/src/components/playwright/PlaywrightDashboardView.tsx`
Current responsibilities already live here:
- `INITIAL_FILTERS` (`~line 36`)
- local filter state via `useState` (`~line 51`)
- the `filteredSessions` `useMemo` (`~line 94`)
- wiring `PlaywrightFilters` into the page (`~line 317`)
- `FilteredEmptyState` reset behavior (`~line 332`)

This is the main place to:
- add new filter booleans
- change the default filter state
- update the row-filtering logic
- ensure “Clear Filters” resets to the new default behavior

#### `apps/ui/src/components/playwright/PlaywrightFilters.tsx`
Current responsibilities already live here:
- `PlaywrightDashboardFiltersState` type (`~line 17`)
- filter controls UI
- existing switches for `onlyCorrelated` and `onlyPreferred`
- existing status select (`~line 70`)

This is the place to:
- extend the filter state shape with `showInactive` and `showStale`
- render the two new toggles
- keep the rest of the controls unchanged

### Optional small polish file

#### `apps/ui/src/components/playwright/PlaywrightDashboardView.tsx`
Same file as above; optional copy-only adjustment in `FilteredEmptyState` so the empty message is less confusing when rows are hidden by default.

Example:
- current: “No sessions match the current filters.”
- better: “No sessions match the current filters. Inactive and stale sessions are hidden by default.”

### Files that do **not** need changes for the tweak

No backend/protocol changes are required for this default-filter tweak.

Relevant existing data is already present:
- `packages/protocol/src/playwright.ts`
  - `PlaywrightSessionLiveness`
  - `PlaywrightDiscoveredSession.liveness`
  - `PlaywrightDiscoveredSession.stale`
- `apps/backend/src/playwright/playwright-discovery-service.ts`
  - already classifies each row as `active | inactive | stale | error`
- `apps/backend/src/ws/routes/playwright-routes.ts`
  - already returns full snapshots

---

## 2) Proposed toggle behavior and defaults

## Recommended behavior

Add two booleans to `PlaywrightDashboardFiltersState`:
- `showInactive: boolean`
- `showStale: boolean`

### Recommended defaults
- `showInactive = false`
- `showStale = false`

Everything else can remain as-is:
- `search = ''`
- `status = 'all'`
- `worktree = 'all'`
- `onlyCorrelated = false`
- `onlyPreferred = false`

### Resulting default view
On first open, the dashboard should show:
- `active` rows
- `error` rows

And hide:
- `inactive` rows
- `stale` rows

That makes the dashboard more meaningful by default without discarding the underlying data. The summary bar can still show the full counts, including stale/inactive totals.

### Interaction with the existing status filter
To minimize churn, keep the current status select.

Recommended precedence:
- If `status === 'all'`, apply the new hide/show toggles:
  - hide `inactive` unless `showInactive` is on
  - hide `stale` unless `showStale` is on
- If `status === 'inactive'`, explicitly show inactive rows regardless of `showInactive`
- If `status === 'stale'`, explicitly show stale rows regardless of `showStale`
- `active` and `error` status selections continue to work normally

That preserves the current status dropdown while making the default `all` view more useful.

### UI placement
Best low-risk placement: add the two new switches in `PlaywrightFilters.tsx` next to the existing:
- `Correlated only`
- `Preferred only`

Suggested labels:
- `Show inactive`
- `Show stale`

### Clear filters behavior
`Clear Filters` should reset back to the new defaults, not to “show everything.”

That means clearing filters still hides stale/inactive rows by default.

---

## 3) Concise implementation plan for the tweak

### Files to modify

1. `apps/ui/src/components/playwright/PlaywrightDashboardView.tsx`
2. `apps/ui/src/components/playwright/PlaywrightFilters.tsx`

### Likely code changes

#### In `PlaywrightFilters.tsx`
- extend `PlaywrightDashboardFiltersState`:
  - `showInactive: boolean`
  - `showStale: boolean`
- add two `Switch` + `Label` controls
- wire them through `onFiltersChange`

#### In `PlaywrightDashboardView.tsx`
- extend `INITIAL_FILTERS`
- update `filteredSessions` logic
- optional: improve filtered-empty copy

Pseudo-logic for the new default `all` view:

```ts
if (filters.status === 'all') {
  sessions = sessions.filter((s) => {
    if (s.liveness === 'inactive') return filters.showInactive
    if (s.liveness === 'stale') return filters.showStale
    return true // active + error remain visible
  })
} else {
  sessions = sessions.filter((s) => s.liveness === filters.status)
}
```

### Backend implications

**None required.**

The backend already supplies:
- per-row liveness
- stale classification
- full snapshot refresh over HTTP + WS

This is purely a client-side presentation change.

### Validation steps

#### Manual validation
1. Open dashboard with a snapshot containing a mix of `active`, `inactive`, `stale`, and `error` rows.
2. Confirm default load shows active/error only.
3. Confirm summary bar still reports stale/inactive counts.
4. Toggle `Show inactive` on → inactive rows appear.
5. Toggle `Show stale` on → stale rows appear.
6. Turn both back off → rows hide again without requiring rescan.
7. Confirm explicit status filter still works for `inactive` and `stale`.
8. Confirm `Clear Filters` resets to hidden stale/inactive defaults.
9. Confirm rescan does not break local filter state.

#### Repo checks
- `pnpm exec tsc --noEmit`
- optional UI smoke pass in the Playwright dashboard itself

### Testability note
There do not appear to be existing UI tests for `apps/ui/src/components/playwright/*` right now. If someone wants coverage, the cleanest path would be to extract the row filtering into a tiny pure helper and add a Vitest unit test around the filter combinations.

---

## 4) Current implementation surface area for a future V2 live preview

## What already exists and is reusable

### Frontend shell and route integration

#### `apps/ui/src/routes/index.tsx`
Current integration points:
- opens the dashboard view (`~line 552`)
- stores `playwrightSnapshot` and `playwrightSettings` in page state (`~lines 555-570`)
- renders `PlaywrightDashboardView` (`~line 654`)

This is the top-level place where a future preview panel/detail state would plug in.

#### `apps/ui/src/lib/ws-state.ts`
Already has app-global state for:
- `playwrightSnapshot`
- `playwrightSettings`

If V2 adds preview session state, this file is a natural place for client-held preview state only if preview becomes globally streamed over WS. If preview is on-demand per selected session via HTTP, this file may not need expansion.

#### `apps/ui/src/components/playwright/PlaywrightDashboardView.tsx`
Natural place for:
- selected-row state
- opening a detail pane/sheet
- preview toolbar / refresh cadence controls
- fallback preview surfaces

#### `apps/ui/src/components/playwright/PlaywrightSessionCard.tsx`
Natural place for:
- “Open preview” action
- current URL badge
- last screenshot thumbnail
- session detail affordances

### Existing protocol/data foundation

#### `packages/protocol/src/playwright.ts`
Already exposes useful preview-adjacent fields:
- `PlaywrightDiscoveredSession.id`
- `ports.cdp`
- `cdpResponsive`
- artifact counts
- filesystem/session identity metadata

This is the correct place to add future preview-specific types, such as:
- preview metadata response
- live preview status
- current page URL/title/tab list
- screenshot freshness metadata

#### `packages/protocol/src/server-events.ts`
Current dashboard WS events are already defined here:
- `playwright_discovery_snapshot`
- `playwright_discovery_updated`
- `playwright_discovery_settings_updated`

If V2 uses WS for preview refresh, new event types should be added here instead of overloading the discovery snapshot events.

### Existing backend routing / transport

#### `apps/backend/src/ws/routes/playwright-routes.ts`
Current endpoints:
- `GET /api/playwright/sessions`
- `POST /api/playwright/rescan`
- `GET/PUT /api/settings/playwright`

This is the most obvious place to add preview-related HTTP endpoints, for example:
- `GET /api/playwright/sessions/:sessionId/preview`
- `POST /api/playwright/sessions/:sessionId/preview/snapshot`
- `GET /api/playwright/sessions/:sessionId/page`

#### `apps/backend/src/ws/server.ts`
Already listens to Playwright discovery events and broadcasts them.
If V2 adds live preview WS events, they would need to be registered here the same way discovery events are.

#### `apps/backend/src/ws/ws-handler.ts`
Currently bootstraps Playwright snapshot + settings during WS connect.
If preview becomes subscription-oriented, this is where preview bootstrap or preview subscription commands would eventually hook in.

### Existing backend discovery service

#### `apps/backend/src/playwright/playwright-discovery-service.ts`
This is the main V2 dependency because it already does the hard part of session discovery:
- scans `.playwright-cli` roots
- resolves worktrees
- reads `.session` files
- extracts `cdp` port
- probes `/json/version` for CDP reachability
- correlates sessions to agents
- watches filesystem changes

This service already knows enough to identify candidate rows for preview.

### Existing generic file-serving path

#### `apps/backend/src/ws/routes/file-routes.ts`
Existing `GET/POST /api/read-file` can already serve:
- `.png` screenshots
- `.yml` page snapshots
- logs

#### `apps/ui/src/components/chat/ArtifactPanel.tsx`
Already supports:
- image preview
- markdown rendering
- code/text display

This is useful for a **fallback or phase-1 static preview** story, where clicking a session opens the most recent saved screenshot or page snapshot file. It is **not** enough for true live preview by itself, but it is reusable.

---

## 5) Gaps and dependencies for V2 live preview

## Main gaps

### 1. No preview-specific backend service yet
There is no current service that:
- resolves current tabs/pages from a live CDP target
- captures a screenshot on demand
- streams preview frames/metadata
- caches preview results
- tracks preview subscriptions

A new backend module is likely needed, e.g.:
- `apps/backend/src/playwright/playwright-preview-service.ts`

### 2. Current discovery service only does liveness probing, not rich preview extraction
`playwright-discovery-service.ts` currently only verifies CDP responsiveness with:
- `http://127.0.0.1:<cdpPort>/json/version`

It does **not** surface richer preview data like:
- current URL
- page title
- tab list
- screenshot bytes
- websocket debugger endpoint

It also defines `cdpHeaders` in the raw session shape but does not currently persist or expose them, which may matter if some environments require headers for CDP access.

### 3. No preview protocol types yet
There are no typed contracts yet for:
- preview metadata payloads
- screenshot responses
- preview WS events
- selected-session preview state

### 4. No UI selection/detail surface yet
The dashboard is currently a grid-only surface.
There is no:
- selected session state
- side panel / modal / detail route
- image canvas/thumbnail region
- current URL/title display
- preview error/loading state

### 5. Snapshot WS is the wrong transport for high-frequency preview
Current WS events broadcast full discovery snapshots to all subscribed dashboard clients.
That is fine for inventory changes, but not for fast preview updates.

For V2 preview, reusing full snapshot events would likely be wasteful and noisy. Preview should use either:
- **on-demand HTTP** for initial metadata + screenshot fetches, with client polling, or
- **dedicated preview WS events** scoped to a selected session

## Likely external/runtime dependency
A true live preview will probably need one of:
- direct HTTP calls to Chrome DevTools endpoints (`/json/version`, `/json/list`, etc.) plus screenshot capture via CDP websocket
- or a Playwright-based backend helper attached to the existing browser/debug port

There is no dedicated CDP client dependency in the repo today. The backend only has generic `ws`, so implementing preview likely means either:
- lightweight custom CDP websocket handling, or
- adding a dedicated CDP/automation dependency

---

## 6) Recommended V2 integration points

## Recommended frontend plug-in points

### Primary UI files
- `apps/ui/src/components/playwright/PlaywrightDashboardView.tsx`
  - own selected session state and layout split
- `apps/ui/src/components/playwright/PlaywrightSessionCard.tsx`
  - open/select preview target
- new file likely needed:
  - `apps/ui/src/components/playwright/PlaywrightPreviewPanel.tsx`
- optional supporting files:
  - `apps/ui/src/components/playwright/playwright-preview-api.ts`
  - `apps/ui/src/components/playwright/PlaywrightSessionDetailSheet.tsx`

### Why this is the cleanest fit
The dashboard already owns inventory filtering and display. Adding preview as a drill-down inside the same view is lower-churn than trying to route it through chat/artifacts/settings.

## Recommended backend plug-in points

### Primary backend files
- `apps/backend/src/playwright/playwright-discovery-service.ts`
  - source of session identity + CDP port lookup
- `apps/backend/src/ws/routes/playwright-routes.ts`
  - add preview HTTP endpoints
- new backend module likely needed:
  - `apps/backend/src/playwright/playwright-preview-service.ts`
- `apps/backend/src/ws/server.ts`
  - register preview events if WS-based
- `apps/backend/src/ws/ws-handler.ts`
  - bootstrap / preview subscription wiring if WS-based

## Recommended protocol files
- `packages/protocol/src/playwright.ts`
  - add preview request/response types
- `packages/protocol/src/server-events.ts`
  - add preview WS events if needed

---

## 7) Suggested phased plan from here

## Phase 0 — land the immediate dashboard tweak
Scope:
- hide stale/inactive by default
- add `Show inactive` and `Show stale`
- no backend changes

Why first:
- very small
- high value immediately
- reduces dashboard noise before any V2 work

## Phase 1 — V2 design spike on preview transport
Goal:
- decide between polling HTTP vs dedicated preview WS
- decide whether to use raw CDP endpoints or a higher-level backend helper
- decide preview UX shape: inline panel vs right-side sheet

Recommended output:
- short design note with route/event contracts and throttling limits

## Phase 2 — static/detail preview MVP
Goal:
- add session selection
- add detail panel with metadata
- reuse `/api/read-file` + existing artifacts for last screenshot/page snapshot fallback

Why:
- delivers visible value before full live preview
- exercises UI shape without CDP complexity

## Phase 3 — live metadata endpoint
Goal:
- backend endpoint for current URL/title/tab list from live CDP session
- show “live page info” in the detail panel

Likely files:
- `playwright-preview-service.ts`
- `playwright-routes.ts`
- `packages/protocol/src/playwright.ts`
- new preview API/UI component files

## Phase 4 — screenshot capture / live frame refresh
Goal:
- on-demand screenshot capture for selected session
- throttled refresh loop or dedicated WS stream

Important constraint:
- keep this separate from full discovery snapshot broadcasting

## Phase 5 — polish / controls
Possible add-ons:
- open frontend URL shortcut
- copy current URL
- preview refresh interval control
- tab picker if multiple targets exist

---

## 8) Recommendation on branching

**Yes — implement the small default-filter tweak immediately in the same branch as these V2 research artifacts, if the branch is already dashboard-focused.**

Reasoning:
- it is isolated to the current dashboard UI
- it requires no protocol/backend changes
- it improves the dashboard immediately
- it does not lock in the V2 preview transport design

What I would **not** do in that same branch:
- start preview transport scaffolding
- add partial CDP plumbing without a design pass
- mix the small filter tweak with speculative V2 backend work

Best split:
1. land the small filter tweak now
2. keep the rest of this branch/doc work as research/planning
3. start V2 preview implementation only after a short transport/UX decision
