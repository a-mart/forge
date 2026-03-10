# Playwright Live Preview `Not Found` Investigation

## Conclusion

**Most likely root cause: frontend URL construction bug, not a backend embed-shell or vendored Playwright app routing bug.**

The embedded iframe URL is being recomputed in the UI with `resolveApiEndpoint()`, but that helper treats the full string as a `pathname`. When the UI passes a path that already contains a query string (`/playwright-live/embed?previewId=...`), the `?` gets URL-encoded into the path.

### Concrete repro from code

Current code path:

- `apps/ui/src/components/playwright/PlaywrightLivePreviewPane.tsx`
- `apps/ui/src/components/playwright/playwright-api.ts`
- `apps/ui/src/lib/api-endpoint.ts`

The UI does this:

```ts
resolveApiEndpoint(wsUrl, `/playwright-live/embed?previewId=${encodeURIComponent(previewId)}`)
```

But `resolveApiEndpoint()` currently does:

```ts
parsed.pathname = path
parsed.search = ''
parsed.hash = ''
```

So this input:

```ts
resolveApiEndpoint('ws://127.0.0.1:47187', '/playwright-live/embed?previewId=abc')
```

becomes:

```txt
http://127.0.0.1:47187/playwright-live/embed%3FpreviewId=abc
```

That request **does not match** the backend route for:

```txt
/playwright-live/embed
```

and falls through to the server-wide 404 handler in:

- `apps/backend/src/ws/server.ts`

which returns plain text:

```txt
Not Found
```

That exactly matches the reported preview behavior.

## Confidence

**High**

This is reproducible from code inspection alone. No runtime speculation is required for the primary failure.

## Why this is probably not the backend embed route / vendored app

From inspection:

- Backend live preview routes correctly serve:
  - `/playwright-live/embed`
  - `/playwright-live/api/previews/:previewId/bootstrap`
  - `/playwright-live/assets/*`
  - compatibility endpoints like `/api/sessions/list` and `/api/sessions/devtools-start`
- `PlaywrightLivePreviewService` already returns a correct `iframeSrc` with a real query string.
- Backend tests already assert that `iframeSrc` contains:
  - `/playwright-live/embed?previewId=`

Relevant files:

- `apps/backend/src/ws/routes/playwright-live-routes.ts`
- `apps/backend/src/playwright/playwright-live-preview-service.ts`
- `apps/backend/src/test/playwright-routes-ws.test.ts`

The vendored app also appears intentionally adapted for embed mode:

- embed shell injects `#session=...`
- fetch calls are intercepted for compatibility route shapes
- controller websocket path is proxied through `/playwright-live/ws/controller/:previewId`

So the current `Not Found` is best explained by the iframe never reaching the intended embed route in the first place.

## About hash routing / route base handling

I inspected this as a possible cause, but it looks secondary at most.

The vendored bundle seems to rely primarily on:

- absolute compatibility endpoints like `/api/sessions/list`
- hash state (`#session=...`)

and I did **not** find evidence that the current `Not Found` requires a basename mismatch or SPA route mismatch to explain it.

If the iframe URL were correct, the next likely content issue from the user's smoke test would be a boring/blank preview, not a raw `Not Found` page.

## Does `about:blank` explain the error?

**No.**

`about:blank` explains only why a successful preview would show little or no useful page content.

It does **not** explain a backend 404 `Not Found` response in the embedded pane.

So there are really two separate issues:

1. **Real bug:** malformed iframe URL -> backend 404 -> `Not Found`
2. **Smoke-test weakness:** `about:blank` is a poor validation target even after the routing bug is fixed

## Exact files likely needing changes

### Primary fix

1. **`apps/ui/src/lib/api-endpoint.ts`**
   - Fix `resolveApiEndpoint()` so it preserves query strings when callers pass a path containing `?`.
   - Safer implementation: construct a new `URL(path, origin)` instead of assigning `pathname` directly.

### Defensive / best-practice follow-up

2. **`apps/ui/src/components/playwright/PlaywrightLivePreviewPane.tsx`**
   - Stop recomputing the iframe URL from `previewId`.
   - Use the backend-returned `handle.iframeSrc` directly.
   - This avoids frontend/backend drift on route shape forever.

3. **`apps/ui/src/components/playwright/playwright-api.ts`**
   - Remove or narrow `resolvePreviewIframeSrc()` if it is no longer needed.
   - If kept, ensure it uses a query-safe URL builder.

### Regression coverage

4. **Add a frontend unit test** for `resolveApiEndpoint()`
   - Case: path without query
   - Case: path with query
   - Case: encoded preview IDs

5. **Optional integration coverage**
   - Add a test that the live preview pane uses `preview.iframeSrc` from the start response unchanged.

## Secondary observation

There is stale status-message handling in:

- `apps/ui/src/components/playwright/PlaywrightLivePreviewPane.tsx`

It still contains a listener for `mm-playwright-preview-status`, while the current embed shell posts `playwright:embed-status` and `PlaywrightLivePreviewFrame` already handles that newer contract.

This does **not** appear to be the cause of the reported `Not Found`, but it should be cleaned up to reduce confusion.

## Recommended fix plan

### Owner 1: Frontend dashboard owner

Implement the actual bug fix:

- fix `resolveApiEndpoint()` query handling
- switch preview pane to use `handle.iframeSrc` directly
- add regression tests

### Owner 2: Playwright/dashboard validation owner

Improve smoke validation:

- stop using `about:blank` as the preview success target
- use a deterministic real page (local fixture or stable external page)
- verify the iframe network request is actually `/playwright-live/embed?previewId=...`, not `%3FpreviewId=`

### Owner 3: Optional cleanup owner

- remove stale `mm-playwright-preview-status` handling from `PlaywrightLivePreviewPane.tsx`

## Final assessment

- **Category:** frontend route/base URL construction bug
- **Not primarily:** backend embed-shell issue
- **Not primarily:** vendored Playwright app integration issue
- **Not explained by:** `about:blank`

The highest-probability exact fix path is:

1. `apps/ui/src/lib/api-endpoint.ts`
2. `apps/ui/src/components/playwright/PlaywrightLivePreviewPane.tsx`
3. `apps/ui/src/components/playwright/playwright-api.ts`

with regression coverage added immediately after.
