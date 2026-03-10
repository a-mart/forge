# Live Preview `Connected` + `No tabs open` Investigation — Backend / Controller Protocol

Date: 2026-03-09

## Update after `926ff6a`

`926ff6a` fixed the proxy replay classifier so buffered controller messages can be recognized when the upstream uses JSON-RPC-style `method` events instead of `type` events.

That was a real bug, but the **user still seeing the same behavior on main means it was not the dominant failure**.

The new evidence sharpens the picture:

- **Expanded view still shows `Connected` + `No tabs open`**
- **Tile view still spins forever**
- **A ghost `default` tile appears as active**

Taken together, the best backend read is now:

1. **Expanded no-tabs is still primarily an initial bootstrap problem**
   - connection succeeds
   - but no initial tab state gets established
2. **Ghost `default` strongly suggests duplicate/shared-socket session handling is still wrong**
   - the backend is surfacing the wrong session representative as active/previewable
3. **Tile spinners are no longer a strong backend signal by themselves**
   - there is likely a separate parent-UI deadlock in tile rendering
   - but the ghost duplicate session still points to a backend discovery/selection bug

---

## Highest-confidence conclusions

## 1. The method-style replay fix was necessary but insufficient

`apps/backend/src/playwright/playwright-live-preview-proxy.ts` now recognizes both:

- `type: 'tabs' | 'frame'`
- `method: 'tabs' | 'frame'`

So the proxy can now buffer/replay previously seen tab/frame events.

However, the current symptom persisting on main means the real failing step is now more likely this:

- the controller connection opens
- **but the upstream never supplies an initial usable tab state to replay**
- or no tab ever becomes selected for the detail view

In other words, replay logic helps only if the upstream already emitted the needed state.

If no initial `tabs` state is proactively fetched/selected, the detail view can still land in:

- `Connected`
- `No tabs open`

---

## 2. Expanded-view `Connected` + `No tabs open` still points to missing tab bootstrap

This remains the best explanation for the split/focus preview symptom.

From the vendored app behavior:

- the detail view connects to the controller successfully
- status text becomes `Connected` on socket open
- tab/UI state is derived from `tabs` data
- if no selected tab is known, the viewport says `No tabs open`

The important part is that **the selected-session path still does not appear to guarantee its own initial bootstrap**.

So after `926ff6a`, the most likely exact failing step is now:

1. client attaches to controller proxy
2. controller socket opens
3. no buffered `tabs` event exists yet
4. no server-side bootstrap request is issued
5. no selected tab is established
6. UI shows `Connected` + `No tabs open`

### What this means

At this point, the best backend-only fix is **not more replay logic**.

It is:

- **active first-client bootstrap** on the proxy channel
- not passive replay-only behavior

Specifically:

- when the first downstream client joins and `lastTabsMessage` is still empty,
- the proxy should actively call upstream `tabs()`
- and if necessary follow with `selectTab({ pageId })`
- then synthesize/broadcast a `tabs` event to the client(s)

That mirrors what the working grid/session-chip path already does in the vendored app.

---

## 3. The ghost `default` active tile is strong evidence that shared-socket duplicate handling is wrong

This is the strongest new backend signal from the latest report.

### Why

In `apps/backend/src/playwright/playwright-discovery-service.ts`:

- duplicate groups are formed by `duplicateGroupKey = socketPath ?? realPath`
- `preferredInDuplicateGroup` is chosen by timestamp ordering
- but **every socket-responsive session is still marked active/previewable**

Today, `preferredInDuplicateGroup` only affects:

- ordering
- counts in some summary calculations
- frontend opacity / frontend filtering in some views

It does **not** currently gate:

- liveness
- previewability
- `startPreview()` eligibility

So a shared-socket duplicate can still surface as a perfectly normal active session even if it is only a stale or secondary on-disk reference.

### Why `default` is suspicious specifically

The project research already established that Playwright `default` sessions across roots/worktrees can share the **same daemon socket**.

That means a visible active `default` tile can easily be:

