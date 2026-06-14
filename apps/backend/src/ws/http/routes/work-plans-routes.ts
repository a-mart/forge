import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ServerEvent } from '@forge/protocol'
import type { SwarmManager } from '../../../swarm/swarm-manager.js'
import { applyCorsHeaders, readJsonBody, sendJson } from '../../http-utils.js'
import type { HttpRoute } from '../shared/http-route.js'

const WORK_PLANS_ENABLED_ENDPOINT_PATH = '/api/settings/work-plans/enabled'
const ENABLED_METHODS = 'GET, PUT, OPTIONS'

export function createWorkPlansRoutes(options: {
  swarmManager: SwarmManager
  broadcastEvent: (event: ServerEvent) => void
}): HttpRoute[] {
  const { swarmManager, broadcastEvent } = options

  return [
    {
      methods: ENABLED_METHODS,
      matches: (pathname) => pathname === WORK_PLANS_ENABLED_ENDPOINT_PATH,
      handle: async (request, response, requestUrl) => {
        await handleWorkPlansEnabledRequest(swarmManager, broadcastEvent, request, response, requestUrl)
      },
    },
  ]
}

async function handleWorkPlansEnabledRequest(
  swarmManager: SwarmManager,
  broadcastEvent: (event: ServerEvent) => void,
  request: IncomingMessage,
  response: ServerResponse,
  _requestUrl: URL,
): Promise<void> {
  if (request.method === 'OPTIONS') {
    applyCorsHeaders(request, response, ENABLED_METHODS)
    response.statusCode = 204
    response.end()
    return
  }

  applyCorsHeaders(request, response, ENABLED_METHODS)

  if (request.method === 'GET') {
    sendJson(response, 200, { enabled: false })
    return
  }

  if (request.method === 'PUT') {
    const body = await readJsonBody(request)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(response, 400, { error: 'Request body must be a JSON object' })
      return
    }

    const obj = body as Record<string, unknown>
    if (typeof obj.enabled !== 'boolean') {
      sendJson(response, 400, { error: 'enabled must be a boolean' })
      return
    }

    await swarmManager.applyWorkPlansSettingsChange(false)
    broadcastEvent({
      type: 'work_plans_settings_changed',
      enabled: false,
      updatedAt: new Date().toISOString(),
    })

    sendJson(response, 200, { ok: true, enabled: false })
    return
  }

  response.setHeader('Allow', ENABLED_METHODS)
  sendJson(response, 405, { error: 'Method Not Allowed' })
}
