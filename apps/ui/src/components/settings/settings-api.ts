/* ------------------------------------------------------------------ */
/*  Shared API helpers for settings components                        */
/* ------------------------------------------------------------------ */

import type {
  SettingsAuthOAuthFlowState,
  TelegramSettingsConfig,
  SkillInfo,
} from './settings-types'
import type {
  ChromeCdpConfig,
  ChromeCdpPreviewTab,
  ChromeCdpProfile,
  ChromeCdpStatus,
  TelegramStatusEvent,
  SettingsAuthLoginAuthUrlEvent,
  SettingsAuthLoginCompleteEvent,
  SettingsAuthLoginEventName,
  SettingsAuthLoginProgressEvent,
  SettingsAuthLoginPromptEvent,
  SettingsAuthLoginProviderId,
  SettingsAuthProvider,
  SettingsAuthProviderId,
  SettingsAuthResponse,
  SettingsEnvResponse,
  SettingsEnvVariable,
  SettingsExtensionsResponse,
  CredentialPoolState,
  CredentialPoolStrategy,
  SkillInventoryResponse,
} from '@forge/protocol'
import { SHARED_INTEGRATION_MANAGER_ID } from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'
import { createBuilderSettingsApiClient } from './settings-api-client'

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

export const SETTINGS_AUTH_PROVIDER_META: Record<
  SettingsAuthProviderId,
  { label: string; description: string; placeholder: string; helpUrl: string; oauthSupported?: boolean }
> = {
  anthropic: {
    label: 'Anthropic',
    description: 'Used by pi-opus and Anthropic-backed managers/workers.',
    placeholder: 'sk-ant-...',
    helpUrl: 'https://console.anthropic.com/settings/keys',
    oauthSupported: true,
  },
  'openai-codex': {
    label: 'OpenAI',
    description: 'Used for Codex runtime sessions and voice transcription.',
    placeholder: 'sk-...',
    helpUrl: 'https://platform.openai.com/api-keys',
    oauthSupported: true,
  },
  xai: {
    label: 'xAI API key',
    description: 'Used by pi-grok and xAI-backed managers/workers.',
    placeholder: 'xai-...',
    helpUrl: 'https://console.x.ai/',
  },
  openrouter: {
    label: 'OpenRouter API key',
    description: 'Used by user-added OpenRouter models for specialists and workers.',
    placeholder: 'sk-or-v1-...',
    helpUrl: 'https://openrouter.ai/keys',
  },
}

export const SETTINGS_AUTH_PROVIDER_ORDER: SettingsAuthProviderId[] = ['anthropic', 'openai-codex', 'xai', 'openrouter']

export { SHARED_INTEGRATION_MANAGER_ID }

export const DEFAULT_SETTINGS_AUTH_OAUTH_FLOW_STATE: SettingsAuthOAuthFlowState = {
  status: 'idle',
  codeValue: '',
  isSubmittingCode: false,
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'An unexpected error occurred.'
}

export function createIdleSettingsAuthOAuthFlowState(): SettingsAuthOAuthFlowState {
  return { ...DEFAULT_SETTINGS_AUTH_OAUTH_FLOW_STATE }
}

function normalizeSettingsAuthProviderId(value: unknown): SettingsAuthProviderId | undefined {
  if (value === 'anthropic') return 'anthropic'
  if (value === 'openai-codex') return 'openai-codex'
  if (value === 'xai') return 'xai'
  if (value === 'openrouter') return 'openrouter'
  return undefined
}

function normalizeSettingsAuthLoginProviderId(value: unknown): SettingsAuthLoginProviderId | undefined {
  if (value === 'anthropic' || value === 'openai-codex') return value
  return undefined
}

async function readApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown; message?: unknown }
    if (typeof payload.error === 'string' && payload.error.trim()) return payload.error
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message
  } catch { /* ignore */ }
  try {
    const text = await response.text()
    if (text.trim().length > 0) return text
  } catch { /* ignore */ }
  return `Request failed (${response.status})`
}

/* ------------------------------------------------------------------ */
/*  Type guards                                                       */
/* ------------------------------------------------------------------ */

