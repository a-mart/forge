/** @vitest-environment jsdom */

import { fireEvent } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAICredentialPool } from './OpenAICredentialPool'
import type { CredentialPoolState, OpenAIBrokerSettingsState, PooledCredentialInfo } from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'
import type { SettingsBackendTarget } from './settings-target'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

const settingsApiMock = vi.hoisted(() => ({
  fetchCredentialPool: vi.fn(),
  fetchOpenAIBrokerSettings: vi.fn(),
  updateOpenAIBrokerSettings: vi.fn(),
  redeemOpenAIBrokerInvite: vi.fn(),
  testOpenAIBrokerSettings: vi.fn(),
  disableOpenAIBrokerSettings: vi.fn(),
  clearOpenAIBrokerSettings: vi.fn(),
  setCredentialPoolStrategy: vi.fn(),
  renamePooledCredential: vi.fn(),
  setPrimaryPooledCredential: vi.fn(),
  resetPooledCredentialCooldown: vi.fn(),
  removePooledCredential: vi.fn(),
  toErrorMessage: vi.fn((err: unknown) => (err instanceof Error ? err.message : String(err))),
  SETTINGS_AUTH_PROVIDER_META: {
    'openai-codex': {
      label: 'OpenAI Codex',
      description: 'OpenAI Codex API access',
      authMode: 'oauth' as const,
    },
  },
  startPoolAddAccountOAuthStream: vi.fn(),
  submitPoolAddAccountOAuthPrompt: vi.fn(),
  createIdleSettingsAuthOAuthFlowState: vi.fn().mockReturnValue({
    status: 'idle',
    authUrl: undefined,
    instructions: undefined,
    promptMessage: undefined,
    promptPlaceholder: undefined,
    progressMessage: undefined,
    errorMessage: undefined,
    isSubmittingCode: false,
    codeValue: '',
  }),
}))

