/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsTab, SettingsBackendTarget } from '@/components/settings/settings-target'

// Track SettingsLayout props received by SettingsPanel
let capturedActiveTab: SettingsTab | undefined
let capturedContentWidthClassName: string | undefined
let capturedGeneralProps: Record<string, unknown> | undefined
let capturedSecretsProps: Record<string, unknown> | undefined
let capturedProjectSettingsProps: Record<string, unknown> | undefined

vi.mock('@/components/settings/SettingsLayout', () => ({
  SettingsLayout: (props: { activeTab: SettingsTab; onTabChange: (tab: SettingsTab) => void; contentWidthClassName?: string; children: React.ReactNode }) => {
    capturedActiveTab = props.activeTab
    capturedContentWidthClassName = props.contentWidthClassName
    return createElement('div', { 'data-testid': 'settings-layout', 'data-active-tab': props.activeTab }, props.children)
  },
}))

// Mock all individual settings panes to avoid their dependencies
vi.mock('@/components/settings/SettingsGeneral', () => ({
  SettingsGeneral: (props: Record<string, unknown>) => {
    capturedGeneralProps = props
    return createElement('div', {
      'data-testid': 'settings-general',
      'data-repo-clone': String(props.repositoryCloneAvailable),
    }, 'General')
  },
}))
vi.mock('@/components/settings/SettingsAppearance', () => ({ SettingsAppearance: () => createElement('div', null, 'Appearance') }))
vi.mock('@/components/settings/SettingsNotifications', () => ({ SettingsNotifications: () => createElement('div', null, 'Notifications') }))
vi.mock('@/components/settings/SettingsAuth', () => ({ SettingsAuth: () => createElement('div', null, 'Auth') }))
vi.mock('@/components/settings/SettingsSecrets', () => ({
  SettingsSecrets: (props: Record<string, unknown>) => {
    capturedSecretsProps = props
    return createElement('div', null, 'Secrets')
  },
}))
vi.mock('@/components/settings/SettingsModels', () => ({ SettingsModels: () => createElement('div', null, 'Models') }))
vi.mock('@/components/settings/SettingsProjectResources', () => ({ SettingsProjectResources: () => createElement('div', null, 'Repository resources') }))
vi.mock('@/components/settings/SettingsProjectSettings', () => ({
  SettingsProjectSettings: (props: Record<string, unknown>) => {
    capturedProjectSettingsProps = props
    return createElement('div', null, 'Project Settings')
  },
}))
vi.mock('@/components/settings/SettingsSkills', () => ({ SettingsSkills: () => createElement('div', null, 'Skills') }))
vi.mock('@/components/settings/SettingsPrompts', () => ({ SettingsPrompts: () => createElement('div', null, 'Prompts') }))
vi.mock('@/components/settings/SettingsSpecialists', () => ({ SettingsSpecialists: () => createElement('div', null, 'Specialists') }))
vi.mock('@/components/settings/SettingsSlashCommands', () => ({ SettingsSlashCommands: () => createElement('div', null, 'Slash Commands') }))
vi.mock('@/components/settings/SettingsExtensions', () => ({ SettingsExtensions: () => createElement('div', null, 'Extensions') }))
vi.mock('@/components/settings/SettingsCollaboration', () => ({ SettingsCollaboration: () => createElement('div', null, 'Collaboration') }))
vi.mock('@/components/settings/SettingsAbout', () => ({ SettingsAbout: () => createElement('div', null, 'About') }))

const { SettingsPanel } = await import('./SettingsDialog')

const BUILDER_TARGET: SettingsBackendTarget = {
  kind: 'builder',
  label: 'Builder backend',
  description: 'Local Forge Builder backend.',
  wsUrl: 'ws://localhost:47187',
  apiBaseUrl: 'http://localhost:47187',
  fetchCredentials: 'same-origin',
  requiresAdmin: false,
  availableTabs: [
    'general', 'appearance', 'notifications', 'auth', 'secrets', 'models',
    'skills', 'prompts', 'specialists', 'slash-commands', 'extensions',
    'collaboration', 'about',
  ],
}

const COLLAB_TARGET: SettingsBackendTarget = {
  kind: 'collab',
  label: 'Collab backend',
  description: 'Remote collab backend.',
  wsUrl: 'wss://collab.example.com',
  apiBaseUrl: 'https://collab.example.com',
  fetchCredentials: 'include',
  requiresAdmin: true,
  availableTabs: [
    'general', 'appearance', 'auth', 'models',
    'skills', 'prompts', 'specialists', 'slash-commands', 'extensions',
    'collaboration', 'about',
  ],
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  capturedActiveTab = undefined
  capturedContentWidthClassName = undefined
  capturedGeneralProps = undefined
  capturedSecretsProps = undefined
  capturedProjectSettingsProps = undefined
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  container.remove()
})

function makeProps(overrides: {
  initialTab?: string
  target?: SettingsBackendTarget
  repositoryCloneAvailable?: boolean
  contextProfileId?: string
  previewSession?: { agentId: string; profileId: string } | null
  profiles?: any[]
  managers?: any[]
}) {
  return {
    wsUrl: 'ws://localhost:47187',
    managers: overrides.managers ?? [],
    profiles: overrides.profiles ?? [],
    promptChangeKey: 0,
    specialistChangeKey: 0,
    modelConfigChangeKey: 0,
    target: overrides.target ?? BUILDER_TARGET,
    initialTab: overrides.initialTab,
    contextProfileId: overrides.contextProfileId,
    previewSession: overrides.previewSession,
    ...(overrides.repositoryCloneAvailable !== undefined
      ? { repositoryCloneAvailable: overrides.repositoryCloneAvailable }
      : {}),
  }
}

