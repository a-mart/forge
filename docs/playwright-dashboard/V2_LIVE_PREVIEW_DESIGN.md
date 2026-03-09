# Playwright Dashboard V2 Live Preview Design

Date: 2026-03-09  
Status: Proposed / implementation-ready  
Target repo: `middleman`

## Executive recommendation

**Primary recommendation:** embed a **Middleman-hosted, lightly patched copy of Playwright’s existing live remote-control web app** inside the Playwright Dashboard, and keep using **Playwright’s existing devtools/controller protocol** behind a **Middleman-owned same-backend-origin proxy**.

In practice, that means:

- keep **Middleman** as the source of truth for discovery, filters, session selection, and dashboard layout
- host the **Playwright live preview sub-app** from the **backend origin** under a dedicated path such as `/playwright-live/`
- reuse Playwright’s existing **`devtools-start` controller flow** and **frame-stream + input** protocol
- proxy controller traffic through Middleman so the browser never needs to connect to `127.0.0.1:<random>` directly
- embed the live viewer in the dashboard via an iframe, with **split view by default** and **focus mode** for full-canvas preview

**Fallback recommendation:** if direct UI asset reuse proves too brittle, build a **Middleman-native React viewer** that still reuses the **same Playwright controller protocol**, not screenshot polling and not raw CDP-from-scratch.

---

## 1. Product goal and non-goals

## 1.1 Product goal

Turn the current Playwright Dashboard from a discovery-only surface into an **integrated live preview surface** for the **actual Playwright-controlled browser session**.

The target user experience is:

- discover running/stale Playwright sessions in the existing dashboard
- select a session
- see the **real live browser viewport** the agent is driving
- optionally interact with it using the same remote-control model Playwright already supports
- do all of the above **inside Middleman**, without launching a separate Playwright app window

This is explicitly intended to feel like:

> “the current Playwright remote-control window, but embedded inside Middleman.”

## 1.2 Non-goals

This V2 design does **not** aim to:

1. **Rebuild a browser viewer from screenshots polled off disk or via periodic capture.**
2. **Implement a raw CDP viewer from scratch** when Playwright already has a working controller stack.
3. **Iframe the target app URL directly** and pretend that is the same thing as the agent’s real browser session.
4. Replace Chrome DevTools or ship a full in-browser inspector suite on day one.
5. Introduce a broad Middleman auth/session architecture rewrite.
6. Support arbitrary external browsers unrelated to discovered Playwright sessions.
7. Replace the existing discovery dashboard; discovery remains the entry point.

## 1.3 V2 scope boundary

V2 is about **live preview of real Playwright sessions**. It is not a generic remote desktop, not a test runner UI, and not a trace viewer.

---

## 2. Why the chosen approach is to reuse/embed Playwright’s existing live remote-control web app/protocol

## 2.1 What the existing Playwright window already is

The research shows the existing Playwright “remote control window” is already:

- a **web app**, not a native-only desktop surface
- backed by a **Playwright controller WebSocket**, not screenshot file polling
- rendering **live screencast frames** from the real page
- sending **navigation / mouse / keyboard / tab** commands back through that controller
- optionally embedding Chromium DevTools through a CDP bridge

That makes it the closest possible behavioral match to what the user already likes.

## 2.2 Why this beats screenshot polling

Screenshot polling is rejected because it is:

- visually choppy
- higher latency
- harder to make interactive
- further from the existing Playwright experience
- explicitly below the requested quality bar

A “latest screenshot” fallback is acceptable for stale/inactive sessions, but **not** as the primary live transport.

## 2.3 Why this beats raw CDP-from-scratch

Building directly on CDP would require Middleman to re-implement behavior Playwright already solved:

- current page/tab selection
- frame streaming lifecycle
- tab metadata updates
- navigation controls
- input forwarding
- locator picker behavior
- Chromium inspector bridge behavior