function isSettingsEnvVariable(value: unknown): value is SettingsEnvVariable {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<SettingsEnvVariable>
  return (
    typeof v.name === 'string' && v.name.trim().length > 0 &&
    typeof v.skillName === 'string' && v.skillName.trim().length > 0 &&
    typeof v.required === 'boolean' &&
    typeof v.isSet === 'boolean'
  )
}

function parseSettingsAuthProvider(value: unknown): SettingsAuthProvider | null {
  if (!value || typeof value !== 'object') return null
  const provider = value as { provider?: unknown; configured?: unknown; authType?: unknown; maskedValue?: unknown }
  const providerId = normalizeSettingsAuthProviderId(provider.provider)
  if (!providerId || typeof provider.configured !== 'boolean') return null
  if (provider.authType !== undefined && provider.authType !== 'api_key' && provider.authType !== 'oauth' && provider.authType !== 'unknown') return null
  return {
    provider: providerId,
    configured: provider.configured,
    authType: provider.authType,
    maskedValue: typeof provider.maskedValue === 'string' ? provider.maskedValue : undefined,
  }
}

function isTelegramSettingsConfig(value: unknown): value is TelegramSettingsConfig {
  if (!value || typeof value !== 'object') return false
  const config = value as Partial<TelegramSettingsConfig>
  const hasValidAllowedUserIds = config.allowedUserIds === undefined ||
    (Array.isArray(config.allowedUserIds) && config.allowedUserIds.every((e) => typeof e === 'string'))
  return (
    typeof config.profileId === 'string' && typeof config.enabled === 'boolean' &&
    config.mode === 'polling' && typeof config.hasBotToken === 'boolean' &&
    hasValidAllowedUserIds && Boolean(config.polling) &&
    Boolean(config.delivery) && Boolean(config.attachments)
  )
}

/* ------------------------------------------------------------------ */
/*  OAuth SSE parsing                                                 */
/* ------------------------------------------------------------------ */

interface SettingsAuthOAuthStreamHandlers {
  onAuthUrl: (event: SettingsAuthLoginAuthUrlEvent) => void
  onPrompt: (event: SettingsAuthLoginPromptEvent) => void
  onProgress: (event: SettingsAuthLoginProgressEvent) => void
  onComplete: (event: SettingsAuthLoginCompleteEvent) => void
  onError: (message: string) => void
}

function parseSettingsAuthOAuthEventData(rawData: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(rawData) } catch { throw new Error('Invalid OAuth event payload.') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid OAuth event payload.')
  return parsed as Record<string, unknown>
}

function parseSettingsAuthEventName(value: string): SettingsAuthLoginEventName | 'message' {
  if (value === 'auth_url' || value === 'prompt' || value === 'progress' || value === 'complete' || value === 'error') {
    return value
  }
  return 'message'
}

/* ------------------------------------------------------------------ */
/*  Env variables API                                                 */
/* ------------------------------------------------------------------ */

export async function fetchSettingsEnvVariables(clientOrWsUrl: SettingsApiClient | string): Promise<SettingsEnvVariable[]> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch('/api/settings/env')
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as Partial<SettingsEnvResponse>
  if (!payload || !Array.isArray(payload.variables)) return []
  return payload.variables.filter(isSettingsEnvVariable)
}

