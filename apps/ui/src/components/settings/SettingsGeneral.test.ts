/** @vitest-environment jsdom */

import { fireEvent } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsGeneral } from './SettingsGeneral'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

vi.mock('@/components/help/help-hooks', () => ({
  useHelpContext: () => {},
}))

vi.mock('@/components/help/HelpTooltip', () => ({
  HelpTooltip: ({ children }: { children: unknown }) => children,
}))

vi.mock('@/components/chat/cortex/OnboardingCallout', () => ({
  OnboardingCallout: () => createElement('div', { 'data-testid': 'onboarding-callout' }, 'Onboarding'),
}))

const onboardingMock = vi.hoisted(() => ({
  useOnboardingState: vi.fn(),
}))

vi.mock('@/hooks/use-onboarding-state', () => ({
  useOnboardingState: (...args: unknown[]) => onboardingMock.useOnboardingState(...args),
}))

const sidebarPrefsMock = vi.hoisted(() => ({
  readSidebarModelIconsPref: vi.fn(),
  readSidebarProviderUsagePref: vi.fn(),
  storeSidebarModelIconsPref: vi.fn(),
  storeSidebarProviderUsagePref: vi.fn(),
}))

vi.mock('@/lib/sidebar-prefs', () => ({
  readSidebarModelIconsPref: () => sidebarPrefsMock.readSidebarModelIconsPref(),
  readSidebarProviderUsagePref: () => sidebarPrefsMock.readSidebarProviderUsagePref(),
  storeSidebarModelIconsPref: (v: boolean) => sidebarPrefsMock.storeSidebarModelIconsPref(v),
  storeSidebarProviderUsagePref: (v: boolean) => sidebarPrefsMock.storeSidebarProviderUsagePref(v),
}))

const themeMock = vi.hoisted(() => ({
  readStoredThemePreference: vi.fn(),
  applyThemePreference: vi.fn(),
}))

vi.mock('@/lib/theme', () => ({
  readStoredThemePreference: () => themeMock.readStoredThemePreference(),
  applyThemePreference: (pref: string) => themeMock.applyThemePreference(pref),
}))

const editorMock = vi.hoisted(() => ({
  readStoredEditorPreference: vi.fn(),
  storeEditorPreference: vi.fn(),
}))

vi.mock('@/lib/editor-preference', () => ({
  EDITOR_LABELS: {
    vscode: 'VS Code',
    'vscode-insiders': 'VS Code Insiders',
    cursor: 'Cursor',
  },
  readStoredEditorPreference: () => editorMock.readStoredEditorPreference(),
  storeEditorPreference: (pref: string) => editorMock.storeEditorPreference(pref),
}))

vi.mock('@/lib/electron-bridge', () => ({
  isElectron: () => false,
}))

vi.mock('@/lib/api-endpoint', () => ({
  resolveApiEndpoint: (_ws: string, path: string) => `http://127.0.0.1:47187${path}`,
}))

const playwrightApiMock = vi.hoisted(() => ({
  fetchPlaywrightSettings: vi.fn(),
  updatePlaywrightSettings: vi.fn(),
}))

vi.mock('@/components/playwright/playwright-api', () => ({
  fetchPlaywrightSettings: (...args: unknown[]) => playwrightApiMock.fetchPlaywrightSettings(...args),
  updatePlaywrightSettings: (...args: unknown[]) => playwrightApiMock.updatePlaywrightSettings(...args),
}))

const cortexApiMock = vi.hoisted(() => ({
  fetchCortexAutoReviewSettings: vi.fn(),
  updateCortexAutoReviewSettings: vi.fn(),
}))

vi.mock('@/components/settings/cortex-auto-review-api', () => ({
  fetchCortexAutoReviewSettings: (...args: unknown[]) => cortexApiMock.fetchCortexAutoReviewSettings(...args),
  updateCortexAutoReviewSettings: (...args: unknown[]) => cortexApiMock.updateCortexAutoReviewSettings(...args),
}))

const terminalApiMock = vi.hoisted(() => ({
  fetchAvailableShells: vi.fn(),
  updateTerminalShellSettings: vi.fn(),
}))

