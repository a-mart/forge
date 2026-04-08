import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TelemetryService } from '../../../telemetry/telemetry-service.js'
import { applyCorsHeaders, sendJson } from '../../http-utils.js'
import type { HttpRoute } from '../shared/http-route.js'

const TELEMETRY_SEND_NOW_ENDPOINT = '/api/telemetry/send-now'

export function createTelemetryRoutes(options: {
  telemetryService: TelemetryService
}): HttpRoute[] {
  const { telemetryService } = options

  return [
    {
      methods: 'POST, OPTIONS',
      matches: (pathname) => pathname === TELEMETRY_SEND_NOW_ENDPOINT,
      handle: async (request, response) => {
        await handleSendNowRequest(request, response, telemetryService)
      },
    },
  ]
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
