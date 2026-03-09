import type {
  GetPlaywrightLivePreviewBootstrapResponse,
  GetPlaywrightLivePreviewSessionsResponse,
  ReleasePlaywrightLivePreviewResponse,
  StartPlaywrightLivePreviewRequest,
  StartPlaywrightLivePreviewResponse,
} from '@middleman/protocol'
import { readFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PlaywrightLivePreviewError,
  PlaywrightLivePreviewService,
  asPlaywrightLivePreviewError,
} from '../../playwright/playwright-live-preview-service.js'
import { applyCorsHeaders, matchPathPattern, readJsonBody, sendJson } from '../http-utils.js'
import type { HttpRoute } from './http-route.js'

const PLAYWRIGHT_LIVE_PREFIX = '/playwright-live'
const PLAYWRIGHT_LIVE_STANDALONE_ENDPOINT = `${PLAYWRIGHT_LIVE_PREFIX}/`
const PLAYWRIGHT_LIVE_ROOT_ENDPOINT = PLAYWRIGHT_LIVE_PREFIX
const PLAYWRIGHT_LIVE_EMBED_ENDPOINT = `${PLAYWRIGHT_LIVE_PREFIX}/embed`
const PLAYWRIGHT_LIVE_ASSET_PATH = /^\/playwright-live\/assets\/(.+)$/

const PLAYWRIGHT_LIVE_SESSIONS_LIST_PATHS = new Set([
  '/api/sessions/list',
  `${PLAYWRIGHT_LIVE_PREFIX}/api/sessions/list`,
])
const PLAYWRIGHT_LIVE_DEVTOOLS_START_PATHS = new Set([
  '/api/sessions/devtools-start',
  `${PLAYWRIGHT_LIVE_PREFIX}/api/sessions/devtools-start`,
])
const PLAYWRIGHT_LIVE_CLOSE_PATHS = new Set([
  '/api/sessions/close',
  `${PLAYWRIGHT_LIVE_PREFIX}/api/sessions/close`,
])
const PLAYWRIGHT_LIVE_DELETE_DATA_PATHS = new Set([
  '/api/sessions/delete-data',
  `${PLAYWRIGHT_LIVE_PREFIX}/api/sessions/delete-data`,
])
const PLAYWRIGHT_LIVE_PARENT_START_ENDPOINT = '/api/playwright/live-preview/start'
const PLAYWRIGHT_LIVE_BOOTSTRAP_PATH = /^\/playwright-live\/api\/previews\/([^/]+)\/bootstrap$/
const PLAYWRIGHT_LIVE_RELEASE_PATH = /^\/playwright-live\/api\/previews\/([^/]+)$/
const PLAYWRIGHT_LIVE_PARENT_RELEASE_PATH = /^\/api\/playwright\/live-preview\/([^/]+)$/

const STATIC_ASSET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../static/playwright-live')
const DEVTOOLS_BUNDLE_JS = 'assets/index-BlUdtOgD.js'
const DEVTOOLS_BUNDLE_CSS = 'assets/index-CcsbAkl3.css'

interface CliLikeSessionConfig {
  name: string
  version: string
  timestamp: number
  socketPath: string | null
  workspaceDir: string
  cli: {
    persistent: boolean
    headed?: boolean
    browser?: string
  }
  resolvedConfig?: {
    browser?: {
      browserName?: string
      launchOptions?: {
        channel?: string
        headless?: boolean
      }
      isolated?: boolean
      userDataDir?: string
    }
  }
  __middleman: {
    sessionId: string
    sessionFilePath: string
    sessionFileRealPath: string
    worktreePath: string | null
    rootPath: string
  }
}