That is more work, more protocol risk, more Chromium lock-in, and worse behavioral parity.

## 2.4 Why this beats direct iframe embedding of the target page

Iframe-ing the target page URL would show **a different browser context**:

- different cookies/auth/session state
- different history
- different tab selection
- different local storage
- not the actual Playwright-managed browser the agent is using

That is product-wise incorrect for the stated requirement.

## 2.5 Decision

Use Playwright’s **existing remote-control model** as the basis of V2:

- reuse the **web app shape** where practical
- reuse the **controller protocol**
- embed/rehost it **inside Middleman**
- do **not** fall back to screenshot polling or raw CDP unless forced into a later, explicit redesign

---

## 3. Primary architecture for embedding/rehosting inside Middleman

## 3.1 High-level architecture

The recommended architecture has three layers:

1. **Middleman discovery shell**
   - owns session discovery, filters, split view, focus mode, and navigation
   - continues to use the existing dashboard code and discovery snapshot

2. **Middleman live-preview bridge**
   - new backend service that starts/owns preview leases
   - adapts discovered sessions into Playwright’s live-preview contract
   - proxies controller HTTP/WS traffic
   - serves the embedded Playwright live-preview app from the backend origin

3. **Playwright controller/runtime**
   - existing Playwright daemon/session infrastructure
   - existing `devtools-start` behavior
   - existing frame-stream + input protocol

## 3.2 Recommended hosting model

### Backend origin hosts the preview app

The preview sub-app should be served from the **backend HTTP origin**, not from the UI Vite origin.

Reason:

- Middleman UI and backend already run on different ports in both dev and prod
- the embedded preview app needs stable same-origin access to its own API + WS proxy routes
- hosting the preview app on the backend origin keeps the Playwright sub-app’s internal assumptions simpler

Example:

- UI: `http://127.0.0.1:47188`
- backend: `http://127.0.0.1:47187`
- embedded iframe source: `http://127.0.0.1:47187/playwright-live/embed?...`

The iframe is cross-origin relative to the parent UI, but the **preview app is same-origin with its own backend routes**, which is what matters.

## 3.3 Recommended reuse strategy

Do **not** depend on Playwright internal asset paths directly at request time.

Instead:

- vendor a **pinned snapshot** of the Playwright devtools/live-preview frontend assets into the repo
- allow a **small, intentional patch layer** for embedded mode
- keep the upstream-coupled surface as small and audited as possible

Recommended asset location:

- `apps/backend/static/playwright-live/`

Recommended bridge source files:

- `apps/backend/src/playwright/playwright-live-preview-service.ts`
- `apps/backend/src/playwright/playwright-devtools-bridge.ts`
- `apps/backend/src/ws/routes/playwright-live-routes.ts`

Optional vendor-sync helper:

- `scripts/sync-playwright-live-assets.mjs`

## 3.4 Recommended backend responsibilities

### Existing files reused

- `apps/backend/src/playwright/playwright-discovery-service.ts`
- `apps/backend/src/ws/routes/playwright-routes.ts`
- `apps/backend/src/ws/server.ts`
- `packages/protocol/src/playwright.ts`

### New service

Create:

- `apps/backend/src/playwright/playwright-live-preview-service.ts`

Responsibilities:

- resolve a previewable discovered session by `sessionId`
- validate liveness / active-session suitability
- start or attach to Playwright’s devtools controller flow for that session
- create a **preview lease** with TTL and cleanup
- map the upstream controller URL to a **Middleman proxy URL**
- optionally cache/reuse controller leases per active session
- clean up leases when iframe disconnects or expires

### New adapter/bridge

Create:

- `apps/backend/src/playwright/playwright-devtools-bridge.ts`

Responsibilities:

- wrap the Playwright-internal backend logic needed for `devtools-start`
- isolate vendored/upstream-coupled code from the rest of Middleman
- normalize the response shape returned to the embedded preview app
- rewrite any controller/inspector URLs so the browser only sees backend-origin URLs