- a shared-socket duplicate reference
- not the real intended session representative
- but still classified as active because the socket responds

That matches the user's new observation much better than a pure frontend rendering bug.

### Most likely backend issue here

**The backend is treating “socket is alive” as if every session file pointing at that socket is independently active/previewable.**

That is too permissive.

---

## 4. Why tiles can still spin even after the replay fix

This symptom now needs to be split into two parts.

### Part A — not a strong backend signal anymore

The current tile implementation in the parent UI likely has its own deadlock:

- it waits for an embed `active` postMessage
- but it does not keep the iframe mounted while waiting
- so the iframe may never get a chance to report active

That means **endless tile spinners do not, by themselves, prove the backend is still failing**.

### Part B — backend still contributes noise/confusion

The ghost `default` tile means the backend is still advertising at least one wrong session as active/previewable.

That matters because tiles eagerly auto-start previews for previewable sessions.

So even if the tile spinner itself is frontend-gated, the backend is still making the tile view worse by:

- surfacing the wrong duplicate representative
- or surfacing duplicate/shared-socket sessions as previewable at all

---

## Exact root causes now ranked

## Root cause A — highest confidence for expanded `No tabs open`

**Missing active bootstrap on first controller client attach.**

The proxy currently replays previously buffered state, but does not proactively initialize state when no `tabs` event has been seen yet.

### Exact failing step

In `apps/backend/src/playwright/playwright-live-preview-proxy.ts`:

- `handleProxyConnection()` adds client
- `replayBufferedMessages()` runs
- if `lastTabsMessage === null`, nothing else happens
- no server-side `tabs()` request is issued
- no fallback `selectTab()` is issued

That is the most likely exact backend step still missing on main.

---

## Root cause B — highest confidence for ghost `default` tile

**Shared-socket duplicate sessions are not being downgraded or filtered strongly enough.**

### Exact failing step

In `apps/backend/src/playwright/playwright-discovery-service.ts` and `apps/backend/src/playwright/playwright-live-preview-service.ts`:

- duplicate groups are identified
- a preferred session is chosen
- but non-preferred duplicates are still treated as active if the shared socket responds
- previewability does not currently depend on `preferredInDuplicateGroup`

So the backend can expose a stale/shadow duplicate as an active preview candidate.

---

## What is *not* the strongest explanation now

### Not primarily the method-vs-type replay classifier anymore

That is already fixed on main.

### Not primarily `/api/sessions/list` payload shape

The embedded compatibility payload still looks internally consistent.

### Not primarily session-key/public-key mismatch

If key mapping were broken, the embed would not reliably reach `Connected` for the selected session.

---

## Exact files likely needing change

## Priority 1 — proxy bootstrap on first client attach

### `apps/backend/src/playwright/playwright-live-preview-proxy.ts`

Add a real upstream bootstrap path.

#### Recommended changes

1. Add a small upstream JSON-RPC helper on the channel, e.g.:
   - `callUpstream(channel, method, params)`
2. On first downstream client attach, if `lastTabsMessage` is missing:
   - call upstream `tabs`
3. If tabs are returned and none is selected:
   - call upstream `selectTab({ pageId: firstTab.pageId })`
4. After the `tabs` result, synthesize/broadcast an event shaped the way the vendored client expects:
   - `{ method: 'tabs', params: result }`
5. Cache that synthetic event into `lastTabsMessage`

This is the cleanest backend-only fix for the surviving expanded-view failure.

---

## Priority 2 — tighten duplicate/shared-socket session eligibility

### `apps/backend/src/playwright/playwright-discovery-service.ts`

#### Recommended changes

1. Change previewability calculation so **non-preferred duplicates are not previewable**.
   - include explicit reason such as:
     - `Session <name> shares a Playwright daemon with a preferred duplicate`
2. Consider whether non-preferred duplicates should also stop being labeled `active`.
   - at minimum they should stop being preview candidates
