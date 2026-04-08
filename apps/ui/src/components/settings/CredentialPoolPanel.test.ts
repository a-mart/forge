/** @vitest-environment jsdom */

import { fireEvent } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CredentialPoolPanel } from './CredentialPoolPanel'
import { OpenAICredentialPool } from './OpenAICredentialPool'
import type { CredentialPoolState, PooledCredentialInfo } from '@forge/protocol'

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
      label: 'OpenAI API key',
      description: 'Used for Codex runtime sessions and voice transcription.',
      placeholder: 'sk-...',
      helpUrl: 'https://platform.openai.com/api-keys',
      oauthSupported: true,
    },
    anthropic: {
      label: 'Anthropic API key',
      description: 'Used by pi-opus and Anthropic-backed managers/workers.',
      placeholder: 'sk-ant-...',
      helpUrl: 'https://console.anthropic.com/settings/keys',
      oauthSupported: true,
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

function renderPanel(
  provider: string,
  providerLabel: string,
  pool?: CredentialPoolState,
): void {
  settingsApiMock.fetchCredentialPool.mockResolvedValue(pool ?? makePool())

  root = createRoot(container)
  flushSync(() => {
    root?.render(
      createElement(CredentialPoolPanel, {
        provider,
        providerLabel,
        wsUrl: 'ws://127.0.0.1:47187',
        onError,
        onSuccess,
        onAuthReload,
      }),
    )
  })
}

function renderOpenAIWrapper(pool?: CredentialPoolState): void {
  settingsApiMock.fetchCredentialPool.mockResolvedValue(pool ?? makePool())

  root = createRoot(container)
  flushSync(() => {
    root?.render(
      createElement(OpenAICredentialPool, {
        wsUrl: 'ws://127.0.0.1:47187',
        onError,
        onSuccess,
        onAuthReload,
      }),
    )
  })
}

/* ================================================================== */
/*  Tests — CredentialPoolPanel                                       */
/* ================================================================== */

describe('CredentialPoolPanel', () => {
  /* ---- OpenAI branding ---- */

  describe('OpenAI branding', () => {
    it('renders with OpenAI provider label', async () => {
      renderPanel('openai-codex', 'OpenAI')
      await flush()
      await flush()

      expect(container.textContent).toContain('OpenAI')
      expect(container.textContent).toContain('Primary Account')
    })

    it('fetches pool with openai-codex provider', async () => {
      renderPanel('openai-codex', 'OpenAI')
      await flush()
      await flush()

      expect(settingsApiMock.fetchCredentialPool).toHaveBeenCalledWith(
        'ws://127.0.0.1:47187',
        'openai-codex',
      )
    })
  })

  /* ---- Anthropic branding ---- */

  describe('Anthropic branding', () => {
    it('renders with Anthropic provider label', async () => {
      renderPanel('anthropic', 'Anthropic')
      await flush()
      await flush()

      expect(container.textContent).toContain('Anthropic')
      expect(container.textContent).toContain('Primary Account')
    })

    it('fetches pool with anthropic provider', async () => {
      renderPanel('anthropic', 'Anthropic')
      await flush()
      await flush()

      expect(settingsApiMock.fetchCredentialPool).toHaveBeenCalledWith(
        'ws://127.0.0.1:47187',
        'anthropic',
      )
    })

    it('shows description from metadata for anthropic', async () => {
      renderPanel('anthropic', 'Anthropic')
      await flush()
      await flush()

      expect(container.textContent).toContain('Used by pi-opus')
    })
  })

  /* ---- Loading ---- */

  describe('loading', () => {
    it('shows loading spinner initially', () => {
      renderPanel('openai-codex', 'OpenAI')
      expect(container.querySelector('.animate-spin')).toBeTruthy()
    })

    it('shows provider label during loading', () => {
      renderPanel('anthropic', 'Anthropic')
      expect(container.textContent).toContain('Anthropic')
    })

    it('renders pool after load', async () => {
      renderPanel('openai-codex', 'OpenAI')
      await flush()
      await flush()

      expect(container.textContent).toContain('OpenAI')
      expect(container.textContent).toContain('Primary Account')
    })

    it('shows not configured badge when no credentials', async () => {
      renderPanel('openai-codex', 'OpenAI', makePool({ credentials: [] }))
      await flush()
      await flush()

      expect(container.textContent).toContain('Not configured')
    })
  })

  /* ---- Credential display ---- */

  describe('credential display', () => {
    it('shows credential label and auto-label', async () => {
      renderPanel('openai-codex', 'OpenAI')
      await flush()
      await flush()

      expect(container.textContent).toContain('Primary Account')
      expect(container.textContent).toContain('user@example.com')
    })

    it('shows healthy badge for healthy credentials', async () => {
      renderPanel('openai-codex', 'OpenAI')
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
      renderPanel('openai-codex', 'OpenAI', pool)
      await flush()
      await flush()

      expect(container.textContent).toContain('Cooldown')
    })

    it('shows auth error badge', async () => {
      const pool = makePool({
        credentials: [makeCredential({ health: 'auth_error' })],
      })
      renderPanel('openai-codex', 'OpenAI', pool)
      await flush()
      await flush()

      expect(container.textContent).toContain('Auth Error')
    })

    it('shows request count', async () => {
      renderPanel('openai-codex', 'OpenAI')
      await flush()
      await flush()

      expect(container.textContent).toContain('42')
    })

    it('shows Primary badge for primary credential', async () => {
      renderPanel('openai-codex', 'OpenAI')
      await flush()
      await flush()

      expect(container.textContent).toContain('Primary')
    })

    it('shows account count badge', async () => {
      renderPanel('openai-codex', 'OpenAI')
      await flush()
      await flush()

      expect(container.textContent).toContain('1 account')
    })
  })

  /* ---- Provider-specific API calls ---- */

  describe('provider-specific API calls', () => {
    it('calls rename with correct provider for Anthropic', async () => {
      settingsApiMock.fetchCredentialPool.mockResolvedValue(makePool())
      renderPanel('anthropic', 'Anthropic')
      await flush()
      await flush()

      // Find and click the pencil icon to start editing
      const pencilBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.querySelector('.lucide-pencil'),
      )
      expect(pencilBtn).toBeTruthy()
      flushSync(() => {
        fireEvent.click(pencilBtn!)
      })

      // Change the input value and confirm
      const input = container.querySelector('input[type="text"]') as HTMLInputElement
      expect(input).toBeTruthy()
      flushSync(() => {
        fireEvent.change(input, { target: { value: 'Renamed Account' } })
      })

      // Click the check button to confirm
      const checkBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.classList.contains('size-6') && btn.querySelector('.lucide-check'),
      )
      expect(checkBtn).toBeTruthy()
      flushSync(() => {
        fireEvent.click(checkBtn!)
      })
      await flush()

      expect(settingsApiMock.renamePooledCredential).toHaveBeenCalledWith(
        'ws://127.0.0.1:47187',
        'anthropic',
        'cred-1',
        'Renamed Account',
      )
    })

    it('calls setPrimary with correct provider for Anthropic', async () => {
      const pool = makePool({
        credentials: [
          makeCredential({ id: 'cred-1', isPrimary: true }),
          makeCredential({ id: 'cred-2', label: 'Second', isPrimary: false }),
        ],
      })
      renderPanel('anthropic', 'Anthropic', pool)
      await flush()
      await flush()

      // Find star buttons — second one should be clickable (non-primary)
      const starButtons = Array.from(container.querySelectorAll('button')).filter(
        (btn) => btn.querySelector('.lucide-star') && !btn.disabled,
      )
      expect(starButtons.length).toBeGreaterThan(0)

      flushSync(() => {
        fireEvent.click(starButtons[0])
      })
      await flush()

      expect(settingsApiMock.setPrimaryPooledCredential).toHaveBeenCalledWith(
        'ws://127.0.0.1:47187',
        'anthropic',
        'cred-2',
      )
    })

    it('starts OAuth flow with correct provider for Anthropic', async () => {
      settingsApiMock.startPoolAddAccountOAuthStream.mockImplementation(async () => {
        // Simulate a long-running operation
      })
      renderPanel('anthropic', 'Anthropic')
      await flush()
      await flush()

      const addBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Add Account'),
      )

      flushSync(() => {
        fireEvent.click(addBtn!)
      })
      await flush()

      expect(settingsApiMock.startPoolAddAccountOAuthStream).toHaveBeenCalledWith(
        'ws://127.0.0.1:47187',
        'anthropic',
        expect.any(Object),
        expect.any(Object),
      )
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
      renderPanel('openai-codex', 'OpenAI', pool)
      await flush()
      await flush()

      expect(container.textContent).toContain('Strategy')
    })

    it('does not show strategy selector for single credential', async () => {
      renderPanel('openai-codex', 'OpenAI')
      await flush()
      await flush()

      expect(container.textContent).not.toContain('Strategy')
    })
  })

  /* ---- Add account ---- */

  describe('add account', () => {
    it('renders Add Account button', async () => {
      renderPanel('openai-codex', 'OpenAI')
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
      renderPanel('openai-codex', 'OpenAI')
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

  /* ---- Error handling ---- */

  describe('error handling', () => {
    it('calls onError when pool fetch fails', async () => {
      settingsApiMock.fetchCredentialPool.mockRejectedValue(new Error('Fetch failed'))

      root = createRoot(container)
      flushSync(() => {
        root?.render(
          createElement(CredentialPoolPanel, {
            provider: 'openai-codex',
            providerLabel: 'OpenAI',
            wsUrl: 'ws://127.0.0.1:47187',
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

/* ================================================================== */
/*  Tests — OpenAICredentialPool wrapper                              */
/* ================================================================== */

describe('OpenAICredentialPool', () => {
  it('renders with OpenAI branding via wrapper', async () => {
    renderOpenAIWrapper()
    await flush()
    await flush()

    expect(container.textContent).toContain('OpenAI')
    expect(container.textContent).toContain('Primary Account')
  })

  it('calls API with openai-codex provider', async () => {
    renderOpenAIWrapper()
    await flush()
    await flush()

    expect(settingsApiMock.fetchCredentialPool).toHaveBeenCalledWith(
      'ws://127.0.0.1:47187',
      'openai-codex',
    )
  })
})