### New route bundle

Create:

- `apps/backend/src/ws/routes/playwright-live-routes.ts`

Recommended route surface:

- `GET /playwright-live/embed`
  - session-scoped embedded shell page
- `GET /playwright-live/assets/*`
  - vendored Playwright live app assets
- `GET /playwright-live/api/sessions/list`
  - returns adapted session list for embedded mode
- `POST /playwright-live/api/sessions/devtools-start`
  - starts or reuses a preview lease for a selected session
- `GET /playwright-live/api/previews/:previewId/bootstrap`
  - embed-specific config/bootstrap payload
- `DELETE /playwright-live/api/previews/:previewId`
  - release preview lease early

If the vendored Playwright UI requires additional legacy-compatible endpoints (`close`, `run`, `delete-data`), add them only if actually needed.

## 3.5 WebSocket proxy requirement

This is a core design requirement.

The browser must **not** receive raw controller URLs like:

- `ws://127.0.0.1:<random>`
- `http://127.0.0.1:<random>`

That fails for:

- remote access over Tailscale/LAN
- non-localhost browsing
- origin consistency
- security guardrails

Instead, Middleman should expose proxy endpoints such as:

- `ws://<backend-origin>/playwright-live/ws/controller/:previewId`
- `ws://<backend-origin>/playwright-live/ws/cdp/:previewId/...` (if inspector proxying is enabled)

## 3.6 Required backend server change for WS upgrade routing

Current `apps/backend/src/ws/server.ts` attaches a single `WebSocketServer({ server })` for manager traffic.

V2 should change that to **path-aware upgrade routing**, so preview proxy sockets can coexist with the existing manager WS.

Recommended implementation direction:

- move to manual `httpServer.on('upgrade', ...)`
- route preview proxy paths to a dedicated preview WS handler/service
- route the existing manager socket path to the current `WsHandler`

This is the cleanest way to keep preview traffic isolated from manager event traffic.

## 3.7 Frontend embedding model

Keep Middleman as the primary shell.

The embedded preview is a **session detail surface**, not the primary discovery UI.

Recommended UI file additions:

- `apps/ui/src/components/playwright/PlaywrightLivePreviewPane.tsx`
- `apps/ui/src/components/playwright/PlaywrightLivePreviewFrame.tsx`
- `apps/ui/src/components/playwright/PlaywrightLivePreviewEmptyState.tsx`
- `apps/ui/src/components/playwright/PlaywrightLivePreviewToolbar.tsx`

Recommended existing files to extend:

- `apps/ui/src/components/playwright/PlaywrightDashboardView.tsx`
- `apps/ui/src/components/playwright/PlaywrightSessionCard.tsx`
- `apps/ui/src/components/playwright/playwright-api.ts`
- `apps/ui/src/hooks/index-page/use-route-state.ts`
- `apps/ui/src/routes/index.tsx`

### UI state owned by Middleman

Middleman should own:

- selected session ID
- view mode (`split | tiles | focus`)
- whether preview is loading / unavailable
- iframe src / preview lease ID
- fallback empty states for inactive/stale sessions

The embedded Playwright preview app should own:

- live frame rendering
- tab strip / navigation / input handling
- internal controller lifecycle once booted

## 3.8 Primary data flow

```text
PlaywrightDashboardView (UI)
  -> user selects session
  -> POST /api/playwright/live-preview/start  (or embedded devtools-start endpoint)

PlaywrightLivePreviewService (backend)
  -> validate discovered session
  -> invoke Playwright devtools-start bridge
  -> create preview lease
  -> return iframe/bootstrap info with backend-origin proxy URLs

UI
  -> render iframe src=/playwright-live/embed?previewId=...

Embedded Playwright live app (backend origin)
  -> GET /playwright-live/api/previews/:previewId/bootstrap
  -> WS /playwright-live/ws/controller/:previewId

Middleman preview proxy
  -> bridge to actual Playwright controller
  -> relay frames/events/commands

Playwright session/controller
  -> send live screencast frames
  -> receive tab/navigation/input commands
```

