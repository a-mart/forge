import type {
  GetPlaywrightLivePreviewBootstrapResponse,
  GetPlaywrightLivePreviewSessionsResponse,
  ReleasePlaywrightLivePreviewResponse,
  StartPlaywrightLivePreviewRequest,
  StartPlaywrightLivePreviewResponse,
} from '@middleman/protocol'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { extname, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  PlaywrightLivePreviewError,
  PlaywrightLivePreviewService,
  asPlaywrightLivePreviewError,
} from '../../playwright/playwright-live-preview-service.js'
import { applyCorsHeaders, matchPathPattern, readJsonBody, sendJson } from '../http-utils.js'
import type { HttpRoute } from './http-route.js'

const PLAYWRIGHT_LIVE_PREFIX = '/playwright-live'
const PLAYWRIGHT_LIVE_EMBED_ENDPOINT = `${PLAYWRIGHT_LIVE_PREFIX}/embed`
const PLAYWRIGHT_LIVE_SESSIONS_LIST_ENDPOINT = `${PLAYWRIGHT_LIVE_PREFIX}/api/sessions/list`
const PLAYWRIGHT_LIVE_DEVTOOLS_START_ENDPOINT = `${PLAYWRIGHT_LIVE_PREFIX}/api/sessions/devtools-start`
const PLAYWRIGHT_LIVE_PARENT_START_ENDPOINT = '/api/playwright/live-preview/start'
const PLAYWRIGHT_LIVE_BOOTSTRAP_PATH = /^\/playwright-live\/api\/previews\/([^/]+)\/bootstrap$/
const PLAYWRIGHT_LIVE_RELEASE_PATH = /^\/playwright-live\/api\/previews\/([^/]+)$/
const PLAYWRIGHT_LIVE_PARENT_RELEASE_PATH = /^\/api\/playwright\/live-preview\/([^/]+)$/
const PLAYWRIGHT_LIVE_ASSET_PATH = /^\/playwright-live\/assets\/(.+)$/

const STATIC_ASSET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../static/playwright-live')

export function createPlaywrightLiveRoutes(options: {
  livePreviewService: PlaywrightLivePreviewService
}): HttpRoute[] {
  const { livePreviewService } = options

  return [
    {
      methods: 'GET, OPTIONS',
      matches: (pathname) => pathname === PLAYWRIGHT_LIVE_EMBED_ENDPOINT || pathname === PLAYWRIGHT_LIVE_PREFIX || pathname === `${PLAYWRIGHT_LIVE_PREFIX}/`,
      handle: async (request, response, requestUrl) => {
        await handleEmbedRequest(request, response, requestUrl)
      },
    },
    {
      methods: 'GET, OPTIONS',
      matches: (pathname) => pathname === PLAYWRIGHT_LIVE_SESSIONS_LIST_ENDPOINT,
      handle: async (request, response) => {
        await handleSessionsListRequest(request, response, livePreviewService)
      },
    },
    {
      methods: 'POST, OPTIONS',
      matches: (pathname) => pathname === PLAYWRIGHT_LIVE_DEVTOOLS_START_ENDPOINT || pathname === PLAYWRIGHT_LIVE_PARENT_START_ENDPOINT,
      handle: async (request, response, requestUrl) => {
        await handleStartPreviewRequest(request, response, requestUrl, livePreviewService)
      },
    },
    {
      methods: 'GET, OPTIONS',
      matches: (pathname) => PLAYWRIGHT_LIVE_BOOTSTRAP_PATH.test(pathname),
      handle: async (request, response, requestUrl) => {
        await handleBootstrapRequest(request, response, requestUrl, livePreviewService)
      },
    },
    {
      methods: 'DELETE, OPTIONS',
      matches: (pathname) => PLAYWRIGHT_LIVE_RELEASE_PATH.test(pathname) || PLAYWRIGHT_LIVE_PARENT_RELEASE_PATH.test(pathname),
      handle: async (request, response, requestUrl) => {
        await handleReleasePreviewRequest(request, response, requestUrl, livePreviewService)
      },
    },
    {
      methods: 'GET, OPTIONS',
      matches: (pathname) => PLAYWRIGHT_LIVE_ASSET_PATH.test(pathname),
      handle: async (request, response, requestUrl) => {
        await handleAssetRequest(request, response, requestUrl)
      },
    },
  ]
}

