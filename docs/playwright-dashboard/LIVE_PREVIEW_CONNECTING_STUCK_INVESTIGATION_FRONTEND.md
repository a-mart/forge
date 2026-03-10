# Playwright Live Preview — "Connecting to preview…" Stuck Investigation (Frontend / Embed Runtime)

Date: 2026-03-09

## Summary

The parent shell stays on "Connecting to preview…" indefinitely (until the 30-second timeout), meaning the iframe HTML loads successfully but the embedded app never sends a `playwright:embed-status` message with `status: 'active'` back to the parent via `postMessage`.

## Architecture Recap

```
Parent (UI @ :47188)                    Embed (iframe @ :47187)
┌─────────────────────────┐             ┌──────────────────────────────┐
│ PlaywrightLivePreviewPane│             │ Inline script:               │
│  - calls start API       │ ──POST──→  │  - sets __MM_PLAYWRIGHT_EMBED│
│  - sets iframe src       │             │  - monkey-patches WebSocket  │
│  - listens for postMsg   │             │  - monkey-patches fetch      │
│                          │             │                              │
│ PlaywrightLivePreviewFrame│            │ DevTools bundle (module):    │
│  - renders <iframe>       │            │  - fetches /api/sessions/list│
│  - shows loading overlay  │            │  - calls devtools-start      │
│  - waits for embed-status │ ←postMsg── │  - creates WebSocket         │
│    type: 'active'         │            │    → monkey-patch fires      │
│  - 30s timeout → error    │            │      postStatus('active')    │
└───────────────────────────┘            └──────────────────────────────┘
```

### Parent loading state logic (PlaywrightLivePreviewFrame.tsx)

```tsx
const showLoading = !embedActive && !hasError
const loadingText = iframeLoaded ? 'Connecting to preview…' : 'Loading preview…'
```

- `iframeLoaded = true` → iframe's `onLoad` fired → HTML served successfully
- `embedActive = false` → no `postMessage` with `type: 'playwright:embed-status'` and `status: 'active'` received
- Timeout: 30 seconds after `iframeLoaded && !embedActive`, fires `onError('Preview connection timed out…')`

## Observed State Diagnosis

