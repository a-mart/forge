import type {
  GetPlaywrightLivePreviewBootstrapResponse,
  ReleasePlaywrightLivePreviewResponse,
  StartPlaywrightLivePreviewRequest,
  StartPlaywrightLivePreviewResponse,
  PlaywrightControllerBootstrap,
  PlaywrightDiscoveredSession,
  PlaywrightLivePreviewCandidate,
} from '@forge/protocol'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyLivePreviewCorsHeaders,
  validateLivePreviewHttpOrigin,
  type PlaywrightLivePreviewHttpAccessPolicy,
} from '../../playwright/playwright-live-preview-access.js'
import {
  PlaywrightLivePreviewError,
  PlaywrightLivePreviewService,
  asPlaywrightLivePreviewError,
} from '../../playwright/playwright-live-preview-service.js'
import { matchPathPattern, readJsonBody, sendJson } from '../http-utils.js'
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

const STATIC_ASSET_ROOT = resolvePlaywrightLiveStaticRoot()
const STATIC_ASSET_VENDORED_ROOT = resolve(STATIC_ASSET_ROOT, 'assets')

function resolvePlaywrightLiveStaticRoot(): string {
  const candidateRoots = [
    resolve(process.cwd(), 'apps', 'backend', 'static', 'playwright-live'),
    process.env.FORGE_RESOURCES_DIR?.trim()
      ? resolve(process.env.FORGE_RESOURCES_DIR.trim(), 'apps', 'backend', 'static', 'playwright-live')
      : null,
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../static/playwright-live'),
  ]

  for (const candidateRoot of candidateRoots) {
    if (candidateRoot && existsSync(candidateRoot)) {
      return candidateRoot
    }
  }

  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../static/playwright-live')
}
const DEVTOOLS_BUNDLE_JS = 'assets/index-BlUdtOgD.js'
const DEVTOOLS_BUNDLE_CSS = 'assets/index-CcsbAkl3.css'

interface CliLikeSessionConfig {
  name: string
  version: string
  timestamp: number
  socketPath: string
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
    }
  }
  __forge: {
    sessionId: string
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
        PLAYWRIGHT_LIVE_DEVTOOLS_START_PATHS.has(pathname) || pathname === PLAYWRIGHT_LIVE_PARENT_START_ENDPOINT,
      handle: async (request, response, requestUrl) => {
        await handleStartPreviewRequest(request, response, requestUrl, livePreviewService)
      },
    },
    {
      methods: 'POST, OPTIONS',
      matches: (pathname) => PLAYWRIGHT_LIVE_CLOSE_PATHS.has(pathname) || PLAYWRIGHT_LIVE_DELETE_DATA_PATHS.has(pathname),
      handle: async (request, response, requestUrl) => {
        await handleDisabledDestructiveRequest(request, response, requestUrl)
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
  if (!beginLivePreviewRequest(request, response, requestUrl, 'GET, OPTIONS', 'embedded-only')) {
    return
  }

  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET, OPTIONS')
    sendJson(response, 405, { error: 'Method Not Allowed' })
    return
  }

  const previewId = normalizePreviewId(requestUrl.searchParams.get('previewId'))

  try {
    const bootstrap = previewId ? livePreviewService.getBootstrap(previewId, requestUrl.origin) : null
    const publicSessionKey = bootstrap ? createPublicSessionKey(bootstrap.sessionId) : null

    response.statusCode = 200
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(buildAppHtml({
      previewId,
      publicSessionKey,
      sessionName: bootstrap?.sessionName ?? null,
    }))
  } catch (error) {
    const normalized = asPlaywrightLivePreviewError(error)
    response.statusCode = normalized.statusCode
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(buildAppErrorHtml({
      previewId,
      publicSessionKey: null,
      sessionName: null,
      status: normalized.statusCode === 410 ? 'expired' : normalized.statusCode === 409 ? 'unavailable' : 'error',
      message: normalized.message,
    }))
  }
}

