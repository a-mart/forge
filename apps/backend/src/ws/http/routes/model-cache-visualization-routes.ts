import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ModelCacheVisualizationSettingsChangedEvent, ServerEvent } from '@forge/protocol'
import {
  getModelCacheVisualizationEnabled,
  setModelCacheVisualizationEnabled,
} from '../../../swarm/model-cache-visualization-settings.js'
import type { SwarmManager } from '../../../swarm/swarm-manager.js'
import { applyCorsHeaders, readJsonBody, sendJson } from '../../http-utils.js'
import type { HttpRoute } from '../shared/http-route.js'

const MODEL_CACHE_VISUALIZATION_ENABLED_ENDPOINT_PATH =
  '/api/settings/model-cache-visualization/enabled'
const ENABLED_METHODS = 'GET, PUT, OPTIONS'

export function createModelCacheVisualizationRoutes(options: {
  swarmManager: SwarmManager
  broadcastEvent: (event: ServerEvent) => void
}): HttpRoute[] {
  const { swarmManager, broadcastEvent } = options

  return [
    {
      methods: ENABLED_METHODS,
      matches: (pathname) => pathname === MODEL_CACHE_VISUALIZATION_ENABLED_ENDPOINT_PATH,
      handle: async (request, response, requestUrl) => {
        await handleModelCacheVisualizationEnabledRequest(
          swarmManager,
          broadcastEvent,
          request,
          response,
          requestUrl,
        )
      },
    },
  ]
}

async function handleModelCacheVisualizationEnabledRequest(
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

  const dataDir = swarmManager.getConfig().paths.dataDir

  if (request.method === 'GET') {
    try {
      const enabled = await getModelCacheVisualizationEnabled(dataDir)
      sendJson(response, 200, { enabled })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(response, 500, { error: message })
    }
    return
  }

  if (request.method === 'PUT') {
    try {
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

      const settings = await setModelCacheVisualizationEnabled(dataDir, obj.enabled)
      await swarmManager.applyModelCacheVisualizationSettingsChange(obj.enabled)

      const event: ModelCacheVisualizationSettingsChangedEvent = {
        type: 'model_cache_visualization_settings_changed',
        enabled: obj.enabled,
        updatedAt: settings.updatedAt ?? new Date().toISOString(),
      }
      broadcastEvent(event)

      sendJson(response, 200, { ok: true, enabled: obj.enabled })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(response, 500, { error: message })
    }
    return
  }

  response.setHeader('Allow', ENABLED_METHODS)
  sendJson(response, 405, { error: 'Method Not Allowed' })
}
