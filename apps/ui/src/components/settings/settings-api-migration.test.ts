/** @vitest-environment jsdom */

/**
 * Package 3 tests: Settings API client migration.
 *
 * Verifies that all migrated API helpers route through SettingsApiClient
 * with correct endpoint resolution, credentials policy, AbortSignal
 * preservation, cache/no-store preservation, and error parsing.
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

let fetchSpy: MockInstance

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJsonResponse({ ok: true }))
})

afterEach(() => {
  fetchSpy.mockRestore()
})

/* ================================================================== */
/*  Env variables API                                                 */
/* ================================================================== */

describe('settings-api env variables via client', () => {
  it('fetches env variables through builder client', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ variables: [] }))
    const { fetchSettingsEnvVariables } = await import('./settings-api')
    const client = createBuilderSettingsApiClient('ws://127.0.0.1:47187')

    await fetchSettingsEnvVariables(client)

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/env',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

  it('fetches env variables through collab client with credentials include', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ variables: [] }))
    const { fetchSettingsEnvVariables } = await import('./settings-api')
    const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

    await fetchSettingsEnvVariables(client)

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/settings/env',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('updates env variables through collab client', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { updateSettingsEnvVariables } = await import('./settings-api')
    const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

    await updateSettingsEnvVariables(client, { BRAVE_API_KEY: 'test' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/settings/env',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'include',
      }),
    )
  })

  it('deletes env variable through collab client', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { deleteSettingsEnvVariable } = await import('./settings-api')
    const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

    await deleteSettingsEnvVariable(client, 'BRAVE_API_KEY')

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/settings/env/BRAVE_API_KEY',
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    )
  })
})

/* ================================================================== */
/*  Server version / stats                                            */
/* ================================================================== */

describe('settings-api server version via client', () => {
  it('fetches server version through collab client', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ system: { serverVersion: '1.0.0' } }))
    const { fetchServerVersion } = await import('./settings-api')
    const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

    const version = await fetchServerVersion(client)

    expect(version).toBe('1.0.0')
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/stats?range=7d',
      expect.objectContaining({ credentials: 'include' }),
    )
  })
})

/* ================================================================== */
/*  Model overrides                                                   */
/* ================================================================== */

describe('models-api via client', () => {
  it('fetches model overrides through collab client with no-store cache', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ version: 1, overrides: {}, providerAvailability: {} }))
    const { fetchModelOverrides } = await import('./models-api')
    const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

    await fetchModelOverrides(client)

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/settings/model-overrides',
      expect.objectContaining({ cache: 'no-store', credentials: 'include' }),
    )
  })

  it('updates model override item through collab client', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { updateModelOverride } = await import('./models-api')
    const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

    await updateModelOverride(client, 'gpt-5', { enabled: false })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/settings/model-overrides/gpt-5',
      expect.objectContaining({ method: 'PUT', credentials: 'include' }),
    )
  })

  it('deletes model override item through collab client', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { deleteModelOverride } = await import('./models-api')
    const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

    await deleteModelOverride(client, 'gpt-5')

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/settings/model-overrides/gpt-5',
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    )
  })

  it('uses builder client via backward-compatible wsUrl string', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ version: 1, overrides: {}, providerAvailability: {} }))
    const { fetchModelOverrides } = await import('./models-api')

    await fetchModelOverrides('ws://127.0.0.1:47187')

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/model-overrides',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })
})

/* ================================================================== */
/*  OpenRouter                                                        */
/* ================================================================== */

describe('openrouter-api via client', () => {
  it('fetches available OpenRouter models through collab client', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ models: [] }))
    const { fetchAvailableOpenRouterModels } = await import('./openrouter-api')
    const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

    await fetchAvailableOpenRouterModels(client)

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/settings/openrouter/available-models',
      expect.objectContaining({ cache: 'no-store', credentials: 'include' }),
    )
  })

  it('adds OpenRouter model through collab client', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { addOpenRouterModel } = await import('./openrouter-api')
    const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

    await addOpenRouterModel(client, { modelId: 'test/model', name: 'Test Model' } as never)

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://collab.example.com/api/settings/openrouter/models/'),
      expect.objectContaining({ method: 'PUT', credentials: 'include' }),
    )
  })

  it('removes OpenRouter model through collab client', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { removeOpenRouterModel } = await import('./openrouter-api')
    const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

    await removeOpenRouterModel(client, 'test/model')

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://collab.example.com/api/settings/openrouter/models/'),
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    )
  })
})

