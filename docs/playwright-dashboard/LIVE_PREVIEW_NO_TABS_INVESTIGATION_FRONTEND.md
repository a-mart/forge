# Live Preview "No tabs open" — Frontend/Embed Investigation

> **Updated** with second-pass evidence: the backend proxy replay-classification
> hotfix (`method` field) was applied but tiles still spin forever and a ghost
> "default" tile still appears. This revision identifies the **independent
> frontend deadlock** that persists regardless of the backend fix.

**Observed symptoms (current, post-hotfix):**
- Tile view: spinners persist indefinitely for live sessions
- Expanded view: shows "Connected" but "No tabs open"
- A ghost tile named "default" appears despite being a stale/duplicate session

---

## Bug #1 (CRITICAL): Tile iframe is never mounted — render-gated deadlock

### The problem

`PlaywrightMosaicTile` has a **chicken-and-egg deadlock** in its render logic.
The iframe is only rendered when `isLive` is true, but `isLive` requires
`embedActive`, which can only become true when the iframe sends a `postMessage`
— which requires the iframe to be mounted in the DOM.

```
PlaywrightMosaicTile.tsx — render logic:

  const isLive    = status === 'active' && !!iframeSrc && embedActive
  const isLoading = status === 'starting' || (status === 'active' && !embedActive)

  // RENDER BRANCH:
  {isLive && iframeSrc ? (
    <iframe ref={iframeRef} src={iframeSrc} ... />     // ← only path that mounts iframe
  ) : isLoading ? (
    <Loader2 className="animate-spin" />                // ← spinner, NO iframe
  ) : ...}
```

**Step-by-step deadlock:**

1. Preview lease starts → `status = 'active'`, `iframeSrc` set, `embedActive = false`
2. `isLive = false` (because `embedActive` is false)
3. `isLoading = true` (because `status === 'active' && !embedActive`)
4. **Renders: `<Loader2>` spinner — the `<iframe>` is NOT in the DOM**
5. No iframe → no HTML load → no vendored app → no WS connect → no `postMessage`
6. `embedActive` stays `false` forever
7. **Permanent spinner. Deadlock.**

### Contrast with the expanded-view `PlaywrightLivePreviewFrame`

The expanded view works correctly because it uses a **loading overlay on top of
an always-mounted iframe**:

```tsx
// PlaywrightLivePreviewFrame.tsx — CORRECT pattern:
<div className="relative">
  {showLoading && <div className="absolute inset-0 z-10">spinner</div>}   // overlay
  <iframe ref={iframeRef} src={iframeSrc} ... />                           // ALWAYS mounted
</div>
```

The iframe loads in the background, sends `postMessage('active')`, and the
overlay is dismissed. This is the pattern the tile must adopt.

### File to fix

**`apps/ui/src/components/playwright/PlaywrightMosaicTile.tsx`**

The iframe must be rendered unconditionally once `status === 'active'` and
`iframeSrc` is available. The spinner/loading state should be an overlay or
z-layered sibling, not a replacement for the iframe.

### Recommended fix shape

```tsx
{/* Preview area */}
<div className="relative aspect-[16/10] bg-muted/30 overflow-hidden">
  {/* Always mount iframe once we have a src, hidden behind overlay until active */}
  {status === 'active' && iframeSrc ? (
    <iframe
      ref={iframeRef}
      src={iframeSrc}
      className="absolute inset-0 w-[200%] h-[200%] origin-top-left scale-50
                 pointer-events-none border-0"
      sandbox="allow-scripts allow-same-origin"
      title={`Preview: ${session.sessionName}`}
    />
  ) : null}

  {/* Loading overlay — covers iframe until embedActive fires */}
  {isLoading ? (
    <div className="absolute inset-0 z-10 flex items-center justify-center
                    bg-muted/30">
      <Loader2 className="size-5 text-muted-foreground/40 animate-spin" />
    </div>
  ) : null}

  {/* Failed / non-previewable placeholders */}
  {previewable && status === 'failed' ? ( ... ) : null}
  {!previewable ? ( ... ) : null}

  {/* Hover overlay */}
  ...
</div>
```

The tile should also add a **timeout fallback** (e.g., 20–30s) that transitions
to `status = 'failed'` if `embedActive` never arrives, mirroring the 30s
timeout already present in `PlaywrightLivePreviewFrame`.

---

## Bug #2 (backend, already identified): Proxy replay-buffer message classification

**Status: hotfix applied** (adding `method` field check to `getControllerMessageType`).

Even with the tile deadlock fixed, the expanded view's "Connected but No tabs
open" state is caused by the proxy failing to buffer `tabs`/`frame` messages for
late-joining clients. The vendored DevTools bundle uses JSON-RPC events shaped as
`{ method: "tabs", params: {...} }` but the proxy's `captureReplayMessage` only
recognized a `type` field.

**File:** `apps/backend/src/playwright/playwright-live-preview-proxy.ts`

This is the backend half of the fix; see original analysis below for details.

---

## Bug #3 (cosmetic/UX): Ghost "default" tile

### The problem