vi.mock('./settings-api', () => ({
  fetchCredentialPool: (...a: unknown[]) => settingsApiMock.fetchCredentialPool(a[0], a[1]),
  fetchOpenAIBrokerSettings: (...a: unknown[]) => settingsApiMock.fetchOpenAIBrokerSettings(a[0]),
  updateOpenAIBrokerSettings: (...a: unknown[]) => settingsApiMock.updateOpenAIBrokerSettings(a[0], a[1]),
  redeemOpenAIBrokerInvite: (...a: unknown[]) => settingsApiMock.redeemOpenAIBrokerInvite(a[0], a[1]),
  testOpenAIBrokerSettings: (...a: unknown[]) => settingsApiMock.testOpenAIBrokerSettings(a[0], a[1]),
  disableOpenAIBrokerSettings: (...a: unknown[]) => settingsApiMock.disableOpenAIBrokerSettings(a[0]),
  clearOpenAIBrokerSettings: (...a: unknown[]) => settingsApiMock.clearOpenAIBrokerSettings(a[0]),
  setCredentialPoolStrategy: (...a: unknown[]) => settingsApiMock.setCredentialPoolStrategy(a[0], a[1], a[2]),
  renamePooledCredential: (...a: unknown[]) => settingsApiMock.renamePooledCredential(a[0], a[1], a[2], a[3]),
  setPrimaryPooledCredential: (...a: unknown[]) => settingsApiMock.setPrimaryPooledCredential(a[0], a[1], a[2]),
  resetPooledCredentialCooldown: (...a: unknown[]) => settingsApiMock.resetPooledCredentialCooldown(a[0], a[1], a[2]),
  removePooledCredential: (...a: unknown[]) => settingsApiMock.removePooledCredential(a[0], a[1], a[2]),
  toErrorMessage: (err: unknown) => settingsApiMock.toErrorMessage(err),
  SETTINGS_AUTH_PROVIDER_META: settingsApiMock.SETTINGS_AUTH_PROVIDER_META,
  startPoolAddAccountOAuthStream: (...a: unknown[]) => settingsApiMock.startPoolAddAccountOAuthStream(a[0], a[1], a[2], a[3]),
  submitPoolAddAccountOAuthPrompt: (...a: unknown[]) => settingsApiMock.submitPoolAddAccountOAuthPrompt(a[0], a[1], a[2]),
  createIdleSettingsAuthOAuthFlowState: () => settingsApiMock.createIdleSettingsAuthOAuthFlowState(),
}))

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function makeCredential(
  overrides: Partial<PooledCredentialInfo> = {},
): PooledCredentialInfo {
  return {
    id: 'cred-1',
    label: 'Primary Account',
    autoLabel: 'user@example.com',
    isPrimary: true,
    health: 'healthy',
    cooldownUntil: null,
    requestCount: 42,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makePool(
  overrides: Partial<CredentialPoolState> = {},
): CredentialPoolState {
  return {
    strategy: 'fill_first',
    credentials: [makeCredential()],
    ...overrides,
  }
}

function makeBrokerSettings(
  overrides: Partial<OpenAIBrokerSettingsState> = {},
): OpenAIBrokerSettingsState {
  return {
    mode: 'local',
    effectiveMode: 'local',
    source: 'default',
    envOverride: false,
    broker: { configured: false, hasToken: false, clientId: 'forge', timeoutMs: 10000 },
    ...overrides,
  }
}

const mockTarget: SettingsBackendTarget = {
  kind: 'builder',
  label: 'Builder',
  description: 'Local builder backend',
  wsUrl: 'ws://127.0.0.1:47187',
  apiBaseUrl: 'http://127.0.0.1:47187/',
  fetchCredentials: 'same-origin',
  requiresAdmin: false,
  availableTabs: ['general', 'auth'],
}

const mockApiClient: SettingsApiClient = {
  target: mockTarget,
  endpoint: (path: string) => `http://127.0.0.1:47187${path}`,
  fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  fetchJson: vi.fn(),
  readApiError: vi.fn(),
}

let container: HTMLDivElement
let root: Root | null = null

const onError = vi.fn()
const onSuccess = vi.fn()
const onAuthReload = vi.fn()

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)

  settingsApiMock.fetchOpenAIBrokerSettings.mockResolvedValue(makeBrokerSettings())
  settingsApiMock.updateOpenAIBrokerSettings.mockResolvedValue(makeBrokerSettings())
  settingsApiMock.redeemOpenAIBrokerInvite.mockResolvedValue(makeBrokerSettings())
  settingsApiMock.testOpenAIBrokerSettings.mockResolvedValue({ ok: true })
  settingsApiMock.disableOpenAIBrokerSettings.mockResolvedValue(makeBrokerSettings())
  settingsApiMock.clearOpenAIBrokerSettings.mockResolvedValue(makeBrokerSettings())
  settingsApiMock.setCredentialPoolStrategy.mockResolvedValue(undefined)
  settingsApiMock.renamePooledCredential.mockResolvedValue(undefined)
  settingsApiMock.setPrimaryPooledCredential.mockResolvedValue(undefined)
  settingsApiMock.resetPooledCredentialCooldown.mockResolvedValue(undefined)
  settingsApiMock.removePooledCredential.mockResolvedValue(undefined)
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
  vi.clearAllMocks()
})

async function flush(): Promise<void> {
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  await Promise.resolve()
  flushSync(() => {})
}

function renderPool(pool?: CredentialPoolState): void {
  settingsApiMock.fetchCredentialPool.mockResolvedValue(pool ?? makePool())

  root = createRoot(container)
  flushSync(() => {
    root?.render(
      createElement(OpenAICredentialPool, {
        apiClient: mockApiClient,
        target: mockTarget,
        onError,
        onSuccess,
        onAuthReload,
      }),
    )
  })
}

/* ================================================================== */
/*  Tests                                                             */
/* ================================================================== */