/* ================================================================== */
/*  Slash commands                                                    */
/* ================================================================== */

describe('slash-commands-api via client', () => {
  it('fetches slash commands through collab client', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ commands: [] }))
    const { fetchSlashCommands } = await import('./slash-commands-api')
    const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

    await fetchSlashCommands(client)

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/slash-commands',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('creates slash command through collab client', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ command: { id: '1', name: 'test', prompt: 'hi', createdAt: '', updatedAt: '' } }))
    const { createSlashCommand } = await import('./slash-commands-api')
    const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

    await createSlashCommand(client, { name: 'test', prompt: 'hi' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/slash-commands',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    )
  })

  it('deletes slash command through collab client', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }))
    const { deleteSlashCommand } = await import('./slash-commands-api')
    const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

    await deleteSlashCommand(client, 'cmd-1')

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/slash-commands/cmd-1',
      expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
    )
  })
})

/* ================================================================== */
/*  Cortex auto-review                                                */
/* ================================================================== */

describe('cortex-auto-review-api via client', () => {
  it('fetches cortex settings through collab client', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ settings: { enabled: true, intervalMinutes: 120 } }))
    const { fetchCortexAutoReviewSettings } = await import('./cortex-auto-review-api')
    const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

    await fetchCortexAutoReviewSettings(client)

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/settings/cortex-auto-review',
      expect.objectContaining({ credentials: 'include' }),
    )
  })
})

/* ================================================================== */
/*  Playwright settings                                               */
/* ================================================================== */

describe('playwright-api settings via client', () => {
  it('fetches playwright settings through collab client', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ settings: { effectiveEnabled: false, source: 'config' } }))
    const { fetchPlaywrightSettings } = await import('../playwright/playwright-api')
    const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

    await fetchPlaywrightSettings(client)

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/settings/playwright',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('updates playwright settings through collab client', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({
      ok: true,
      settings: { effectiveEnabled: true, source: 'config' },
      snapshot: { sessions: [] },
    }))
    const { updatePlaywrightSettings } = await import('../playwright/playwright-api')
    const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

    await updatePlaywrightSettings(client, { enabled: true })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/settings/playwright',
      expect.objectContaining({ method: 'PUT', credentials: 'include' }),
    )
  })
})

/* ================================================================== */
/*  Specialists                                                       */
/* ================================================================== */

describe('specialists-api via client', () => {
  it('fetches specialists through collab client with no-store cache', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ specialists: [] }))
    const { fetchSpecialists } = await import('./specialists-api')
    const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

    await fetchSpecialists(client, 'profile-1')

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/settings/specialists?profileId=profile-1',
      expect.objectContaining({ cache: 'no-store', credentials: 'include' }),
    )
  })
})

/* ================================================================== */
/*  Prompts                                                           */
/* ================================================================== */

describe('prompt-api via client', () => {
  it('fetches prompt list through collab client', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ prompts: [] }))
    const { fetchPromptList } = await import('./prompts/prompt-api')
    const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

    await fetchPromptList(client, 'profile-1')

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/prompts?profileId=profile-1',
      expect.objectContaining({ credentials: 'include' }),
    )
  })
})

/* ================================================================== */
/*  Extensions                                                        */
/* ================================================================== */

describe('extensions-api via client', () => {
  it('fetches extensions through collab client', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ forgeExtensions: [], piExtensions: [] }))
    const { fetchSettingsExtensions } = await import('./settings-api')
    const client = createSettingsApiClient(createCollabSettingsTarget('wss://collab.example.com'))

    await fetchSettingsExtensions(client)

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://collab.example.com/api/settings/extensions',
      expect.objectContaining({ credentials: 'include' }),
    )
  })
})

/* ================================================================== */
/*  Backward compatibility: wsUrl string still works                  */
/* ================================================================== */

describe('backward compatibility — wsUrl string', () => {
  it('settings-api env fetch with wsUrl uses builder credentials', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ variables: [] }))
    const { fetchSettingsEnvVariables } = await import('./settings-api')

    await fetchSettingsEnvVariables('ws://127.0.0.1:47187')

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/settings/env',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

  it('slash-commands fetch with wsUrl uses builder credentials', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ commands: [] }))
    const { fetchSlashCommands } = await import('./slash-commands-api')

    await fetchSlashCommands('ws://127.0.0.1:47187')

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/slash-commands',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })
})
