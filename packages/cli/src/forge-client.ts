import type {
  CliAgentShowResponse,
  CliAgentsListResponse,
  CliCapabilitiesResponse,
  CliChoiceShowResponse,
  CliChoicesListResponse,
  CliHttpErrorResponse,
  CliProfileShowResponse,
  CliProfilesListResponse,
  CliProjectAgentShowResponse,
  CliProjectAgentsListResponse,
  CliSessionShowResponse,
  CliSessionsListResponse,
  CliStatusResponse,
} from '@forge/protocol'

import { CliError } from './output.js'
import { CLI_PROTOCOL_VERSION, EXIT_CODES } from './version.js'

export interface ForgeClientOptions {
  url: string
  apiKey: string
  fetchImpl?: typeof fetch
}

export interface ChoiceListFilters {
  profileId?: string
  sessionAgentId?: string
}

export interface ForgeClientLike {
  getCapabilities(): Promise<CliCapabilitiesResponse>
  getStatus(): Promise<CliStatusResponse>
  listProfiles(): Promise<CliProfilesListResponse>
  showProfile(profileId: string): Promise<CliProfileShowResponse>
  listSessions(profileId: string): Promise<CliSessionsListResponse>
  showSession(agentId: string): Promise<CliSessionShowResponse>
  listAgents(profileId?: string): Promise<CliAgentsListResponse>
  showAgent(agentId: string): Promise<CliAgentShowResponse>
  listProjectAgents(profileId: string): Promise<CliProjectAgentsListResponse>
  showProjectAgent(profileId: string, handle: string): Promise<CliProjectAgentShowResponse>
  listChoices(filters?: ChoiceListFilters): Promise<CliChoicesListResponse>
  showChoice(choiceId: string, sessionAgentId?: string): Promise<CliChoiceShowResponse>
}

export class ForgeClient implements ForgeClientLike {
  private readonly baseUrl: URL
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch

  constructor(options: ForgeClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.url)
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  getCapabilities(): Promise<CliCapabilitiesResponse> {
    return this.get('capabilities')
  }

  getStatus(): Promise<CliStatusResponse> {
    return this.get('status')
  }

  listProfiles(): Promise<CliProfilesListResponse> {
    return this.get('profiles')
  }

  showProfile(profileId: string): Promise<CliProfileShowResponse> {
    return this.get(`profiles/${encodeURIComponent(profileId)}`)
  }

  listSessions(profileId: string): Promise<CliSessionsListResponse> {
    return this.get(`sessions?profileId=${encodeURIComponent(profileId)}`)
  }

  showSession(agentId: string): Promise<CliSessionShowResponse> {
    return this.get(`sessions/${encodeURIComponent(agentId)}`)
  }

  listAgents(profileId?: string): Promise<CliAgentsListResponse> {
    const query = profileId ? `?profileId=${encodeURIComponent(profileId)}` : ''
    return this.get(`agents${query}`)
  }

  showAgent(agentId: string): Promise<CliAgentShowResponse> {
    return this.get(`agents/${encodeURIComponent(agentId)}`)
  }

  listProjectAgents(profileId: string): Promise<CliProjectAgentsListResponse> {
    return this.get(`project-agents?profileId=${encodeURIComponent(profileId)}`)
  }

  showProjectAgent(profileId: string, handle: string): Promise<CliProjectAgentShowResponse> {
    return this.get(`project-agents/${encodeURIComponent(handle)}?profileId=${encodeURIComponent(profileId)}`)
  }

  listChoices(filters: ChoiceListFilters = {}): Promise<CliChoicesListResponse> {
    const params = new URLSearchParams()
    if (filters.sessionAgentId) params.set('sessionAgentId', filters.sessionAgentId)
    if (filters.profileId) params.set('profileId', filters.profileId)
    const query = params.size > 0 ? `?${params.toString()}` : ''
    return this.get(`choices${query}`)
  }

  showChoice(choiceId: string, sessionAgentId?: string): Promise<CliChoiceShowResponse> {
    const query = sessionAgentId ? `?sessionAgentId=${encodeURIComponent(sessionAgentId)}` : ''
    return this.get(`choices/${encodeURIComponent(choiceId)}${query}`)
  }

  private async get<T>(path: string): Promise<T> {
    const url = new URL(`/api/cli/${path}`, this.baseUrl)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
        },
      })
    } catch (error) {
      throw new CliError(`Could not connect to Forge at ${this.baseUrl.origin}: ${errorMessage(error)}`, {
        exitCode: EXIT_CODES.connection,
        code: 'connection_failed',
      })
    }

    if (!response.ok) {
      const errorPayload = await readErrorPayload(response)
      const message = errorPayload?.error.message ?? `Forge request failed with HTTP ${response.status}`
      throw new CliError(message, {
        exitCode: response.status === 401 || response.status === 403 ? EXIT_CODES.auth : EXIT_CODES.connection,
        code: errorPayload?.error.code ?? `http_${response.status}`,
        details: { status: response.status },
      })
    }

    try {
      return (await response.json()) as T
    } catch (error) {
      throw new CliError(`Forge returned invalid JSON: ${errorMessage(error)}`, {
        exitCode: EXIT_CODES.connection,
        code: 'invalid_json',
      })
    }
  }
}

export function assertSupportedCapabilities(response: CliCapabilitiesResponse | CliStatusResponse): void {
  const capabilities = response.capabilities
  if (!capabilities.available) {
    throw new CliError('Forge CLI API is not available on this server.', {
      exitCode: EXIT_CODES.unsupported,
      code: 'cli_unavailable',
    })
  }
  if (capabilities.protocolVersion !== CLI_PROTOCOL_VERSION) {
    throw new CliError(`Unsupported Forge CLI protocol version: ${capabilities.protocolVersion}`, {
      exitCode: EXIT_CODES.unsupported,
      code: 'unsupported_protocol',
    })
  }
  if (!capabilities.features.bearerAuth) {
    throw new CliError('Forge server does not advertise CLI bearer authentication.', {
      exitCode: EXIT_CODES.unsupported,
      code: 'missing_bearer_auth',
    })
  }
}

export function normalizeBaseUrl(value: string): URL {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new CliError('Forge URL is required.', { exitCode: EXIT_CODES.usage, code: 'missing_url' })
  }

  const httpUrl = trimmed.startsWith('ws://')
    ? `http://${trimmed.slice('ws://'.length)}`
    : trimmed.startsWith('wss://')
      ? `https://${trimmed.slice('wss://'.length)}`
      : trimmed

  try {
    const url = new URL(httpUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`unsupported protocol ${url.protocol}`)
    }
    return url
  } catch (error) {
    throw new CliError(`Invalid Forge URL: ${errorMessage(error)}`, { exitCode: EXIT_CODES.usage, code: 'invalid_url' })
  }
}

async function readErrorPayload(response: Response): Promise<CliHttpErrorResponse | null> {
  try {
    return (await response.json()) as CliHttpErrorResponse
  } catch {
    return null
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
