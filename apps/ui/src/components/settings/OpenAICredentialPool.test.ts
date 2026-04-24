/** @vitest-environment jsdom */

import { fireEvent } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAICredentialPool } from './OpenAICredentialPool'
import type { CredentialPoolState, PooledCredentialInfo } from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'
import type { SettingsBackendTarget } from './settings-target'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

const settingsApiMock = vi.hoisted(() => ({
  fetchCredentialPool: vi.fn(),
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

      expect(container.textContent).toContain('OpenAI Codex')
      expect(container.textContent).toContain('Primary Account')
    })

    it('shows not configured badge when no credentials', async () => {
      renderPool(makePool({ credentials: [] }))
      await flush()
      await flush()

      expect(container.textContent).toContain('Not configured')
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
})
