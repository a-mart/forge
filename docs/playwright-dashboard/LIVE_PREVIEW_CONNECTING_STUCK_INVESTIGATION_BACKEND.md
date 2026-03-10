# Live Preview "Connecting to preview…" Stuck — Backend Investigation

Date: 2026-03-09

## Executive summary

**Highest-confidence root cause:** the embedded Playwright app bundle is not being served by the backend, so the iframe shell loads but the actual vendored Playwright UI never boots.

This is **not primarily a hashed-filename mismatch**.
The filenames referenced by the embed HTML **do exist on disk**:

- `apps/backend/static/playwright-live/assets/index-BlUdtOgD.js`
- `apps/backend/static/playwright-live/assets/index-CcsbAkl3.css`

The actual backend bug is that the asset route resolves:

- request: `/playwright-live/assets/index-BlUdtOgD.js`

to the wrong filesystem path:

- attempted path: `apps/backend/static/playwright-live/index-BlUdtOgD.js`

instead of:

- correct path: `apps/backend/static/playwright-live/assets/index-BlUdtOgD.js`

So the embed HTML loads, but the app bundle/CSS 404, which prevents:

- the vendored Playwright app from starting
- the controller WebSocket from being opened by that app
- the embed `postMessage({ type: 'playwright:embed-status', status: 'active' })` bridge from ever firing

That cleanly explains the current user-visible symptom: **iframe shell + spinner text `Connecting to preview…` forever**.

---

## Runtime evidence gathered

### 1. Real backend on port 47287 returns 404 for the bundle assets

Observed directly against the running backend:

- `GET http://127.0.0.1:47287/playwright-live/assets/index-BlUdtOgD.js` → `404 {"error":"Asset not found"}`
- user also reported `GET /playwright-live/assets/index-CcsbAkl3.css` → 404

So the current production-ish runtime is definitely failing before the embedded app can bootstrap.

### 2. The embed HTML references those exact asset URLs

`/playwright-live/` returns HTML that includes:

- `/playwright-live/assets/index-BlUdtOgD.js`
- `/playwright-live/assets/index-CcsbAkl3.css`

So the shell is pointing at the expected URLs.

### 3. The files exist on disk

In the repo:

- `apps/backend/static/playwright-live/assets/index-BlUdtOgD.js`
- `apps/backend/static/playwright-live/assets/index-CcsbAkl3.css`

Both are present and readable.

### 4. Route-level reproduction proves the path-resolution bug

I imported the compiled route module and instrumented `fs/promises.readFile`.

When the route handles:

- `/playwright-live/assets/index-BlUdtOgD.js`

it tries to read:

- `/Users/adam/repos/middleman/apps/backend/static/playwright-live/index-BlUdtOgD.js`

and gets `ENOENT`.

That is the key proof. The server is dropping the `assets/` directory segment during resolution.

---

## Exact failing step in the chain

The failing step is:

1. preview lease start succeeds enough to produce `iframeSrc`
2. iframe HTML loads successfully
3. iframe HTML references vendored JS/CSS bundle URLs
4. backend asset route returns 404 for those bundle URLs
5. vendored Playwright app never boots
6. no controller proxy WebSocket is opened by the app
7. no embed `postMessage(... status: 'active' ...)` reaches the parent shell
8. parent UI stays on `Connecting to preview…`

So the stuck spinner is downstream of **asset serving failure**, not currently evidence of a controller-proxy or origin-policy issue.

---

## Code-level root cause

### Primary bug

File:

- `apps/backend/src/ws/routes/playwright-live-routes.ts`

Relevant code:

- `const PLAYWRIGHT_LIVE_ASSET_PATH = /^\/playwright-live\/assets\/(.+)$/`
- `const STATIC_ASSET_ROOT = resolve(..., '../../../static/playwright-live')`
- in `handleAssetRequest()`:
  - `const relativePath = decodeURIComponent(match[1] ?? '')`
  - `const assetPath = resolve(STATIC_ASSET_ROOT, relativePath)`

Problem:

- the regex captures only the part **after** `/assets/`
- for `/playwright-live/assets/index-BlUdtOgD.js`, `relativePath` becomes `index-BlUdtOgD.js`
- resolving that against `static/playwright-live` produces:
  - `static/playwright-live/index-BlUdtOgD.js`
- but the real file lives in:
  - `static/playwright-live/assets/index-BlUdtOgD.js`

