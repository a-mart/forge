import type {
  GetCortexAutoReviewSettingsResponse,
  UpdateCortexAutoReviewSettingsRequest,
  UpdateCortexAutoReviewSettingsResponse,
} from '@forge/protocol'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CortexAutoReviewSettingsService,
  CortexAutoReviewSettingsValidationError,
} from '../../../swarm/cortex-auto-review-settings.js'
import { applyCorsHeaders, readJsonBody, sendJson } from '../../http-utils.js'
import type { HttpRoute } from '../shared/http-route.js'

const CORTEX_AUTO_REVIEW_SETTINGS_ENDPOINT = '/api/settings/cortex-auto-review'

export function createCortexAutoReviewRoutes(options: {
  settingsService: CortexAutoReviewSettingsService
  cortexEnabled?: boolean
}): HttpRoute[] {
  const { settingsService } = options

  return [
    {
      methods: 'GET, PUT, OPTIONS',
      matches: (pathname) => pathname === CORTEX_AUTO_REVIEW_SETTINGS_ENDPOINT,
      handle: async (request, response) => {
        await handleSettingsRequest(request, response, settingsService, options.cortexEnabled !== false)
      },
    },
  ]
}

async function handleSettingsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  settingsService: CortexAutoReviewSettingsService,
  cortexEnabled: boolean,
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
    const payload: GetCortexAutoReviewSettingsResponse & { cortexDisabled?: boolean } = {
      settings: settingsService.getSettings(),
      ...(cortexEnabled ? {} : { cortexDisabled: true }),
    }
    sendJson(response, 200, payload as unknown as Record<string, unknown>)
    return
  }

  if (request.method !== 'PUT') {
    response.setHeader('Allow', methods)
    sendJson(response, 405, { error: 'Method Not Allowed' })
    return
  }

  if (!cortexEnabled) {
    sendJson(response, 503, { error: 'Cortex is disabled' })
    return
  }

  try {
    const patch = parseSettingsPatch(await readJsonBody(request))
    const settings = await settingsService.update(patch)
    const payload: UpdateCortexAutoReviewSettingsResponse = {
      ok: true,
      settings,
    }
    sendJson(response, 200, payload as unknown as Record<string, unknown>)
  } catch (error) {
    if (error instanceof CortexAutoReviewSettingsValidationError) {
      sendJson(response, 400, { error: error.message })
      return
    }

    throw error
  }
}

function parseSettingsPatch(value: unknown): UpdateCortexAutoReviewSettingsRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CortexAutoReviewSettingsValidationError('Request body must be a JSON object')
  }

  const maybe = value as Record<string, unknown>
  const patch: UpdateCortexAutoReviewSettingsRequest = {}

  if ('enabled' in maybe) {
    patch.enabled = maybe.enabled as boolean
  }

  if ('intervalMinutes' in maybe) {
    patch.intervalMinutes = maybe.intervalMinutes as number
  }

  return patch
}
