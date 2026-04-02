import type { TelemetrySettingsResponse } from '@forge/protocol'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TelemetryService } from '../../telemetry/telemetry-service.js'
import { applyCorsHeaders, readJsonBody, sendJson } from '../http-utils.js'
import type { HttpRoute } from './http-route.js'

const TELEMETRY_SETTINGS_ENDPOINT = '/api/settings/telemetry'
const TELEMETRY_RESET_ID_ENDPOINT = '/api/telemetry/reset-id'
const TELEMETRY_SEND_NOW_ENDPOINT = '/api/telemetry/send-now'

class TelemetrySettingsValidationError extends Error {}

export function createTelemetryRoutes(options: {
  telemetryService: TelemetryService
}): HttpRoute[] {
  const { telemetryService } = options

  return [
    {
      methods: 'GET, PUT, OPTIONS',
      matches: (pathname) => pathname === TELEMETRY_SETTINGS_ENDPOINT,
      handle: async (request, response) => {
        await handleSettingsRequest(request, response, telemetryService)
      },
    },
    {
      methods: 'POST, OPTIONS',
      matches: (pathname) => pathname === TELEMETRY_RESET_ID_ENDPOINT,
      handle: async (request, response) => {
        await handleResetIdRequest(request, response, telemetryService)
      },
    },
    {
      methods: 'POST, OPTIONS',
      matches: (pathname) => pathname === TELEMETRY_SEND_NOW_ENDPOINT,
      handle: async (request, response) => {
        await handleSendNowRequest(request, response, telemetryService)
      },
    },
  ]
}

async function handleSettingsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  telemetryService: TelemetryService,
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
    const payload: { settings: TelemetrySettingsResponse } = {
      settings: await telemetryService.readSettings(),
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
    const settings = await telemetryService.updateConfig(patch)
    sendJson(response, 200, {
      ok: true,
      settings: settings as unknown as Record<string, unknown>,
    })
  } catch (error) {
    if (error instanceof TelemetrySettingsValidationError) {
      sendJson(response, 400, { error: error.message })
      return
    }

    throw error
  }
}

async function handleResetIdRequest(
  request: IncomingMessage,
  response: ServerResponse,
  telemetryService: TelemetryService,
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

  const settings = await telemetryService.resetInstallId()
  sendJson(response, 200, {
    ok: true,
    settings: settings as unknown as Record<string, unknown>,
  })
}

async function handleSendNowRequest(
  request: IncomingMessage,
  response: ServerResponse,
  telemetryService: TelemetryService,
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

  const sent = await telemetryService.forceSend()
  sendJson(response, 200, { ok: true, sent })
}

function parseSettingsPatch(value: unknown): { enabled?: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TelemetrySettingsValidationError('Request body must be a JSON object')
  }

  const maybe = value as Record<string, unknown>
  const patch: { enabled?: boolean } = {}

  if ('enabled' in maybe) {
    if (typeof maybe.enabled !== 'boolean') {
      throw new TelemetrySettingsValidationError('enabled must be a boolean')
    }
    patch.enabled = maybe.enabled
  }

  return patch
}
