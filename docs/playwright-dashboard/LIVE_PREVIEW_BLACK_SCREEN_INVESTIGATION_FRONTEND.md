# Playwright Live Preview — Black Screen Investigation (Frontend / Embed Runtime)

## Summary

After the Not Found 404 fix (malformed `resolveApiEndpoint()` URL), the embed HTML now loads successfully but the preview shows a black screen. This investigation traces the full frontend embed lifecycle to identify where and why the live page content fails to render.

## Embed Architecture Overview

The live preview uses a **two-layer iframe architecture**:

1. **Parent shell** (Middleman UI): `PlaywrightLivePreviewPane` → calls backend `/api/playwright/live-preview/start` → gets `iframeSrc` → renders `<iframe>` via `PlaywrightLivePreviewFrame`
2. **Embed shell** (backend-served HTML at `/playwright-live/embed?previewId=<id>`): Contains an inline bootstrap script + the vendored Playwright DevTools React app (`index-BlUdtOgD.js`)

The vendored app is a **full standalone Playwright DevTools SPA** — it has its own session polling, controller WebSocket management, tab bar, URL bar, and screencast display. The embed inline script adapts it for the embedded context by:
- Setting `window.location.hash = '#session=mm-session:<sessionId>'` to auto-select the session
- Patching `window.fetch` to append `?previewId=<id>` to managed API routes
- Patching `window.WebSocket` to report status events to the parent frame via `postMessage`
- Hiding destructive UI controls via CSS

## Complete Data Flow (Happy Path)

```
1. Parent: POST /api/playwright/live-preview/start
   → Backend creates preview lease, calls devtools-start on Playwright daemon
   → Returns PlaywrightLivePreviewHandle with iframeSrc + controllerWsUrl

2. Parent: Renders <iframe src="http://backend:47187/playwright-live/embed?previewId=xxx">
   → Sets preview.status = 'active'

3. Iframe loads embed HTML:
   a. Inline script sets window.__MM_PLAYWRIGHT_EMBED__ = { previewId, publicSessionKey, sessionName }
   b. Inline script sets location.hash = '#session=mm-session:<sessionId>'
   c. Inline script patches fetch() and WebSocket
   d. Vendored React bundle loads (type="module", deferred)
   e. CSS bundle loads

4. Vendored app mounts:
   a. Reads hash → gets 'mm-session:<sessionId>'
   b. Creates V0 model, starts polling /api/sessions/list
   c. Patched fetch adds ?previewId=xxx → backend returns filtered session list
   d. For previewable sessions, calls /api/sessions/devtools-start (POST)
   e. Backend reuses existing lease, returns { url: controllerWsUrl }
   f. Model stores wsUrls.set('mm-session:<sessionId>', controllerWsUrl)
   g. Main component re-renders → renders DevTools view (G0)

5. DevTools view:
   a. Creates pi.create(controllerWsUrl) → opens WebSocket
   b. Patched WebSocket connects to ws://backend:47187/playwright-live/ws/controller/<previewId>
   c. Backend proxy creates upstream WebSocket to actual Playwright controller
   d. Controller sends 'tabs' event → app shows tab bar
   e. Controller sends 'frame' events (base64 JPEG) → app renders <img src="data:image/jpeg;base64,...">
```

## Identified Failure Points

### Root Cause 1 (PRIMARY — High Confidence): Double-lease / controller WebSocket race

**The vendored app's `devtools-start` call creates a SECOND controller session that may conflict with the first.**

When the parent calls `startPlaywrightLivePreview()`, the backend calls `devtoolsBridge.startPreviewController(session)` which sends a `devtools-start` RPC to the Playwright CLI daemon. This starts the DevTools controller server.

When the vendored app inside the iframe calls `/api/sessions/devtools-start`, the backend calls `startPreview()` with `reuseIfActive: true`. This reuses the existing lease but does NOT call `devtoolsBridge.startPreviewController()` again. The returned `controllerWsUrl` is the same proxy URL.

However, the **proxy creates a brand-new upstream WebSocket** for each client connection. Each proxy connection:
```
client WS → Proxy → NEW upstream WS → Playwright controller server
```

The Playwright controller server may handle this correctly (serving frames to the new connection), but there's a **timing window** where:
1. The proxy receives the WebSocket upgrade from the vendored app
2. The proxy creates a new upstream connection to the controller
3. Before the upstream connects, client messages are queued
4. The upstream `open` event fires, queued messages are flushed
5. But by this point, the controller may have already sent the initial `tabs` and first `frame` to the connection that opened at step 1-time

**If the controller only sends a screencast frame once (on change) and doesn't repeat the initial frame, the vendored app would receive `tabs` but never a `frame` — resulting in a black viewport with tab bar and toolbar visible.**

### Root Cause 2 (SECONDARY — Medium-High Confidence): No frames because the browser page hasn't changed

The Playwright controller screencast sends frames when the page **changes visually**. If the browser is sitting idle on a static page, the controller may:
- Send one initial frame immediately after connection
- Then go silent until the page changes

If the initial frame is lost due to timing (upstream WebSocket not yet connected when controller sends it), or if the controller doesn't send an initial frame to the proxied connection, the vendored app would show:
- Tab bar with session name ✓
- Toolbar with URL ✓
- **Black viewport** (the `<img>` with empty `src=""` on `background: #000`)

### Root Cause 3 (TERTIARY — Medium Confidence): Vendored app stays on Grid view

If the `/api/sessions/devtools-start` call fails (returns non-200), the vendored app stores `wsUrls.set(socketPath, null)`. The main component checks:
```js
const c = Ja.wsUrls.get(o);  // null
if (c) return <G0 wsUrl={c} />;  // null is falsy → falls through
return <X0 model={Ja} />;  // Grid view renders
```

