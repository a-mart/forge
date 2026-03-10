# Live Preview Black Screen Investigation — Backend / Protocol

Date: 2026-03-09

## Conclusion

**Most likely root cause:** the embedded Playwright app is reaching the controller socket, but the selected-session viewport is **never explicitly initialized** in the deep-link embed path.

This looks like a **controller-connected / viewport-uninitialized** failure, not a route failure.

## Why this is the strongest explanation

### 1. The embed path deep-links straight into the session detail view
In `apps/backend/src/ws/routes/playwright-live-routes.ts`, the embed shell sets:

- `window.location.hash = '#session=' + encodeURIComponent(config.publicSessionKey)`

That means the vendored app boots directly into a selected session instead of letting the user click through the grid first.

### 2. The selected-session view does not perform initial tab/bootstrap RPCs
In the vendored bundle `apps/backend/static/playwright-live/assets/index-BlUdtOgD.js`:

- `J0` renders the detail view (`G0`) as soon as a hash-selected session has a WS URL.
- `G0` opens the controller socket and **only subscribes** to pushed `tabs`, `frame`, and `elementPicked` events.
- `G0` does **not** issue an initial `tabs()` request.
- `G0` does **not** issue an initial `selectTab(...)` call.

So if the upstream controller does not proactively push the current selected-tab state and start screencast frames on connect, `G0` has nothing to render.

### 3. The only place that does an eager `tabs()` call is the grid-card path
In the same vendored bundle:

- `Z0` (session chip / grid path) calls `b.tabs().then(H)`

That strongly suggests the app normally relies on an explicit initial `tabs()` fetch to populate state.

But the embed flow bypasses that path by deep-linking straight into `G0`.

### 4. Backend bootstrap currently provides connection info, but not viewport-init state
`apps/backend/src/playwright/playwright-live-preview-service.ts` + `apps/backend/src/ws/routes/playwright-live-routes.ts` provide:

- preview lease
- controller proxy URL
- sanitized session info

But they do **not** provide:

- initial tab list
- selected tab/page id
- initial URL
- any server-side prewarm/init handshake

Notably, `PlaywrightControllerBootstrap.initialUrl` is currently always `null`.

## Likely runtime symptom

**Yes — the black screen very likely means the controller connected, but the viewport session never fully initialized.**

The vendored UI theme uses a black viewport background. If no selected tab and/or no `frame` event ever arrives, the user sees a black canvas area even though the iframe and WS connection are alive.

That matches the current report much better than a proxy/origin/routing failure.

## Confidence

**High** on the deep-link initialization bug.

**Medium** on it being the only cause, because the actual upstream Playwright controller may also have version-sensitive behavior.

## Secondary risk: version skew

The live session metadata in the real repro tree reports Playwright session version:

- `1.59.0-alpha-1771104257000`

The Middleman side currently vendors a pinned opaque frontend bundle and only checks that `session.sessionVersion` exists in `apps/backend/src/playwright/playwright-devtools-bridge.ts`.

There is **no compatibility check** ensuring the vendored frontend assumptions still match the live controller protocol.

So version skew is a plausible secondary contributor, but the missing init path is already enough to explain the black screen.

## Exact files likely needing changes

### Highest-probability fix files
1. `apps/backend/static/playwright-live/assets/index-BlUdtOgD.js`
   - Patch/re-vendor the selected-session view so it performs initial controller bootstrap work on connect.
   - Minimum likely change: call `tabs()` after socket open, then select an initial tab if needed.

2. `apps/backend/src/ws/routes/playwright-live-routes.ts`
   - If we want a more robust bridge, extend bootstrap data for embed mode instead of only handing back a controller URL.
   - Candidate additions: selected tab metadata, initial URL, or an embed-mode flag that changes startup behavior.

3. `packages/protocol/src/playwright.ts`
   - If backend bootstrap grows, add typed fields for initial tab/viewport bootstrap payload.

### Possible supporting backend change
4. `apps/backend/src/playwright/playwright-devtools-bridge.ts`
   - Optional: add a server-side prewarm/init step or compatibility guard if controller protocol/version mismatches are detected.

### Regression coverage
5. `apps/backend/src/test/playwright-routes-ws.test.ts`
   - Add a direct-embed-path regression test for the real failure mode: preview boot with hash-selected session should still receive/initialize a visible tab/frame path without requiring the grid-chip bootstrap flow.

## Recommended fix plan

### Plan A — minimal and most likely to work
Patch the vendored Playwright app detail view:

1. On controller open in the detail view, immediately call `tabs()`.
2. If tabs are returned and none is marked selected, call `selectTab({ pageId: firstTab.pageId })`.
3. Reuse the returned/pushed tabs state to populate the viewport.
4. Keep listening for pushed `frame` events as today.

This directly fixes the deep-link embed case.

### Plan B — backend-assisted bootstrap
If we want the embed contract to be explicit instead of relying on vendored frontend behavior:

1. Extend `/playwright-live/api/previews/:previewId/bootstrap` to include initial controller state.
2. Have the embed app consume that state and explicitly initialize the detail view.
3. Optionally prewarm the controller from the backend side.

This is cleaner long-term, but a bigger change.

### Plan C — hardening for version skew
Add a compatibility check/logging path so we can detect when:

- vendored UI expectations
- live controller protocol
- session Playwright version

are out of sync.

## Bottom line

The black screen is **probably not** “the socket failed.”

It is **probably**:

- iframe loads
- controller proxy connects
- but the embedded app never performs the initial tab-selection / viewport bootstrap it needs in the direct-deep-link path
- so no frames are rendered

That is the most concrete backend/protocol-adjacent explanation in the current code.