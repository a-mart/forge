/** @vitest-environment jsdom */

import { fireEvent } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsChromeCdp } from './SettingsChromeCdp'
import type { ChromeCdpConfig, ChromeCdpStatus } from './settings-types'
import type { SettingsApiClient } from './settings-api-client'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

const settingsApiMock = vi.hoisted(() => ({
  fetchChromeCdpSettings: vi.fn(),
  updateChromeCdpSettings: vi.fn(),
  testChromeCdpConnection: vi.fn(),
  fetchChromeCdpProfiles: vi.fn(),
  fetchChromeCdpPreview: vi.fn(),
  toErrorMessage: vi.fn((err: unknown) => (err instanceof Error ? err.message : String(err))),
}))

vi.mock('./settings-api', () => ({
  fetchChromeCdpSettings: (clientOrWsUrl: SettingsApiClient | string) => settingsApiMock.fetchChromeCdpSettings(clientOrWsUrl),
  updateChromeCdpSettings: (clientOrWsUrl: SettingsApiClient | string, config: unknown) => settingsApiMock.updateChromeCdpSettings(clientOrWsUrl, config),
  testChromeCdpConnection: (clientOrWsUrl: SettingsApiClient | string) => settingsApiMock.testChromeCdpConnection(clientOrWsUrl),
  fetchChromeCdpProfiles: (clientOrWsUrl: SettingsApiClient | string) => settingsApiMock.fetchChromeCdpProfiles(clientOrWsUrl),
  fetchChromeCdpPreview: (clientOrWsUrl: SettingsApiClient | string, config: unknown, signal?: AbortSignal) =>
    settingsApiMock.fetchChromeCdpPreview(clientOrWsUrl, config, signal),
  toErrorMessage: (err: unknown) => settingsApiMock.toErrorMessage(err),
}))

/* ------------------------------------------------------------------ */
/*  Setup                                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_CONFIG: ChromeCdpConfig = {
  contextId: null,
  urlAllow: [],
  urlBlock: [],
}

const CONNECTED_STATUS: ChromeCdpStatus = {
  connected: true,
  port: 9222,
  tabCount: 3,
  version: '130.0',
  browser: 'Chrome/130.0',
}

const DISCONNECTED_STATUS: ChromeCdpStatus = {
  connected: false,
  error: 'Could not connect',
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
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

function renderComponent(config = DEFAULT_CONFIG, status: ChromeCdpStatus = CONNECTED_STATUS): void {
  settingsApiMock.fetchChromeCdpSettings.mockResolvedValue({ config, status })
  settingsApiMock.fetchChromeCdpPreview.mockResolvedValue({
    tabs: [],
    totalFiltered: 0,
    totalUnfiltered: status.tabCount ?? 0,
  })

  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(SettingsChromeCdp, { clientOrWsUrl: 'ws://127.0.0.1:47187' }))
  })
}

/* ================================================================== */
/*  Tests                                                             */
/* ================================================================== */