So the route is structurally wrong.

### Why the runtime symptom is a spinner instead of a visible error

The parent shell waits for embed status via `postMessage` in:

- `apps/ui/src/components/playwright/PlaywrightLivePreviewFrame.tsx`

But when the vendored bundle fails to load, the embedded app never fully initializes, so the bridge never reports `active`.

Also, the inline shell script in:

- `apps/backend/src/ws/routes/playwright-live-routes.ts`

does not appear to reliably convert external module/CSS load failures into a parent-visible status message, so the parent can keep showing the spinner instead of surfacing a precise asset-load error.

---

## Highest-confidence conclusion

**Primary root cause:** broken backend asset path resolution for `/playwright-live/assets/*`.

This is the highest-confidence failing step and is sufficient to explain the live runtime issue.

### Important clarification

The new console evidence initially looked like a possible hardcoded-hash mismatch.

After checking the filesystem and instrumenting the route, the stronger conclusion is:

- the hardcoded asset filenames currently **do exist**
- the backend route is simply reading the wrong path

So the immediate fix is not “rename the filenames”; it is “serve the `assets/` directory correctly.”

---

## Exact files likely needing changes

### 1. `apps/backend/src/ws/routes/playwright-live-routes.ts`

This is the main fix location.

Likely fix options:

- change `STATIC_ASSET_ROOT` to point at `.../static/playwright-live/assets` for this route, or
- keep `STATIC_ASSET_ROOT` as-is and resolve with `resolve(STATIC_ASSET_ROOT, 'assets', relativePath)`

I would prefer the second if root-level static files may still be used elsewhere; otherwise a dedicated `STATIC_ASSETS_DIR` constant is cleaner.

### 2. `apps/backend/src/test/playwright-routes-ws.test.ts`

Add a **positive** asset-serving regression test.

Current tests cover rejection/origin behavior, but this bug slipped because there is no assertion that:

- `GET /playwright-live/assets/index-BlUdtOgD.js` returns 200
- `GET /playwright-live/assets/index-CcsbAkl3.css` returns 200

That test should exist.

### 3. Optional hardening in `apps/backend/src/ws/routes/playwright-live-routes.ts`

Add explicit error surfacing for bundle load failures so the parent does not hang on a spinner forever.

Examples:

- script `onerror` handler that posts `playwright:embed-status` with `status: 'error'`
- stylesheet load failure detection if practical
- or a small preflight asset existence check before rendering the embed HTML

This is secondary to the main fix, but it would make future regressions much easier to diagnose.

---

## Recommended fix plan

### Fix plan A — immediate unblock

1. Fix asset path resolution in `handleAssetRequest()`.
2. Add regression tests that successful asset fetches return 200.
3. Validate in an isolated test instance/worktree, not the live user instance.

### Fix plan B — hardening

1. Stop relying on silent external bundle loads.
2. Surface JS/CSS asset boot failures back to the parent shell via `postMessage`.
3. Optionally replace hardcoded hashed asset names with a manifest/discovery mechanism if the vendored bundle will be refreshed regularly.

Note: hardcoded filenames are still brittle long-term, but they are **not** the immediate runtime failure here.

---

## Quick validation steps for the implementation worker

Use an isolated backend instance after patching.

### Backend route checks

1. `GET /playwright-live/assets/index-BlUdtOgD.js` returns:
   - HTTP 200
   - JS content-type
   - non-JSON body

2. `GET /playwright-live/assets/index-CcsbAkl3.css` returns:
   - HTTP 200
   - CSS content-type

3. `GET /playwright-live/` still returns HTML referencing the asset URLs.

### Live preview smoke check

1. Open a real previewable session.
2. Confirm browser network tab shows 200 for the JS/CSS bundle requests.
3. Confirm iframe transitions out of `Connecting to preview…`.
4. Confirm parent receives embed status `active`.
5. Confirm the controller proxy WebSocket connects only after the bundle loads.

### Regression coverage

Add/verify a test that would have failed before the fix:

- route-level asset request for `/playwright-live/assets/...` must return 200

---

## Bottom line

The highest-confidence failing step is **backend static asset serving**, specifically a bad path resolution bug in:

- `apps/backend/src/ws/routes/playwright-live-routes.ts`

The live preview is stuck because the embed shell loads, but the actual Playwright app bundle never does.
