/** @vitest-environment jsdom */

import { getByText } from '@testing-library/dom'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from './settings-api-client'
import { SettingsProjectResources } from './SettingsProjectResources'

const projectResourcesApiMock = vi.hoisted(() => ({
  fetchProjectResourcesSnapshot: vi.fn(),
  updateProjectResourcesOverride: vi.fn(),
  updateProjectResourcesTrust: vi.fn(),
  activateRepoProjectAgent: vi.fn(),
}))

vi.mock('./project-resources-api', () => ({
  fetchProjectResourcesSnapshot: (...args: unknown[]) => projectResourcesApiMock.fetchProjectResourcesSnapshot(...args),
  updateProjectResourcesOverride: (...args: unknown[]) => projectResourcesApiMock.updateProjectResourcesOverride(...args),
  updateProjectResourcesTrust: (...args: unknown[]) => projectResourcesApiMock.updateProjectResourcesTrust(...args),
  activateRepoProjectAgent: (...args: unknown[]) => projectResourcesApiMock.activateRepoProjectAgent(...args),
}))

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

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushSync(() => {})
}

function makeBaseSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: '2026-05-19T00:00:00.000Z',
    profileId: 'profile-a',
    sessionAgentId: 'session-a',
    cwdRealpath: '/test/workspace',
    source: 'git-root',
    trust: { state: 'trusted', key: 'key-abc' },
    signature: 'abc123def456',
    scaffold: { canSeed: false, missing: [] },
    resources: {
      skills: { exists: true, count: 0, items: [] },
      specialists: { exists: true, count: 0, items: [] },
      reference: { exists: true, count: 0, items: [] },
      forgeExtensions: { exists: false, count: 0, items: [] },
      piExtensions: { exists: false, count: 0, items: [] },
      piSettings: { exists: false, count: 0, items: [] },
    },
    executableSurfaces: [],
    ...overrides,
  }
}

function renderComponent(snapshotOverrides: Record<string, unknown> = {}) {
  const snapshot = makeBaseSnapshot(snapshotOverrides)
  projectResourcesApiMock.fetchProjectResourcesSnapshot.mockResolvedValue(snapshot)

  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(SettingsProjectResources, {
      managers: [{ agentId: 'session-a', profileId: 'profile-a', role: 'manager', cwd: '/test/workspace' } as never],
      previewSession: { agentId: 'session-a', profileId: 'profile-a' },
      apiClient: { fetchJson: vi.fn() } as unknown as SettingsApiClient,
    }))
  })
  return snapshot
}