export function createPlaywrightLiveRoutes(options: {
  livePreviewService: PlaywrightLivePreviewService
}): HttpRoute[] {
  const { livePreviewService } = options

  return [
    {
      methods: 'GET, OPTIONS',
      matches: (pathname) =>
        pathname === PLAYWRIGHT_LIVE_ROOT_ENDPOINT ||
        pathname === PLAYWRIGHT_LIVE_STANDALONE_ENDPOINT ||
        pathname === PLAYWRIGHT_LIVE_EMBED_ENDPOINT,
      handle: async (request, response, requestUrl) => {
        await handleAppHtmlRequest(request, response, requestUrl, livePreviewService)
      },
    },
    {
      methods: 'GET, OPTIONS',
      matches: (pathname) => PLAYWRIGHT_LIVE_SESSIONS_LIST_PATHS.has(pathname),
      handle: async (request, response, requestUrl) => {
        await handleSessionsListRequest(request, response, requestUrl, livePreviewService)
      },
    },
    {
      methods: 'POST, OPTIONS',
      matches: (pathname) =>
        PLAYWRIGHT_LIVE_DEVTOOLS_START_PATHS.has(pathname) ||
        pathname === PLAYWRIGHT_LIVE_PARENT_START_ENDPOINT,
      handle: async (request, response, requestUrl) => {
        await handleStartPreviewRequest(request, response, requestUrl, livePreviewService)
      },
    },
    {
      methods: 'POST, OPTIONS',
      matches: (pathname) => PLAYWRIGHT_LIVE_CLOSE_PATHS.has(pathname),
      handle: async (request, response, requestUrl) => {
        await handleCloseSessionRequest(request, response, requestUrl, livePreviewService)
      },
    },
    {
      methods: 'POST, OPTIONS',
      matches: (pathname) => PLAYWRIGHT_LIVE_DELETE_DATA_PATHS.has(pathname),
      handle: async (request, response, requestUrl) => {
        await handleDeleteDataRequest(request, response, requestUrl, livePreviewService)
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
      matches: (pathname) =>
        PLAYWRIGHT_LIVE_RELEASE_PATH.test(pathname) || PLAYWRIGHT_LIVE_PARENT_RELEASE_PATH.test(pathname),
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

async function handleAppHtmlRequest(
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

  try {
    const previewId = normalizePreviewId(requestUrl.searchParams.get('previewId'))
    const bootstrap = previewId ? livePreviewService.getBootstrap(previewId, requestUrl.origin) : null

    response.statusCode = 200
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(buildAppHtml({
      previewId,
      sessionSocketPath: bootstrap?.session.socketPath ?? null,
      sessionName: bootstrap?.session.sessionName ?? null,
    }))
  } catch (error) {
    const normalized = asPlaywrightLivePreviewError(error)
    sendJson(response, normalized.statusCode, { error: normalized.message })
  }
}

async function handleSessionsListRequest(
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

  try {
    const previewId = normalizePreviewId(requestUrl.searchParams.get('previewId'))
    const candidates = livePreviewService.getPreviewableSessions().sessions
    const filteredCandidates = previewId
      ? filterCandidatesForPreview(candidates, livePreviewService, previewId, requestUrl.origin)
      : candidates

    const sessions = filteredCandidates.map((candidate) => ({
      config: toCliLikeSessionConfig(candidate.session),
      canConnect: candidate.session.liveness === 'active',
    }))

    const payload: GetPlaywrightLivePreviewSessionsResponse & {
      clientInfo: { workspaceDir: string; version: string | null }
    } = {
      sessions: filteredCandidates,
      updatedAt: livePreviewService.getPreviewableSessions().updatedAt,
      clientInfo: {
        workspaceDir:
          filteredCandidates[0]?.session.worktreePath ??
          filteredCandidates[0]?.session.rootPath ??
          process.cwd(),
        version: filteredCandidates[0]?.session.sessionVersion ?? null,
      },
    }

    sendJson(response, 200, {
      sessions,
      clientInfo: payload.clientInfo,
      updatedAt: payload.updatedAt,
    })
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
    const body = await readJsonBody(request)

    if (requestUrl.pathname === PLAYWRIGHT_LIVE_PARENT_START_ENDPOINT) {
      const payload: StartPlaywrightLivePreviewResponse = {
        ok: true,
        preview: await livePreviewService.startPreview(parseStartPreviewRequest(body), requestUrl.origin),
      }
      sendJson(response, 200, payload as unknown as Record<string, unknown>)
      return
    }

    const previewId = normalizePreviewId(requestUrl.searchParams.get('previewId'))
    const sessionId = resolveSessionIdFromCliPayload(body, livePreviewService, previewId, requestUrl.origin)
    const preview = await livePreviewService.startPreview(
      { sessionId, mode: 'embedded', reuseIfActive: true },
      requestUrl.origin,
    )

    sendJson(response, 200, { url: preview.controllerWsUrl })
  } catch (error) {
    const normalized = asPlaywrightLivePreviewError(error)
    sendJson(response, normalized.statusCode, { error: normalized.message })
  }
}

async function handleCloseSessionRequest(
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
    const body = await readJsonBody(request)
    const previewId = normalizePreviewId(requestUrl.searchParams.get('previewId'))
    const sessionId = resolveSessionIdFromCliPayload(body, livePreviewService, previewId, requestUrl.origin)
    const session = findSessionCandidate(livePreviewService, sessionId).session

    await sendStopRpc(session)

    const activePreviewId = findSessionCandidate(livePreviewService, sessionId).activePreviewId
    if (activePreviewId) {
      livePreviewService.releasePreview(activePreviewId)
    }

    sendJson(response, 200, { success: true })
  } catch (error) {
    const normalized = asPlaywrightLivePreviewError(error)
    sendJson(response, normalized.statusCode, { error: normalized.message })
  }
}

async function handleDeleteDataRequest(
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
    const body = await readJsonBody(request)
    const previewId = normalizePreviewId(requestUrl.searchParams.get('previewId'))
    const sessionId = resolveSessionIdFromCliPayload(body, livePreviewService, previewId, requestUrl.origin)
    const candidate = findSessionCandidate(livePreviewService, sessionId)
    const session = candidate.session

    await sendStopRpc(session).catch(() => {})
    if (candidate.activePreviewId) {
      livePreviewService.releasePreview(candidate.activePreviewId)
    }

    await Promise.allSettled([
      session.userDataDirPath ? rm(session.userDataDirPath, { recursive: true, force: true }) : Promise.resolve(),
      rm(session.sessionFilePath, { force: true }),
      rm(session.sessionFileRealPath, { force: true }),
    ])

    sendJson(response, 200, { success: true })
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
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
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

function normalizePreviewId(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function filterCandidatesForPreview(
  candidates: ReturnType<PlaywrightLivePreviewService['getPreviewableSessions']>['sessions'],
  livePreviewService: PlaywrightLivePreviewService,
  previewId: string,
  backendOrigin: string,
) {
  const bootstrap = livePreviewService.getBootstrap(previewId, backendOrigin)
  return candidates.filter((candidate) => candidate.session.id === bootstrap.session.id)
}

function resolveSessionIdFromCliPayload(
  value: unknown,
  livePreviewService: PlaywrightLivePreviewService,
  previewId: string | null,
  backendOrigin: string,
): string {
  if (previewId) {
    return livePreviewService.getBootstrap(previewId, backendOrigin).session.id
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlaywrightLivePreviewError('Request body must be a JSON object', 400)
  }

  const config = (value as { config?: unknown }).config
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new PlaywrightLivePreviewError('config is required', 400)
  }

  const maybeConfig = config as Partial<CliLikeSessionConfig> & {
    __middleman?: { sessionId?: unknown; sessionFileRealPath?: unknown }
  }

  const sessionId =
    typeof maybeConfig.__middleman?.sessionId === 'string'
      ? maybeConfig.__middleman.sessionId.trim()
      : ''
  if (sessionId) {
    return sessionId
  }

  const candidates = livePreviewService.getPreviewableSessions().sessions
  const matched = candidates.find((candidate) => {
    if (maybeConfig.socketPath && candidate.session.socketPath !== maybeConfig.socketPath) {
      return false
    }

    if (maybeConfig.__middleman?.sessionFileRealPath && candidate.session.sessionFileRealPath !== maybeConfig.__middleman.sessionFileRealPath) {
      return false
    }

    if (maybeConfig.workspaceDir) {
      const workspaceDir = candidate.session.worktreePath ?? candidate.session.rootPath
      return workspaceDir === maybeConfig.workspaceDir
    }

    return Boolean(maybeConfig.socketPath)
  })

  if (!matched) {
    throw new PlaywrightLivePreviewError('Unknown Playwright session config', 404)
  }

  return matched.session.id
}

function findSessionCandidate(
  livePreviewService: PlaywrightLivePreviewService,
  sessionId: string,
) {
  const candidate = livePreviewService
    .getPreviewableSessions()
    .sessions.find((entry) => entry.session.id === sessionId)

  if (!candidate) {
    throw new PlaywrightLivePreviewError(`Unknown Playwright session ${sessionId}`, 404)
  }

  return candidate
}

function toCliLikeSessionConfig(session: ReturnType<typeof findSessionCandidate>['session']): CliLikeSessionConfig {
  return {
    name: session.sessionName,
    version: session.sessionVersion ?? '0.0.0',
    timestamp: Date.parse(session.sessionTimestamp ?? session.sessionFileUpdatedAt) || Date.now(),
    socketPath: session.socketPath,
    workspaceDir: session.worktreePath ?? session.rootPath,
    cli: {
      persistent: session.persistent === true,
      headed: session.headless === null ? undefined : !session.headless,
      browser: session.browserChannel ?? session.browserName ?? undefined,
    },
    resolvedConfig: {
      browser: {
        browserName: session.browserName ?? undefined,
        launchOptions: {
          channel: session.browserChannel ?? undefined,
          headless: session.headless ?? undefined,
        },
        isolated: session.isolated ?? undefined,
        userDataDir: session.userDataDirPath ?? undefined,
      },
    },
    __middleman: {
      sessionId: session.id,
      sessionFilePath: session.sessionFilePath,
      sessionFileRealPath: session.sessionFileRealPath,
      worktreePath: session.worktreePath,
      rootPath: session.rootPath,
    },
  }
}

async function sendStopRpc(session: ReturnType<typeof findSessionCandidate>['session']): Promise<void> {
  if (!session.socketPath || !session.sessionVersion) {
    return
  }

  const { createConnection } = await import('node:net')
  const socketPath = session.socketPath
  if (!socketPath) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath)
    const timeout = setTimeout(() => {
      socket.destroy()
      resolve()
    }, 2_000)

    const cleanup = (): void => {
      clearTimeout(timeout)
      socket.removeAllListeners()
    }

    socket.once('connect', () => {
      const payload = JSON.stringify({ id: 1, method: 'stop', params: {}, version: session.sessionVersion })
      socket.write(`${payload}\n`, () => {
        cleanup()
        socket.destroy()
        resolve()
      })
    })

    socket.once('error', (error) => {
      cleanup()
      reject(error)
    })
  })
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

function buildAppHtml(options: {
  previewId: string | null
  sessionSocketPath: string | null
  sessionName: string | null
}): string {
  const embedConfig = {
    previewId: options.previewId,
    sessionSocketPath: options.sessionSocketPath,
    sessionName: options.sessionName,
  }

  return `<!DOCTYPE html>
<html lang="en" translate="no">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Playwright Remote Control</title>
    <script>
      window.__MM_PLAYWRIGHT_EMBED__ = ${JSON.stringify(embedConfig)};
      (() => {
        const config = window.__MM_PLAYWRIGHT_EMBED__;
        if (config?.sessionSocketPath) {
          window.location.hash = '#session=' + encodeURIComponent(config.sessionSocketPath);
        }
        const originalFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const rawUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
          const url = new URL(rawUrl, window.location.origin);
          if (config?.previewId && (url.pathname === '/api/sessions/list' || url.pathname === '/api/sessions/devtools-start' || url.pathname === '/api/sessions/close' || url.pathname === '/api/sessions/delete-data')) {
            url.searchParams.set('previewId', config.previewId);
          }
          if (typeof input === 'string') {
            return originalFetch(url.toString(), init);
          }
          if (input instanceof Request) {
            return originalFetch(new Request(url.toString(), input), init);
          }
          return originalFetch(url.toString(), init);
        };
      })();
    </script>
    <style>
      html, body, #root { height: 100%; }
      body { margin: 0; }
      body[data-mm-playwright-embed='true'] .tabbar-back { display: none !important; }
    </style>
    <script>
      if (window.__MM_PLAYWRIGHT_EMBED__?.previewId) {
        document.body.dataset.mmPlaywrightEmbed = 'true';
      }
    </script>
    <script type="module" crossorigin src="${PLAYWRIGHT_LIVE_PREFIX}/${DEVTOOLS_BUNDLE_JS}"></script>
    <link rel="stylesheet" crossorigin href="${PLAYWRIGHT_LIVE_PREFIX}/${DEVTOOLS_BUNDLE_CSS}" />
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`
}
