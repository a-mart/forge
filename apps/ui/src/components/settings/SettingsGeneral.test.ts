/** @vitest-environment jsdom */

import { fireEvent, getAllByRole, getByRole, queryByRole, waitFor } from '@testing-library/dom'
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
  readConversationThroughputDisplayPref: vi.fn(),
  storeConversationThroughputDisplayPref: vi.fn(),
}))

vi.mock('@/lib/sidebar-prefs', () => ({
  readSidebarModelIconsPref: () => sidebarPrefsMock.readSidebarModelIconsPref(),
  readSidebarProviderUsagePref: () => sidebarPrefsMock.readSidebarProviderUsagePref(),
  storeSidebarModelIconsPref: (v: boolean) => sidebarPrefsMock.storeSidebarModelIconsPref(v),
  storeSidebarProviderUsagePref: (v: boolean) => sidebarPrefsMock.storeSidebarProviderUsagePref(v),
  readConversationThroughputDisplayPref: () => sidebarPrefsMock.readConversationThroughputDisplayPref(),
  storeConversationThroughputDisplayPref: (v: boolean) => sidebarPrefsMock.storeConversationThroughputDisplayPref(v),
  CONVERSATION_THROUGHPUT_DISPLAY_KEY: 'forge-conversation-throughput-display',
  PREFERENCE_CHANGE_EVENT: 'forge-sidebar-pref-change',
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

const cortexApiMock = vi.hoisted(() => ({
  fetchCortexAutoReviewSettings: vi.fn(),
  updateCortexAutoReviewSettings: vi.fn(),
}))

vi.mock('@/components/settings/cortex-auto-review-api', () => ({
  fetchCortexAutoReviewSettings: (...args: unknown[]) => cortexApiMock.fetchCortexAutoReviewSettings(...args),
  updateCortexAutoReviewSettings: (...args: unknown[]) => cortexApiMock.updateCortexAutoReviewSettings(...args),
}))

const knowledgeV2ApiMock = vi.hoisted(() => ({
  fetchKnowledgeV2Settings: vi.fn(),
  updateKnowledgeV2Settings: vi.fn(),
}))

vi.mock('@/components/settings/knowledge-v2-api', () => ({
  fetchKnowledgeV2Settings: (...args: unknown[]) => knowledgeV2ApiMock.fetchKnowledgeV2Settings(...args),
  updateKnowledgeV2Settings: (...args: unknown[]) => knowledgeV2ApiMock.updateKnowledgeV2Settings(...args),
}))

function knowledgeV2SettingsView(enabled: boolean, canEnable = true) {
  return {
    settings: {
      enabled,
      legacyCleanupConfirmed: false,
      indexCaps: { global: 200, profile: 100 },
      updatedAt: null,
    },
    defaults: {
      enabled: false,
      legacyCleanupConfirmed: false,
      indexCaps: { global: 200, profile: 100 },
      updatedAt: null,
    },
    constraints: { indexCaps: { min: 0, max: 1000, defaults: { global: 200, profile: 100 } } },
    activation: { canEnable, reason: canEnable ? null : 'migration_required' },
  }
}

const modelCacheVisualizationApiMock = vi.hoisted(() => ({
  fetchModelCacheVisualizationEnabled: vi.fn(),
  setModelCacheVisualizationEnabledApi: vi.fn(),
}))

vi.mock('@/components/settings/model-cache-visualization-api', () => ({
  fetchModelCacheVisualizationEnabled: (...args: unknown[]) =>
    modelCacheVisualizationApiMock.fetchModelCacheVisualizationEnabled(...args),
  setModelCacheVisualizationEnabledApi: (...args: unknown[]) =>
    modelCacheVisualizationApiMock.setModelCacheVisualizationEnabledApi(...args),
}))

const terminalApiMock = vi.hoisted(() => ({
  fetchAvailableShells: vi.fn(),
  updateTerminalShellSettings: vi.fn(),
}))

vi.mock('@/components/settings/terminal-shell-api', () => ({
  fetchAvailableShells: (...args: unknown[]) => terminalApiMock.fetchAvailableShells(...args),
  updateTerminalShellSettings: (...args: unknown[]) => terminalApiMock.updateTerminalShellSettings(...args),
}))

const compactionApiMock = vi.hoisted(() => ({
  fetchCompactionSettings: vi.fn(),
  updateCompactionSettings: vi.fn(),
}))

vi.mock('@/components/settings/compaction-settings-api', () => ({
  fetchCompactionSettings: (...args: unknown[]) => compactionApiMock.fetchCompactionSettings(...args),
  updateCompactionSettings: (...args: unknown[]) => compactionApiMock.updateCompactionSettings(...args),
}))

const repositoryApiMock = vi.hoisted(() => ({
  fetchRepositorySettings: vi.fn(),
  updateRepositorySettings: vi.fn(),
}))

vi.mock('@/components/settings/repository-settings-api', () => ({
  fetchRepositorySettings: (...args: unknown[]) => repositoryApiMock.fetchRepositorySettings(...args),
  updateRepositorySettings: (...args: unknown[]) => repositoryApiMock.updateRepositorySettings(...args),
}))

const modelPresetMock = vi.hoisted(() => ({
  fetchModelPresets: vi.fn(),
}))

vi.mock('@/lib/model-preset', () => ({
  fetchModelPresets: (...args: unknown[]) => modelPresetMock.fetchModelPresets(...args),
}))

/* ------------------------------------------------------------------ */
/*  Setup                                                             */
/* ------------------------------------------------------------------ */

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  if (!Element.prototype.hasPointerCapture) {
    Object.defineProperty(Element.prototype, 'hasPointerCapture', {
      configurable: true,
      value: () => false,
    })
  }
  if (!Element.prototype.setPointerCapture) {
    Object.defineProperty(Element.prototype, 'setPointerCapture', {
      configurable: true,
      value: () => {},
    })
  }
  if (!Element.prototype.releasePointerCapture) {
    Object.defineProperty(Element.prototype, 'releasePointerCapture', {
      configurable: true,
      value: () => {},
    })
  }
  if (!Element.prototype.scrollIntoView) {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: () => {},
    })
  }

  container = document.createElement('div')
  document.body.appendChild(container)

  editorMock.readStoredEditorPreference.mockReturnValue('vscode')
  sidebarPrefsMock.readSidebarModelIconsPref.mockReturnValue(true)
  sidebarPrefsMock.readSidebarProviderUsagePref.mockReturnValue(true)
  sidebarPrefsMock.readConversationThroughputDisplayPref.mockReturnValue(false)
  onboardingMock.useOnboardingState.mockReturnValue({
    onboardingState: null,
    isMutating: false,
    error: null,
    savePreferences: vi.fn(),
  })
  cortexApiMock.fetchCortexAutoReviewSettings.mockResolvedValue({
    settings: { enabled: true, intervalMinutes: 1440 },
    cortexDisabled: false,
  })
  knowledgeV2ApiMock.fetchKnowledgeV2Settings.mockResolvedValue({
    available: true,
    response: knowledgeV2SettingsView(false),
  })
  knowledgeV2ApiMock.updateKnowledgeV2Settings.mockResolvedValue({
    ok: true,
    ...knowledgeV2SettingsView(true),
  })
  modelCacheVisualizationApiMock.fetchModelCacheVisualizationEnabled.mockResolvedValue(false)
  modelCacheVisualizationApiMock.setModelCacheVisualizationEnabledApi.mockResolvedValue(undefined)
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
  compactionApiMock.fetchCompactionSettings.mockResolvedValue({
    settings: {
      model: { provider: 'openai-codex', modelId: 'gpt-5.5' },
      reasoningLevel: 'low',
      timeoutMs: 300_000,
      updatedAt: null,
    },
    availability: {
      providerConfigured: true,
      modelValid: true,
      reasoningSupported: true,
    },
    defaults: {
      model: { provider: 'openai-codex', modelId: 'gpt-5.5' },
      reasoningLevel: 'low',
      timeoutMs: 300_000,
      updatedAt: null,
    },
    constraints: {
      timeoutMs: { min: 60_000, max: 900_000, default: 300_000 },
    },
  })
  compactionApiMock.updateCompactionSettings.mockResolvedValue({
    ok: true,
    settings: {
      model: { provider: 'openai-codex', modelId: 'gpt-5.5' },
      reasoningLevel: 'low',
      timeoutMs: 300_000,
      updatedAt: '2026-06-24T00:00:00.000Z',
    },
    availability: {
      providerConfigured: true,
      modelValid: true,
      reasoningSupported: true,
    },
  })
  modelPresetMock.fetchModelPresets.mockResolvedValue([
    {
      presetId: 'gpt-5.5',
      displayName: 'GPT-5.5',
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      defaultReasoningLevel: 'low',
      supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
    },
    {
      presetId: 'cursor-composer',
      displayName: 'Cursor Composer',
      provider: 'cursor-sdk',
      modelId: 'claude-sonnet-5',
      defaultReasoningLevel: 'high',
      supportedReasoningLevels: ['low', 'medium', 'high'],
    },
    {
      presetId: 'pi-grok',
      displayName: 'Grok 4',
      provider: 'xai',
      modelId: 'grok-4',
      defaultReasoningLevel: 'low',
      supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
    },
  ])
  repositoryApiMock.fetchRepositorySettings.mockResolvedValue({
    configuredHome: null,
    lastUsedBasePath: null,
    effectiveBasePath: '/tmp/home',
    source: 'default',
  })
  repositoryApiMock.updateRepositorySettings.mockResolvedValue({
    configuredHome: '/tmp/repos',
    lastUsedBasePath: null,
    effectiveBasePath: '/tmp/repos',
    source: 'configured',
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
  /* ---- Editor section ---- */

  describe('editor section', () => {
    it('renders the local editor selector', async () => {
      renderGeneral()
      await flush()

      expect(container.textContent).toContain('Editor')
      expect(container.textContent).toContain('Preferred Editor')
    })
  })

  /* ---- Compaction ---- */

  describe('compaction settings', () => {
    it('renders compaction settings with server defaults', async () => {
      renderGeneral()
      await flush()
      await flush()

      expect(container.textContent).toContain('Compaction')
      expect(container.textContent).toContain('Compaction model')
      expect(container.textContent).toContain('Compaction reasoning')
      expect(container.textContent).toContain('Compaction timeout')
      expect(container.textContent).toContain('GPT-5.5')
      expect(container.textContent).toContain('Low')
      expect(container.textContent).toContain('5 minutes')
    })

    it('filters unsupported xAI and Cursor SDK models out of compaction model choices', async () => {
      renderGeneral()
      await flush()
      await flush()

      const trigger = container.querySelector('[aria-label="Compaction model"]')
      expect(trigger).toBeTruthy()

      flushSync(() => {
        fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      })
      await waitFor(() => expect(getByRole(document.body, 'option', { name: 'GPT-5.5' })).toBeTruthy())

      expect(queryByRole(document.body, 'option', { name: 'Grok 4' })).toBeNull()
      expect(queryByRole(document.body, 'option', { name: 'Cursor Composer' })).toBeNull()
    })

    it('uses model-specific reasoning metadata for GPT-5.6 compaction variants', async () => {
      modelPresetMock.fetchModelPresets.mockResolvedValueOnce([
        {
          presetId: 'pi-5.6',
          displayName: 'GPT-5.6 Sol',
          provider: 'openai-codex',
          modelId: 'gpt-5.6-sol',
          defaultReasoningLevel: 'max',
          supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          variants: [
            { modelId: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
            { modelId: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
          ],
        },
      ])

      renderGeneral()
      await flush()
      await flush()

      const modelTrigger = container.querySelector('[aria-label="Compaction model"]')
      expect(modelTrigger).toBeTruthy()
      flushSync(() => {
        fireEvent.pointerDown(modelTrigger!, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      })
      await waitFor(() => expect(getByRole(document.body, 'option', { name: 'GPT-5.6 Sol' })).toBeTruthy())
      flushSync(() => {
        fireEvent.click(getByRole(document.body, 'option', { name: 'GPT-5.6 Sol' }))
      })

      let reasoningTrigger = getByRole(container, 'combobox', { name: 'Compaction reasoning level' })
      flushSync(() => {
        fireEvent.pointerDown(reasoningTrigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      })
      await waitFor(() => expect(getByRole(document.body, 'option', { name: 'Extra High' })).toBeTruthy())
      expect(getAllByRole(document.body, 'option').map((option) => option.textContent?.trim() ?? '')).toEqual([
        'Low',
        'Medium',
        'High',
        'Extra High',
        'Max',
        'Ultra',
      ])
      flushSync(() => {
        fireEvent.click(getByRole(document.body, 'option', { name: 'Extra High' }))
      })
      await waitFor(() => expect(reasoningTrigger.textContent).toContain('Extra High'))

      flushSync(() => {
        fireEvent.pointerDown(modelTrigger!, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      })
      await waitFor(() => expect(getByRole(document.body, 'option', { name: 'GPT-5.6 Terra' })).toBeTruthy())
      flushSync(() => {
        fireEvent.click(getByRole(document.body, 'option', { name: 'GPT-5.6 Terra' }))
      })

      await waitFor(() => expect(getByRole(container, 'combobox', { name: 'Compaction reasoning level' }).textContent).toContain('High'))

      reasoningTrigger = getByRole(container, 'combobox', { name: 'Compaction reasoning level' })
      flushSync(() => {
        fireEvent.pointerDown(reasoningTrigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      })
      await waitFor(() => expect(getByRole(document.body, 'option', { name: 'Extra High' })).toBeTruthy())
      expect(getAllByRole(document.body, 'option').map((option) => option.textContent?.trim() ?? '')).toEqual([
        'Low',
        'Medium',
        'High',
        'Extra High',
        'Max',
        'Ultra',
      ])
      flushSync(() => {
        fireEvent.click(getByRole(document.body, 'option', { name: 'Max' }))
      })

      flushSync(() => {
        fireEvent.pointerDown(modelTrigger!, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      })
      await waitFor(() => expect(getByRole(document.body, 'option', { name: 'GPT-5.6 Luna' })).toBeTruthy())
      flushSync(() => {
        fireEvent.click(getByRole(document.body, 'option', { name: 'GPT-5.6 Luna' }))
      })

      reasoningTrigger = getByRole(container, 'combobox', { name: 'Compaction reasoning level' })
      flushSync(() => {
        fireEvent.pointerDown(reasoningTrigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      })
      await waitFor(() => expect(getByRole(document.body, 'option', { name: 'Extra High' })).toBeTruthy())
      expect(getAllByRole(document.body, 'option').map((option) => option.textContent?.trim() ?? '')).toEqual([
        'Low',
        'Medium',
        'High',
        'Extra High',
        'Max',
      ])
    })

    it('shows a warning when the configured compaction provider is unavailable', async () => {
      compactionApiMock.fetchCompactionSettings.mockResolvedValueOnce({
        settings: {
          model: { provider: 'openai-codex', modelId: 'gpt-5.5' },
          reasoningLevel: 'low',
          timeoutMs: 300_000,
          updatedAt: null,
        },
        availability: {
          providerConfigured: false,
          modelValid: true,
          reasoningSupported: true,
        },
        defaults: {
          model: { provider: 'openai-codex', modelId: 'gpt-5.5' },
          reasoningLevel: 'low',
          timeoutMs: 300_000,
          updatedAt: null,
        },
        constraints: {
          timeoutMs: { min: 60_000, max: 900_000, default: 300_000 },
        },
      })

      renderGeneral()
      await flush()
      await flush()

      expect(container.textContent).toContain('The configured compaction provider is not available right now.')
    })
  })

  /* ---- Cortex consolidation (auto-review API) ---- */

  describe('cortex consolidation', () => {
    it('renders consolidation toggle with Knowledge v2 language', async () => {
      renderGeneral()
      await flush()
      await flush()

      expect(container.textContent).toContain('Automatic Consolidation')
      expect(container.textContent).toContain('merges, archives, and reindexes knowledge entries')
      expect(container.textContent).not.toContain('Automatic Reviews')
      expect(container.textContent).not.toContain('reviews active sessions')
      expect(container.textContent).not.toContain('memory, and reference docs')
    })

    it('shows fixed 24-hour cadence without unsupported interval options', async () => {
      renderGeneral()
      await flush()
      await flush()

      expect(container.textContent).toContain('Consolidation Cadence')
      expect(container.textContent).toContain('Every 24 hours')
      expect(container.textContent).not.toContain('Review Interval')
      expect(container.textContent).not.toContain('Every 15 minutes')
      expect(container.textContent).not.toContain('Every 30 minutes')
      expect(container.textContent).not.toContain('Every 2 hours')
      expect(container.textContent).not.toContain('Every 12 hours')
      expect(container.querySelector('[data-testid="cortex-consolidation-cadence"]')?.textContent).toBe(
        'Every 24 hours',
      )
      expect(cortexApiMock.updateCortexAutoReviewSettings).not.toHaveBeenCalled()
    })

    it('does not PUT unsupported intervalMinutes from the Settings UI', async () => {
      renderGeneral()
      await flush()
      await flush()

      const intervalPuts = cortexApiMock.updateCortexAutoReviewSettings.mock.calls.filter(
        (call: unknown[]) =>
          Boolean(call[1] && typeof call[1] === 'object' && call[1] !== null && 'intervalMinutes' in call[1]),
      )
      expect(intervalPuts).toEqual([])
    })

    it('hides Cortex section when cortex is disabled', async () => {
      cortexApiMock.fetchCortexAutoReviewSettings.mockResolvedValue({
        settings: { enabled: false, intervalMinutes: 1440 },
        cortexDisabled: true,
      })
      renderGeneral()
      await flush()
      await flush()

      expect(container.textContent).not.toContain('Automatic Consolidation')
      expect(container.textContent).not.toContain('Automatic Reviews')
    })
  })

  /* ---- Knowledge v2 (New Cortex) toggle ---- */

  describe('new cortex (knowledge v2) toggle', () => {
    it('renders the toggle reflecting the fetched enabled=false state', async () => {
      renderGeneral()
      await flush()
      await flush()

      expect(container.textContent).toContain('New Cortex (Knowledge v2)')
      const toggle = container.querySelector('#knowledge-v2-enabled-toggle')
      expect(toggle).toBeTruthy()
      expect(toggle?.getAttribute('aria-checked')).toBe('false')
    })

    it('shows migration guidance and does not PUT when activation is unavailable', async () => {
      knowledgeV2ApiMock.fetchKnowledgeV2Settings.mockResolvedValue({
        available: true,
        response: knowledgeV2SettingsView(false, false),
      })
      renderGeneral()
      await flush()
      await flush()

      const toggle = container.querySelector('#knowledge-v2-enabled-toggle') as HTMLInputElement | null
      expect(toggle).toBeTruthy()
      expect(container.textContent).toContain('Migration required')
      flushSync(() => fireEvent.click(toggle!))
      await flush()
      expect(knowledgeV2ApiMock.updateKnowledgeV2Settings).not.toHaveBeenCalled()
    })

    it('clears and ignores stale activation capability when the backend source changes', async () => {
      let resolveFirst!: (value: unknown) => void
      const first = new Promise((resolve) => { resolveFirst = resolve })
      knowledgeV2ApiMock.fetchKnowledgeV2Settings
        .mockReturnValueOnce(first)
        .mockResolvedValueOnce({ available: true, response: knowledgeV2SettingsView(false, false) })

      root = createRoot(container)
      flushSync(() => root?.render(createElement(SettingsGeneral, { wsUrl: 'ws://first' })))
      flushSync(() => root?.render(createElement(SettingsGeneral, { wsUrl: 'ws://second' })))
      await flush()
      resolveFirst({ available: true, response: knowledgeV2SettingsView(false, true) })
      await flush()

      expect(container.textContent).toContain('Migration required')
      const toggle = container.querySelector('#knowledge-v2-enabled-toggle') as HTMLInputElement | null
      flushSync(() => fireEvent.click(toggle!))
      await flush()
      expect(knowledgeV2ApiMock.updateKnowledgeV2Settings).not.toHaveBeenCalled()
    })

    it('writes enabled=true via PUT when migration is complete', async () => {
      renderGeneral()
      await flush()
      await flush()

      const toggle = container.querySelector('#knowledge-v2-enabled-toggle') as HTMLInputElement | null
      expect(toggle).toBeTruthy()

      flushSync(() => {
        fireEvent.click(toggle!)
      })
      await flush()

      expect(knowledgeV2ApiMock.updateKnowledgeV2Settings).toHaveBeenCalledWith(
        expect.anything(),
        { enabled: true },
      )
      await flush()
      const toggleAfter = container.querySelector('#knowledge-v2-enabled-toggle')
      expect(toggleAfter?.getAttribute('aria-checked')).toBe('true')
      expect(container.textContent).not.toContain('Migration required')
    })

    it('allows turning off even when activation capability is unavailable', async () => {
      knowledgeV2ApiMock.fetchKnowledgeV2Settings.mockResolvedValue({
        available: true,
        response: knowledgeV2SettingsView(true, false),
      })
      renderGeneral()
      await flush()
      await flush()

      const toggle = container.querySelector('#knowledge-v2-enabled-toggle') as HTMLInputElement | null
      flushSync(() => fireEvent.click(toggle!))
      await flush()
      expect(knowledgeV2ApiMock.updateKnowledgeV2Settings).toHaveBeenCalledWith(
        expect.anything(),
        { enabled: false },
      )
    })

    it('shows a disabled error row on network/server failure', async () => {
      knowledgeV2ApiMock.fetchKnowledgeV2Settings.mockRejectedValue(new Error('backend offline'))
      renderGeneral()
      await flush()
      await flush()

      expect(container.textContent).toContain('New Cortex (Knowledge v2)')
      expect(container.textContent).toContain('backend offline')
      expect(container.querySelector('#knowledge-v2-enabled-toggle')).toBeTruthy()
    })

    it('hides the toggle when the knowledge-v2 endpoint is unavailable (404)', async () => {
      knowledgeV2ApiMock.fetchKnowledgeV2Settings.mockResolvedValue({ available: false })
      renderGeneral()
      await flush()
      await flush()

      expect(container.textContent).not.toContain('New Cortex (Knowledge v2)')
      expect(container.querySelector('#knowledge-v2-enabled-toggle')).toBeFalsy()
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

  it('hides prompt cache visualization and does not load builder-only setting in collab mode', async () => {
    renderCollab()
    await flush()
    await flush()

    expect(container.textContent).not.toContain('Prompt Cache Visualization')
    expect(container.textContent).not.toContain('Enable prompt cache visualization')
    expect(modelCacheVisualizationApiMock.fetchModelCacheVisualizationEnabled).not.toHaveBeenCalled()
    expect(modelCacheVisualizationApiMock.setModelCacheVisualizationEnabledApi).not.toHaveBeenCalled()
  })

  it('hides compaction settings and does not load builder-only compaction APIs in collab mode', async () => {
    renderCollab()
    await flush()
    await flush()

    expect(container.textContent).not.toContain('Compaction model')
    expect(container.textContent).not.toContain('Compaction timeout')
    expect(compactionApiMock.fetchCompactionSettings).not.toHaveBeenCalled()
    expect(modelPresetMock.fetchModelPresets).not.toHaveBeenCalled()
  })

  it('hides Repositories and does not hit repository settings routes in collab mode', async () => {
    renderCollab()
    await flush()
    await flush()

    expect(container.textContent).not.toContain('Repositories')
    expect(container.textContent).not.toContain('Configured repository home')
    expect(repositoryApiMock.fetchRepositorySettings).not.toHaveBeenCalled()
  })

  it('still renders Cortex settings in collab mode', async () => {
    renderCollab()
    await flush()
    await flush()

    expect(container.textContent).toContain('Automatic Consolidation')
    expect(container.textContent).toContain('Every 24 hours')
    expect(container.textContent).not.toContain('Automatic Reviews')
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

  /* ---- Collab reboot confirmation ---- */

  function makeCollabClient() {
    return {
      target: {
        kind: 'collab' as const,
        label: 'Collab',
        description: 'Remote',
        wsUrl: 'wss://collab.example.com',
        apiBaseUrl: 'https://collab.example.com/',
        fetchCredentials: 'include' as const,
        requiresAdmin: true,
        availableTabs: ['general' as const, 'auth' as const, 'models' as const, 'about' as const],
      },
      endpoint: (path: string) => `https://collab.example.com${path}`,
      fetch: vi.fn().mockResolvedValue({ ok: true }),
      fetchJson: vi.fn(),
      readApiError: vi.fn(),
    }
  }

  function renderCollabWithClient(client: ReturnType<typeof makeCollabClient>): void {
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(SettingsGeneral, {
          wsUrl: 'wss://collab.example.com',
          target: client.target,
          apiClient: client,
        }),
      )
    })
  }

  it('shows confirmation dialog before collab reboot (does not fire immediately)', async () => {
    const client = makeCollabClient()
    renderCollabWithClient(client)
    await flush()

    // Click the Reboot button
    const rebootBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Reboot'),
    )
    expect(rebootBtn).toBeTruthy()

    flushSync(() => {
      fireEvent.click(rebootBtn!)
    })
    await flush()

    // Confirmation dialog should appear in the document (portal)
    expect(document.body.textContent).toContain('Reboot remote backend?')

    // No fetch yet — waiting for confirmation
    expect(client.fetch).not.toHaveBeenCalled()
  })

  it('executes reboot after confirming the collab confirmation dialog', async () => {
    const client = makeCollabClient()
    renderCollabWithClient(client)
    await flush()

    // Open confirmation dialog
    const rebootBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Reboot'),
    )
    flushSync(() => {
      fireEvent.click(rebootBtn!)
    })
    await flush()

    // Find and click the confirm action in the dialog (second "Reboot" button)
    const allButtons = Array.from(document.body.querySelectorAll('button'))
    const confirmBtn = allButtons.find(
      (btn) => btn.textContent === 'Reboot' && btn !== rebootBtn,
    )
    expect(confirmBtn).toBeTruthy()

    flushSync(() => {
      fireEvent.click(confirmBtn!)
    })
    await flush()

    expect(client.fetch).toHaveBeenCalledWith('/api/reboot', { method: 'POST' })
  })

  it('does not reboot when collab confirmation is cancelled', async () => {
    const client = makeCollabClient()
    renderCollabWithClient(client)
    await flush()

    // Open confirmation dialog
    const rebootBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Reboot'),
    )
    flushSync(() => {
      fireEvent.click(rebootBtn!)
    })
    await flush()

    // Find and click the Cancel button
    const cancelBtn = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Cancel',
    )
    expect(cancelBtn).toBeTruthy()

    flushSync(() => {
      fireEvent.click(cancelBtn!)
    })
    await flush()

    expect(client.fetch).not.toHaveBeenCalled()
  })

  it('Builder reboot fires immediately without confirmation', async () => {
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

    // Builder fires immediately — no confirmation dialog
    expect(document.body.textContent).not.toContain('Reboot remote backend?')
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:47187/api/reboot',
      expect.objectContaining({ method: 'POST' }),
    )

    vi.unstubAllGlobals()
  })

  it('renders prompt cache visualization toggle defaulting off', async () => {
    renderGeneral()
    await flush()

    expect(container.textContent).toContain('Enable prompt cache visualization')
    expect(container.querySelector('#model-cache-visualization-enabled-toggle')).toBeTruthy()
    expect(modelCacheVisualizationApiMock.fetchModelCacheVisualizationEnabled).toHaveBeenCalled()

    const toggle = container.querySelector('#model-cache-visualization-enabled-toggle') as HTMLInputElement | null
    expect(toggle?.getAttribute('aria-checked')).toBe('false')
  })

  it('renders conversation throughput off by default and persists an immediate change', async () => {
    renderGeneral()
    await flush()

    expect(container.textContent).toContain('Show response throughput in conversations')
    expect(container.textContent).toContain('Stats → Response throughput continues collecting history')
    const toggle = container.querySelector('#conversation-throughput-display-toggle') as HTMLInputElement | null
    expect(toggle?.getAttribute('aria-checked')).toBe('false')

    flushSync(() => {
      fireEvent.click(toggle!)
    })
    await flush()

    expect(sidebarPrefsMock.storeConversationThroughputDisplayPref).toHaveBeenCalledWith(true)
  })

  it('updates prompt cache visualization via PUT when toggled on', async () => {
    renderGeneral()
    await flush()

    const toggle = container.querySelector('#model-cache-visualization-enabled-toggle') as HTMLInputElement | null
    expect(toggle).toBeTruthy()

    flushSync(() => {
      fireEvent.click(toggle!)
    })
    await flush()

    expect(modelCacheVisualizationApiMock.setModelCacheVisualizationEnabledApi).toHaveBeenCalledWith(
      expect.any(String),
      true,
    )
  })
})

describe('SettingsGeneral — builder target repositories', () => {
  function renderBuilder(): void {
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(SettingsGeneral, {
          wsUrl: 'ws://127.0.0.1:47187',
          target: {
            kind: 'builder',
            label: 'Local Builder',
            description: 'Local backend.',
            wsUrl: 'ws://127.0.0.1:47187',
            apiBaseUrl: 'http://127.0.0.1:47187/',
            fetchCredentials: 'same-origin',
            requiresAdmin: false,
            availableTabs: ['general', 'auth', 'models', 'about'],
          },
        }),
      )
    })
  }

  it('loads and renders Repositories for an explicit builder target', async () => {
    renderBuilder()
    await flush()
    await flush()

    expect(container.textContent).toContain('Repositories')
    expect(container.textContent).toContain('Configured repository home')
    expect(repositoryApiMock.fetchRepositorySettings).toHaveBeenCalled()
  })

  it('hides Repositories when repositoryCloneAvailable is false on a builder target (direct collab)', async () => {
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(SettingsGeneral, {
          wsUrl: 'ws://127.0.0.1:47187',
          repositoryCloneAvailable: false,
          target: {
            kind: 'builder',
            label: 'Hosted collab builder',
            description: 'Direct collaboration server builder shell.',
            wsUrl: 'ws://127.0.0.1:47187',
            apiBaseUrl: 'http://127.0.0.1:47187/',
            fetchCredentials: 'same-origin',
            requiresAdmin: false,
            availableTabs: ['general', 'auth', 'models', 'about'],
          },
        }),
      )
    })
    await flush()
    await flush()

    expect(container.textContent).not.toContain('Repositories')
    expect(container.textContent).not.toContain('Configured repository home')
    expect(repositoryApiMock.fetchRepositorySettings).not.toHaveBeenCalled()
  })
})