## 3.9 Protocol/type additions

Extend `packages/protocol/src/playwright.ts` with preview-specific DTOs, for example:

- `PlaywrightLivePreviewStatus`
- `PlaywrightLivePreviewHandle`
- `StartPlaywrightLivePreviewRequest`
- `StartPlaywrightLivePreviewResponse`
- `ReleasePlaywrightLivePreviewResponse`
- `PlaywrightControllerBootstrap`
- `PlaywrightControllerClientMessage`
- `PlaywrightControllerServerMessage`

These do **not** need to be part of the existing global `ServerEvent` union unless the parent shell wants live preview status broadcast outside the iframe.

## 3.10 Dependency/versioning recommendation

Add a **pinned Playwright dependency** on the backend side for the bridge/vendor workflow.

Recommended principle:

- pin the version intentionally
- treat upgrades as explicit work
- validate asset + controller compatibility together

Do not rely on a floating Playwright internal structure across upgrades.

---

## 4. Fallback architecture if direct asset/app reuse is too brittle

If vendoring/patching the Playwright web app turns out too fragile, the fallback is:

## 4.1 Middleman-native React preview panel using the same Playwright controller protocol

Keep the backend bridge and controller proxy, but replace the iframe app with a native React viewer.

### Backend stays mostly the same

Still keep:

- `PlaywrightLivePreviewService`
- preview lease lifecycle
- controller bootstrap
- controller WS proxy
- optional inspector proxy

### Frontend becomes native

Create:

- `apps/ui/src/components/playwright/PlaywrightRemoteCanvas.tsx`
- `apps/ui/src/components/playwright/usePlaywrightController.ts`
- `apps/ui/src/components/playwright/PlaywrightRemoteToolbar.tsx`
- `apps/ui/src/components/playwright/PlaywrightRemoteTabStrip.tsx`

The native viewer would implement only the protocol features V2 actually needs:

- receive frame events
- receive tab/title/url updates
- render current frame
- send `selectTab`, `navigate`, `back`, `forward`, `reload`
- optionally send mouse/keyboard events

## 4.2 Why this is the right fallback

It still preserves the most important decision:

> reuse Playwright’s existing controller protocol instead of rebuilding live preview on screenshot polling or raw CDP.

## 4.3 What gets deferred in the fallback

If the fallback is used, these become follow-on work instead of day-one scope:

- exact Playwright UI parity
- locator picker parity
- Chromium DevTools side panel parity
- multi-surface embedded app reuse

## 4.4 Last-resort operational escape hatch

During development, keep an internal-only escape hatch that opens the existing standalone Playwright window for a session.

That is **not** the product design, but it is useful for debugging parity gaps.

---

## 5. Backend changes needed in Middleman

## 5.1 New backend modules

Add:

- `apps/backend/src/playwright/playwright-live-preview-service.ts`
- `apps/backend/src/playwright/playwright-devtools-bridge.ts`
- `apps/backend/src/ws/routes/playwright-live-routes.ts`

Likely add supporting helpers:

- `apps/backend/src/playwright/playwright-live-preview-types.ts`
- `apps/backend/src/playwright/playwright-live-preview-proxy.ts`

## 5.2 Existing backend files to modify

### `apps/backend/src/playwright/playwright-discovery-service.ts`

Add helper APIs such as:

- `getSessionById(sessionId: string)`
- optional `listActiveSessions()`
- optional event or helper for “best preview candidate” logic

### `apps/backend/src/ws/routes/playwright-routes.ts`

Keep existing discovery/settings routes, and add preview bootstrap endpoints only if they fit cleanly. Otherwise keep live preview routes in the separate bundle.