async function handleEmbedRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  const methods = 'GET, OPTIONS'

  if (request.method === 'OPTIONS') {
    applyCorsHeaders(request, response, methods)
    response.statusCode = 204
    response.end()
    return
  }

  applyCorsHeaders(request, response, methods)

  if (request.method !== 'GET') {
    response.setHeader('Allow', methods)
    sendJson(response, 405, { error: 'Method Not Allowed' })
    return
  }

  response.statusCode = 200
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.end(buildEmbedHtml(requestUrl))
}

async function handleSessionsListRequest(
  request: IncomingMessage,
  response: ServerResponse,
  livePreviewService: PlaywrightLivePreviewService,
): Promise<void> {
  const methods = 'GET, OPTIONS'

  if (request.method === 'OPTIONS') {
    applyCorsHeaders(request, response, methods)
    response.statusCode = 204
    response.end()
    return
  }

  applyCorsHeaders(request, response, methods)

  if (request.method !== 'GET') {
    response.setHeader('Allow', methods)
    sendJson(response, 405, { error: 'Method Not Allowed' })
    return
  }

  try {
    const payload: GetPlaywrightLivePreviewSessionsResponse = livePreviewService.getPreviewableSessions()
    sendJson(response, 200, payload as unknown as Record<string, unknown>)
  } catch (error) {
    const normalized = asPlaywrightLivePreviewError(error)
    sendJson(response, normalized.statusCode, { error: normalized.message })
  }
}

async function handleStartPreviewRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  livePreviewService: PlaywrightLivePreviewService,
): Promise<void> {
  const methods = 'POST, OPTIONS'

  if (request.method === 'OPTIONS') {
    applyCorsHeaders(request, response, methods)
    response.statusCode = 204
    response.end()
    return
  }

  applyCorsHeaders(request, response, methods)

  if (request.method !== 'POST') {
    response.setHeader('Allow', methods)
    sendJson(response, 405, { error: 'Method Not Allowed' })
    return
  }

  try {
    const body = parseStartPreviewRequest(await readJsonBody(request))
    const payload: StartPlaywrightLivePreviewResponse = {
      ok: true,
      preview: await livePreviewService.startPreview(body, requestUrl.origin),
    }
    sendJson(response, 200, payload as unknown as Record<string, unknown>)
  } catch (error) {
    const normalized = asPlaywrightLivePreviewError(error)
    sendJson(response, normalized.statusCode, { error: normalized.message })
  }
}

async function handleBootstrapRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  livePreviewService: PlaywrightLivePreviewService,
): Promise<void> {
  const methods = 'GET, OPTIONS'

  if (request.method === 'OPTIONS') {
    applyCorsHeaders(request, response, methods)
    response.statusCode = 204
    response.end()
    return
  }

  applyCorsHeaders(request, response, methods)

  if (request.method !== 'GET') {
    response.setHeader('Allow', methods)
    sendJson(response, 405, { error: 'Method Not Allowed' })
    return
  }

  const match = matchPathPattern(requestUrl.pathname, PLAYWRIGHT_LIVE_BOOTSTRAP_PATH)
  if (!match) {
    sendJson(response, 404, { error: 'Not Found' })
    return
  }

  try {
    const previewId = decodeURIComponent(match[1] ?? '')
    const payload: GetPlaywrightLivePreviewBootstrapResponse = {
      bootstrap: livePreviewService.getBootstrap(previewId, requestUrl.origin),
    }
    sendJson(response, 200, payload as unknown as Record<string, unknown>)
  } catch (error) {
    const normalized = asPlaywrightLivePreviewError(error)
    sendJson(response, normalized.statusCode, { error: normalized.message })
  }
}

async function handleReleasePreviewRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  livePreviewService: PlaywrightLivePreviewService,
): Promise<void> {
  const methods = 'DELETE, OPTIONS'

  if (request.method === 'OPTIONS') {
    applyCorsHeaders(request, response, methods)
    response.statusCode = 204
    response.end()
    return
  }

  applyCorsHeaders(request, response, methods)

  if (request.method !== 'DELETE') {
    response.setHeader('Allow', methods)
    sendJson(response, 405, { error: 'Method Not Allowed' })
    return
  }

  const match =
    matchPathPattern(requestUrl.pathname, PLAYWRIGHT_LIVE_RELEASE_PATH) ??
    matchPathPattern(requestUrl.pathname, PLAYWRIGHT_LIVE_PARENT_RELEASE_PATH)
  if (!match) {
    sendJson(response, 404, { error: 'Not Found' })
    return
  }

  const previewId = decodeURIComponent(match[1] ?? '')
  const payload: ReleasePlaywrightLivePreviewResponse = livePreviewService.releasePreview(previewId)
  sendJson(response, 200, payload as unknown as Record<string, unknown>)
}

