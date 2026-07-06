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
  OpenAIBrokerInviteRedeemResponse,
  OpenAIBrokerSettingsResponse,
  OpenAIBrokerSettingsState,
  OpenAIBrokerTestResponse,
  RedeemOpenAIBrokerInviteRequest,
  UpdateOpenAIBrokerSettingsRequest,
  CredentialPoolState,
  CredentialPoolStrategy,
  SkillInventoryResponse,
} from '@forge/protocol'
import { SHARED_INTEGRATION_MANAGER_ID } from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'

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
  'cursor-sdk': {
    label: 'Cursor API key',
    description: 'Used by Cursor SDK Composer specialists.',
    placeholder: 'key_... or Cursor API key',
    helpUrl: 'https://cursor.com/dashboard?tab=api-keys',
  },
}

export const SETTINGS_AUTH_PROVIDER_ORDER: SettingsAuthProviderId[] = ['anthropic', 'openai-codex', 'xai', 'openrouter', 'cursor-sdk']

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
  if (value === 'cursor-sdk') return 'cursor-sdk'
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
  const provider = value as { provider?: unknown; configured?: unknown; authType?: unknown; maskedValue?: unknown; source?: unknown; readOnly?: unknown; statusDetail?: unknown }
  const providerId = normalizeSettingsAuthProviderId(provider.provider)
  if (!providerId || typeof provider.configured !== 'boolean') return null
  if (provider.authType !== undefined && provider.authType !== 'api_key' && provider.authType !== 'oauth' && provider.authType !== 'unknown') return null
  return {
    provider: providerId,
    configured: provider.configured,
    authType: provider.authType,
    maskedValue: typeof provider.maskedValue === 'string' ? provider.maskedValue : undefined,
    source: provider.source === 'auth_file' || provider.source === 'env' || provider.source === 'secrets' || provider.source === 'pool' || provider.source === 'central_broker' ? provider.source : undefined,
    readOnly: typeof provider.readOnly === 'boolean' ? provider.readOnly : undefined,
    statusDetail: typeof provider.statusDetail === 'string' ? provider.statusDetail : undefined,
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

export async function fetchSettingsEnvVariables(client: SettingsApiClient): Promise<SettingsEnvVariable[]> {
  const response = await client.fetch('/api/settings/env')
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as Partial<SettingsEnvResponse>
  if (!payload || !Array.isArray(payload.variables)) return []
  return payload.variables.filter(isSettingsEnvVariable)
}

export async function updateSettingsEnvVariables(client: SettingsApiClient, values: Record<string, string>): Promise<void> {
  const response = await client.fetch('/api/settings/env', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values }) })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function deleteSettingsEnvVariable(client: SettingsApiClient, variableName: string): Promise<void> {
  const response = await client.fetch(`/api/settings/env/${encodeURIComponent(variableName)}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function fetchServerVersion(client: SettingsApiClient): Promise<string | null> {
  const response = await client.fetch('/api/stats?range=7d')
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { system?: { serverVersion?: unknown } }
  const version = payload.system?.serverVersion
  return typeof version === 'string' && version.trim().length > 0 ? version.trim() : null
}

/* ------------------------------------------------------------------ */
/*  Auth providers API                                                */
/* ------------------------------------------------------------------ */

export async function fetchSettingsAuthProviders(client: SettingsApiClient): Promise<SettingsAuthProvider[]> {
  const response = await client.fetch('/api/settings/auth')
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as Partial<SettingsAuthResponse>
  if (!payload || !Array.isArray(payload.providers)) return []
  const parsed = payload.providers.map((v) => parseSettingsAuthProvider(v)).filter((v): v is SettingsAuthProvider => v !== null)
  const configuredByProvider = new Map(parsed.map((entry) => [entry.provider, entry]))
  return SETTINGS_AUTH_PROVIDER_ORDER.map((provider) => configuredByProvider.get(provider) ?? { provider, configured: false })
}

export const SETTINGS_AUTH_CHANGED_EVENT = 'forge:settings-auth-changed'

function dispatchSettingsAuthChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(SETTINGS_AUTH_CHANGED_EVENT))
}

export async function updateSettingsAuthProviders(client: SettingsApiClient, values: Partial<Record<SettingsAuthProviderId, string>>): Promise<void> {
  const response = await client.fetch('/api/settings/auth', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) })
  if (!response.ok) throw new Error(await client.readApiError(response))
  dispatchSettingsAuthChanged()
}

export async function deleteSettingsAuthProvider(client: SettingsApiClient, provider: SettingsAuthProviderId): Promise<void> {
  const response = await client.fetch(`/api/settings/auth/${encodeURIComponent(provider)}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  dispatchSettingsAuthChanged()
}

export async function fetchOpenAIBrokerSettings(client: SettingsApiClient): Promise<OpenAIBrokerSettingsState> {
  const response = await client.fetch('/api/settings/auth/openai-codex/source')
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as Partial<OpenAIBrokerSettingsResponse>
  if (!payload.settings) throw new Error('Invalid Forge Auth broker settings response from backend.')
  return payload.settings
}

export async function updateOpenAIBrokerSettings(
  client: SettingsApiClient,
  request: UpdateOpenAIBrokerSettingsRequest,
): Promise<OpenAIBrokerSettingsState> {
  const response = await client.fetch('/api/settings/auth/openai-codex/source', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
  dispatchSettingsAuthChanged()
  const payload = (await response.json()) as Partial<OpenAIBrokerSettingsResponse>
  if (!payload.settings) throw new Error('Invalid Forge Auth broker settings response from backend.')
  return payload.settings
}

export async function redeemOpenAIBrokerInvite(
  client: SettingsApiClient,
  request: RedeemOpenAIBrokerInviteRequest,
): Promise<OpenAIBrokerSettingsState> {
  const response = await client.fetch('/api/settings/auth/openai-codex/source/invite/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
  dispatchSettingsAuthChanged()
  const payload = (await response.json()) as Partial<OpenAIBrokerInviteRedeemResponse>
  if (!payload.settings) throw new Error('Invalid Forge Auth broker invite redeem response from backend.')
  return payload.settings
}

export async function testOpenAIBrokerSettings(
  client: SettingsApiClient,
  request?: Partial<UpdateOpenAIBrokerSettingsRequest>,
): Promise<OpenAIBrokerTestResponse> {
  const response = await client.fetch('/api/settings/auth/openai-codex/source/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request ?? {}),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
  return (await response.json()) as OpenAIBrokerTestResponse
}

export async function disableOpenAIBrokerSettings(client: SettingsApiClient): Promise<OpenAIBrokerSettingsState> {
  const response = await client.fetch('/api/settings/auth/openai-codex/source/disable', { method: 'POST' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  dispatchSettingsAuthChanged()
  const payload = (await response.json()) as Partial<OpenAIBrokerSettingsResponse>
  if (!payload.settings) throw new Error('Invalid Forge Auth broker settings response from backend.')
  return payload.settings
}

export async function clearOpenAIBrokerSettings(client: SettingsApiClient): Promise<OpenAIBrokerSettingsState> {
  const response = await client.fetch('/api/settings/auth/openai-codex/source', { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  dispatchSettingsAuthChanged()
  const payload = (await response.json()) as Partial<OpenAIBrokerSettingsResponse>
  if (!payload.settings) throw new Error('Invalid Forge Auth broker settings response from backend.')
  return payload.settings
}

export async function startSettingsAuthOAuthLoginStream(
  client: SettingsApiClient,
  provider: SettingsAuthProviderId,
  handlers: SettingsAuthOAuthStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
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
      dispatchSettingsAuthChanged()
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

export async function submitSettingsAuthOAuthPrompt(client: SettingsApiClient, provider: SettingsAuthProviderId, value: string): Promise<void> {
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

export async function fetchTelegramSettings(client: SettingsApiClient, managerId: string): Promise<{ config: TelegramSettingsConfig; status: TelegramStatusEvent | null }> {
  const path = resolveManagerIntegrationPath(managerId, 'telegram')
  const response = await client.fetch(path)
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { config?: unknown; status?: TelegramStatusEvent }
  if (!isTelegramSettingsConfig(payload.config)) throw new Error('Invalid Telegram settings response from backend.')
  return { config: payload.config, status: payload.status ?? null }
}

export async function updateTelegramSettings(client: SettingsApiClient, managerId: string, patch: Record<string, unknown>): Promise<{ config: TelegramSettingsConfig; status: TelegramStatusEvent | null }> {
  const path = resolveManagerIntegrationPath(managerId, 'telegram')
  const response = await client.fetch(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { config?: unknown; status?: TelegramStatusEvent }
  if (!isTelegramSettingsConfig(payload.config)) throw new Error('Invalid Telegram settings response from backend.')
  return { config: payload.config, status: payload.status ?? null }
}

export async function disableTelegramSettings(client: SettingsApiClient, managerId: string): Promise<{ config: TelegramSettingsConfig; status: TelegramStatusEvent | null }> {
  const path = resolveManagerIntegrationPath(managerId, 'telegram')
  const response = await client.fetch(path, { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { config?: unknown; status?: TelegramStatusEvent }
  if (!isTelegramSettingsConfig(payload.config)) throw new Error('Invalid Telegram settings response from backend.')
  return { config: payload.config, status: payload.status ?? null }
}

export async function testTelegramConnection(client: SettingsApiClient, managerId: string, patch?: Record<string, unknown>): Promise<{ botId?: string; botUsername?: string; botDisplayName?: string }> {
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

export async function fetchSkillsList(client: SettingsApiClient, profileId?: string): Promise<SkillInfo[]> {
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

export async function fetchChromeCdpSettings(client: SettingsApiClient): Promise<{ config: ChromeCdpConfig; status: ChromeCdpStatus }> {
  const response = await client.fetch('/api/settings/chrome-cdp')
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { config?: unknown; status?: unknown }
  if (!isChromeCdpConfig(payload.config)) throw new Error('Invalid Chrome CDP config response from backend.')
  if (!isChromeCdpStatus(payload.status)) throw new Error('Invalid Chrome CDP status response from backend.')
  return { config: payload.config, status: payload.status }
}

export async function updateChromeCdpSettings(client: SettingsApiClient, config: Partial<ChromeCdpConfig>): Promise<void> {
  const response = await client.fetch('/api/settings/chrome-cdp', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function testChromeCdpConnection(client: SettingsApiClient): Promise<ChromeCdpStatus> {
  const response = await client.fetch('/api/settings/chrome-cdp/test', { method: 'POST' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as unknown
  if (!isChromeCdpStatus(payload)) throw new Error('Invalid Chrome CDP test response from backend.')
  return payload
}

export async function fetchChromeCdpProfiles(client: SettingsApiClient): Promise<ChromeCdpProfile[]> {
  const response = await client.fetch('/api/settings/chrome-cdp/profiles', { method: 'POST' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as { profiles?: unknown }
  if (!payload || !Array.isArray(payload.profiles)) return []
  return payload.profiles.filter(isChromeCdpProfile)
}

export async function fetchChromeCdpPreview(
  client: SettingsApiClient,
  config: Partial<ChromeCdpConfig>,
  signal?: AbortSignal,
): Promise<{ tabs: ChromeCdpPreviewTab[]; totalFiltered: number; totalUnfiltered: number }> {
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

export async function fetchSettingsExtensions(client: SettingsApiClient): Promise<SettingsExtensionsResponse> {
  const response = await client.fetch('/api/settings/extensions')
  if (!response.ok) throw new Error(await client.readApiError(response))
  const payload = (await response.json()) as SettingsExtensionsResponse
  return payload
}

/* ------------------------------------------------------------------ */
/*  Credential Pool API                                               */
/* ------------------------------------------------------------------ */

export async function fetchCredentialPool(client: SettingsApiClient, provider: string): Promise<CredentialPoolState> {
  const response = await client.fetch(`/api/settings/auth/${encodeURIComponent(provider)}/accounts`)
  if (!response.ok) throw new Error(await client.readApiError(response))
  return ((await response.json()) as { pool: CredentialPoolState }).pool
}

export async function setCredentialPoolStrategy(client: SettingsApiClient, provider: string, strategy: CredentialPoolStrategy): Promise<void> {
  const response = await client.fetch(`/api/settings/auth/${encodeURIComponent(provider)}/strategy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strategy }),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
  dispatchSettingsAuthChanged()
}

export async function renamePooledCredential(client: SettingsApiClient, provider: string, id: string, label: string): Promise<void> {
  const response = await client.fetch(`/api/settings/auth/${encodeURIComponent(provider)}/accounts/${encodeURIComponent(id)}/label`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

export async function setPrimaryPooledCredential(client: SettingsApiClient, provider: string, id: string): Promise<void> {
  const response = await client.fetch(`/api/settings/auth/${encodeURIComponent(provider)}/accounts/${encodeURIComponent(id)}/primary`, { method: 'POST' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  dispatchSettingsAuthChanged()
}

export async function resetPooledCredentialCooldown(client: SettingsApiClient, provider: string, id: string): Promise<void> {
  const response = await client.fetch(`/api/settings/auth/${encodeURIComponent(provider)}/accounts/${encodeURIComponent(id)}/cooldown`, { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  dispatchSettingsAuthChanged()
}

export async function removePooledCredential(client: SettingsApiClient, provider: string, id: string): Promise<void> {
  const response = await client.fetch(`/api/settings/auth/${encodeURIComponent(provider)}/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(await client.readApiError(response))
  dispatchSettingsAuthChanged()
}

/**
 * Start an OAuth SSE stream for adding a new account to the credential pool.
 * POSTs to the pool-specific login endpoint, NOT the legacy per-provider login.
 */
export async function startPoolAddAccountOAuthStream(
  client: SettingsApiClient,
  provider: string,
  handlers: SettingsAuthOAuthStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
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
      dispatchSettingsAuthChanged()
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
export async function submitPoolAddAccountOAuthPrompt(client: SettingsApiClient, provider: string, value: string): Promise<void> {
  const response = await client.fetch(`/api/settings/auth/${encodeURIComponent(provider)}/accounts/login/respond`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) })
  if (!response.ok) throw new Error(await client.readApiError(response))
}

/* ------------------------------------------------------------------ */
/*  Notification Settings                                             */
/* ------------------------------------------------------------------ */

/**
 * Fetch notification settings from the backend.
 */
export async function fetchNotificationSettings(client: SettingsApiClient): Promise<import('@forge/protocol').NotificationSettingsResponse> {
  return client.fetchJson<import('@forge/protocol').NotificationSettingsResponse>('/api/settings/notifications')
}

/**
 * Update notification settings on the backend.
 */
export async function updateNotificationSettings(
  client: SettingsApiClient,
  update: { muteCliOriginatedNotifications?: boolean },
): Promise<import('@forge/protocol').NotificationSettingsMutationResponse> {
  return client.fetchJson<import('@forge/protocol').NotificationSettingsMutationResponse>('/api/settings/notifications', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  })
}
