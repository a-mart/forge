import type {
  ForgeGlobalSettings,
  StreamDeckActionRequest,
  StreamDeckActionResponse,
  StreamDeckSnapshot,
  StreamDeckPairingClaimResponse,
  StreamDeckPairingRequestCreated,
} from './types.js'

const DEFAULT_BASE_URL = 'http://127.0.0.1:47287'
const DEFAULT_UI_URL = 'forge://open'

export class ForgeClient {
  constructor(private readonly getSettings: () => Promise<ForgeGlobalSettings>) {}

  async getSnapshot(sessionAgentId?: string): Promise<StreamDeckSnapshot> {
    const settings = await this.getSettings()
    const url = new URL('/api/stream-deck/snapshot', normalizeBaseUrl(settings.baseUrl))
    if (sessionAgentId) url.searchParams.set('sessionAgentId', sessionAgentId)
    return this.request<StreamDeckSnapshot>(url, settings)
  }

  async perform(action: StreamDeckActionRequest): Promise<StreamDeckActionResponse> {
    const settings = await this.getSettings()
    const url = new URL('/api/stream-deck/actions', normalizeBaseUrl(settings.baseUrl))
    return this.request<StreamDeckActionResponse>(url, settings, {
      method: 'POST',
      body: JSON.stringify(action),
    })
  }

  async createPairing(input: {
    deviceId: string
    deviceName: string
    pluginVersion: string
  }): Promise<StreamDeckPairingRequestCreated> {
    const settings = await this.getSettings()
    const url = new URL('/api/stream-deck/pairing/requests', normalizeBaseUrl(settings.baseUrl))
    return this.requestWithoutAuth<StreamDeckPairingRequestCreated>(url, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  async claimPairing(requestId: string, claimSecret: string): Promise<StreamDeckPairingClaimResponse> {
    const settings = await this.getSettings()
    const url = new URL(`/api/stream-deck/pairing/requests/${encodeURIComponent(requestId)}/claim`, normalizeBaseUrl(settings.baseUrl))
    return this.requestWithoutAuth<StreamDeckPairingClaimResponse>(url, {
      method: 'POST',
      body: JSON.stringify({ claimSecret }),
    })
  }

  async open(sessionAgentId: string | null, view: string): Promise<string> {
    const settings = await this.getSettings()
    const url = new URL(normalizeUiUrl(settings.uiUrl))
    if (view === 'stats' || view === 'tokens') {
      url.searchParams.set('view', 'stats')
      if (view === 'tokens') url.searchParams.set('statsTab', 'tokens')
    } else {
      if (sessionAgentId) url.searchParams.set('agent', sessionAgentId)
      url.searchParams.set('surface', 'builder')
      if (view !== 'chat') url.searchParams.set('deckPanel', view)
    }
    return url.toString()
  }

  private async request<T>(
    url: URL,
    settings: ForgeGlobalSettings,
    init: RequestInit = {},
  ): Promise<T> {
    const apiKey = settings.accessToken?.trim() || settings.apiKey?.trim()
    if (!apiKey) throw new ForgeHttpError(401, 'Pair this Stream Deck in Forge Settings')
    return this.requestWithoutAuth<T>(url, {
      ...init,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...init.headers,
      },
    })
  }

  private async requestWithoutAuth<T>(url: URL, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...init.headers,
      },
      signal: AbortSignal.timeout(4_000),
    })
    const payload = await response.json() as T | { message?: string; error?: { message?: string } }
    if (!response.ok) {
      const details = payload as { message?: string; error?: { message?: string } }
      throw new ForgeHttpError(response.status, details.message ?? details.error?.message ?? `Forge returned ${response.status}`)
    }
    return payload as T
  }
}

export class ForgeHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'ForgeHttpError'
  }
}

function normalizeBaseUrl(value: string | undefined): string {
  return value?.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL
}

function normalizeUiUrl(value: string | undefined): string {
  return value?.trim() || DEFAULT_UI_URL
}
