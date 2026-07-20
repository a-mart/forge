/** @vitest-environment jsdom */

import { fireEvent, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/help/help-hooks', () => ({
  useHelpContext: () => {},
}))

vi.mock('@/components/help/HelpTooltip', () => ({
  HelpTooltip: ({ children }: { children: unknown }) => children,
}))

vi.mock('@/components/chat/cortex/OnboardingCallout', () => ({
  OnboardingCallout: () => null,
}))

vi.mock('@/hooks/use-onboarding-state', () => ({
  useOnboardingState: () => ({
    onboardingState: null,
    isMutating: false,
    error: null,
    savePreferences: vi.fn(),
  }),
}))

vi.mock('@/lib/sidebar-prefs', () => ({
  readSidebarModelIconsPref: () => true,
  readSidebarProviderUsagePref: () => true,
  storeSidebarModelIconsPref: vi.fn(),
  storeSidebarProviderUsagePref: vi.fn(),
}))

vi.mock('@/lib/editor-preference', () => ({
  EDITOR_LABELS: { vscode: 'VS Code', cursor: 'Cursor' },
  readStoredEditorPreference: () => 'vscode',
  storeEditorPreference: vi.fn(),
}))

vi.mock('@/lib/electron-bridge', () => ({
  isElectron: () => false,
}))

vi.mock('@/lib/api-endpoint', () => ({
  resolveApiEndpoint: (_ws: string, path: string) => `http://127.0.0.1:47187${path}`,
}))

const repositoryApiMock = vi.hoisted(() => ({
  fetchRepositorySettings: vi.fn(),
  updateRepositorySettings: vi.fn(),
}))

vi.mock('@/components/settings/repository-settings-api', () => ({
  fetchRepositorySettings: (...args: unknown[]) => repositoryApiMock.fetchRepositorySettings(...args),
  updateRepositorySettings: (...args: unknown[]) => repositoryApiMock.updateRepositorySettings(...args),
}))

vi.mock('@/components/settings/cortex-auto-review-api', () => ({
  fetchCortexAutoReviewSettings: vi.fn().mockResolvedValue({
    settings: { enabled: false, intervalMinutes: 120 },
    cortexDisabled: false,
  }),
  updateCortexAutoReviewSettings: vi.fn(),
}))

vi.mock('@/components/settings/knowledge-v2-api', () => ({
  fetchKnowledgeV2Settings: vi.fn().mockResolvedValue({ available: false }),
  updateKnowledgeV2Settings: vi.fn(),
}))

vi.mock('@/components/settings/model-cache-visualization-api', () => ({
  fetchModelCacheVisualizationEnabled: vi.fn().mockResolvedValue(false),
  setModelCacheVisualizationEnabledApi: vi.fn(),
}))

vi.mock('@/components/settings/terminal-shell-api', () => ({
  fetchAvailableShells: vi.fn().mockResolvedValue({ shells: [], settings: { persistedDefaultShell: null, effectiveShell: null, source: 'auto' } }),
  updateTerminalShellSettings: vi.fn(),
}))

vi.mock('@/components/settings/compaction-settings-api', () => ({
  fetchCompactionSettings: vi.fn().mockResolvedValue(null),
  updateCompactionSettings: vi.fn(),
}))

vi.mock('@/lib/model-preset', () => ({
  fetchModelPresets: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/components/settings/SettingsLayout', () => ({
  SettingsLayout: (props: { children: unknown }) =>
    createElement('div', { 'data-testid': 'settings-layout' }, props.children as never),
}))

vi.mock('@/components/settings/SettingsAppearance', () => ({ SettingsAppearance: () => null }))
vi.mock('@/components/settings/SettingsNotifications', () => ({ SettingsNotifications: () => null }))
vi.mock('@/components/settings/SettingsAuth', () => ({ SettingsAuth: () => null }))
vi.mock('@/components/settings/SettingsModels', () => ({ SettingsModels: () => null }))
vi.mock('@/components/settings/SettingsSkills', () => ({ SettingsSkills: () => null }))
vi.mock('@/components/settings/SettingsPrompts', () => ({ SettingsPrompts: () => null }))
vi.mock('@/components/settings/SettingsSpecialists', () => ({ SettingsSpecialists: () => null }))
vi.mock('@/components/settings/SettingsSlashCommands', () => ({ SettingsSlashCommands: () => null }))
vi.mock('@/components/settings/SettingsExtensions', () => ({ SettingsExtensions: () => null }))
vi.mock('@/components/settings/SettingsCollaboration', () => ({ SettingsCollaboration: () => null }))
vi.mock('@/components/settings/SettingsAbout', () => ({ SettingsAbout: () => null }))
vi.mock('@/components/settings/SettingsCliAccess', () => ({ SettingsCliAccess: () => null }))
vi.mock('@/components/settings/SettingsObservability', () => ({ SettingsObservability: () => null }))
vi.mock('@/components/settings/SettingsProjectResources', () => ({ SettingsProjectResources: () => null }))

const { SettingsPanel } = await import('./SettingsDialog')

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  repositoryApiMock.fetchRepositorySettings.mockResolvedValue({
    configuredHome: null,
    lastUsedBasePath: null,
    effectiveBasePath: '/tmp/home',
    source: 'default',
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
  flushSync(() => {})
}

describe('SettingsPanel + SettingsGeneral repository clone composition', () => {
  it('hides Repositories and does not fetch for collab target when prop omitted', async () => {
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(SettingsPanel, {
          wsUrl: 'wss://collab.example.com',
          managers: [],
          profiles: [],
          promptChangeKey: 0,
          specialistChangeKey: 0,
          modelConfigChangeKey: 0,
          target: {
            kind: 'collab',
            label: 'Collab',
            description: 'Remote',
            wsUrl: 'wss://collab.example.com',
            apiBaseUrl: 'https://collab.example.com/',
            fetchCredentials: 'include',
            requiresAdmin: true,
            availableTabs: ['general', 'auth', 'about'],
          },
        }),
      )
    })
    await flush()
    await flush()

    expect(container.textContent).not.toContain('Repositories')
    expect(repositoryApiMock.fetchRepositorySettings).not.toHaveBeenCalled()
  })

  it('loads Repositories for builder when repositoryCloneAvailable is true', async () => {
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(SettingsPanel, {
          wsUrl: 'ws://127.0.0.1:47187',
          managers: [],
          profiles: [],
          promptChangeKey: 0,
          specialistChangeKey: 0,
          modelConfigChangeKey: 0,
          repositoryCloneAvailable: true,
          target: {
            kind: 'builder',
            label: 'Builder',
            description: 'Local',
            wsUrl: 'ws://127.0.0.1:47187',
            apiBaseUrl: 'http://127.0.0.1:47187/',
            fetchCredentials: 'same-origin',
            requiresAdmin: false,
            availableTabs: ['general', 'auth', 'about'],
          },
        }),
      )
    })
    await flush()
    await waitFor(() => {
      expect(container.textContent).toContain('Repositories')
    })
    expect(repositoryApiMock.fetchRepositorySettings).toHaveBeenCalled()
  })
})

void fireEvent