export async function updateSettingsEnvVariables(clientOrWsUrl: SettingsApiClient | string, values: Record<string, string>): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch('/api/settings/env', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values }) })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function deleteSettingsEnvVariable(clientOrWsUrl: SettingsApiClient | string, variableName: string): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch(`/api/settings/env/${encodeURIComponent(variableName)}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function fetchServerVersion(clientOrWsUrl: SettingsApiClient | string): Promise<string | null> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch('/api/stats?range=7d')
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { system?: { serverVersion?: unknown } }
  const version = payload.system?.serverVersion
  return typeof version === 'string' && version.trim().length > 0 ? version.trim() : null
}

/* ------------------------------------------------------------------ */
/*  Auth providers API                                                */
/* ------------------------------------------------------------------ */

export async function fetchSettingsAuthProviders(clientOrWsUrl: SettingsApiClient | string): Promise<SettingsAuthProvider[]> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch('/api/settings/auth')
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as Partial<SettingsAuthResponse>
  if (!payload || !Array.isArray(payload.providers)) return []
  const parsed = payload.providers.map((v) => parseSettingsAuthProvider(v)).filter((v): v is SettingsAuthProvider => v !== null)
  const configuredByProvider = new Map(parsed.map((entry) => [entry.provider, entry]))
  return SETTINGS_AUTH_PROVIDER_ORDER.map((provider) => configuredByProvider.get(provider) ?? { provider, configured: false })
}

export async function updateSettingsAuthProviders(clientOrWsUrl: SettingsApiClient | string, values: Partial<Record<SettingsAuthProviderId, string>>): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch('/api/settings/auth', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function deleteSettingsAuthProvider(clientOrWsUrl: SettingsApiClient | string, provider: SettingsAuthProviderId): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch(`/api/settings/auth/${encodeURIComponent(provider)}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function startSettingsAuthOAuthLoginStream(
  clientOrWsUrl: SettingsApiClient | string,
  provider: SettingsAuthProviderId,
  handlers: SettingsAuthOAuthStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch(`/api/settings/auth/login/${encodeURIComponent(provider)}`, { method: 'POST', signal })
  if (!response.ok) throw new Error(await readApiError(response))
  if (!response.body) throw new Error('OAuth login stream is unavailable.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let lineBuffer = ''
  let eventName: SettingsAuthLoginEventName | 'message' = 'message'
  let eventDataLines: string[] = []

  const flushEvent = (): void => {
    if (eventDataLines.length === 0) { eventName = 'message'; return }
    const rawData = eventDataLines.join('\n')
    eventDataLines = []

    if (eventName === 'auth_url') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      if (typeof payload.url !== 'string' || !payload.url.trim()) throw new Error('OAuth auth_url event is missing a URL.')
      handlers.onAuthUrl({ url: payload.url, instructions: typeof payload.instructions === 'string' ? payload.instructions : undefined })
    } else if (eventName === 'prompt') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      if (typeof payload.message !== 'string' || !payload.message.trim()) throw new Error('OAuth prompt event is missing a message.')
      handlers.onPrompt({ message: payload.message, placeholder: typeof payload.placeholder === 'string' ? payload.placeholder : undefined })
    } else if (eventName === 'progress') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      if (typeof payload.message === 'string' && payload.message.trim()) handlers.onProgress({ message: payload.message })
    } else if (eventName === 'complete') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      const providerId = normalizeSettingsAuthLoginProviderId(payload.provider)
      if (!providerId || payload.status !== 'connected') throw new Error('OAuth complete event payload is invalid.')
      handlers.onComplete({ provider: providerId, status: 'connected' })
    } else if (eventName === 'error') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      const message = typeof payload.message === 'string' && payload.message.trim() ? payload.message : 'OAuth login failed.'
      handlers.onError(message)
    }
    eventName = 'message'
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    lineBuffer += decoder.decode(value, { stream: true })
    let newlineIndex = lineBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      let line = lineBuffer.slice(0, newlineIndex)
      lineBuffer = lineBuffer.slice(newlineIndex + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (!line) flushEvent()
      else if (line.startsWith(':')) { /* comment */ }
      else if (line.startsWith('event:')) eventName = parseSettingsAuthEventName(line.slice('event:'.length).trim())
      else if (line.startsWith('data:')) eventDataLines.push(line.slice('data:'.length).trimStart())
      newlineIndex = lineBuffer.indexOf('\n')
    }
  }
  flushEvent()
}