async function handleSessionsListRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  livePreviewService: PlaywrightLivePreviewService,
): Promise<void> {
  if (!beginLivePreviewRequest(request, response, requestUrl, 'GET, OPTIONS', 'embedded-only')) {
    return
  }

  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET, OPTIONS')
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
      canConnect: candidate.previewable,
      previewable: candidate.previewable,
      unavailableReason: candidate.unavailableReason,
    }))

    sendJson(response, 200, {
      sessions,
      clientInfo: {
        workspaceDir: filteredCandidates[0] ? getWorkspaceLabel(filteredCandidates[0].session) : 'Playwright preview',
        version: filteredCandidates[0]?.session.sessionVersion ?? null,
      },
      updatedAt: livePreviewService.getPreviewableSessions().updatedAt,
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
  const policy: PlaywrightLivePreviewHttpAccessPolicy =
    requestUrl.pathname === PLAYWRIGHT_LIVE_PARENT_START_ENDPOINT ? 'parent-shell' : 'embedded-only'

  if (!beginLivePreviewRequest(request, response, requestUrl, 'POST, OPTIONS', policy)) {
    return
  }

  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST, OPTIONS')
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

    sendJson(response, 200, {
      url: preview.controllerWsUrl,
      inspectorUrl: null,
    })
  } catch (error) {
    const normalized = asPlaywrightLivePreviewError(error)
    sendJson(response, normalized.statusCode, { error: normalized.message })
  }
}

async function handleDisabledDestructiveRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
): Promise<void> {
  if (!beginLivePreviewRequest(request, response, requestUrl, 'POST, OPTIONS', 'embedded-only')) {
    return
  }

  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST, OPTIONS')
    sendJson(response, 405, { error: 'Method Not Allowed' })
    return
  }

  sendJson(response, 403, {
    error: 'Destructive Playwright session actions are disabled in embedded live preview mode',
  })
}