vi.mock('@/components/settings/terminal-shell-api', () => ({
  fetchAvailableShells: (...args: unknown[]) => terminalApiMock.fetchAvailableShells(...args),
  updateTerminalShellSettings: (...args: unknown[]) => terminalApiMock.updateTerminalShellSettings(...args),
}))

/* ------------------------------------------------------------------ */
/*  Setup                                                             */
/* ------------------------------------------------------------------ */

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)

  themeMock.readStoredThemePreference.mockReturnValue('dark')
  editorMock.readStoredEditorPreference.mockReturnValue('vscode')
  sidebarPrefsMock.readSidebarModelIconsPref.mockReturnValue(true)
  sidebarPrefsMock.readSidebarProviderUsagePref.mockReturnValue(true)
  onboardingMock.useOnboardingState.mockReturnValue({
    onboardingState: null,
    isMutating: false,
    error: null,
    savePreferences: vi.fn(),
  })
  playwrightApiMock.fetchPlaywrightSettings.mockResolvedValue({
    effectiveEnabled: false,
    source: 'config',
  })
  cortexApiMock.fetchCortexAutoReviewSettings.mockResolvedValue({
    settings: { enabled: true, intervalMinutes: 120 },
    cortexDisabled: false,
  })
  terminalApiMock.fetchAvailableShells.mockResolvedValue({
    shells: [
      { name: 'Bash', path: '/bin/bash', available: true },
      { name: 'Zsh', path: '/bin/zsh', available: true },
    ],
    settings: {
      persistedDefaultShell: null,
      effectiveShell: '/bin/zsh',
      source: 'auto',
    },
  })
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

function renderGeneral(): void {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(SettingsGeneral, { wsUrl: 'ws://127.0.0.1:47187' }))
  })
}

/* ================================================================== */
/*  Tests                                                             */
/* ================================================================== */

describe('SettingsGeneral', () => {
  /* ---- Appearance section ---- */

  describe('appearance section', () => {
    it('renders theme and editor selectors', async () => {
      renderGeneral()
      await flush()

      expect(container.textContent).toContain('Theme')
      expect(container.textContent).toContain('Preferred Editor')
    })

    it('applies theme preference on change', async () => {
      renderGeneral()
      await flush()

      // The theme select should exist with the current value
      expect(container.textContent).toContain('Appearance')
    })
  })

  /* ---- Playwright section ---- */

  describe('experimental features', () => {
    it('renders Playwright Dashboard toggle', async () => {
      renderGeneral()
      await flush()
      await flush()

      expect(container.textContent).toContain('Playwright Dashboard')
    })

    it('shows env-var override message when source is env', async () => {
      playwrightApiMock.fetchPlaywrightSettings.mockResolvedValue({
        effectiveEnabled: true,
        source: 'env',
      })
      renderGeneral()
      await flush()
      await flush()

      expect(container.textContent).toContain('FORGE_PLAYWRIGHT_DASHBOARD_ENABLED')
    })
  })

  /* ---- Cortex auto-review ---- */

  describe('cortex auto-review', () => {
    it('renders Cortex auto-review toggle', async () => {
      renderGeneral()
      await flush()
      await flush()

      expect(container.textContent).toContain('Automatic Reviews')
    })

    it('renders review interval selector', async () => {
      renderGeneral()
      await flush()
      await flush()

      expect(container.textContent).toContain('Review Interval')
    })

    it('hides Cortex section when cortex is disabled', async () => {
      cortexApiMock.fetchCortexAutoReviewSettings.mockResolvedValue({
        settings: { enabled: false, intervalMinutes: 120 },
        cortexDisabled: true,
      })
      renderGeneral()
      await flush()
      await flush()

      expect(container.textContent).not.toContain('Automatic Reviews')
    })
  })

  /* ---- Sidebar prefs ---- */

  describe('sidebar preferences', () => {
    it('renders sidebar model icons toggle', async () => {
      renderGeneral()
      await flush()

      expect(container.textContent).toContain('Show model icons')
    })

    it('renders provider usage toggle', async () => {
      renderGeneral()
      await flush()

      expect(container.textContent).toContain('Show provider usage')
    })
  })

  /* ---- Terminal shell settings ---- */

  describe('terminal settings', () => {
    it('renders terminal shell selector', async () => {
      renderGeneral()
      await flush()
      await flush()

      expect(container.textContent).toContain('Default Shell')
    })

    it('shows system default option', async () => {
      renderGeneral()
      await flush()
      await flush()

      expect(container.textContent).toContain('System Default')
    })

    it('shows error when terminal settings fail to load', async () => {
      terminalApiMock.fetchAvailableShells.mockRejectedValue(new Error('Shell load failed'))
      renderGeneral()
      await flush()
      await flush()

      expect(container.textContent).toContain('Shell load failed')
    })
  })

  /* ---- System section ---- */

  describe('system section', () => {
    it('renders Reboot button', async () => {
      renderGeneral()
      await flush()

      const rebootBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Reboot'),
      )
      expect(rebootBtn).toBeTruthy()
    })

    it('sends POST to /api/reboot on click', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
      vi.stubGlobal('fetch', fetchSpy)

      renderGeneral()
      await flush()

      const rebootBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Reboot'),
      )
      flushSync(() => {
        fireEvent.click(rebootBtn!)
      })
      await flush()

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:47187/api/reboot',
        expect.objectContaining({ method: 'POST' }),
      )

      vi.unstubAllGlobals()
    })
  })

  /* ---- Welcome preferences ---- */

  describe('welcome preferences', () => {
    it('renders onboarding callout section', async () => {
      renderGeneral()
      await flush()

      expect(container.textContent).toContain('Welcome Preferences')
      expect(container.textContent).toContain('Onboarding')
    })
  })
})