A tile named "default" appears in the mosaic. This is a real session file on
disk (`default.session`) that gets discovered. There are typically **two**
`default.session` files sharing the same `socketPath`:

- **v1** (legacy, root-level): no `name` field → `sessionName` falls back to
  `basename(path, '.session')` = `"default"`, no timestamp → classified as
  `schemaVersion: 'v1'`
- **v2** (daemon-scoped, under `3f15aae.../`): has `name: "default"`,
  timestamp, resolvedConfig → `schemaVersion: 'v2'`

Both share `socketPath = /tmp/playwright-cli-sockets/.../default.sock`, so they
form a duplicate group. The v2 wins as preferred (newer timestamp). But the
tile's `displaySessions` filter only hides non-preferred duplicates:

```ts
// PlaywrightDashboardView.tsx
return filteredSessions.filter((s) => s.preferredInDuplicateGroup)
```

So the v2 "default" session **is** the preferred one and passes through. If it's
`active` (socket responsive), it renders as a real tile. If it's `inactive` or
`stale`, the default filter hides it (because `showInactive`/`showStale` default
to `false`).

**The ghost tile appears when the "default" session is `active`** (its socket
exists and responds), even though it's a leftover/uninteresting session.

### Possible approaches

1. **Filter by `schemaVersion`**: Hide `v1` sessions from tiles by default (they
   lack the metadata for meaningful display). This is already partially handled
   by the `preferredInDuplicateGroup` logic but doesn't help when v2 "default"
   is the preferred one.
2. **Hide sessions named "default" that have no correlation**: If the session
   doesn't correlate to any agent (`confidence: 'none'`), it's likely a daemon
   bootstrap artifact, not a user-started session.
3. **Backend-side**: Give the discovery service a way to mark
   daemon-bootstrap/default sessions as low-priority or auto-hidden.

This is a UX polish issue, not a blocking bug. The most pragmatic fix is option 2
— adding a soft filter in the tile view's `displaySessions` derivation.

---

## Summary: Is this frontend or backend?

| Issue | Layer | Blocking? | Fix file |
|---|---|---|---|
| Tile deadlock (iframe never mounts) | **Frontend** | **Yes — permanent spinner** | `PlaywrightMosaicTile.tsx` |
| Proxy replay buffer miss | Backend | Yes — "No tabs" in expanded | `playwright-live-preview-proxy.ts` |
| Ghost "default" tile | Frontend + Backend data | No — cosmetic | `PlaywrightDashboardView.tsx` or discovery |

**The tile spinner is a pure frontend bug, independent of the backend replay
fix.** Even if the backend perfectly streams data, the tile iframe is never
mounted so it can never receive anything.

---

## Exact files needing change (priority order)

### 1. `apps/ui/src/components/playwright/PlaywrightMosaicTile.tsx` — MUST FIX

- Restructure render to always mount `<iframe>` once `iframeSrc` is available
- Use overlay pattern (like `PlaywrightLivePreviewFrame`) instead of
  conditional iframe rendering
- Add embed-ready timeout (20–30s) → transition to `failed` state
- Keep `iframeRef` wired so the `postMessage` listener can source-check

### 2. `apps/backend/src/playwright/playwright-live-preview-proxy.ts` — MUST FIX

- `getControllerMessageType()` must check both `type` and `method` fields
- Already hotfixed; verify the fix is on main

### 3. `apps/ui/src/components/playwright/PlaywrightDashboardView.tsx` — SHOULD FIX

- In `displaySessions` for tiles mode, consider filtering out uncorrelated
  "default"-named sessions or adding a `showDefaultSessions` filter toggle

### 4. `apps/backend/static/playwright-live/embed.js` — CLEANUP

- Dead code (never loaded by embed HTML). Either remove or repurpose as
  lightweight fallback.

---

## Appendix: Original backend analysis (preserved)

### Protocol message format mismatch in the proxy

The vendored DevTools bundle uses a JSON-RPC style protocol, but the proxy
classifies messages by a `type` field instead of `method`.

Evidence from the vendored bundle's transport class (`s0`):
```js
// s0 transport — how the vendored app PARSES incoming WS messages:
this._ws.onmessage = (h) => {
  let c = JSON.parse(h.data);
  if (c.id !== undefined) {
    // RPC response — resolve pending promise
    this._pending.get(c.id)?.resolve(c.result);
  } else if (c.method) {
    // EVENT — dispatch to listeners via onevent(method, params)
    this.onevent(c.method, c.params);
  }
};
```

The vendored app expects events shaped as `{ method: "tabs", params: { tabs: [...] } }`.

The proxy's `getControllerMessageType` only checked `type`:
```ts
function getControllerMessageType(value: unknown): string | null {
  return typeof (value as { type?: unknown }).type === 'string'
    ? (value as { type: string }).type : null;
}
```

Fix: check both `type` and `method` fields.

### Standalone embed.js is dead code

`embed.js` in `static/playwright-live/` uses `type`-based classification matching
the proxy's original expectations. It was designed for the proxy but the actual
embed HTML loads the vendored DevTools bundle instead.