### `apps/backend/src/ws/server.ts`

Modify to:

- register `createPlaywrightLiveRoutes(...)`
- support path-aware websocket upgrade handling
- wire in `PlaywrightLivePreviewService`

### `apps/backend/src/index.ts`

Instantiate and start:

- `PlaywrightLivePreviewService`

Pass it into:

- `SwarmWebSocketServer`

Stop it on shutdown.

### `packages/protocol/src/playwright.ts`

Extend with preview DTOs and controller message typings.

## 5.3 Preview lease model

Each active embedded preview should be backed by a short-lived server-side lease.

Recommended lease fields:

- `previewId`
- `sessionId`
- `createdAt`
- `lastUsedAt`
- `expiresAt`
- `upstreamControllerUrl`
- `inspectorAvailable`
- `mode` (`embedded` / `focus`)

Recommended behavior:

- create on explicit preview open
- reuse for the same session if still valid
- expire automatically after inactivity
- release on iframe unload when possible

## 5.4 Input/control safety

Even though the reused Playwright app supports remote input, Middleman should avoid accidental control in split view.

Recommended behavior:

- split view opens with an overlay: **“Click to control”**
- focus mode can remove that overlay after explicit user action
- if input is disabled initially, keep navigation-only controls enabled

This can be implemented as a lightweight patch/wrapper around the embedded app.

## 5.5 Inactive/stale session behavior

For sessions that are not previewable:

- do **not** try to bootstrap the controller
- show preview-unavailable UI in the parent dashboard
- optionally show the latest screenshot artifact via existing file-reading path as a non-live fallback

That fallback is secondary UX only.

---

## 6. Frontend changes needed in Middleman

## 6.1 Evolve the existing dashboard, do not replace it

The current discovery dashboard is already implemented in:

- `apps/ui/src/components/playwright/PlaywrightDashboardView.tsx`
- `apps/ui/src/components/playwright/PlaywrightSessionCard.tsx`
- `apps/ui/src/components/playwright/PlaywrightFilters.tsx`
- `apps/ui/src/components/playwright/PlaywrightSummaryBar.tsx`

V2 should extend these rather than replace them.

## 6.2 Recommended layout model

### Default: split view

- left: discovery list / cards / filters
- right: live preview pane

### Focus mode

- full-width live preview pane
- minimal session metadata bar
- back button returns to split view

### Tiles mode

- discovery-first mosaic view
- tiles show session state and quick-open affordance
- selecting a tile opens focus mode or the split-view preview
- do **not** require simultaneous live streams for all tiles in the first phase

## 6.3 Specific UI changes

### `apps/ui/src/components/playwright/PlaywrightDashboardView.tsx`

Add:

- selected session state
- preview mode state
- resizable split layout
- preview pane empty/loading/unavailable states
- preview pane + dashboard coexistence logic

### `apps/ui/src/components/playwright/PlaywrightSessionCard.tsx`

Add actions such as:

- `Live view`
- `Focus`
- optional `Open standalone` debug action behind a dev flag

Also make the primary click select the session for preview.

### New files

Add:

- `apps/ui/src/components/playwright/PlaywrightLivePreviewPane.tsx`
- `apps/ui/src/components/playwright/PlaywrightLivePreviewFrame.tsx`
- `apps/ui/src/components/playwright/PlaywrightLivePreviewToolbar.tsx`
- `apps/ui/src/components/playwright/PlaywrightTilesView.tsx` (phase 3 if needed)

### `apps/ui/src/components/playwright/playwright-api.ts`

Add helpers for:

- start preview
- release preview
- resolve iframe URL/bootstrap URL

## 6.4 Route/search-state recommendation

Extend `apps/ui/src/hooks/index-page/use-route-state.ts` to support optional preview-related search params, for example:

- `view=playwright`
- `playwrightSession=<sessionId>`
- `playwrightMode=split|focus|tiles`