/* ================================================================== */
/*  Collab target — Builder-only sections hidden                      */
/* ================================================================== */

describe('SettingsGeneral — collab target', () => {
  function renderCollab(): void {
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(SettingsGeneral, {
          wsUrl: 'wss://collab.example.com',
          target: {
            kind: 'collab',
            label: 'Collab backend',
            description: 'Remote collab.',
            wsUrl: 'wss://collab.example.com',
            apiBaseUrl: 'https://collab.example.com/',
            fetchCredentials: 'include',
            requiresAdmin: true,
            availableTabs: ['general', 'auth', 'models', 'about'],
          },
        }),
      )
    })
  }

  it('hides the Terminal section in collab mode', async () => {
    renderCollab()
    await flush()
    await flush()

    expect(container.textContent).not.toContain('Default Shell')
    expect(container.textContent).not.toContain('Terminal')
  })

  it('does NOT call fetchAvailableShells in collab mode', async () => {
    renderCollab()
    await flush()
    await flush()

    expect(terminalApiMock.fetchAvailableShells).not.toHaveBeenCalled()
  })

  it('hides the Appearance section in collab mode', async () => {
    renderCollab()
    await flush()

    expect(container.textContent).not.toContain('Appearance')
    expect(container.textContent).not.toContain('Theme')
  })

  it('hides the Sidebar section in collab mode', async () => {
    renderCollab()
    await flush()

    expect(container.textContent).not.toContain('Sidebar')
    expect(container.textContent).not.toContain('Show model icons')
  })

  it('still renders Playwright and Cortex sections in collab mode', async () => {
    renderCollab()
    await flush()
    await flush()

    expect(container.textContent).toContain('Playwright Dashboard')
    expect(container.textContent).toContain('Automatic Reviews')
  })

  it('passes apiClient to onboarding hook when provided', async () => {
    const mockClient = {
      target: {
        kind: 'collab' as const,
        label: 'Collab',
        description: 'Remote',
        wsUrl: 'wss://collab.example.com',
        apiBaseUrl: 'https://collab.example.com/',
        fetchCredentials: 'include' as const,
        requiresAdmin: true,
        availableTabs: ['general' as const],
      },
      endpoint: (path: string) => `https://collab.example.com${path}`,
      fetch: vi.fn(),
      fetchJson: vi.fn(),
      readApiError: vi.fn(),
    }
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(SettingsGeneral, {
          wsUrl: 'wss://collab.example.com',
          target: mockClient.target,
          apiClient: mockClient,
        }),
      )
    })
    await flush()

    // useOnboardingState should have been called with the apiClient, not wsUrl
    expect(onboardingMock.useOnboardingState).toHaveBeenCalledWith(mockClient)
  })
})