async function handleBootstrapRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  livePreviewService: PlaywrightLivePreviewService,
): Promise<void> {
  if (!beginLivePreviewRequest(request, response, requestUrl, 'GET, OPTIONS', 'embedded-only')) {
    return
  }

  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET, OPTIONS')
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
    const bootstrap = livePreviewService.getBootstrap(previewId, requestUrl.origin)
    const payload: GetPlaywrightLivePreviewBootstrapResponse = {
      bootstrap: sanitizeBootstrapForBrowser(bootstrap),
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
  if (!beginLivePreviewRequest(request, response, requestUrl, 'DELETE, OPTIONS', 'parent-shell')) {
    return
  }

  if (request.method !== 'DELETE') {
    response.setHeader('Allow', 'DELETE, OPTIONS')
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
  if (!beginLivePreviewRequest(request, response, requestUrl, 'GET, OPTIONS', 'embedded-only')) {
    return
  }

  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET, OPTIONS')
    sendJson(response, 405, { error: 'Method Not Allowed' })
    return
  }

  const match = matchPathPattern(requestUrl.pathname, PLAYWRIGHT_LIVE_ASSET_PATH)
  if (!match) {
    sendJson(response, 404, { error: 'Not Found' })
    return
  }

  const relativePath = decodeURIComponent(match[1] ?? '')
  const assetPath = resolve(STATIC_ASSET_VENDORED_ROOT, relativePath)
  if (!assetPath.startsWith(`${STATIC_ASSET_VENDORED_ROOT}/`) && assetPath !== STATIC_ASSET_VENDORED_ROOT) {
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

function beginLivePreviewRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  methods: string,
  policy: PlaywrightLivePreviewHttpAccessPolicy,
): boolean {
  const validation = validateLivePreviewHttpOrigin(request, requestUrl, policy)
  if (!validation.ok) {
    response.statusCode = 403
    sendJson(response, 403, { error: validation.errorMessage ?? 'Forbidden' })
    return false
  }

  applyLivePreviewCorsHeaders(request, response, methods, validation.allowedOrigin)

  if (request.method === 'OPTIONS') {
    response.statusCode = 204
    response.end()
    return false
  }

  return true
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

  return {
    sessionId,
    mode: maybe.mode === 'focus' ? 'focus' : 'embedded',
    reuseIfActive: typeof maybe.reuseIfActive === 'boolean' ? maybe.reuseIfActive : true,
  }
}

function normalizePreviewId(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function filterCandidatesForPreview(
  candidates: PlaywrightLivePreviewCandidate[],
  livePreviewService: PlaywrightLivePreviewService,
  previewId: string,
  backendOrigin: string,
): PlaywrightLivePreviewCandidate[] {
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

  const maybeConfig = config as Partial<CliLikeSessionConfig>
  const sessionId = typeof maybeConfig.__forge?.sessionId === 'string' ? maybeConfig.__forge.sessionId.trim() : ''
  if (sessionId) {
    return sessionId
  }

  const publicSessionKey = typeof maybeConfig.socketPath === 'string' ? maybeConfig.socketPath.trim() : ''
  if (publicSessionKey.startsWith('mm-session:')) {
    return publicSessionKey.slice('mm-session:'.length)
  }

  throw new PlaywrightLivePreviewError('Unknown Playwright session config', 404)
}

function sanitizeBootstrapForBrowser(bootstrap: PlaywrightControllerBootstrap): PlaywrightControllerBootstrap {
  return {
    ...bootstrap,
    inspectorWsUrl: null,
    inspectorProxyUrl: null,
    session: toBrowserSafeSession(bootstrap.session),
  }
}

function toBrowserSafeSession(session: PlaywrightDiscoveredSession): PlaywrightDiscoveredSession {
  return {
    ...session,
    sessionFilePath: '',
    sessionFileRealPath: '',
    rootPath: getWorkspaceLabel(session),
    repoRootPath: null,
    backendRootPath: null,
    worktreePath: null,
    socketPath: createPublicSessionKey(session.id),
    userDataDirPath: null,
  }
}

function toCliLikeSessionConfig(session: PlaywrightDiscoveredSession): CliLikeSessionConfig {
  return {
    name: session.sessionName,
    version: session.sessionVersion ?? '0.0.0',
    timestamp: Date.parse(session.sessionTimestamp ?? session.sessionFileUpdatedAt) || Date.now(),
    socketPath: createPublicSessionKey(session.id),
    workspaceDir: getWorkspaceLabel(session),
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
      },
    },
    __forge: {
      sessionId: session.id,
    },
  }
}

function getWorkspaceLabel(session: PlaywrightDiscoveredSession): string {
  if (session.worktreeName) {
    return `worktree:${session.worktreeName}`
  }

  if (session.repoRootPath) {
    return session.rootKind === 'backend-root' ? 'repo:backend' : 'repo:root'
  }

  return session.rootKind
}

function createPublicSessionKey(sessionId: string): string {
  return `mm-session:${sessionId}`
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
  publicSessionKey: string | null
  sessionName: string | null
}): string {
  return renderEmbedDocument({
    title: 'Playwright Remote Control',
    embedConfig: {
      previewId: options.previewId,
      publicSessionKey: options.publicSessionKey,
      sessionName: options.sessionName,
    },
    bodyContent: '<div id="root"></div>',
    loadAppBundle: true,
    initialStatus: null,
  })
}

function buildAppErrorHtml(options: {
  previewId: string | null
  publicSessionKey: string | null
  sessionName: string | null
  status: 'unavailable' | 'expired' | 'error'
  message: string
}): string {
  const escapedMessage = escapeHtml(options.message)

  return renderEmbedDocument({
    title: 'Playwright Live Preview',
    embedConfig: {
      previewId: options.previewId,
      publicSessionKey: options.publicSessionKey,
      sessionName: options.sessionName,
    },
    bodyContent: `<div class="mm-playwright-status-shell"><div class="mm-playwright-status-card"><h1>Playwright Live Preview</h1><p>${escapedMessage}</p></div></div>`,
    loadAppBundle: false,
    initialStatus: {
      status: options.status,
      message: options.message,
    },
  })
}