This makes reload/back-forward behavior much better and preserves the currently selected preview.

## 6.5 Parent/iframe coordination

Because the preview iframe is served from backend origin, keep parent/iframe coordination minimal.

Recommended parent responsibilities:

- set iframe src
- handle layout and selection
- show loading or unavailable shell states

Optional later enhancement:

- `postMessage` bridge for status updates (`loading`, `ready`, `controller_disconnected`)

If added, it must validate origin strictly.

---

## 7. Transport / protocol / auth / origin considerations

## 7.1 Transport rules

### Discovery transport

Keep existing discovery transport unchanged:

- HTTP for initial snapshot/rescan/settings
- existing WS for live discovery updates

### Live preview transport

Use a separate preview transport path:

- backend-hosted embedded app
- backend HTTP bootstrap endpoints
- backend websocket proxy endpoints for controller traffic

Do **not** send high-frequency preview frames through the existing manager WebSocket event channel.

## 7.2 Origin model

There are two distinct browser origins in Middleman today:

- UI origin
- backend origin

The preview app should live on the **backend origin**.

Implications:

- the iframe is cross-origin from the parent UI
- the iframe is same-origin with preview API and preview WS routes
- future CSP / frame-ancestors headers must explicitly allow the UI origin to embed backend preview pages

## 7.3 Controller URL rewriting/proxying

Never expose direct controller URLs back to the browser.

The backend must rewrite or wrap all preview/control URLs so they stay on backend origin.

This is mandatory for:

- local dev correctness
- remote access correctness
- future auth correctness
- least-surprise networking

## 7.4 Auth and access control

Middleman is currently effectively local-first and backend-access based. Live preview should inherit that model, but with a few extra guardrails:

1. preview start endpoints accept **session IDs**, not arbitrary socket paths or controller URLs
2. preview leases are opaque server-side IDs
3. proxy WS routes validate the lease before bridging traffic
4. expired preview IDs are rejected
5. preview routes should only expose sessions already visible through discovery

This prevents the browser from steering arbitrary local controller endpoints.

## 7.5 Same-device vs remote-device support

The design must work in both cases:

- UI and backend on same machine/browser
- UI opened remotely against a reachable backend host

That is why controller proxying is part of the primary design, not an optional hardening step.

## 7.6 Inspector/CDP side panel

The Chromium inspector is the most origin-sensitive piece.

Recommendation:

- do not block V2 launch on full embedded DevTools-panel parity
- support the main live viewport first
- add inspector proxying only after the main preview path is stable

If the inspector can be proxied cleanly, it should remain backend-origin and iframe-safe.

---

## 8. How discovery dashboard and live preview coexist

## 8.1 Default layout: split view

This is the recommended default.

### Left pane

- existing summary bar
- filters
- session list/cards
- selection state

### Right pane

- live preview iframe
- session metadata header
- preview loading/unavailable states
- optional control affordances

### Selection behavior

- if exactly one active session exists, auto-select it on dashboard open
- otherwise preserve the last selected preview session if still present
- otherwise start with no preview selected

## 8.2 Focus mode

Focus mode is the main “feels like the old Playwright window” experience.

Behavior:

- hide the list pane
- expand preview to full available width
- keep a compact header with session name, liveness, and exit button
- optionally enable interactive control more aggressively here than in split view

## 8.3 Tiles mode

Tiles mode should exist, but the first shipping version should remain discovery-first.

Recommended V2 behavior:

- show the existing session cards in a denser grid
- add stronger live/open affordances
- selecting a tile opens focus mode or the split-view preview
- avoid N simultaneous live iframes in the first milestone

Reason:

- each live controller consumes bandwidth/CPU
- the embedded-app approach is strongest for one selected session at a time
- a live-thumbnails wall can be a later optimization phase if needed

## 8.4 Discovery data remains visible

Live preview should not hide the operational context that makes the discovery dashboard useful.

Keep visible near the preview:

