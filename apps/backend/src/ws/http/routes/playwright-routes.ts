import type {
  ClosePlaywrightSessionResponse,
  GetPlaywrightSessionsResponse,
  GetPlaywrightSettingsResponse,
  PlaywrightDiscoverySettings,
  PlaywrightDiscoverySnapshot,
  TriggerPlaywrightRescanResponse,
  UpdatePlaywrightSettingsRequest,
  UpdatePlaywrightSettingsResponse,
} from '@forge/protocol'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  PlaywrightSettingsConflictError,
  PlaywrightSessionNotFoundError,
  PlaywrightSessionCloseError,
} from '../../../playwright/playwright-discovery-service.js'
import {
  PlaywrightSettingsService,
  PlaywrightSettingsValidationError,
  type PlaywrightPersistedSettings,
} from '../../../playwright/playwright-settings-service.js'
import type { PlaywrightDiscoveryService } from '../../../playwright/playwright-discovery-service.js'
import { applyCorsHeaders, readJsonBody, sendJson } from '../../http-utils.js'
import type { HttpRoute } from '../shared/http-route.js'

const PLAYWRIGHT_SESSIONS_ENDPOINT = '/api/playwright/sessions'
const PLAYWRIGHT_RESCAN_ENDPOINT = '/api/playwright/rescan'
const PLAYWRIGHT_CLOSE_SESSION_ENDPOINT = '/api/playwright/sessions/close'
const PLAYWRIGHT_SETTINGS_ENDPOINT = '/api/settings/playwright'

export function createPlaywrightRoutes(options: {
  discoveryService: PlaywrightDiscoveryService | null
  settingsService: PlaywrightSettingsService
  envEnabledOverride?: boolean
}): HttpRoute[] {
  const { discoveryService, settingsService, envEnabledOverride } = options

  return [
    {
      methods: 'GET, OPTIONS',
      matches: (pathname) => pathname === PLAYWRIGHT_SESSIONS_ENDPOINT,
      handle: async (request, response) => {
        await handleGetSessions(request, response, discoveryService)
      },
    },
    {
      methods: 'POST, OPTIONS',
      matches: (pathname) => pathname === PLAYWRIGHT_RESCAN_ENDPOINT,
      handle: async (request, response) => {
        await handlePostRescan(request, response, discoveryService)
      },
    },
    {
      methods: 'POST, OPTIONS',
      matches: (pathname) => pathname === PLAYWRIGHT_CLOSE_SESSION_ENDPOINT,
      handle: async (request, response) => {
        await handleCloseSession(request, response, discoveryService)
      },
    },
    {
      methods: 'GET, PUT, OPTIONS',
      matches: (pathname) => pathname === PLAYWRIGHT_SETTINGS_ENDPOINT,
      handle: async (request, response) => {
        await handleSettingsRequest(request, response, discoveryService, settingsService, envEnabledOverride)
      },
    },
  ]
}

async function handleGetSessions(
  request: IncomingMessage,
  response: ServerResponse,
  discoveryService: PlaywrightDiscoveryService | null,
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

  if (!discoveryService) {
    sendJson(response, 503, { error: 'Playwright discovery service is unavailable' })
    return
  }

  const payload: GetPlaywrightSessionsResponse = {
    snapshot: discoveryService.getSnapshot(),
  }
  sendJson(response, 200, payload as unknown as Record<string, unknown>)
}

async function handlePostRescan(
  request: IncomingMessage,
  response: ServerResponse,
  discoveryService: PlaywrightDiscoveryService | null,
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

  if (!discoveryService) {
    sendJson(response, 503, { error: 'Playwright discovery service is unavailable' })
    return
  }

  const payload: TriggerPlaywrightRescanResponse = {
    ok: true,
    snapshot: await discoveryService.triggerRescan('http_rescan'),
  }
  sendJson(response, 200, payload as unknown as Record<string, unknown>)
}

async function handleCloseSession(
  request: IncomingMessage,
  response: ServerResponse,
  discoveryService: PlaywrightDiscoveryService | null,
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

  if (!discoveryService) {
    sendJson(response, 503, { error: 'Playwright discovery service is unavailable' })
    return
  }

  try {
    const body = await readJsonBody(request)
    const sessionId = (body as Record<string, unknown>)?.sessionId
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      sendJson(response, 400, { error: 'Missing or invalid sessionId' })
      return
    }

    const result = await discoveryService.closeSession(sessionId.trim())
    const payload: ClosePlaywrightSessionResponse = {
      ok: true,
      sessionId: sessionId.trim(),
      sessionName: result.sessionName,
      snapshot: result.snapshot,
    }
    sendJson(response, 200, payload as unknown as Record<string, unknown>)
  } catch (error) {
    if (error instanceof PlaywrightSessionNotFoundError) {
      sendJson(response, 404, { error: error.message })
      return
    }
    if (error instanceof PlaywrightSessionCloseError) {
      sendJson(response, 422, { error: error.message })
      return
    }
    throw error
  }
}