**"Connecting to preview…"** confirms:
1. ✅ The preview lease was created (parent got `iframeSrc` from start API)
2. ✅ The iframe HTML loaded (served by backend at `/playwright-live/embed?previewId=xxx`)
3. ✅ The inline monkey-patching script ran (it's inline in `<head>`, executes synchronously)
4. ❌ The DevTools app never created a controller WebSocket that opened successfully

## Root Cause Analysis

### Root Cause 1 (HIGHEST CONFIDENCE): Silent failure paths in the embedded DevTools app

The inline script's `postStatus()` function is ONLY triggered by:
- **WebSocket events** (open/close/error on controller sockets)
- **Fetch errors** (non-200 responses on managed routes like `/api/sessions/list`, `/api/sessions/devtools-start`)
- **Window errors** (`error` event, `unhandledrejection` event)
- **Initial error status** (if the embed HTML was an error page)

There are **multiple silent failure paths** where no `postStatus` is ever called:

#### 1a. Sessions list returns `canConnect: false` (200 OK response)

The embedded fetch to `/api/sessions/list?previewId=xxx` goes through the backend's `handleSessionsListRequest`. Each session's `canConnect` is set to `candidate.previewable`, which calls `buildPreviewCandidate` → `inferPreviewabilityFromSession()`.

`inferPreviewabilityFromSession` re-checks the session's **current** liveness and socket responsiveness:

```typescript
if (session.liveness !== 'active') {
  return { previewable: false, ... }
}
if (!session.socketPath || !session.socketExists || session.socketResponsive !== true) {
  return { previewable: false, ... }
}
```

If the session's state changed between when the parent called `startPlaywrightLivePreview` (which succeeded) and when the embedded app fetches the sessions list (moments later), `canConnect` would be `false`.

**Crucially, this is a 200 OK response.** The monkey-patched fetch only reports errors for non-OK responses. So no `postStatus` is sent.

With `canConnect: false`, the DevTools app's model (`V0`) skips `_obtainDevtoolsUrl()`:
```javascript
for (const s of this.sessions) s.canConnect && this._obtainDevtoolsUrl(s.config)
```

No devtools-start call → no WebSocket URL → no WebSocket → no `postStatus('active')` → parent stuck.

#### 1b. Sessions list returns empty array (200 OK response)

The `filterCandidatesForPreview` function filters all sessions to only the one matching the preview's bootstrap session ID:

```typescript
function filterCandidatesForPreview(candidates, livePreviewService, previewId, backendOrigin) {
  const bootstrap = livePreviewService.getBootstrap(previewId, backendOrigin)
  return candidates.filter(candidate => candidate.session.id === bootstrap.session.id)
}
```

If the session was removed from the discovery snapshot (e.g., session file deleted, discovery rescanned), or if the session ID format doesn't match, the result is an empty array. The DevTools app renders an empty grid — no sessions, no connections, no `postStatus`.

#### 1c. DevTools bundle fails to load (module script error)

The DevTools bundle is loaded as `<script type="module" crossorigin src="/playwright-live/assets/index-BlUdtOgD.js">`. Module script loading errors (404, parse errors, CORS failures) fire an `error` event on the `<script>` element — **NOT on `window`**. The inline script's `window.addEventListener('error', ...)` handler does NOT catch module load failures.

Without the bundle, `#root` stays empty, no sessions are fetched, no WebSocket is created. Complete silence.

#### 1d. DevTools app throws during initialization (swallowed by React)

React's error boundaries can catch and swallow rendering errors without them propagating to `window.onerror`. If the DevTools app throws during its first render (e.g., due to unexpected API response shape), the error might not reach the global error handler.

### Root Cause 2 (MEDIUM CONFIDENCE): WebSocket proxy rejection not triggering browser events

If the proxy's `handleUpgrade` rejects the WebSocket upgrade (via `writeUpgradeError`), it writes a raw HTTP error response to the TCP socket and destroys it:

```typescript
function writeUpgradeError(socket: Duplex, statusCode: number, message: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\n...`)
  socket.destroy()
}
```

This is a non-standard WebSocket rejection. Different browsers may handle this differently:
- Some may fire `onerror` on the WebSocket → monkey-patch catches it → `postStatus('error')`
- Some may silently close the connection without firing any events
- The monkey-patched `addEventListener('close')` may or may not fire

If no event fires, no `postStatus` is sent, and the parent stays stuck.

### Root Cause 3 (LOWER CONFIDENCE): DevTools app renders grid view, workspace group collapsed

The DevTools app first renders the grid view (`X0`) because `wsUrls` is empty on first render. Session chips (`Z0`) only create WebSocket connections when `visible: H` (workspace group expanded).

If the workspace group defaults to collapsed AND the grid→detail view transition happens before `Z0` gets a chance to create a connection, the connection responsibility falls entirely on the detail view (`G0`).

`G0` does create its own WebSocket via `pi.create(wsUrl)`, so this alone shouldn't cause the issue. But the transition timing matters: if `G0` renders and creates the connection, the monkey-patched WebSocket should fire `postStatus('active')`.

**This is only a contributing factor if `G0` never renders** — which would happen if `wsUrls.get(o)` never returns a valid URL (ties back to Root Cause 1a/1b).

## Exact Failing Step in the Embed→Parent Status Path

```
Step 1: Parent calls startPlaywrightLivePreview()  → ✅ Works (preview handle returned)
Step 2: Iframe loads embed HTML                     → ✅ Works (iframeLoaded = true)
Step 3: Inline script runs, patches WS/fetch        → ✅ Works (synchronous inline script)
Step 4: DevTools bundle loads                       → ⚠️ Could silently fail (module error)
Step 5: App fetches /api/sessions/list?previewId=x  → ⚠️ Could return canConnect:false silently
Step 6: App calls devtools-start                    → ❌ SKIPPED if canConnect:false
Step 7: App creates WebSocket to controller proxy   → ❌ NEVER HAPPENS
Step 8: Monkey-patch fires postStatus('active')     → ❌ NEVER HAPPENS
Step 9: Parent receives postMessage                 → ❌ NEVER HAPPENS
```

**The most likely failure point is Step 5→6: the sessions list returns successfully (200 OK) but with `canConnect: false`, so no WebSocket is ever created.**

## Recommended Fix Plan

### Fix 1 (CRITICAL): Add embed-side initialization watchdog in inline script

The inline script should set a timer after monkey-patching. If no controller WebSocket connection is established within a reasonable window (e.g., 10 seconds), send a diagnostic `postStatus('error')`:

```javascript
// In the inline script, after monkey-patching:
let controllerConnected = false;

// Hook into the WebSocket monkey-patch to track connection
const originalPostStatus = postStatus;
const wrappedPostStatus = (status, message, extra) => {
  if (status === 'active' && extra?.source === 'websocket') {
    controllerConnected = true;
  }
  originalPostStatus(status, message, extra);
};

