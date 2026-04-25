/** @vitest-environment jsdom */

/**
 * Package 5 write-isolation tests.
 *
 * Proves that collab writes route through the remote collab API client
 * (credentials: include, collab base URL) and builder writes stay local
 * (credentials: same-origin, local base URL), even when both targets
 * are configured in the same runtime.
 *
 * These complement Package 3's API-level migration tests by testing
 * additional write operations not previously covered.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

vi.mock('@/lib/api-endpoint', () => ({
  resolveApiEndpoint: (wsUrl: string, path: string) => {
    try {
      const parsed = new URL(wsUrl)
      parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
      return new URL(path, parsed.origin).toString()
    } catch {
      return path
    }
  },
}))

vi.mock('@/lib/collaboration-endpoints', () => ({
  resolveCollaborationApiBaseUrl: () => 'https://collab.example.com/',
}))

const {
  createSettingsApiClient,
  createBuilderSettingsApiClient,
} = await import('./settings-api-client')
const {
  createCollabSettingsTarget,
} = await import('./settings-target')

/* ------------------------------------------------------------------ */
/*  Setup                                                             */
/* ------------------------------------------------------------------ */

const BUILDER_WS = 'ws://127.0.0.1:47187'
const COLLAB_WS = 'wss://collab.example.com'

let fetchSpy: MockInstance

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function builderClient() {
  return createBuilderSettingsApiClient(BUILDER_WS)
}

function collabClient() {
  return createSettingsApiClient(createCollabSettingsTarget(COLLAB_WS))
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJsonResponse({ ok: true }))
})

afterEach(() => {
  fetchSpy.mockRestore()
})

/* ================================================================== */
/*  Model override writes                                             */
/* ================================================================== */

describe('model override write isolation', () => {
  it('resetAllModelOverrides routes through collab', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { resetAllModelOverrides } = await import('./models-api')

    await resetAllModelOverrides(collabClient())

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/settings/model-overrides',
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    )
  })

  it('resetAllModelOverrides routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { resetAllModelOverrides } = await import('./models-api')

    await resetAllModelOverrides(builderClient())

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/model-overrides',
      expect.objectContaining({ method: 'DELETE', credentials: 'same-origin' }),
    )
  })

  it('updateModelOverride routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { updateModelOverride } = await import('./models-api')

    await updateModelOverride(builderClient(), 'gpt-5', { enabled: true })

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/model-overrides/gpt-5',
      expect.objectContaining({ method: 'PUT', credentials: 'same-origin' }),
    )
  })
})

/* ================================================================== */
/*  Slash command writes                                              */
/* ================================================================== */

describe('slash command write isolation', () => {
  it('updateSlashCommand routes through collab', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({
      command: { id: '1', name: 'test', prompt: 'updated', createdAt: '', updatedAt: '' },
    }))
    const { updateSlashCommand } = await import('./slash-commands-api')

    await updateSlashCommand(collabClient(), '1', { prompt: 'updated' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/slash-commands/1',
      expect.objectContaining({ method: 'PUT', credentials: 'include' }),
    )
  })

  it('updateSlashCommand routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({
      command: { id: '1', name: 'test', prompt: 'updated', createdAt: '', updatedAt: '' },
    }))
    const { updateSlashCommand } = await import('./slash-commands-api')

    await updateSlashCommand(builderClient(), '1', { prompt: 'updated' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/slash-commands/1',
      expect.objectContaining({ method: 'PUT', credentials: 'same-origin' }),
    )
  })

  it('createSlashCommand routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({
      command: { id: '2', name: 'new', prompt: 'hi', createdAt: '', updatedAt: '' },
    }))
    const { createSlashCommand } = await import('./slash-commands-api')

    await createSlashCommand(builderClient(), { name: 'new', prompt: 'hi' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/slash-commands',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    )
  })
})

/* ================================================================== */
/*  Env variable writes                                               */
/* ================================================================== */

describe('env variable write isolation', () => {
  it('updateSettingsEnvVariables routes through collab', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { updateSettingsEnvVariables } = await import('./settings-api')

    await updateSettingsEnvVariables(collabClient(), { MY_KEY: 'secret' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/settings/env',
      expect.objectContaining({ method: 'PUT', credentials: 'include' }),
    )
  })

  it('updateSettingsEnvVariables routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { updateSettingsEnvVariables } = await import('./settings-api')

    await updateSettingsEnvVariables(builderClient(), { MY_KEY: 'secret' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/env',
      expect.objectContaining({ method: 'PUT', credentials: 'same-origin' }),
    )
  })

  it('deleteSettingsEnvVariable routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { deleteSettingsEnvVariable } = await import('./settings-api')

    await deleteSettingsEnvVariable(builderClient(), 'MY_KEY')

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/env/MY_KEY',
      expect.objectContaining({ method: 'DELETE', credentials: 'same-origin' }),
    )
  })
})