describe('SettingsProjectResources', () => {
  it('uses the explicit project context instead of the sticky session preview', async () => {
    projectResourcesApiMock.fetchProjectResourcesSnapshot.mockResolvedValue(makeBaseSnapshot({
      profileId: 'project-beta',
      sessionAgentId: 'session-beta',
    }))

    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(SettingsProjectResources, {
        managers: [{ agentId: 'session-alpha', profileId: 'project-alpha', role: 'manager' } as never],
        previewSession: { agentId: 'session-alpha', profileId: 'project-alpha' },
        projectContext: { profileId: 'project-beta', sessionAgentId: 'session-beta' },
        apiClient: { fetchJson: vi.fn() } as unknown as SettingsApiClient,
      }))
    })
    await flushPromises()

    expect(projectResourcesApiMock.fetchProjectResourcesSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      { profileId: 'project-beta', sessionAgentId: 'session-beta' },
    )
  })

  it('renders degraded repository warnings prominently', async () => {
    projectResourcesApiMock.fetchProjectResourcesSnapshot.mockResolvedValue({
      generatedAt: '2026-05-19T00:00:00.000Z',
      profileId: 'profile-a',
      sessionAgentId: 'session-a',
      cwdRealpath: '/missing/workspace',
      warning: 'Session working directory is unavailable: path does not exist',
      source: 'none',
      trust: { state: 'not_applicable' },
      signature: 'abc123',
      resources: {
        skills: { exists: false, count: 0, items: [] },
        specialists: { exists: false, count: 0, items: [] },
        reference: { exists: false, count: 0, items: [] },
        forgeExtensions: { exists: false, count: 0, items: [] },
        piExtensions: { exists: false, count: 0, items: [] },
        piSettings: { exists: false, count: 0, items: [] },
      },
      executableSurfaces: [],
    })

    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(SettingsProjectResources, {
        managers: [{ agentId: 'session-a', profileId: 'profile-a', role: 'manager', cwd: '/missing/workspace' } as never],
        previewSession: { agentId: 'session-a', profileId: 'profile-a' },
        apiClient: { fetchJson: vi.fn() } as unknown as SettingsApiClient,
      }))
    })
    await flushPromises()

    expect(getByText(container, 'Repository unavailable')).toBeTruthy()
    expect(getByText(container, 'Session working directory is unavailable: path does not exist')).toBeTruthy()
  })

  it('renders project agent inventory section with valid definitions', async () => {
    renderComponent({
      resources: {
        skills: { exists: true, count: 0, items: [] },
        specialists: { exists: true, count: 0, items: [] },
        reference: { exists: true, count: 0, items: [] },
        forgeExtensions: { exists: false, count: 0, items: [] },
        piExtensions: { exists: false, count: 0, items: [] },
        piSettings: { exists: false, count: 0, items: [] },
        projectAgents: {
          path: '/test/.forge/project-agents',
          exists: true,
          count: 2,
          items: [
            {
              definitionId: 'def-docs',
              handle: 'docs',
              path: 'docs/',
              status: 'valid',
              problems: [],
              displayName: 'Documentation Agent',
              whenToUse: 'Use for documentation tasks',
              requestedCapabilities: ['create_session'],
              recommendedModel: { provider: 'anthropic', modelId: 'claude-opus-5', thinkingLevel: 'high' },
            },
            {
              definitionId: 'def-releases',
              handle: 'releases',
              path: 'releases/',
              status: 'valid',
              problems: [],
              whenToUse: 'Manages release notes',
              activatedAgentId: 'agent-xyz',
            },
          ],
        },
      },
    })
    await flushPromises()

    // Section title is visible
    expect(document.body.querySelector('h3')?.textContent || document.body.textContent).toContain('Project Agent Definitions')

    // Both agent handles rendered
    expect(document.body.textContent).toContain('@docs')
    expect(document.body.textContent).toContain('@releases')

    // Display name rendered
    expect(document.body.textContent).toContain('Documentation Agent')

    // When-to-use rendered
    expect(document.body.textContent).toContain('Use for documentation tasks')

    // Active badge for activated agent
    expect(document.body.textContent).toContain('Active')

    // Activate button for non-activated valid agent
    const activateButton = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Activate'),
    )
    expect(activateButton).toBeTruthy()
  })

  it('renders invalid status badges and diagnostics', async () => {
    renderComponent({
      resources: {
        skills: { exists: true, count: 0, items: [] },
        specialists: { exists: true, count: 0, items: [] },
        reference: { exists: true, count: 0, items: [] },
        forgeExtensions: { exists: false, count: 0, items: [] },
        piExtensions: { exists: false, count: 0, items: [] },
        piSettings: { exists: false, count: 0, items: [] },
        projectAgents: {
          path: '/test/.forge/project-agents',
          exists: true,
          count: 1,
          items: [
            {
              definitionId: 'def-broken',
              handle: 'broken',
              path: 'broken/',
              status: 'invalid',
              problems: [
                { code: 'missing_prompt', message: 'prompt.md is missing' },
              ],
            },
          ],
        },
      },
    })
    await flushPromises()

    expect(document.body.textContent).toContain('@broken')
    expect(document.body.textContent).toContain('Invalid')
    expect(document.body.textContent).toContain('prompt.md is missing')

    // No activate button for invalid definitions
    const activateButton = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Activate'),
    )
    expect(activateButton).toBeFalsy()
  })

  it('calls activateRepoProjectAgent API on activate button click', async () => {
    const updatedSnapshot = makeBaseSnapshot({
      resources: {
        skills: { exists: true, count: 0, items: [] },
        specialists: { exists: true, count: 0, items: [] },
        reference: { exists: true, count: 0, items: [] },
        forgeExtensions: { exists: false, count: 0, items: [] },
        piExtensions: { exists: false, count: 0, items: [] },
        piSettings: { exists: false, count: 0, items: [] },
        projectAgents: {
          path: '/test/.forge/project-agents',
          exists: true,
          count: 1,
          items: [
            {
              definitionId: 'def-docs',
              handle: 'docs',
              path: 'docs/',
              status: 'valid',
              problems: [],
              whenToUse: 'For docs',
              activatedAgentId: 'new-agent-id',
            },
          ],
        },
      },
    })

    projectResourcesApiMock.activateRepoProjectAgent.mockResolvedValue({
      success: true,
      snapshot: updatedSnapshot,
      agentId: 'new-agent-id',
      projectAgent: {},
    })

    renderComponent({
      resources: {
        skills: { exists: true, count: 0, items: [] },
        specialists: { exists: true, count: 0, items: [] },
        reference: { exists: true, count: 0, items: [] },
        forgeExtensions: { exists: false, count: 0, items: [] },
        piExtensions: { exists: false, count: 0, items: [] },
        piSettings: { exists: false, count: 0, items: [] },
        projectAgents: {
          path: '/test/.forge/project-agents',
          exists: true,
          count: 1,
          items: [
            {
              definitionId: 'def-docs',
              handle: 'docs',
              path: 'docs/',
              status: 'valid',
              problems: [],
              whenToUse: 'For docs',
              requestedCapabilities: ['create_session'],
              recommendedModel: { provider: 'anthropic', modelId: 'claude-opus-5', thinkingLevel: 'high' },
            },
          ],
        },
      },
    })
    await flushPromises()

    const activateButton = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Activate'),
    )
    expect(activateButton).toBeTruthy()

    flushSync(() => {
      activateButton!.click()
    })
    await flushPromises()

    expect(projectResourcesApiMock.activateRepoProjectAgent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        profileId: 'profile-a',
        sessionAgentId: 'session-a',
        definitionId: 'def-docs',
        mode: 'create',
        applyRecommendedModel: true,
        approvedCapabilities: ['create_session'],
      }),
    )
  })

  it('does not render project agent section when projectAgents is absent', async () => {
    renderComponent()
    await flushPromises()

    expect(document.body.textContent).not.toContain('Project Agent Definitions')
  })
})