describe('SettingsChromeCdp', () => {
  /* ---- Initial load ---- */

  describe('loading and display', () => {
    it('shows loading spinner initially then renders content', async () => {
      renderComponent()

      // Initially shows loader
      expect(container.querySelector('.animate-spin')).toBeTruthy()

      await flush()
      await flush()

      // After load, should show connection status
      expect(container.textContent).toContain('Connected')
    })

    it('shows connected badge when Chrome is connected', async () => {
      renderComponent(DEFAULT_CONFIG, CONNECTED_STATUS)
      await flush()
      await flush()

      expect(container.textContent).toContain('Connected')
      expect(container.textContent).toContain('9222')
    })

    it('shows disconnected state when Chrome is not available', async () => {
      renderComponent(DEFAULT_CONFIG, DISCONNECTED_STATUS)
      await flush()
      await flush()

      expect(container.textContent).toContain('Not connected')
    })
  })

  /* ---- Test connection ---- */

  describe('test connection', () => {
    it('calls testChromeCdpConnection when Test Connection clicked', async () => {
      settingsApiMock.testChromeCdpConnection.mockResolvedValue(CONNECTED_STATUS)
      renderComponent()
      await flush()
      await flush()

      const testBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Test Connection'),
      )
      expect(testBtn).toBeTruthy()

      flushSync(() => {
        fireEvent.click(testBtn!)
      })
      await flush()
      await flush()

      expect(settingsApiMock.testChromeCdpConnection).toHaveBeenCalledWith('ws://127.0.0.1:47187')
    })

    it('shows success message on successful test', async () => {
      settingsApiMock.testChromeCdpConnection.mockResolvedValue(CONNECTED_STATUS)
      renderComponent()
      await flush()
      await flush()

      const testBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Test Connection'),
      )
      flushSync(() => {
        fireEvent.click(testBtn!)
      })
      await flush()
      await flush()

      // Success feedback shows "Connected on port ..."
      expect(container.textContent).toContain('Connected')
    })

    it('shows error message on failed test', async () => {
      settingsApiMock.testChromeCdpConnection.mockResolvedValue({
        connected: false,
        error: 'Connection refused',
      })
      renderComponent()
      await flush()
      await flush()

      const testBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Test Connection'),
      )
      flushSync(() => {
        fireEvent.click(testBtn!)
      })
      await flush()
      await flush()

      expect(container.textContent).toContain('Connection refused')
    })
  })

  /* ---- Save/clear config ---- */

  describe('save and clear configuration', () => {
    it('calls updateChromeCdpSettings on save', async () => {
      settingsApiMock.updateChromeCdpSettings.mockResolvedValue(undefined)
      renderComponent()
      await flush()
      await flush()

      const saveBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Save Configuration'),
      )
      expect(saveBtn).toBeTruthy()

      flushSync(() => {
        fireEvent.click(saveBtn!)
      })
      await flush()
      await flush()

      expect(settingsApiMock.updateChromeCdpSettings).toHaveBeenCalledWith(
        'ws://127.0.0.1:47187',
        expect.objectContaining({
          contextId: null,
          urlAllow: [],
          urlBlock: [],
        }),
      )
    })

    it('shows success message after save', async () => {
      settingsApiMock.updateChromeCdpSettings.mockResolvedValue(undefined)
      renderComponent()
      await flush()
      await flush()

      const saveBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Save Configuration'),
      )
      flushSync(() => {
        fireEvent.click(saveBtn!)
      })
      await flush()
      await flush()

      expect(container.textContent).toContain('Chrome CDP configuration saved')
    })

    it('clears configuration when Clear All clicked', async () => {
      settingsApiMock.updateChromeCdpSettings.mockResolvedValue(undefined)
      const configWithFilters: ChromeCdpConfig = {
        contextId: 'some-id',
        urlAllow: ['*.example.com'],
        urlBlock: ['*.ads.com'],
      }
      renderComponent(configWithFilters)
      await flush()
      await flush()

      const clearBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Clear All'),
      )
      expect(clearBtn).toBeTruthy()

      flushSync(() => {
        fireEvent.click(clearBtn!)
      })
      await flush()
      await flush()

      expect(settingsApiMock.updateChromeCdpSettings).toHaveBeenCalledWith(
        'ws://127.0.0.1:47187',
        {
          contextId: null,
          urlAllow: [],
          urlBlock: [],
        },
      )
    })
  })

  /* ---- Profile discovery ---- */

  describe('profile discovery', () => {
    it('calls fetchChromeCdpProfiles when Discover Profiles clicked', async () => {
      settingsApiMock.fetchChromeCdpProfiles.mockResolvedValue([
        { contextId: 'ctx-1', tabCount: 5, isDefault: true, sampleUrls: ['https://example.com'] },
      ])
      renderComponent()
      await flush()
      await flush()

      const discoverBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Discover Profiles'),
      )
      expect(discoverBtn).toBeTruthy()

      flushSync(() => {
        fireEvent.click(discoverBtn!)
      })
      await flush()
      await flush()

      expect(settingsApiMock.fetchChromeCdpProfiles).toHaveBeenCalledWith('ws://127.0.0.1:47187')
      expect(container.textContent).toContain('ctx-1')
    })
  })

  /* ---- Error handling ---- */

  describe('error handling', () => {
    it('shows error when initial load fails', async () => {
      settingsApiMock.fetchChromeCdpSettings.mockRejectedValue(new Error('Network error'))

      root = createRoot(container)
      flushSync(() => {
        root?.render(createElement(SettingsChromeCdp, { clientOrWsUrl: 'ws://127.0.0.1:47187' }))
      })
      await flush()
      await flush()

      expect(container.textContent).toContain('Network error')
    })

    it('shows error when save fails', async () => {
      settingsApiMock.updateChromeCdpSettings.mockRejectedValue(new Error('Save failed'))
      renderComponent()
      await flush()
      await flush()

      const saveBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Save Configuration'),
      )
      flushSync(() => {
        fireEvent.click(saveBtn!)
      })
      await flush()
      await flush()

      expect(container.textContent).toContain('Save failed')
    })
  })

  /* ---- Tab preview ---- */

  describe('tab preview', () => {
    it('shows tab preview section when connected', async () => {
      renderComponent()
      await flush()
      await flush()

      expect(container.textContent).toContain('Tab Preview')
    })

    it('shows no-filters message when no filters configured', async () => {
      settingsApiMock.fetchChromeCdpPreview.mockResolvedValue({
        tabs: [],
        totalFiltered: 0,
        totalUnfiltered: 3,
      })
      renderComponent()
      await flush()
      await flush()
      // Wait for debounced preview
      await new Promise((r) => setTimeout(r, 600))
      await flush()

      expect(container.textContent).toContain('No filters configured')
    })
  })

  /* ---- Collab-target support ---- */

  describe('collab target support', () => {
    it('passes SettingsApiClient through to settings-api helpers when provided', async () => {
      const mockClient: SettingsApiClient = {
        target: {
          kind: 'collab',
          label: 'Collab backend',
          description: 'Remote',
          wsUrl: 'wss://collab.example.com',
          apiBaseUrl: 'https://collab.example.com/',
          fetchCredentials: 'include',
          requiresAdmin: true,
          availableTabs: [],
        },
        endpoint: (path: string) => `https://collab.example.com${path}`,
        fetch: vi.fn(),
        fetchJson: vi.fn(),
        readApiError: vi.fn(),
      }

      settingsApiMock.fetchChromeCdpSettings.mockResolvedValue({
        config: DEFAULT_CONFIG,
        status: CONNECTED_STATUS,
      })
      settingsApiMock.fetchChromeCdpPreview.mockResolvedValue({
        tabs: [],
        totalFiltered: 0,
        totalUnfiltered: 3,
      })

      root = createRoot(container)
      flushSync(() => {
        root?.render(createElement(SettingsChromeCdp, {
          clientOrWsUrl: mockClient,
        }))
      })
      await flush()
      await flush()

      // fetchChromeCdpSettings should have been called with the client object, not a raw wsUrl
      expect(settingsApiMock.fetchChromeCdpSettings).toHaveBeenCalledWith(mockClient)
    })

    it('passes raw wsUrl in builder mode', async () => {
      settingsApiMock.fetchChromeCdpSettings.mockResolvedValue({
        config: DEFAULT_CONFIG,
        status: CONNECTED_STATUS,
      })
      settingsApiMock.fetchChromeCdpPreview.mockResolvedValue({
        tabs: [],
        totalFiltered: 0,
        totalUnfiltered: 3,
      })

      root = createRoot(container)
      flushSync(() => {
        root?.render(createElement(SettingsChromeCdp, {
          clientOrWsUrl: 'ws://127.0.0.1:47187',
        }))
      })
      await flush()
      await flush()

      expect(settingsApiMock.fetchChromeCdpSettings).toHaveBeenCalledWith('ws://127.0.0.1:47187')
    })
  })
})