3. Improve preferred duplicate selection.
   - current ordering is mostly timestamp-first
   - that is not robust enough for shared sockets
   - prefer a richer score using:
     - exact agent/worktree correlation
     - runtime env stack root match
     - live manager/worker cwd match
     - then timestamp recency as a tiebreaker

### `apps/backend/src/playwright/playwright-live-preview-service.ts`

#### Recommended changes

4. Enforce the same rule at preview start time.
   - if a session is a non-preferred duplicate, `startPreview()` should reject it
   - do not rely only on frontend filtering

This is the best backend fix for the ghost `default` tile evidence.

---

## Priority 3 — optional compatibility-route hardening

### `apps/backend/src/ws/routes/playwright-live-routes.ts`

Possible hardening:

1. When serving compatibility `sessions/list` outside a `previewId` context, only expose preferred duplicates.
2. Keep embedded `previewId` filtering strict to the selected preview session.

This is useful cleanup, but it is secondary to fixing discovery/previewability and first-client bootstrap.

---

## Regression coverage that should be added

### `apps/backend/src/test/playwright-routes-ws.test.ts`

Add tests for:

1. **First-client bootstrap with no prior replay buffer**
   - upstream channel has sent no prior `tabs` event
   - downstream client attaches
   - proxy actively fetches tabs and client receives usable tab state

2. **Bootstrap selects a tab when none is selected**
   - upstream `tabs()` returns tabs with no `selected: true`
   - proxy triggers `selectTab` on first tab

3. **Shared-socket duplicates are not previewable unless preferred**
   - two sessions share one socket
   - only preferred duplicate is previewable/startable
   - shadow duplicate gets explicit unavailable reason

### `apps/backend/src/test/playwright-discovery-service.test.ts`

Add duplicate-representative selection tests that validate:

- correlation/runtime-env can outrank raw timestamp when choosing preferred representative
- previewability is suppressed for non-preferred duplicates

---

## Recommended next backend fix path on main

## Step 1 — fix duplicate/shared-socket handling first

Why first:

- the ghost `default` tile is a direct backend correctness bug
- it contaminates the dashboard even before live preview rendering starts
- it is the clearest new evidence from the latest report

### Files

- `apps/backend/src/playwright/playwright-discovery-service.ts`
- `apps/backend/src/playwright/playwright-live-preview-service.ts`

### Goal

- only the preferred session in a shared-socket group is previewable/startable
- shadow duplicates stop showing up as normal active preview sessions

---

## Step 2 — add first-client controller bootstrap in the proxy

Why second:

- this is the best backend-only path for the still-broken expanded preview
- it addresses the exact post-`926ff6a` remaining gap: replay is not enough if nothing has been replay-buffered yet

### File

- `apps/backend/src/playwright/playwright-live-preview-proxy.ts`

### Goal

- when the client connects and no buffered tab state exists, actively bootstrap it

---

## Step 3 — only then reevaluate the remaining tile symptom

After Steps 1 and 2, reevaluate tiles.

If tiles still spin forever, that remaining issue is very likely in:

- `apps/ui/src/components/playwright/PlaywrightMosaicTile.tsx`

not in the backend/controller protocol.

---

## Bottom line

With the new evidence, the updated backend assessment is:

1. **`926ff6a` fixed a real replay bug, but not the main blocker.**
2. **Expanded `Connected` + `No tabs open` now most likely means the proxy still lacks an active first-client tab bootstrap.**
3. **The ghost `default` tile is strong evidence that shared-socket/preferred-session handling is wrong on the backend.**
4. **The exact next backend fix path on main is:**
   - first, tighten duplicate/shared-socket previewability/selection
   - second, add active `tabs()` / `selectTab()` bootstrap in `playwright-live-preview-proxy.ts`

## Best file targets now

- `apps/backend/src/playwright/playwright-discovery-service.ts`
- `apps/backend/src/playwright/playwright-live-preview-service.ts`
- `apps/backend/src/playwright/playwright-live-preview-proxy.ts`
- tests in `apps/backend/src/test/playwright-routes-ws.test.ts`
- tests in `apps/backend/src/test/playwright-discovery-service.test.ts`