async function handleSettingsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  discoveryService: PlaywrightDiscoveryService | null,
  settingsService: PlaywrightSettingsService,
  envEnabledOverride: boolean | undefined,
): Promise<void> {
  const methods = 'GET, PUT, OPTIONS'

  if (request.method === 'OPTIONS') {
    applyCorsHeaders(request, response, methods)
    response.statusCode = 204
    response.end()
    return
  }

  applyCorsHeaders(request, response, methods)

  if (request.method === 'GET') {
    const payload: GetPlaywrightSettingsResponse = {
      settings: discoveryService?.getSettings() ?? buildEffectiveSettings(settingsService.getPersisted(), envEnabledOverride),
    }
    sendJson(response, 200, payload as unknown as Record<string, unknown>)
    return
  }

  if (request.method !== 'PUT') {
    response.setHeader('Allow', methods)
    sendJson(response, 405, { error: 'Method Not Allowed' })
    return
  }

  try {
    const patch = parseSettingsPatch(await readJsonBody(request))

    if (discoveryService) {
      const updated = await discoveryService.updateSettings(patch)
      const payload: UpdatePlaywrightSettingsResponse = {
        ok: true,
        settings: updated.settings,
        snapshot: updated.snapshot,
      }
      sendJson(response, 200, payload as unknown as Record<string, unknown>)
      return
    }

    if (envEnabledOverride !== undefined) {
      throw new PlaywrightSettingsConflictError()
    }

    await settingsService.update(patch)
    const settings = buildEffectiveSettings(settingsService.getPersisted(), envEnabledOverride)
    const payload: UpdatePlaywrightSettingsResponse = {
      ok: true,
      settings,
      snapshot: createUnavailableSnapshot(settings),
    }
    sendJson(response, 200, payload as unknown as Record<string, unknown>)
  } catch (error) {
    if (error instanceof PlaywrightSettingsConflictError) {
      sendJson(response, 409, { error: error.message })
      return
    }

    if (error instanceof PlaywrightSettingsValidationError) {
      sendJson(response, 400, { error: error.message })
      return
    }

    throw error
  }
}

function buildEffectiveSettings(
  persisted: PlaywrightPersistedSettings,
  envEnabledOverride: boolean | undefined,
): PlaywrightDiscoverySettings {
  const effectiveEnabled =
    process.platform === 'win32'
      ? false
      : (envEnabledOverride ?? persisted.enabled)

  return {
    enabled: persisted.enabled,
    effectiveEnabled,
    source: envEnabledOverride !== undefined ? 'env' : persisted.updatedAt ? 'settings' : 'default',
    envOverride: envEnabledOverride ?? null,
    scanRoots: [...persisted.scanRoots],
    pollIntervalMs: persisted.pollIntervalMs,
    socketProbeTimeoutMs: persisted.socketProbeTimeoutMs,
    staleSessionThresholdMs: persisted.staleSessionThresholdMs,
    updatedAt: persisted.updatedAt,
  }
}

function createUnavailableSnapshot(settings: PlaywrightDiscoverySettings): PlaywrightDiscoverySnapshot {
  return {
    updatedAt: null,
    lastScanStartedAt: null,
    lastScanCompletedAt: null,
    scanDurationMs: null,
    sequence: 0,
    serviceStatus: 'error',
    settings,
    rootsScanned: [],
    summary: {
      totalSessions: 0,
      activeSessions: 0,
      inactiveSessions: 0,
      staleSessions: 0,
      legacySessions: 0,
      duplicateSessions: 0,
      correlatedSessions: 0,
      unmatchedSessions: 0,
      worktreeCount: 0,
    },
    sessions: [],
    warnings: [],
    lastError: 'Playwright discovery service is unavailable',
  }
}

function parseSettingsPatch(value: unknown): UpdatePlaywrightSettingsRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlaywrightSettingsValidationError('Request body must be a JSON object')
  }

  const maybe = value as Record<string, unknown>
  const patch: UpdatePlaywrightSettingsRequest = {}

  if ('enabled' in maybe) {
    patch.enabled = maybe.enabled as boolean
  }
  if ('scanRoots' in maybe) {
    patch.scanRoots = maybe.scanRoots as string[]
  }
  if ('pollIntervalMs' in maybe) {
    patch.pollIntervalMs = maybe.pollIntervalMs as number
  }
  if ('socketProbeTimeoutMs' in maybe) {
    patch.socketProbeTimeoutMs = maybe.socketProbeTimeoutMs as number
  }
  if ('staleSessionThresholdMs' in maybe) {
    patch.staleSessionThresholdMs = maybe.staleSessionThresholdMs as number
  }

  return patch
}