export async function submitSettingsAuthOAuthPrompt(clientOrWsUrl: SettingsApiClient | string, provider: SettingsAuthProviderId, value: string): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch(`/api/settings/auth/login/${encodeURIComponent(provider)}/respond`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

/* ------------------------------------------------------------------ */
/*  Integrations API                                                  */
/* ------------------------------------------------------------------ */

function resolveManagerIntegrationPath(managerId: string, provider: 'telegram', suffix = ''): string {
  const normalizedManagerId = managerId.trim()
  if (!normalizedManagerId) {
    throw new Error('managerId is required.')
  }
  return `/api/managers/${encodeURIComponent(normalizedManagerId)}/integrations/${provider}${suffix}`
}

/* ------------------------------------------------------------------ */
/*  Telegram API                                                      */
/* ------------------------------------------------------------------ */

export async function fetchTelegramSettings(clientOrWsUrl: SettingsApiClient | string, managerId: string): Promise<{ config: TelegramSettingsConfig; status: TelegramStatusEvent | null }> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const path = resolveManagerIntegrationPath(managerId, 'telegram')
  const response = await client.fetch(path)
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { config?: unknown; status?: TelegramStatusEvent }
  if (!isTelegramSettingsConfig(payload.config)) throw new Error('Invalid Telegram settings response from backend.')
  return { config: payload.config, status: payload.status ?? null }
}

export async function updateTelegramSettings(clientOrWsUrl: SettingsApiClient | string, managerId: string, patch: Record<string, unknown>): Promise<{ config: TelegramSettingsConfig; status: TelegramStatusEvent | null }> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const path = resolveManagerIntegrationPath(managerId, 'telegram')
  const response = await client.fetch(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { config?: unknown; status?: TelegramStatusEvent }
  if (!isTelegramSettingsConfig(payload.config)) throw new Error('Invalid Telegram settings response from backend.')
  return { config: payload.config, status: payload.status ?? null }
}

export async function disableTelegramSettings(clientOrWsUrl: SettingsApiClient | string, managerId: string): Promise<{ config: TelegramSettingsConfig; status: TelegramStatusEvent | null }> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const path = resolveManagerIntegrationPath(managerId, 'telegram')
  const response = await client.fetch(path, { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { config?: unknown; status?: TelegramStatusEvent }
  if (!isTelegramSettingsConfig(payload.config)) throw new Error('Invalid Telegram settings response from backend.')
  return { config: payload.config, status: payload.status ?? null }
}

export async function testTelegramConnection(clientOrWsUrl: SettingsApiClient | string, managerId: string, patch?: Record<string, unknown>): Promise<{ botId?: string; botUsername?: string; botDisplayName?: string }> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const path = resolveManagerIntegrationPath(managerId, 'telegram', '/test')
  const response = await client.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch ?? {}) })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { result?: { botId?: string; botUsername?: string; botDisplayName?: string } }
  return payload.result ?? {}
}

/* ------------------------------------------------------------------ */
/*  Skills metadata API                                               */
/* ------------------------------------------------------------------ */

function isSkillInfo(value: unknown): value is SkillInfo {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<SkillInfo>
  return (
    typeof v.name === 'string' && v.name.trim().length > 0 &&
    (v.description === undefined || typeof v.description === 'string') &&
    typeof v.envCount === 'number' &&
    typeof v.hasRichConfig === 'boolean'
  )
}

export async function fetchSkillsList(clientOrWsUrl: SettingsApiClient | string, profileId?: string): Promise<SkillInfo[]> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const path = profileId
    ? `/api/settings/skills?profileId=${encodeURIComponent(profileId)}`
    : '/api/settings/skills'
  const response = await client.fetch(path)
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as Partial<SkillInventoryResponse>
  if (!payload || !Array.isArray(payload.skills)) return []
  return payload.skills.filter(isSkillInfo)
}

/* ------------------------------------------------------------------ */
/*  Chrome CDP API                                                    */
/* ------------------------------------------------------------------ */

function isChromeCdpConfig(value: unknown): value is ChromeCdpConfig {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<ChromeCdpConfig>
  return (
    (v.contextId === null || typeof v.contextId === 'string') &&
    Array.isArray(v.urlAllow) &&
    Array.isArray(v.urlBlock)
  )
}

function isChromeCdpStatus(value: unknown): value is ChromeCdpStatus {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<ChromeCdpStatus>
  return typeof v.connected === 'boolean'
}