/* ================================================================== */
/*  Specialist writes                                                 */
/* ================================================================== */

describe('specialist write isolation', () => {
  it('saveSpecialist routes through collab', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { saveSpecialist } = await import('./specialists-api')

    await saveSpecialist(collabClient(), 'profile-1', 'backend', {
      displayName: 'Backend',
      color: '#2563eb',
      enabled: true,
      whenToUse: 'Backend work',
      modelId: 'gpt-5',
      provider: 'openai-codex',
      reasoningLevel: 'high',
      promptBody: 'You are a backend specialist.',
    })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/settings/specialists/backend?profileId=profile-1',
      expect.objectContaining({ method: 'PUT', credentials: 'include' }),
    )
  })

  it('saveSpecialist routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { saveSpecialist } = await import('./specialists-api')

    await saveSpecialist(builderClient(), 'profile-1', 'backend', {
      displayName: 'Backend',
      color: '#2563eb',
      enabled: true,
      whenToUse: 'Backend work',
      modelId: 'gpt-5',
      provider: 'openai-codex',
      reasoningLevel: 'high',
      promptBody: 'You are a backend specialist.',
    })

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/specialists/backend?profileId=profile-1',
      expect.objectContaining({ method: 'PUT', credentials: 'same-origin' }),
    )
  })

  it('deleteSpecialist routes through collab', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { deleteSpecialist } = await import('./specialists-api')

    await deleteSpecialist(collabClient(), 'profile-1', 'backend')

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/settings/specialists/backend?profileId=profile-1',
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    )
  })

  it('deleteSharedSpecialist routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { deleteSharedSpecialist } = await import('./specialists-api')

    await deleteSharedSpecialist(builderClient(), 'backend')

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/specialists/backend',
      expect.objectContaining({ method: 'DELETE', credentials: 'same-origin' }),
    )
  })

  it('setSpecialistsEnabledApi routes through collab', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { setSpecialistsEnabledApi } = await import('./specialists-api')

    await setSpecialistsEnabledApi(collabClient(), false)

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/settings/specialists/enabled',
      expect.objectContaining({ method: 'PUT', credentials: 'include' }),
    )
  })
})

/* ================================================================== */
/*  Prompt writes                                                     */
/* ================================================================== */

describe('prompt write isolation', () => {
  it('savePromptOverride routes through collab', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { savePromptOverride } = await import('./prompts/prompt-api')

    await savePromptOverride(collabClient(), 'archetype', 'default', 'new content', 'profile-1')

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://collab.example.com/api/prompts/archetype/default'),
      expect.objectContaining({ method: 'PUT', credentials: 'include' }),
    )
  })

  it('savePromptOverride routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { savePromptOverride } = await import('./prompts/prompt-api')

    await savePromptOverride(builderClient(), 'archetype', 'default', 'new content', 'profile-1')

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('http://127.0.0.1:47187/api/prompts/archetype/default'),
      expect.objectContaining({ method: 'PUT', credentials: 'same-origin' }),
    )
  })

  it('deletePromptOverride routes through collab', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { deletePromptOverride } = await import('./prompts/prompt-api')

    await deletePromptOverride(collabClient(), 'archetype', 'default', 'profile-1')

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://collab.example.com/api/prompts/archetype/default'),
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    )
  })
})

/* ================================================================== */
/*  Telegram / integrations writes                                    */
/* ================================================================== */

describe('telegram write isolation', () => {
  /** Minimal config shape that passes `isTelegramSettingsConfig` validation */
  const validTelegramConfig = {
    profileId: 'profile-1',
    enabled: true,
    mode: 'polling' as const,
    hasBotToken: true,
    polling: { intervalMs: 1000 },
    delivery: { chatId: '' },
    attachments: { enabled: false },
  }

  it('updateTelegramSettings routes through collab', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({
      config: validTelegramConfig,
      status: null,
    }))
    const { updateTelegramSettings } = await import('./settings-api')

    await updateTelegramSettings(collabClient(), 'manager-1', { botToken: 'tok' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/managers/manager-1/integrations/telegram',
      expect.objectContaining({ method: 'PUT', credentials: 'include' }),
    )
  })

  it('updateTelegramSettings routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({
      config: validTelegramConfig,
      status: null,
    }))
    const { updateTelegramSettings } = await import('./settings-api')

    await updateTelegramSettings(builderClient(), 'manager-1', { botToken: 'tok' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/managers/manager-1/integrations/telegram',
      expect.objectContaining({ method: 'PUT', credentials: 'same-origin' }),
    )
  })

  it('fetchTelegramSettings routes through collab', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({
      config: { ...validTelegramConfig, enabled: false },
      status: null,
    }))
    const { fetchTelegramSettings } = await import('./settings-api')

    await fetchTelegramSettings(collabClient(), 'manager-1')

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/managers/manager-1/integrations/telegram',
      expect.objectContaining({ credentials: 'include' }),
    )
  })
})

