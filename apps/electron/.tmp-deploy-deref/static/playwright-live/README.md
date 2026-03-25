# Playwright live preview bundle

## What this is
This directory contains the static frontend shipped for the Playwright **embedded live preview** mode (the iframe page loaded by the backend when a preview is started).

The backend serves an HTML shell that loads:
- `assets/index-BlUdtOgD.js`
- `assets/index-CcsbAkl3.css`

The UI is rendered from this SPA and connects to the backend preview controller websocket for frame/tabs updates.

## Source location
I could not find source files for this bundle in this repository.

Searches for the hashed bundle names (`index-BlUdtOgD.js`, `index-CcsbAkl3.css`) only return the two files under `apps/backend/static/playwright-live/assets/` and references in backend route tests.

`embed.js` and `embed.css` exist in this folder but are not referenced by the current `/playwright-live` route handler.

## How it is served
Serving is implemented in:
- `apps/backend/src/ws/routes/playwright-live-routes.ts`
- `apps/backend/src/ws/server.ts` (WebSocket upgrade dispatch)
- `apps/backend/src/playwright/playwright-live-preview-proxy.ts`

Current endpoints:
- `GET /playwright-live` and `/playwright-live/embed` → returns the bootstrap HTML page
- `GET /playwright-live/assets/<file>` → serves files from `apps/backend/static/playwright-live/assets`
- `GET /playwright-live/api/previews/:previewId/bootstrap` → returns preview bootstrap JSON used by the app
- `GET /playwright-live/ws/controller/:previewId` (websocket) → proxied via `PlaywrightLivePreviewProxy` to upstream controller

UI start/release endpoints are on:
- `POST /api/playwright/live-preview/start`
- `DELETE /api/playwright/live-preview/:previewId` (external route)
- `DELETE /playwright-live/api/previews/:previewId` (embedded-live route alias)

## Rebuild instructions
There is currently **no in-repo build pipeline or documented script** for these files.

To rebuild, you need the SPA source (not present here) and then build it with whatever toolchain generated the hashes, then copy the output files into:
- `apps/backend/static/playwright-live/index.html` (if/when added)
- `apps/backend/static/playwright-live/assets/`

Also update `apps/backend/src/ws/routes/playwright-live-routes.ts` constants if hashed filenames change:
- `DEVTOOLS_BUNDLE_JS`
- `DEVTOOLS_BUNDLE_CSS`