function isChromeCdpProfile(value: unknown): value is ChromeCdpProfile {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<ChromeCdpProfile>
  return (
    typeof v.contextId === 'string' &&
    typeof v.tabCount === 'number' &&
    Array.isArray(v.sampleUrls) &&
    typeof v.isDefault === 'boolean'
  )
}

function isChromeCdpPreviewTab(value: unknown): value is ChromeCdpPreviewTab {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<ChromeCdpPreviewTab>
  return (
    typeof v.targetId === 'string' &&
    typeof v.title === 'string' &&
    typeof v.url === 'string'
  )
}

export async function fetchChromeCdpSettings(clientOrWsUrl: SettingsApiClient | string): Promise<{ config: ChromeCdpConfig; status: ChromeCdpStatus }> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch('/api/settings/chrome-cdp')
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { config?: unknown; status?: unknown }
  if (!isChromeCdpConfig(payload.config)) throw new Error('Invalid Chrome CDP config response from backend.')
  if (!isChromeCdpStatus(payload.status)) throw new Error('Invalid Chrome CDP status response from backend.')
  return { config: payload.config, status: payload.status }
}

export async function updateChromeCdpSettings(clientOrWsUrl: SettingsApiClient | string, config: Partial<ChromeCdpConfig>): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch('/api/settings/chrome-cdp', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function testChromeCdpConnection(clientOrWsUrl: SettingsApiClient | string): Promise<ChromeCdpStatus> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch('/api/settings/chrome-cdp/test', { method: 'POST' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as unknown
  if (!isChromeCdpStatus(payload)) throw new Error('Invalid Chrome CDP test response from backend.')
  return payload
}

export async function fetchChromeCdpProfiles(clientOrWsUrl: SettingsApiClient | string): Promise<ChromeCdpProfile[]> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch('/api/settings/chrome-cdp/profiles', { method: 'POST' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { profiles?: unknown }
  if (!payload || !Array.isArray(payload.profiles)) return []
  return payload.profiles.filter(isChromeCdpProfile)
}

export async function fetchChromeCdpPreview(
  clientOrWsUrl: SettingsApiClient | string,
  config: Partial<ChromeCdpConfig>,
  signal?: AbortSignal,
): Promise<{ tabs: ChromeCdpPreviewTab[]; totalFiltered: number; totalUnfiltered: number }> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch('/api/settings/chrome-cdp/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
    signal,
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { tabs?: unknown; totalFiltered?: unknown; totalUnfiltered?: unknown }
  const tabs = Array.isArray(payload.tabs) ? payload.tabs.filter(isChromeCdpPreviewTab) : []
  const totalFiltered = typeof payload.totalFiltered === 'number' ? payload.totalFiltered : 0
  const totalUnfiltered = typeof payload.totalUnfiltered === 'number' ? payload.totalUnfiltered : 0
  return { tabs, totalFiltered, totalUnfiltered }
}

/* ------------------------------------------------------------------ */
/*  Extensions API                                                    */
/* ------------------------------------------------------------------ */

export async function fetchSettingsExtensions(clientOrWsUrl: SettingsApiClient | string): Promise<SettingsExtensionsResponse> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch('/api/settings/extensions')
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as SettingsExtensionsResponse
  return payload
}

/* ------------------------------------------------------------------ */
/*  Credential Pool API                                               */
/* ------------------------------------------------------------------ */

export async function fetchCredentialPool(clientOrWsUrl: SettingsApiClient | string, provider: string): Promise<CredentialPoolState> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch(`/api/settings/auth/${encodeURIComponent(provider)}/accounts`)
  if (!response.ok) throw new Error(await client.readApiError(response))
  return ((await response.json()) as { pool: CredentialPoolState }).pool
}

export async function setCredentialPoolStrategy(clientOrWsUrl: SettingsApiClient | string, provider: string, strategy: CredentialPoolStrategy): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch(`/api/settings/auth/${encodeURIComponent(provider)}/strategy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strategy }),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function renamePooledCredential(clientOrWsUrl: SettingsApiClient | string, provider: string, id: string, label: string): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch(`/api/settings/auth/${encodeURIComponent(provider)}/accounts/${encodeURIComponent(id)}/label`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function setPrimaryPooledCredential(clientOrWsUrl: SettingsApiClient | string, provider: string, id: string): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch(`/api/settings/auth/${encodeURIComponent(provider)}/accounts/${encodeURIComponent(id)}/primary`, { method: 'POST' })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function resetPooledCredentialCooldown(clientOrWsUrl: SettingsApiClient | string, provider: string, id: string): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch(`/api/settings/auth/${encodeURIComponent(provider)}/accounts/${encodeURIComponent(id)}/cooldown`, { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function removePooledCredential(clientOrWsUrl: SettingsApiClient | string, provider: string, id: string): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch(`/api/settings/auth/${encodeURIComponent(provider)}/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

/**
 * Start an OAuth SSE stream for adding a new account to the credential pool.
 * POSTs to the pool-specific login endpoint, NOT the legacy per-provider login.
 */
export async function startPoolAddAccountOAuthStream(
  clientOrWsUrl: SettingsApiClient | string,
  provider: string,
  handlers: SettingsAuthOAuthStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch(`/api/settings/auth/${encodeURIComponent(provider)}/accounts/login`, { method: 'POST', signal })
  if (!response.ok) throw new Error(await readApiError(response))
  if (!response.body) throw new Error('OAuth login stream is unavailable.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let lineBuffer = ''
  let eventName: SettingsAuthLoginEventName | 'message' = 'message'
  let eventDataLines: string[] = []

  const flushEvent = (): void => {
    if (eventDataLines.length === 0) { eventName = 'message'; return }
    const rawData = eventDataLines.join('\n')
    eventDataLines = []

    if (eventName === 'auth_url') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      if (typeof payload.url !== 'string' || !payload.url.trim()) throw new Error('OAuth auth_url event is missing a URL.')
      handlers.onAuthUrl({ url: payload.url, instructions: typeof payload.instructions === 'string' ? payload.instructions : undefined })
    } else if (eventName === 'prompt') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      if (typeof payload.message !== 'string' || !payload.message.trim()) throw new Error('OAuth prompt event is missing a message.')
      handlers.onPrompt({ message: payload.message, placeholder: typeof payload.placeholder === 'string' ? payload.placeholder : undefined })
    } else if (eventName === 'progress') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      if (typeof payload.message === 'string' && payload.message.trim()) handlers.onProgress({ message: payload.message })
    } else if (eventName === 'complete') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      const providerId = normalizeSettingsAuthLoginProviderId(payload.provider)
      if (!providerId || payload.status !== 'connected') throw new Error('OAuth complete event payload is invalid.')
      handlers.onComplete({ provider: providerId, status: 'connected' })
    } else if (eventName === 'error') {
      const payload = parseSettingsAuthOAuthEventData(rawData)
      const message = typeof payload.message === 'string' && payload.message.trim() ? payload.message : 'OAuth login failed.'
      handlers.onError(message)
    }
    eventName = 'message'
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    lineBuffer += decoder.decode(value, { stream: true })
    let newlineIndex = lineBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      let line = lineBuffer.slice(0, newlineIndex)
      lineBuffer = lineBuffer.slice(newlineIndex + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (!line) flushEvent()
      else if (line.startsWith(':')) { /* comment */ }
      else if (line.startsWith('event:')) eventName = parseSettingsAuthEventName(line.slice('event:'.length).trim())
      else if (line.startsWith('data:')) eventDataLines.push(line.slice('data:'.length).trimStart())
      newlineIndex = lineBuffer.indexOf('\n')
    }
  }
  flushEvent()
}

/**
 * Submit a prompt response (e.g. authorization code) for the pool add-account OAuth flow.
 */
export async function submitPoolAddAccountOAuthPrompt(clientOrWsUrl: SettingsApiClient | string, provider: string, value: string): Promise<void> {
  const client = typeof clientOrWsUrl === 'string' ? createBuilderSettingsApiClient(clientOrWsUrl) : clientOrWsUrl
  const response = await client.fetch(`/api/settings/auth/${encodeURIComponent(provider)}/accounts/login/respond`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) })
  if (!response.ok) throw new Error(await client.readApiError(response))
}