// Watchdog timer
setTimeout(() => {
  if (!controllerConnected) {
    postStatus('error', 'Embedded app did not establish controller connection', {
      source: 'shell'
    });
  }
}, 10000);
```

This eliminates ALL silent failure paths — if anything goes wrong (bundle load, sessions list, devtools-start, or WebSocket), the parent gets notified.

### Fix 2 (CRITICAL): Override `canConnect` for active preview leases

In `handleSessionsListRequest`, when serving sessions for a valid previewId, override `canConnect` to `true` if there's an active preview for that session. The preview lease is the authoritative truth — the controller was already started:

```typescript
// In handleSessionsListRequest or buildPreviewCandidate:
const sessions = filteredCandidates.map((candidate) => {
  const hasActiveLease = candidate.activePreviewId !== null;
  return {
    config: toCliLikeSessionConfig(candidate.session),
    canConnect: candidate.previewable || hasActiveLease,
    previewable: candidate.previewable || hasActiveLease,
    unavailableReason: hasActiveLease ? null : candidate.unavailableReason,
  };
});
```

**File:** `apps/backend/src/ws/routes/playwright-live-routes.ts` (in `handleSessionsListRequest`)

### Fix 3 (IMPORTANT): Add module load error detection

Catch module script loading failures by adding an `onerror` handler directly on the script element via the inline script:

```javascript
// In renderEmbedDocument, after the module script tag:
<script>
  document.querySelector('script[type="module"]')?.addEventListener('error', () => {
    if (window.__MM_PLAYWRIGHT_EMBED__) {
      // Use the postStatus function from the earlier inline script
      // (it's in the same scope chain)
    }
  });
</script>
```

Or more robustly, the inline script can set a global flag that the module sets when it initializes, and use the watchdog timer (Fix 1) to catch the case where the flag is never set.

### Fix 4 (DEFENSIVE): Add diagnostic postStatus on sessions-list fetch

Extend the monkey-patched fetch to report status when `/api/sessions/list` returns successfully but with no connectable sessions:

```javascript
// In the monkey-patched fetch handler:
if (managedRoute && response.ok) {
  if (url.pathname === '/api/sessions/list' || url.pathname === '/playwright-live/api/sessions/list') {
    try {
      const data = await response.clone().json();
      const connectable = data.sessions?.filter(s => s.canConnect);
      if (!connectable?.length) {
        postStatus('unavailable', 'No connectable Playwright sessions found', { source: 'fetch' });
      }
    } catch {}
  }
}
```

**File:** `apps/backend/src/ws/routes/playwright-live-routes.ts` (in `renderEmbedDocument` inline script)

## Primary vs Backend vs Cross-Layer Assessment

**This is primarily a FRONTEND / EMBED SHELL issue.**

- The backend correctly creates the preview lease ✅
- The backend correctly serves the embed HTML ✅
- The backend proxy correctly handles WebSocket upgrades ✅
- The backend API endpoints return correct data ✅

The issue is that the **embed inline script has incomplete status coverage**:
- It reports WebSocket status changes ✅
- It reports HTTP errors ✅
- It reports window errors ✅
- It does NOT report "no WebSocket was ever created" ❌
- It does NOT report "sessions list returned but with canConnect:false" ❌
- It does NOT report "DevTools bundle failed to load" ❌

**Secondary backend contribution**: The sessions list endpoint re-checks previewability even when there's an active preview lease, which can cause `canConnect: false` for a session that was just successfully started. This is a backend fix (Fix 2 above).

## Files Requiring Changes

| Priority | File | Change |
|----------|------|--------|
| P0 | `apps/backend/src/ws/routes/playwright-live-routes.ts` | Add shell-side watchdog timer and enhanced status reporting to `renderEmbedDocument` inline script |
| P0 | `apps/backend/src/ws/routes/playwright-live-routes.ts` | Override `canConnect` for sessions with active preview leases in `handleSessionsListRequest` |
| P1 | `apps/backend/src/ws/routes/playwright-live-routes.ts` | Add module load error detection in embed HTML |
| P2 | `apps/backend/src/ws/routes/playwright-live-routes.ts` | Add diagnostic postStatus for 200-OK-but-no-connectable-sessions |
| P3 | `apps/backend/static/playwright-live/embed.js` | Dead code — confirm unused and remove or document |

## Verification Plan

After implementing fixes:
1. Select an active Playwright session → preview should show "Live" status within 5 seconds
2. Force `canConnect: false` by temporarily disabling socket → should show "Unavailable" immediately (not stuck on "Connecting…")
3. Block the DevTools bundle JS asset → should show "Error" within watchdog timeout (not stuck on "Connecting…")
4. The 30-second timeout in `PlaywrightLivePreviewFrame.tsx` serves as an outer safety net but should rarely trigger after these fixes