function renderEmbedDocument(options: {
  title: string
  embedConfig: {
    previewId: string | null
    publicSessionKey: string | null
    sessionName: string | null
  }
  bodyContent: string
  loadAppBundle: boolean
  initialStatus: { status: 'unavailable' | 'expired' | 'error'; message: string } | null
}): string {
  const embedConfigJson = serializeInlineScriptValue(options.embedConfig)
  const initialStatusJson = serializeInlineScriptValue(options.initialStatus)
  const bundleMarkup = options.loadAppBundle
    ? `<script type="module" crossorigin src="${PLAYWRIGHT_LIVE_PREFIX}/${DEVTOOLS_BUNDLE_JS}"></script>
    <link rel="stylesheet" crossorigin href="${PLAYWRIGHT_LIVE_PREFIX}/${DEVTOOLS_BUNDLE_CSS}" />`
    : ''

  return `<!DOCTYPE html>
<html lang="en" translate="no">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(options.title)}</title>
    <script>
      window.__MM_PLAYWRIGHT_EMBED__ = ${embedConfigJson};
      window.__MM_PLAYWRIGHT_EMBED_INITIAL_STATUS__ = ${initialStatusJson};
      (() => {
        const MESSAGE_TYPE = 'playwright:embed-status';
        const config = window.__MM_PLAYWRIGHT_EMBED__;
        const initialStatus = window.__MM_PLAYWRIGHT_EMBED_INITIAL_STATUS__;
        const targetOrigin = (() => {
          try {
            return document.referrer ? new URL(document.referrer).origin : '*';
          } catch {
            return '*';
          }
        })();
        let lastStatusKey = null;

        const postStatus = (status, message, extra = {}) => {
          if (window.parent === window) {
            return;
          }
          const payload = {
            type: MESSAGE_TYPE,
            previewId: config?.previewId ?? null,
            publicSessionKey: config?.publicSessionKey ?? null,
            sessionName: config?.sessionName ?? null,
            status,
            message: typeof message === 'string' && message ? message : undefined,
            ...extra,
          };
          const dedupeKey = JSON.stringify({
            status: payload.status,
            message: payload.message ?? null,
            source: payload.source ?? null,
            httpStatus: payload.httpStatus ?? null,
            code: payload.code ?? null,
            reason: payload.reason ?? null,
          });
          if (dedupeKey === lastStatusKey) {
            return;
          }
          lastStatusKey = dedupeKey;
          window.parent.postMessage(payload, targetOrigin);
        };

        const classifyHttpFailure = (status, message) => {
          const detail = typeof message === 'string' ? message.toLowerCase() : '';
          if (status === 410 || detail.includes('expired')) {
            return 'expired';
          }
          if (status === 409 || detail.includes('unavailable') || detail.includes('not previewable')) {
            return 'unavailable';
          }
          return 'error';
        };

        const isManagedRoute = (pathname) => pathname === '/api/sessions/list'
          || pathname === '/api/sessions/devtools-start'
          || pathname === '/api/sessions/close'
          || pathname === '/api/sessions/delete-data';

        const readErrorMessage = async (response) => {
          try {
            const data = await response.clone().json();
            if (data && typeof data.error === 'string' && data.error.trim()) {
              return data.error.trim();
            }
          } catch {}
          try {
            const text = await response.clone().text();
            if (text.trim()) {
              return text.trim();
            }
          } catch {}
          return response.statusText || 'Request failed';
        };

        if (config?.publicSessionKey) {
          window.location.hash = '#session=' + encodeURIComponent(config.publicSessionKey);
        }

        const NativeWebSocket = window.WebSocket;
        const controllerPathSegment = '/playwright-live/ws/controller/';
        const isControllerSocket = (urlLike) => {
          try {
            const url = new URL(typeof urlLike === 'string' ? urlLike : String(urlLike), window.location.origin);
            return url.pathname.includes(controllerPathSegment);
          } catch {
            return false;
          }
        };

        class ForgePlaywrightWebSocket extends NativeWebSocket {
          constructor(url, protocols) {
            if (protocols === undefined) {
              super(url);
            } else {
              super(url, protocols);
            }

            if (!isControllerSocket(url)) {
              return;
            }

            let opened = false;

            this.addEventListener('open', () => {
              opened = true;
              postStatus('active', 'Live preview connected', { source: 'websocket' });
            });

            this.addEventListener('error', () => {
              postStatus(opened ? 'disconnected' : 'error', opened ? 'Live preview controller error' : 'Failed to connect live preview controller', {
                source: 'websocket',
              });
            });

            this.addEventListener('close', (event) => {
              const reason = typeof event.reason === 'string' ? event.reason : '';
              const lowerReason = reason.toLowerCase();
              const status = lowerReason.includes('expired') || lowerReason.includes('released')
                ? 'expired'
                : opened
                  ? 'disconnected'
                  : 'error';
              postStatus(status, reason || (status === 'disconnected' ? 'Live preview disconnected' : 'Live preview connection closed'), {
                source: 'websocket',
                code: event.code,
                reason: reason || undefined,
                wasClean: event.wasClean,
              });
            });
          }
        }

        ForgePlaywrightWebSocket.prototype = NativeWebSocket.prototype;
        Object.defineProperty(ForgePlaywrightWebSocket, 'CONNECTING', { value: NativeWebSocket.CONNECTING });
        Object.defineProperty(ForgePlaywrightWebSocket, 'OPEN', { value: NativeWebSocket.OPEN });
        Object.defineProperty(ForgePlaywrightWebSocket, 'CLOSING', { value: NativeWebSocket.CLOSING });
        Object.defineProperty(ForgePlaywrightWebSocket, 'CLOSED', { value: NativeWebSocket.CLOSED });
        window.WebSocket = ForgePlaywrightWebSocket;

        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const rawUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
          const url = new URL(rawUrl, window.location.origin);
          const managedRoute = isManagedRoute(url.pathname);
          if (config?.previewId && managedRoute) {
            url.searchParams.set('previewId', config.previewId);
          }

          const requestInput = typeof input === 'string'
            ? url.toString()
            : input instanceof Request
              ? new Request(url.toString(), input)
              : url.toString();

          try {
            const response = await originalFetch(requestInput, init);
            if (managedRoute && !response.ok) {
              const message = await readErrorMessage(response);
              postStatus(classifyHttpFailure(response.status, message), message, {
                source: 'fetch',
                httpStatus: response.status,
              });
            }
            return response;
          } catch (error) {
            if (managedRoute) {
              postStatus('error', error instanceof Error ? error.message : 'Live preview request failed', {
                source: 'fetch',
              });
            }
            throw error;
          }
        };

        window.addEventListener('error', (event) => {
          postStatus('error', event.message || 'Live preview runtime error', { source: 'window-error' });
        });

        window.addEventListener('unhandledrejection', (event) => {
          const reason = event.reason;
          const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'Unhandled live preview rejection';
          postStatus('error', message, { source: 'window-error' });
        });

        if (initialStatus) {
          postStatus(initialStatus.status, initialStatus.message, { source: 'shell' });
        }
      })();
    </script>
    <style>
      html, body, #root { height: 100%; }
      body { margin: 0; }
      body[data-mm-playwright-embed='true'] .tabbar-back { display: none !important; }
      body[data-mm-playwright-embed='true'] .session-chip-action { display: none !important; }
      .mm-playwright-status-shell {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100%;
        padding: 24px;
        background: #0b1020;
        color: rgba(255, 255, 255, 0.92);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .mm-playwright-status-card {
        max-width: 480px;
        padding: 20px 24px;
        border-radius: 16px;
        background: rgba(15, 23, 42, 0.92);
        border: 1px solid rgba(148, 163, 184, 0.28);
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
      }
      .mm-playwright-status-card h1 {
        margin: 0 0 8px;
        font-size: 16px;
        font-weight: 600;
      }
      .mm-playwright-status-card p {
        margin: 0;
        font-size: 13px;
        line-height: 1.5;
        color: rgba(226, 232, 240, 0.9);
      }
    </style>
    ${bundleMarkup}
  </head>
  <body>
    ${options.bodyContent}
    <script>
      if (window.__MM_PLAYWRIGHT_EMBED__?.previewId) {
        document.body.dataset.mmPlaywrightEmbed = 'true';
      }
    </script>
  </body>
</html>`
}

function serializeInlineScriptValue(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\\u2028/g, '\\u2028')
    .replace(/\\u2029/g, '\\u2029')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
