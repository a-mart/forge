import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  GetRepositorySettingsResponse,
  UpdateRepositorySettingsRequest,
  UpdateRepositorySettingsResponse,
} from '@forge/protocol'
import { isBuilderRuntimeTarget, type RuntimeTarget } from '../../../runtime-target.js'
import {
  RepositorySettingsService,
  RepositorySettingsValidationError,
} from '../../../swarm/repository-settings-service.js'
import { applyCorsHeaders, readJsonBody, sendJson } from '../../http-utils.js'
import type { HttpRoute } from '../shared/http-route.js'

const REPOSITORY_SETTINGS_ENDPOINT = '/api/settings/repositories'
const REPOSITORY_SETTINGS_METHODS = 'GET, PUT, OPTIONS'

export function createRepositorySettingsRoutes(options: {
  settingsService: RepositorySettingsService
  runtimeTarget: RuntimeTarget
}): HttpRoute[] {
  const { settingsService, runtimeTarget } = options

  return [
    {
      methods: REPOSITORY_SETTINGS_METHODS,
      matches: (pathname) => pathname === REPOSITORY_SETTINGS_ENDPOINT,
      handle: async (request, response) => {
        await handleRepositorySettingsRequest(request, response, settingsService, runtimeTarget)
      },
    },
  ]
}

async function handleRepositorySettingsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  settingsService: RepositorySettingsService,
  runtimeTarget: RuntimeTarget,
): Promise<void> {
  if (request.method === 'OPTIONS') {
    applyCorsHeaders(request, response, REPOSITORY_SETTINGS_METHODS)
    response.statusCode = 204
    response.end()
    return
  }

  applyCorsHeaders(request, response, REPOSITORY_SETTINGS_METHODS)

  if (!isBuilderRuntimeTarget(runtimeTarget)) {
    sendJson(response, 404, { error: 'Repository settings are only available in Builder runtime.' })
    return
  }

  if (request.method === 'GET') {
    const settings = await settingsService.getSettingsAsync()
    const payload: GetRepositorySettingsResponse = { settings }
    sendJson(response, 200, payload as unknown as Record<string, unknown>)
    return
  }

  if (request.method !== 'PUT') {
    response.setHeader('Allow', REPOSITORY_SETTINGS_METHODS)
    sendJson(response, 405, { error: 'Method Not Allowed' })
    return
  }

  try {
    const patch = parseUpdateRequest(await readJsonBody(request))
    const settings = await settingsService.updateConfiguredHome(patch.configuredHome)
    const payload: UpdateRepositorySettingsResponse = { ok: true, settings }
    sendJson(response, 200, payload as unknown as Record<string, unknown>)
  } catch (error) {
    if (error instanceof RepositorySettingsValidationError) {
      sendJson(response, 400, { error: error.message, code: error.code })
      return
    }

    if (error instanceof Error && isBadRequestBodyError(error.message)) {
      sendJson(response, 400, { error: error.message })
      return
    }

    throw error
  }
}

function isBadRequestBodyError(message: string): boolean {
  return message === 'Request body must be valid JSON' || message.startsWith('Request body too large')
}

function parseUpdateRequest(value: unknown): UpdateRepositorySettingsRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RepositorySettingsValidationError('Request body must be a JSON object')
  }

  const maybe = value as Record<string, unknown>
  if (!('configuredHome' in maybe)) {
    throw new RepositorySettingsValidationError('configuredHome is required (string or null)')
  }

  if (maybe.configuredHome === null) {
    return { configuredHome: null }
  }

  if (typeof maybe.configuredHome !== 'string') {
    throw new RepositorySettingsValidationError('configuredHome must be a string or null')
  }

  return { configuredHome: maybe.configuredHome }
}