- session name
- worktree
- matched agent/manager
- liveness
- ports
- artifact counts
- warning banners

That preserves the value of the current dashboard while adding the missing live layer.

---

## 9. Detailed phased implementation plan

## Phase 0 — viability spike

Goal: prove the architecture before deep UI work.

Deliverables:

- pinned Playwright dependency strategy selected
- vendored preview assets checked into repo or sync script working
- backend prototype that boots a single embedded preview route from one known active session
- controller URL successfully proxied through Middleman backend
- no separate Playwright app window launched

Exit criteria:

- live frames visible in a normal browser tab against the backend route
- remote browser access does not break due to `127.0.0.1` leakage

## Phase 1 — backend live-preview bridge

Deliverables:

- `apps/backend/src/playwright/playwright-live-preview-service.ts`
- `apps/backend/src/playwright/playwright-devtools-bridge.ts`
- `apps/backend/src/ws/routes/playwright-live-routes.ts`
- preview lease lifecycle
- WS proxy path support in `apps/backend/src/ws/server.ts`
- preview DTOs in `packages/protocol/src/playwright.ts`

Exit criteria:

- start preview for a discovered active session by session ID
- bootstrap + controller proxy work reliably
- stale/inactive sessions return clear errors

## Phase 2 — dashboard integration (split view + focus)

Deliverables:

- select session from `PlaywrightDashboardView`
- embed preview iframe in right pane
- add preview toolbar + empty states
- add focus mode
- add session-specific URL/search-state persistence

Files:

- `apps/ui/src/components/playwright/PlaywrightDashboardView.tsx`
- `apps/ui/src/components/playwright/PlaywrightSessionCard.tsx`
- `apps/ui/src/components/playwright/playwright-api.ts`
- `apps/ui/src/hooks/index-page/use-route-state.ts`

Exit criteria:

- split view works end-to-end
- focus mode works end-to-end
- navigating away cleans up preview leases

## Phase 3 — embedded control polish

Deliverables:

- click-to-control overlay or explicit control enablement
- better loading/disconnected overlays
- better selection persistence
- optional navigation affordances surfaced in parent toolbar

Exit criteria:

- accidental input is prevented
- reconnect/disconnect UX is understandable

## Phase 4 — tile mode and scalability pass

Deliverables:

- tile-mode layout in the dashboard
- choose whether tiles remain discovery-only or gain low-rate live thumbnails
- impose concurrency caps for simultaneous previews if thumbnails are added

Exit criteria:

- dashboard remains usable with multiple active sessions
- backend/controller resource usage remains bounded

## Phase 5 — inspector/devtools parity pass (optional)

Deliverables:

- evaluate Chromium DevTools side-panel support inside embedded mode
- add CDP proxy/rewrite only if it is stable enough

Exit criteria:

- either inspector works cleanly, or it is explicitly documented as deferred

## Phase 6 — hardening and docs

Deliverables:

- final docs update in `docs/playwright-dashboard/`
- upgrade/versioning notes for vendored Playwright assets
- cleanup/leak tests
- final typecheck and smoke validation

---

## 10. Validation plan and success criteria

## 10.1 Core validation plan

### Backend validation

1. Start preview for an active discovered session.
2. Confirm backend returns a preview lease and backend-origin URLs only.
3. Confirm websocket proxy relays frames and commands.
4. Confirm preview lease expires/cleans up after inactivity.
5. Confirm stale/inactive sessions never open a broken controller.

### UI validation

1. Open Playwright Dashboard.
2. Select an active session.
3. Confirm split-view preview renders live motion.
4. Enter focus mode.
5. Navigate back out to split view.
6. Switch sessions and confirm the preview updates correctly.
7. Navigate away from the dashboard and confirm cleanup.

### Origin/remote validation

Validate both:

- local browser against local backend
- remote/Tailscale browser against reachable backend