function renderPanel(props: {
  initialTab?: string
  target?: SettingsBackendTarget
  repositoryCloneAvailable?: boolean
  contextProfileId?: string
  previewSession?: { agentId: string; profileId: string } | null
  profiles?: any[]
  managers?: any[]
}) {
  act(() => {
    root = createRoot(container)
    root.render(createElement(SettingsPanel, makeProps(props)))
  })
}

function rerenderPanel(props: {
  initialTab?: string
  target?: SettingsBackendTarget
  repositoryCloneAvailable?: boolean
  contextProfileId?: string
  previewSession?: { agentId: string; profileId: string } | null
  profiles?: any[]
  managers?: any[]
}) {
  act(() => {
    root?.render(createElement(SettingsPanel, makeProps(props)))
  })
}

describe('SettingsPanel initialTab', () => {
  it('defaults to general when no initialTab is provided', () => {
    renderPanel({})
    expect(capturedActiveTab).toBe('general')
    expect(capturedContentWidthClassName).toBeUndefined()
  })

  it('uses initialTab on mount when it is a valid tab', () => {
    renderPanel({ initialTab: 'collaboration' })
    expect(capturedActiveTab).toBe('collaboration')
  })

  it('uses contextual project identity for Secrets without replacing task preview context', () => {
    renderPanel({
      initialTab: 'secrets',
      contextProfileId: 'project-beta',
      previewSession: {
        agentId: 'session-with-draft',
        profileId: 'project-alpha',
      },
    })

    expect(capturedActiveTab).toBe('secrets')
    expect(capturedSecretsProps?.currentProfileId).toBe('project-beta')
  })

  it('renders the project settings surface for the route-selected project', () => {
    renderPanel({
      initialTab: 'project-settings',
      contextProfileId: 'project-beta',
      previewSession: { agentId: 'session-alpha', profileId: 'project-alpha' },
      profiles: [{
        profileId: 'project-beta',
        displayName: 'Project Beta',
        defaultSessionAgentId: 'session-beta',
        defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' },
      }],
      managers: [{ agentId: 'session-beta', profileId: 'project-beta', role: 'manager', cwd: '/project-beta' }],
    })

    expect(capturedActiveTab).toBe('project-settings')
    expect((capturedProjectSettingsProps?.profile as { profileId: string }).profileId).toBe('project-beta')
    expect((capturedProjectSettingsProps?.manager as { agentId: string }).agentId).toBe('session-beta')
  })

  it('uses a wider content width for the appearance tab', () => {
    renderPanel({ initialTab: 'appearance' })
    expect(capturedActiveTab).toBe('appearance')
    expect(capturedContentWidthClassName).toBe('max-w-6xl')
  })

  it('preserves full-width content for the skills tab', () => {
    renderPanel({ initialTab: 'skills' })
    expect(capturedActiveTab).toBe('skills')
    expect(capturedContentWidthClassName).toBe('max-w-full')
  })

  it('syncs activeTab when initialTab prop changes while mounted', () => {
    renderPanel({ initialTab: 'general' })
    expect(capturedActiveTab).toBe('general')

    rerenderPanel({ initialTab: 'collaboration' })
    expect(capturedActiveTab).toBe('collaboration')
  })

  it('syncs activeTab from undefined to a valid tab', () => {
    renderPanel({})
    expect(capturedActiveTab).toBe('general')

    rerenderPanel({ initialTab: 'auth' })
    expect(capturedActiveTab).toBe('auth')
  })

  it('ignores initialTab change when tab is not in availableTabs', () => {
    renderPanel({ initialTab: 'general', target: COLLAB_TARGET })
    expect(capturedActiveTab).toBe('general')

    // 'notifications' is not in COLLAB_TARGET.availableTabs
    rerenderPanel({ initialTab: 'notifications', target: COLLAB_TARGET })
    // Should stay on general (invalid tab ignored)
    expect(capturedActiveTab).toBe('general')
  })

  it('repairs to first available tab when activeTab is not in availableTabs', () => {
    renderPanel({ initialTab: 'notifications', target: BUILDER_TARGET })
    expect(capturedActiveTab).toBe('notifications')

    // Switch to collab target where notifications is unavailable
    rerenderPanel({ initialTab: 'notifications', target: COLLAB_TARGET })
    // Should repair to first collab tab
    expect(capturedActiveTab).toBe('general')
  })
})

describe('SettingsPanel repositoryCloneAvailable derivation', () => {
  it('enables repository settings for builder when prop is omitted', () => {
    renderPanel({ target: BUILDER_TARGET })
    expect(capturedGeneralProps?.repositoryCloneAvailable).toBe(true)
  })

  it('enables repository settings for builder when prop is true', () => {
    renderPanel({ target: BUILDER_TARGET, repositoryCloneAvailable: true })
    expect(capturedGeneralProps?.repositoryCloneAvailable).toBe(true)
  })

  it('disables repository settings for builder when prop is explicit false', () => {
    renderPanel({ target: BUILDER_TARGET, repositoryCloneAvailable: false })
    expect(capturedGeneralProps?.repositoryCloneAvailable).toBe(false)
  })

  it('always disables repository settings for collab target even when prop omitted or true', () => {
    renderPanel({ target: COLLAB_TARGET })
    expect(capturedGeneralProps?.repositoryCloneAvailable).toBe(false)

    rerenderPanel({ target: COLLAB_TARGET, repositoryCloneAvailable: true })
    expect(capturedGeneralProps?.repositoryCloneAvailable).toBe(false)
  })
})