/* ================================================================== */
/*  Extensions fetch isolation                                        */
/* ================================================================== */

describe('extensions fetch isolation', () => {
  it('fetchSettingsExtensions routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ forgeExtensions: [], piExtensions: [] }))
    const { fetchSettingsExtensions } = await import('./settings-api')

    await fetchSettingsExtensions(builderClient())

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/extensions',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })
})

/* ================================================================== */
/*  Server version (About panel) fetch isolation                      */
/* ================================================================== */

describe('server version fetch isolation', () => {
  it('fetchServerVersion routes through builder', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ system: { serverVersion: '2.0.0' } }))
    const { fetchServerVersion } = await import('./settings-api')

    const version = await fetchServerVersion(builderClient())

    expect(version).toBe('2.0.0')
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/stats?range=7d',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

  it('fetchServerVersion routes through collab with credentials: include', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ system: { serverVersion: '3.0.0' } }))
    const { fetchServerVersion } = await import('./settings-api')

    const version = await fetchServerVersion(collabClient())

    expect(version).toBe('3.0.0')
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/stats?range=7d',
      expect.objectContaining({ credentials: 'include' }),
    )
  })
})

/* ================================================================== */
/*  Chrome CDP fetch/write isolation                                   */
/* ================================================================== */

describe('chrome cdp target isolation', () => {
  it('fetchChromeCdpSettings routes through collab with credentials: include', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({
      config: { contextId: null, urlAllow: [], urlBlock: [] },
      status: { connected: false },
    }))
    const { fetchChromeCdpSettings } = await import('./settings-api')

    await fetchChromeCdpSettings(collabClient())

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/settings/chrome-cdp',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('updateChromeCdpSettings routes through collab with credentials: include', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { updateChromeCdpSettings } = await import('./settings-api')

    await updateChromeCdpSettings(collabClient(), { contextId: null, urlAllow: [], urlBlock: [] })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/settings/chrome-cdp',
      expect.objectContaining({ method: 'PUT', credentials: 'include' }),
    )
  })

  it('testChromeCdpConnection routes through builder with same-origin', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ connected: true, port: 9222 }))
    const { testChromeCdpConnection } = await import('./settings-api')

    await testChromeCdpConnection(builderClient())

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/chrome-cdp/test',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    )
  })
})

/* ================================================================== */
/*  Model preset fetch isolation (Specialists)                        */
/* ================================================================== */

describe('model preset fetch isolation', () => {
  it('fetchModelPresets routes through collab with credentials: include', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ models: [] }))
    const { fetchModelPresets } = await import('../../lib/model-preset')

    await fetchModelPresets(collabClient())

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/settings/models',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('fetchModelPresets routes through builder with same-origin', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ models: [] }))
    const { fetchModelPresets } = await import('../../lib/model-preset')

    await fetchModelPresets(builderClient())

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/models',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

  it('fetchModelPresets with raw wsUrl string uses bare fetch (backward compatible)', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ models: [] }))
    const { fetchModelPresets } = await import('../../lib/model-preset')

    await fetchModelPresets('ws://127.0.0.1:47187')

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/models',
      expect.objectContaining({ cache: 'no-store' }),
    )
  })
})

/* ================================================================== */
/*  Negative assertion: collab writes never hit builder URL            */
/* ================================================================== */

describe('negative assertion: collab never hits builder', () => {
  it('collab model override update does NOT call builder URL', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { updateModelOverride } = await import('./models-api')

    await updateModelOverride(collabClient(), 'gpt-5', { enabled: false })

    for (const call of fetchSpy.mock.calls) {
      expect(call[0]).not.toContain('127.0.0.1')
    }
  })

  it('collab slash command create does NOT call builder URL', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({
      command: { id: '1', name: 'x', prompt: 'y', createdAt: '', updatedAt: '' },
    }))
    const { createSlashCommand } = await import('./slash-commands-api')

    await createSlashCommand(collabClient(), { name: 'x', prompt: 'y' })

    for (const call of fetchSpy.mock.calls) {
      expect(call[0]).not.toContain('127.0.0.1')
    }
  })

  it('collab specialist save does NOT call builder URL', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { saveSharedSpecialist } = await import('./specialists-api')

    await saveSharedSpecialist(collabClient(), 'test', {
      displayName: 'Test',
      color: '#000',
      enabled: true,
      whenToUse: 'test',
      modelId: 'gpt-5',
      provider: 'openai-codex',
      reasoningLevel: 'high',
      promptBody: 'prompt',
    })

    for (const call of fetchSpy.mock.calls) {
      expect(call[0]).not.toContain('127.0.0.1')
    }
  })
})