Success means the preview still works without the browser ever attempting to connect to a machine-local `127.0.0.1` controller endpoint.

### Performance validation

Measure:

- preview startup time
- frame latency under normal browsing
- CPU/network behavior with one active preview
- behavior after repeated open/close cycles

## 10.2 Launch success criteria

V2 is successful when all of the following are true:

1. **No separate Playwright app window is needed.**
2. **The dashboard shows the actual live Playwright-controlled browser session.**
3. **The preview is live, not screenshot-polled.**
4. **The primary transport reuses Playwright’s existing controller path.**
5. **Remote access works because controller traffic is proxied through Middleman.**
6. **Split view and focus mode are both usable.**
7. **Stale/inactive sessions fail gracefully.**
8. **The implementation preserves current discovery behavior.**
9. **`pnpm exec tsc --noEmit` passes.**
10. **Manual dashboard smoke checks pass in dev and prod-like ports.**

## 10.3 Explicit anti-success cases

V2 should be considered unsuccessful if it ships as any of these:

- periodic screenshot capture masquerading as live preview
- raw CDP implementation that abandons the proven Playwright controller path
- direct target-page iframe embedding
- only a button that opens the old standalone Playwright window

---

## 11. Explicit open questions and risk items

## 11.1 Highest-risk items

### 1. Exact Playwright vendoring surface

Open question:

- how much of Playwright’s devtools frontend/backend glue must be vendored versus lightly wrapped?

Risk:

- internal APIs and bundle structure are not public/stable.

Mitigation:

- keep a pinned version
- isolate all upstream-coupled code in `playwright-devtools-bridge.ts`
- keep the patch surface small

### 2. Controller bootstrap internals

Open question:

- what is the cleanest, least-fragile server-side path to invoke the equivalent of Playwright’s `devtools-start` for an existing session?

Risk:

- backend glue may depend on internal package behavior.

Mitigation:

- prototype this first in Phase 0 before deep UI work

### 3. Embedded inspector side panel

Open question:

- can Chromium inspector embedding work cleanly inside the backend-hosted embedded app and nested iframe constraints?

Risk:

- this may be significantly more brittle than the main live viewport.

Mitigation:

- treat it as optional parity work after the main viewer ships

## 11.2 Medium-risk items

### 4. WebSocket upgrade refactor in backend server

Open question:

- how invasive will path-aware upgrade routing be relative to the current single-WS setup?

Mitigation:

- isolate preview proxy sockets from manager sockets early

### 5. Version skew between monitored sessions and vendored Playwright assets

Open question:

- how tolerant is the embedded app/controller pairing if the monitored environment’s Playwright CLI version drifts?

Mitigation:

- document supported version family
- detect/report mismatches in the preview bootstrap payload

### 6. Input safety in split view

Open question:

- should V2 default to view-only until explicit activation, or allow immediate interaction?

Recommendation:

- explicit activation is safer

## 11.3 Low-risk / deferred items

### 7. Tile-mode live thumbnails

Question:

- are simultaneous live tile previews worth the extra complexity/cost?

Recommendation:

- not for the first shipping milestone

### 8. Parent/iframe message bridge

Question:

- do we need cross-window status messaging immediately?

Recommendation:

- no; defer unless parent-shell UX clearly needs it

---

## Final recommendation hierarchy

### Primary

**Embed a backend-hosted, lightly patched fork of Playwright’s existing live remote-control web app inside Middleman, and proxy all controller traffic through Middleman.**

### Secondary fallback

**If direct asset reuse is too brittle, build a native Middleman preview pane that still reuses Playwright’s controller protocol and backend bridge.**

### Explicitly rejected

- screenshot polling as the primary live-preview transport
- raw CDP-from-scratch as the primary architecture
- direct iframe embedding of the target app URL

This gives Middleman the closest match to the existing Playwright remote-control experience with the lowest behavioral risk and the clearest path to an implementation-ready V2.