The Grid view with `background: var(--bg)` (#202124) and possibly no visible session cards could appear as a near-black screen.

This could happen if:
- The preview lease expired between parent start and iframe poll
- The session previewability changed between parent start and iframe poll
- The backend returns an error for the embedded devtools-start route

## CSS / Layout Analysis

The "black screen" visual is the **expected rendering** when the DevTools view is active but no frames have been received:

```css
.viewport-wrapper { background: #000; }      /* Fills available space */
.display { background: #000; object-fit: contain; }  /* <img> element */
.no-pages { background: #000; }              /* "No tabs open" state */
```

The tab bar (38px) and toolbar (40px) are dark gray (`#35363a`), taking up ~78px at the top. The remaining space is solid black. In the Middleman UI's `PlaywrightLivePreviewFrame`, the wrapper div adds `bg-black/5 dark:bg-white/5` but the iframe fills the space. The Middleman toolbar adds another ~40px above. So the user sees:
```
┌─────────────────────────┐
│ MM Toolbar (40px)       │  ← PlaywrightLivePreviewToolbar
├─────────────────────────┤
│ Tab bar (38px)          │  ← Vendored app tab bar (dark gray)
│ URL bar (40px)          │  ← Vendored app toolbar (dark gray)
│                         │
│   BLACK VIEWPORT        │  ← No frames = black
│                         │
│                         │
└─────────────────────────┘
```

If the vendored app shows the Grid view instead, the entire iframe area is `#202124` (very dark gray), which could also be perceived as "black."

## Frontend vs Backend Assessment

**This is primarily a frontend embed/app boot issue, not a backend data issue.**

- The backend correctly creates the preview lease ✓
- The backend correctly serves the embed HTML ✓ (404 fixed)
- The backend correctly handles embedded API routes ✓
- The WebSocket proxy correctly forwards messages ✓
- The backend controller bridge correctly starts the Playwright controller ✓

The issue is in the **interaction between the vendored Playwright DevTools app and the proxy-mediated controller connection**:
1. The vendored app expects to receive `frame` events after connecting
2. The proxy adds an indirection layer (client → proxy → upstream) that introduces timing gaps
3. The upstream Playwright controller may not resend the initial frame to a late-connecting client

## Exact Files Likely Needing Changes

### Priority 1: Proxy frame buffering (backend)
- **`apps/backend/src/playwright/playwright-live-preview-proxy.ts`**
  - Buffer the last received upstream `frame` message per preview
  - When a new client connects and upstream is already open, immediately replay the last frame
  - This eliminates the "missed initial frame" race condition

### Priority 2: Embed shell frame request (backend static)
- **`apps/backend/src/ws/routes/playwright-live-routes.ts`** (embed HTML generation)
  - The inline script could send an explicit `requestFrame` or similar message after WebSocket connects
  - Or the embed shell could add a fallback: if no frame arrives within N seconds, request a screenshot via HTTP

### Priority 3: Frontend loading state (frontend)
- **`apps/ui/src/components/playwright/PlaywrightLivePreviewFrame.tsx`**
  - Keep showing "Loading preview…" until an `active` status message arrives from the embed
  - Currently, `handleLoad` fires when the iframe's `onload` triggers (which is when the HTML loads, before the vendored app connects or receives frames)

### Priority 4: Diagnostic logging (backend)
- **`apps/backend/src/playwright/playwright-live-preview-proxy.ts`**
  - Log frame count, upstream connection state, and timing for troubleshooting
  - Track whether the upstream ever sent any frames

### Cleanup
- **`apps/backend/static/playwright-live/embed.js`** and **`embed.css`**
  - These are dead code — the embed HTML is generated in `playwright-live-routes.ts` and loads the vendored React bundle, not these files
  - Should be removed or clearly documented as unused

## Recommended Fix Plan

### Phase 1: Last-frame buffering in proxy (fixes the black screen)
```
In PlaywrightLivePreviewProxy:
1. Add a Map<string, RawData> for lastFrameByPreviewId
2. On upstream 'message', if it's a 'frame' type message, store it
3. On new client connection, after upstream opens and queued messages flush,
   if there's a stored last frame, send it immediately to the client
4. Clear the buffer when the preview is released
```

### Phase 2: Fallback frame request
```
In the embed inline script or the vendored app patch:
1. After WebSocket 'open', set a timer (e.g., 2 seconds)
2. If no 'frame' event received in that window, send a 'requestScreencast' message
3. The proxy or controller should respond with the current frame
```

### Phase 3: Parent frame loading state improvement
```
In PlaywrightLivePreviewFrame:
1. Don't hide the "Loading preview..." overlay on iframe onload
2. Instead, hide it when a 'playwright:embed-status' message with status='active'
   AND source='websocket' is received
3. This gives accurate visual feedback about the actual preview state
```

## Confidence Level

**High confidence** that the black screen is caused by the vendored Playwright DevTools app connecting to the controller but not receiving the initial screencast frame. The proxy's upstream WebSocket creation timing, combined with the controller's frame delivery semantics, creates a window where the initial frame is missed.

**Medium confidence** on the exact sub-cause: it's either:
- (A) The upstream sends the initial frame before the proxy has finished connecting, or
- (B) The controller only sends frames on page changes and the page hasn't changed since the initial (non-proxied) connection, or
- (C) The vendored app's `devtools-start` call triggers a new controller context that doesn't have the screencast running yet

All three sub-causes are fixed by the same solution: **buffering the last frame in the proxy and replaying it to new clients.**
