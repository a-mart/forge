import type {
  GetPlaywrightSessionsResponse,
  GetPlaywrightSettingsResponse,
  TriggerPlaywrightRescanResponse,
  UpdatePlaywrightSettingsRequest,
  UpdatePlaywrightSettingsResponse,
} from '@middleman/protocol'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  PlaywrightSettingsConflictError,
} from '../../playwright/playwright-discovery-service.js'
import {
  PlaywrightSettingsValidationError,
} from '../../playwright/playwright-settings-service.js'
import type { PlaywrightDiscoveryService } from '../../playwright/playwright-discovery-service.js'
import { applyCorsHeaders, readJsonBody, sendJson } from '../http-utils.js'
import type { HttpRoute } from './http-route.js'

const PLAYWRIGHT_SESSIONS_ENDPOINT = '/api/playwright/sessions'
const PLAYWRIGHT_RESCAN_ENDPOINT = '/api/playwright/rescan'
const PLAYWRIGHT_SETTINGS_ENDPOINT = '/api/settings/playwright'

export function createPlaywrightRoutes(options: {
  discoveryService: PlaywrightDiscoveryService | null
}): HttpRoute[] {
  const { discoveryService } = options

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
      methods: 'GET, PUT, OPTIONS',
      matches: (pathname) => pathname === PLAYWRIGHT_SETTINGS_ENDPOINT,
      handle: async (request, response) => {
        await handleSettingsRequest(request, response, discoveryService)
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

async function handleSettingsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  discoveryService: PlaywrightDiscoveryService | null,
): Promise<void> {
  const methods = 'GET, PUT, OPTIONS'

  if (request.method === 'OPTIONS') {
    applyCorsHeaders(request, response, methods)
    response.statusCode = 204
    response.end()
    return
  }

  applyCorsHeaders(request, response, methods)

  if (!discoveryService) {
    sendJson(response, 503, { error: 'Playwright discovery service is unavailable' })
    return
  }

  if (request.method === 'GET') {
    const payload: GetPlaywrightSettingsResponse = {
      settings: discoveryService.getSettings(),
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
    const updated = await discoveryService.updateSettings(patch)
    const payload: UpdatePlaywrightSettingsResponse = {
      ok: true,
      settings: updated.settings,
      snapshot: updated.snapshot,
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
