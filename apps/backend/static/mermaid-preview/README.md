# Mermaid preview static assets

This directory contains the backend-served document and source-managed assets for Forge's isolated Mermaid preview iframe.

## Route shape

The backend serves these endpoints from `apps/backend/src/ws/routes/mermaid-preview-routes.ts`:

- `GET /mermaid-preview`
- `GET /mermaid-preview/`
- `GET /mermaid-preview/embed`
- `GET /mermaid-preview/assets/<file>`

The intended iframe URL is:

- `/mermaid-preview/embed?instanceId=<opaque-instance-id>`

`instanceId` is optional but recommended so the child document can echo it back in `postMessage` events. Mermaid diagram source must **not** be placed in the URL.

An optional `theme=light|dark` query param is supported for the initial shell paint only. Ongoing theming should flow through the message bridge by re-sending render requests.

## Message bridge contract

The child document communicates with its parent via `window.postMessage`.

Parent -> child:

- `forge:mermaid-render`
  - `{ type, instanceId, requestId, source, themeMode }`
- `forge:mermaid-export-svg`
  - `{ type, instanceId, requestId }`

Child -> parent:

- `forge:mermaid-ready`
  - `{ type, instanceId, capabilities, renderer }`
- `forge:mermaid-rendered`
  - `{ type, instanceId, requestId, size, renderMode }`
- `forge:mermaid-size`
  - `{ type, instanceId, requestId, size }`
- `forge:mermaid-error`
  - `{ type, instanceId, requestId, error }`
- `forge:mermaid-export-svg-result`
  - `{ type, instanceId, requestId, svg? , error? }`

The current checked-in assets include:

- `assets/embed.js` — the iframe controller that listens for bridge messages, renders Mermaid inside the isolated document, reports size updates, and returns SVG exports.
- `assets/embed.css` — shell styles for the isolated iframe document.
- `assets/vendor/mermaid.min.js` — vendored browser runtime copied from the installed `mermaid` package so the iframe can render without reaching out to a CDN.

## Build / output story

There is intentionally **no extra runtime build step** for the shipped iframe assets right now.

- `apps/backend/static/mermaid-preview/assets/embed.js`
- `apps/backend/static/mermaid-preview/assets/embed.css`
- `apps/backend/static/mermaid-preview/assets/vendor/mermaid.min.js`

are served directly by the backend in dev, prod, and Electron.

Why this is intentional:

- `apps/backend/package.json` already publishes the `static/` directory.
- Serving checked-in assets keeps dev, prod, and Electron behavior identical.
- The Mermaid runtime is vendored locally so the sandboxed iframe does not depend on network access or CDN policy.

If a future Mermaid-specific build step is introduced, it should remain explicit, documented, and source-backed in-repo. Do not replace this directory with an undocumented generated bundle.

## Security notes

The embed document is served with a restrictive CSP and no network access:

- `default-src 'none'`
- `script-src 'self'`
- `style-src 'self'`
- `connect-src 'none'`
- `img-src data: blob:`
- `object-src 'none'`

`frame-ancestors` is intentionally not set because the Forge UI may embed this document from a different origin in web dev, prod, and Electron.
