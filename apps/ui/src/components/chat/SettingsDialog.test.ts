/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsTab, SettingsBackendTarget } from '@/components/settings/settings-target'

// Track activeTab values received by SettingsLayout
let capturedActiveTab: SettingsTab | undefined

vi.mock('@/components/settings/SettingsLayout', () => ({
  SettingsLayout: (props: { activeTab: SettingsTab; onTabChange: (tab: SettingsTab) => void; children: React.ReactNode }) => {
    capturedActiveTab = props.activeTab
    return createElement('div', { 'data-testid': 'settings-layout', 'data-active-tab': props.activeTab }, props.children)
  },
}))

// Mock all individual settings panes to avoid their dependencies
vi.mock('@/components/settings/SettingsGeneral', () => ({ SettingsGeneral: () => createElement('div', null, 'General') }))
vi.mock('@/components/settings/SettingsAppearance', () => ({ SettingsAppearance: () => createElement('div', null, 'Appearance') }))
vi.mock('@/components/settings/SettingsNotifications', () => ({ SettingsNotifications: () => createElement('div', null, 'Notifications') }))
vi.mock('@/components/settings/SettingsAuth', () => ({ SettingsAuth: () => createElement('div', null, 'Auth') }))
vi.mock('@/components/settings/SettingsModels', () => ({ SettingsModels: () => createElement('div', null, 'Models') }))
vi.mock('@/components/settings/SettingsIntegrations', () => ({ SettingsIntegrations: () => createElement('div', null, 'Integrations') }))
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
    'general', 'appearance', 'notifications', 'auth', 'models', 'integrations',
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
    'general', 'appearance', 'auth', 'models', 'integrations',
    'skills', 'prompts', 'specialists', 'slash-commands', 'extensions',
    'collaboration', 'about',
  ],
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  capturedActiveTab = undefined
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

function makeProps(overrides: { initialTab?: string; target?: SettingsBackendTarget }) {
  return {
    wsUrl: 'ws://localhost:47187',
    managers: [] as any[],
    profiles: [] as any[],
    promptChangeKey: 0,
    specialistChangeKey: 0,
    modelConfigChangeKey: 0,
    target: overrides.target ?? BUILDER_TARGET,
    initialTab: overrides.initialTab,
  }
}

function renderPanel(props: { initialTab?: string; target?: SettingsBackendTarget }) {
  act(() => {
    root = createRoot(container)
    root.render(createElement(SettingsPanel, makeProps(props)))
  })
}

function rerenderPanel(props: { initialTab?: string; target?: SettingsBackendTarget }) {
  act(() => {
    root?.render(createElement(SettingsPanel, makeProps(props)))
  })
}

describe('SettingsPanel initialTab', () => {
  it('defaults to general when no initialTab is provided', () => {
    renderPanel({})
    expect(capturedActiveTab).toBe('general')
  })

  it('uses initialTab on mount when it is a valid tab', () => {
    renderPanel({ initialTab: 'collaboration' })
    expect(capturedActiveTab).toBe('collaboration')
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