async function handleAssetRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  const methods = 'GET, OPTIONS'

  if (request.method === 'OPTIONS') {
    applyCorsHeaders(request, response, methods)
    response.statusCode = 204
    response.end()
    return
  }

  applyCorsHeaders(request, response, methods)

  if (request.method !== 'GET') {
    response.setHeader('Allow', methods)
    sendJson(response, 405, { error: 'Method Not Allowed' })
    return
  }

  const match = matchPathPattern(requestUrl.pathname, PLAYWRIGHT_LIVE_ASSET_PATH)
  if (!match) {
    sendJson(response, 404, { error: 'Not Found' })
    return
  }

  const relativePath = decodeURIComponent(match[1] ?? '')
  const assetPath = resolve(STATIC_ASSET_ROOT, relativePath)
  if (!assetPath.startsWith(`${STATIC_ASSET_ROOT}/`) && assetPath !== STATIC_ASSET_ROOT) {
    sendJson(response, 403, { error: 'Forbidden' })
    return
  }

  try {
    const content = await readFile(assetPath)
    response.statusCode = 200
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Type', resolveAssetContentType(assetPath))
    response.end(content)
  } catch {
    sendJson(response, 404, { error: 'Asset not found' })
  }
}

function parseStartPreviewRequest(value: unknown): StartPlaywrightLivePreviewRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlaywrightLivePreviewError('Request body must be a JSON object', 400)
  }

  const maybe = value as Record<string, unknown>
  const sessionId = typeof maybe.sessionId === 'string' ? maybe.sessionId.trim() : ''
  if (!sessionId) {
    throw new PlaywrightLivePreviewError('sessionId is required', 400)
  }

  const mode = maybe.mode === 'focus' ? 'focus' : 'embedded'
  const reuseIfActive = typeof maybe.reuseIfActive === 'boolean' ? maybe.reuseIfActive : true

  return {
    sessionId,
    mode,
    reuseIfActive,
  }
}

function resolveAssetContentType(pathValue: string): string {
  switch (extname(pathValue).toLowerCase()) {
    case '.css':
      return 'text/css; charset=utf-8'
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

function buildEmbedHtml(requestUrl: URL): string {
  const previewId = requestUrl.searchParams.get('previewId') ?? ''
  const assetBase = `${PLAYWRIGHT_LIVE_PREFIX}/assets`

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Playwright Live Preview</title>
    <link rel="stylesheet" href="${assetBase}/embed.css" />
  </head>
  <body data-preview-id="${escapeHtml(previewId)}">
    <div class="pw-live-shell">
      <header class="pw-live-header">
        <div>
          <p class="pw-live-eyebrow">Middleman · Playwright live preview</p>
          <h1 id="pw-live-title">Waiting for preview</h1>
        </div>
        <span id="pw-live-status" class="pw-live-status">idle</span>
      </header>
      <main class="pw-live-main">
        <section class="pw-live-canvas-card">
          <img id="pw-live-frame" alt="Playwright live frame" hidden />
          <div id="pw-live-empty" class="pw-live-empty">
            <p>Open a Playwright session from the dashboard to attach a live preview lease.</p>
          </div>
        </section>
        <aside class="pw-live-sidebar">
          <dl class="pw-live-meta">
            <div>
              <dt>Preview ID</dt>
              <dd id="pw-live-preview-id">—</dd>
            </div>
            <div>
              <dt>Controller</dt>
              <dd id="pw-live-controller">—</dd>
            </div>
            <div>
              <dt>Frames</dt>
              <dd id="pw-live-frame-count">0</dd>
            </div>
          </dl>
          <pre id="pw-live-log" class="pw-live-log">Embed shell ready.</pre>
        </aside>
      </main>
    </div>
    <script type="module" src="${assetBase}/embed.js"></script>
  </body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