describe('OpenAICredentialPool', () => {
  /* ---- Loading ---- */

  describe('loading', () => {
    it('shows loading spinner initially', () => {
      renderPool()
      expect(container.querySelector('.animate-spin')).toBeTruthy()
    })

    it('renders pool after load', async () => {
      renderPool()
      await flush()
      await flush()

      expect(container.textContent).toContain('OpenAI auth source')
      expect(container.textContent).toContain('OpenAI local credentials')
      expect(container.textContent).toContain('Primary Account')
    })

    it('passes the active settings API client to broker and local credential requests', async () => {
      renderPool()
      await flush()
      await flush()

      expect(settingsApiMock.fetchOpenAIBrokerSettings).toHaveBeenCalledWith(mockApiClient)
      expect(settingsApiMock.fetchCredentialPool).toHaveBeenCalledWith(mockApiClient, 'openai-codex')
    })

    it('shows not configured badge when no credentials', async () => {
      renderPool(makePool({ credentials: [] }))
      await flush()
      await flush()

      expect(container.textContent).toContain('Not configured')
    })

    it('keeps local OpenAI credentials visible but read-only when broker mode is active', async () => {
      settingsApiMock.fetchOpenAIBrokerSettings.mockResolvedValue(makeBrokerSettings({
        mode: 'central_broker',
        effectiveMode: 'central_broker',
        source: 'settings',
        broker: {
          configured: true,
          url: 'https://broker.example.test/',
          hasToken: true,
          tokenMasked: '********oken',
          clientId: 'forge',
          timeoutMs: 10000,
          status: { ok: true, checkedAt: '2026-01-01T00:00:00.000Z' },
        },
      }))
      renderPool()
      await flush()
      await flush()

      expect(container.textContent).toContain('Forge Auth broker active')
      expect(container.textContent).toContain('Local OpenAI credentials below are visible for reference')
      expect(container.textContent).toContain('Primary Account')
      expect(container.textContent).toContain('Read-only while Forge Auth broker mode is active.')
      expect(container.textContent).not.toContain('Add Account')
    })

    it('removes stored broker settings after confirmation and returns to local credentials', async () => {
      settingsApiMock.fetchOpenAIBrokerSettings.mockResolvedValue(makeBrokerSettings({
        mode: 'central_broker',
        effectiveMode: 'central_broker',
        source: 'settings',
        broker: {
          configured: true,
          url: 'https://broker.example.test/',
          hasToken: true,
          tokenMasked: '********oken',
          clientId: 'forge',
          timeoutMs: 10000,
          status: { ok: true, checkedAt: '2026-01-01T00:00:00.000Z' },
        },
      }))
      settingsApiMock.clearOpenAIBrokerSettings.mockResolvedValue(makeBrokerSettings())
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

      renderPool()
      await flush()
      await flush()

      const removeButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Remove Forge Auth broker settings'))
      expect(removeButton).toBeTruthy()
      fireEvent.click(removeButton!)
      await flush()
      await flush()

      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Remove the saved Forge Auth broker URL and token'))
      expect(settingsApiMock.clearOpenAIBrokerSettings).toHaveBeenCalledWith(mockApiClient)
      expect(onAuthReload).toHaveBeenCalledTimes(1)
      expect(onSuccess).toHaveBeenCalledWith('Removed stored Forge Auth broker settings. Local credentials are active.')
      confirmSpy.mockRestore()
    })

    it('documents strict env broker override semantics in the locked settings copy', async () => {
      settingsApiMock.fetchOpenAIBrokerSettings.mockResolvedValue(makeBrokerSettings({
        effectiveMode: 'central_broker',
        source: 'env',
        envOverride: true,
        broker: {
          configured: false,
          hasToken: false,
          clientId: 'forge',
          timeoutMs: 10000,
        },
      }))

      renderPool()
      await flush()
      await flush()

      expect(container.textContent).toContain('Forge uses only `FORGE_OPENAI_AUTH_BROKER_URL` and `FORGE_OPENAI_AUTH_BROKER_TOKEN` from the environment')
      expect(container.textContent).toContain('saved Forge Auth broker URL/token values are ignored')
    })

    it('redeems pasted Forge Auth broker invites, clears the paste box, and reloads auth summaries', async () => {
      const enabled = makeBrokerSettings({
        mode: 'central_broker',
        effectiveMode: 'central_broker',
        source: 'settings',
        broker: {
          configured: true,
          url: 'https://broker.example.test/',
          hasToken: true,
          tokenMasked: '********oken',
          clientId: 'forge',
          timeoutMs: 10000,
          status: { ok: true, checkedAt: '2026-01-01T00:00:00.000Z' },
        },
      })
      settingsApiMock.redeemOpenAIBrokerInvite.mockResolvedValue(enabled)
      renderPool()
      await flush()
      await flush()

      const remoteButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Forge Auth broker'))
      expect(remoteButton).toBeTruthy()
      fireEvent.click(remoteButton!)
      await flush()

      const textarea = container.querySelector('#openai-broker-invite') as HTMLTextAreaElement | null
      expect(textarea).toBeTruthy()
      fireEvent.input(textarea!, { target: { value: 'https://broker.example.test/-/forge-auth/invite#forge_auth_broker=secret-fragment' } })
      const redeemButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Redeem invite'))
      expect(redeemButton).toBeTruthy()
      fireEvent.click(redeemButton!)
      await flush()
      await flush()

      expect(settingsApiMock.redeemOpenAIBrokerInvite).toHaveBeenCalledWith(mockApiClient, {
        invite: 'https://broker.example.test/-/forge-auth/invite#forge_auth_broker=secret-fragment',
      })
      expect(onAuthReload).toHaveBeenCalledTimes(1)
      expect(onSuccess).toHaveBeenCalledWith('Forge Auth broker invite redeemed. Broker mode is active.')
      expect((container.querySelector('#openai-broker-invite') as HTMLTextAreaElement | null)?.value ?? '').toBe('')
    })

    it('surfaces invite redeem failures without switching auth source', async () => {
      settingsApiMock.redeemOpenAIBrokerInvite.mockRejectedValue(new Error('Invite could not be redeemed.'))
      renderPool()
      await flush()
      await flush()

      const remoteButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Forge Auth broker'))
      fireEvent.click(remoteButton!)
      await flush()
      fireEvent.input(container.querySelector('#openai-broker-invite')!, { target: { value: 'https://broker.example.test/-/forge-auth/invite#forge_auth_broker=bad' } })
      const redeemButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Redeem invite'))
      fireEvent.click(redeemButton!)
      await flush()
      await flush()

      expect(onError).toHaveBeenCalledWith('Invite could not be redeemed.')
      expect(onAuthReload).not.toHaveBeenCalled()
    })

    it('keeps invite paste disabled under environment broker overrides', async () => {
      settingsApiMock.fetchOpenAIBrokerSettings.mockResolvedValue(makeBrokerSettings({
        effectiveMode: 'central_broker',
        source: 'env',
        envOverride: true,
        broker: {
          configured: false,
          hasToken: false,
          clientId: 'forge',
          timeoutMs: 10000,
        },
      }))
      renderPool()
      await flush()
      await flush()

      expect(container.textContent).toContain('controlled by environment variables')
      expect(container.querySelector('#openai-broker-invite')).toBeNull()
      const brokerButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Forge Auth broker'))
      expect(brokerButton?.disabled).toBe(true)
    })

    it('disables active broker mode from the top local credentials source control', async () => {
      settingsApiMock.fetchOpenAIBrokerSettings.mockResolvedValue(makeBrokerSettings({
        mode: 'central_broker',
        effectiveMode: 'central_broker',
        source: 'settings',
        broker: {
          configured: true,
          url: 'https://broker.example.test/',
          hasToken: true,
          tokenMasked: '********oken',
          clientId: 'forge',
          timeoutMs: 10000,
          status: { ok: true, checkedAt: '2026-01-01T00:00:00.000Z' },
        },
      }))
      settingsApiMock.disableOpenAIBrokerSettings.mockResolvedValue(makeBrokerSettings({
        mode: 'local',
        effectiveMode: 'local',
        source: 'settings',
        broker: {
          configured: true,
          url: 'https://broker.example.test/',
          hasToken: true,
          tokenMasked: '********oken',
          clientId: 'forge',
          timeoutMs: 10000,
          status: { ok: true, checkedAt: '2026-01-01T00:00:00.000Z' },
        },
      }))

      renderPool()
      await flush()
      await flush()

      expect(container.textContent).toContain('Forge Auth broker active')
      expect(container.textContent).toContain('Read-only while Forge Auth broker mode is active.')
      const localButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Local credentials')
      expect(localButton).toBeTruthy()
      fireEvent.click(localButton!)
      await flush()
      await flush()

      expect(settingsApiMock.disableOpenAIBrokerSettings).toHaveBeenCalledWith(mockApiClient)
      expect(onAuthReload).toHaveBeenCalledTimes(1)
      expect(onSuccess).toHaveBeenCalledWith('Switched OpenAI auth back to local credentials.')
      expect(container.textContent).toContain('Forge Auth broker configured')
      expect(container.textContent).toContain('Add Account')
      expect(container.textContent).not.toContain('Read-only while Forge Auth broker mode is active.')
    })

    it('enables an already configured Forge Auth broker from the top auth source control', async () => {
      const configuredLocal = makeBrokerSettings({
        mode: 'local',
        effectiveMode: 'local',
        source: 'settings',
        broker: {
          configured: true,
          url: 'https://broker.example.test/',
          hasToken: true,
          tokenMasked: '********oken',
          clientId: 'forge',
          timeoutMs: 10000,
          status: { ok: true, checkedAt: '2026-01-01T00:00:00.000Z' },
        },
      })
      const enabled = makeBrokerSettings({
        mode: 'central_broker',
        effectiveMode: 'central_broker',
        source: 'settings',
        broker: configuredLocal.broker,
      })
      settingsApiMock.fetchOpenAIBrokerSettings.mockResolvedValue(configuredLocal)
      settingsApiMock.updateOpenAIBrokerSettings.mockResolvedValue(enabled)

      renderPool()
      await flush()
      await flush()

      expect(container.textContent).toContain('Forge Auth broker configured')
      const brokerButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Forge Auth broker')
      expect(brokerButton).toBeTruthy()
      fireEvent.click(brokerButton!)
      await flush()
      await flush()

      expect(settingsApiMock.updateOpenAIBrokerSettings).toHaveBeenCalledWith(mockApiClient, expect.objectContaining({
        mode: 'central_broker',
        testBeforeEnable: true,
        broker: expect.not.objectContaining({ token: expect.any(String) }),
      }))
      expect(onAuthReload).toHaveBeenCalledTimes(1)
      expect(onSuccess).toHaveBeenCalledWith('Forge Auth broker enabled.')
      expect(container.textContent).toContain('Forge Auth broker active')
    })

    it('refetches enabled broker mode after settings is reopened', async () => {
      const enabled = makeBrokerSettings({
        mode: 'central_broker',
        effectiveMode: 'central_broker',
        source: 'settings',
        broker: {
          configured: true,
          url: 'https://broker.example.test/',
          hasToken: true,
          tokenMasked: '********oken',
          clientId: 'forge',
          timeoutMs: 10000,
          status: { ok: true, checkedAt: '2026-01-01T00:00:00.000Z' },
        },
      })
      settingsApiMock.fetchOpenAIBrokerSettings.mockResolvedValue(enabled)

      renderPool()
      await flush()
      await flush()

      expect(settingsApiMock.fetchOpenAIBrokerSettings).toHaveBeenCalledWith(mockApiClient)
      expect(container.textContent).toContain('Forge Auth broker active')
      expect(container.textContent).toContain('Local OpenAI credentials below are visible for reference')
    })

    it('keeps enable and edit controls disabled under environment broker overrides', async () => {
      settingsApiMock.fetchOpenAIBrokerSettings.mockResolvedValue(makeBrokerSettings({
        mode: 'central_broker',
        effectiveMode: 'central_broker',
        source: 'env',
        envOverride: true,
        broker: {
          configured: true,
          url: 'https://broker.example.test/',
          hasToken: true,
          tokenMasked: '********oken',
          clientId: 'forge',
          timeoutMs: 10000,
        },
      }))
      renderPool()
      await flush()
      await flush()

      const sourceButtons = Array.from(container.querySelectorAll('button')).filter((button) => (
        button.textContent?.includes('Local credentials') || button.textContent?.includes('Forge Auth broker')
      ))
      expect(sourceButtons.length).toBeGreaterThanOrEqual(2)
      expect(sourceButtons.every((button) => button.disabled)).toBe(true)
      expect(container.querySelector('#openai-broker-url')).toBeNull()
      expect(container.querySelector('#openai-broker-token')).toBeNull()
      expect(settingsApiMock.updateOpenAIBrokerSettings).not.toHaveBeenCalled()
    })

    it('reloads parent auth summaries after broker settings are saved', async () => {
      const enabled = makeBrokerSettings({
        mode: 'central_broker',
        effectiveMode: 'central_broker',
        source: 'settings',
        broker: {
          configured: true,
          url: 'https://broker.example.test/',
          hasToken: true,
          tokenMasked: '********oken',
          clientId: 'forge',
          timeoutMs: 10000,
          status: { ok: true, checkedAt: '2026-01-01T00:00:00.000Z' },
        },
      })
      settingsApiMock.updateOpenAIBrokerSettings.mockResolvedValue(enabled)
      renderPool()
      await flush()
      await flush()

      const remoteButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Forge Auth broker'))
      expect(remoteButton).toBeTruthy()
      fireEvent.click(remoteButton!)
      await flush()

      const advancedButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Advanced manual setup'))
      expect(advancedButton).toBeTruthy()
      fireEvent.click(advancedButton!)
      await flush()

      fireEvent.input(container.querySelector('#openai-broker-url')!, { target: { value: 'https://broker.example.test' } })
      fireEvent.input(container.querySelector('#openai-broker-token')!, { target: { value: 'broker-token' } })
      const enableButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Enable Forge Auth broker'))
      expect(enableButton).toBeTruthy()
      fireEvent.click(enableButton!)
      await flush()
      await flush()

      expect(settingsApiMock.updateOpenAIBrokerSettings).toHaveBeenCalledWith(mockApiClient, expect.objectContaining({
        mode: 'central_broker',
      }))
      expect(onAuthReload).toHaveBeenCalledTimes(1)
    })
  })

  /* ---- Credential display ---- */

  describe('credential display', () => {
    it('shows credential label and auto-label', async () => {
      renderPool()
      await flush()
      await flush()

      expect(container.textContent).toContain('Primary Account')
      expect(container.textContent).toContain('user@example.com')
    })

    it('shows healthy badge for healthy credentials', async () => {
      renderPool()
      await flush()
      await flush()

      expect(container.textContent).toContain('Healthy')
    })

    it('shows cooldown badge for credentials in cooldown', async () => {
      const pool = makePool({
        credentials: [
          makeCredential({
            health: 'cooldown',
            cooldownUntil: Date.now() + 300_000,
          }),
        ],
      })
      renderPool(pool)
      await flush()
      await flush()

      expect(container.textContent).toContain('Cooldown')
    })

    it('shows auth error badge', async () => {
      const pool = makePool({
        credentials: [makeCredential({ health: 'auth_error' })],
      })
      renderPool(pool)
      await flush()
      await flush()

      expect(container.textContent).toContain('Auth Error')
    })

    it('shows request count', async () => {
      renderPool()
      await flush()
      await flush()

      expect(container.textContent).toContain('42')
    })

    it('shows Primary badge for primary credential', async () => {
      renderPool()
      await flush()
      await flush()

      expect(container.textContent).toContain('Primary')
    })

    it('shows account count badge', async () => {
      renderPool()
      await flush()
      await flush()

      expect(container.textContent).toContain('1 account')
    })
  })

  /* ---- Remove credential ---- */

  describe('remove credential', () => {
    it('renders remove button for credentials', async () => {
      renderPool()
      await flush()
      await flush()

      // Remove button contains the Trash2 icon (rendered as an SVG inside a ghost button)
      const removeButtons = Array.from(container.querySelectorAll('button')).filter(
        (btn) => btn.classList.contains('size-7') && btn.querySelector('svg'),
      )
      expect(removeButtons.length).toBeGreaterThan(0)
    })
  })

  /* ---- Strategy selector ---- */

  describe('strategy selector', () => {
    it('shows strategy selector when multiple credentials exist', async () => {
      const pool = makePool({
        credentials: [
          makeCredential({ id: 'cred-1', isPrimary: true }),
          makeCredential({ id: 'cred-2', label: 'Second Account', isPrimary: false }),
        ],
      })
      renderPool(pool)
      await flush()
      await flush()

      expect(container.textContent).toContain('Strategy')
    })

    it('does not show strategy selector for single credential', async () => {
      renderPool()
      await flush()
      await flush()

      expect(container.textContent).not.toContain('Strategy')
    })
  })

  /* ---- Add account ---- */

  describe('add account', () => {
    it('renders Add Account button', async () => {
      renderPool()
      await flush()
      await flush()

      const addBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Add Account'),
      )
      expect(addBtn).toBeTruthy()
    })

    it('starts OAuth flow on Add Account click', async () => {
      settingsApiMock.startPoolAddAccountOAuthStream.mockImplementation(async () => {
        // Simulate a long-running operation
      })
      renderPool()
      await flush()
      await flush()

      const addBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Add Account'),
      )

      flushSync(() => {
        fireEvent.click(addBtn!)
      })
      await flush()

      // Should show Authorizing state
      expect(container.textContent).toContain('Authorizing')
    })
  })

  /* ---- Rename credential ---- */

  describe('rename credential', () => {
    it('shows edit pencil icon on hover area (exists in markup)', async () => {
      renderPool()
      await flush()
      await flush()

      // The pencil icon exists in the DOM (shown on hover via CSS)
      const pencilSvgs = container.querySelectorAll('.lucide-pencil')
      expect(pencilSvgs.length).toBeGreaterThan(0)
    })
  })

  /* ---- Set primary ---- */

  describe('set primary', () => {
    it('renders star icon for each credential', async () => {
      const pool = makePool({
        credentials: [
          makeCredential({ id: 'cred-1', isPrimary: true }),
          makeCredential({ id: 'cred-2', label: 'Second', isPrimary: false }),
        ],
      })
      renderPool(pool)
      await flush()
      await flush()

      // Star icons present (SVGs)
      const starSvgs = container.querySelectorAll('.lucide-star')
      expect(starSvgs.length).toBeGreaterThanOrEqual(2)
    })
  })

  /* ---- Error handling ---- */

  describe('error handling', () => {
    it('calls onError when pool fetch fails', async () => {
      settingsApiMock.fetchCredentialPool.mockRejectedValue(new Error('Fetch failed'))

      // Render directly (not through renderPool which overrides the mock)
      root = createRoot(container)
      flushSync(() => {
        root?.render(
          createElement(OpenAICredentialPool, {
            apiClient: mockApiClient,
            target: mockTarget,
            onError,
            onSuccess,
            onAuthReload,
          }),
        )
      })
      await flush()
      await flush()

      expect(onError).toHaveBeenCalledWith('Fetch failed')
    })
  })

  /* ---- Collab target isolation ---- */

  describe('Collab target isolation', () => {
    const collabTarget: SettingsBackendTarget = {
      kind: 'collab',
      label: 'Collab backend',
      description: 'Connected remote collaboration backend',
      wsUrl: 'ws://remote-collab:47287',
      apiBaseUrl: 'https://collab.example.com/',
      fetchCredentials: 'include',
      requiresAdmin: true,
      availableTabs: ['general', 'auth'],
    }

    const collabApiClient: SettingsApiClient = {
      target: collabTarget,
      endpoint: (path: string) => `https://collab.example.com${path}`,
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
      fetchJson: vi.fn(),
      readApiError: vi.fn(),
    }

    function renderCollabPool(pool?: CredentialPoolState): void {
      settingsApiMock.fetchCredentialPool.mockResolvedValue(pool ?? makePool())

      root = createRoot(container)
      flushSync(() => {
        root?.render(
          createElement(OpenAICredentialPool, {
            apiClient: collabApiClient,
            target: collabTarget,
            onError,
            onSuccess,
            onAuthReload,
          }),
        )
      })
    }

    it('fetches pool via collab apiClient', async () => {
      renderCollabPool()
      await flush()
      await flush()

      expect(settingsApiMock.fetchCredentialPool).toHaveBeenCalledWith(
        collabApiClient,
        'openai-codex',
      )
      expect(settingsApiMock.fetchCredentialPool).not.toHaveBeenCalledWith(
        mockApiClient,
        expect.anything(),
      )
    })

    it('OAuth add-account targets collab backend', async () => {
      settingsApiMock.startPoolAddAccountOAuthStream.mockImplementation(async () => {})
      renderCollabPool()
      await flush()
      await flush()

      const addBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Add Account'),
      )
      expect(addBtn).toBeTruthy()

      flushSync(() => {
        fireEvent.click(addBtn!)
      })
      await flush()

      expect(settingsApiMock.startPoolAddAccountOAuthStream).toHaveBeenCalledWith(
        collabApiClient,
        'openai-codex',
        expect.any(Object),
        expect.any(Object),
      )
    })

    it('collab apiClient does not reference local builder URL', () => {
      expect(collabApiClient.target.apiBaseUrl).not.toContain('127.0.0.1')
      expect(collabApiClient.target.apiBaseUrl).not.toContain('47187')
      expect(collabApiClient.target.fetchCredentials).toBe('include')
    })
  })
})
