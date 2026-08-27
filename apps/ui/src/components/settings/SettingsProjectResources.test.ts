/** @vitest-environment jsdom */

import { fireEvent, getByRole, getByText, queryByRole } from '@testing-library/dom'
import { act, createElement } from 'react'
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
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  projectResourcesApiMock.fetchProjectResourcesSnapshot.mockReset()
  projectResourcesApiMock.updateProjectResourcesOverride.mockReset()
  projectResourcesApiMock.updateProjectResourcesTrust.mockReset()
  projectResourcesApiMock.activateRepoProjectAgent.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  root = null
  container.remove()
})

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

async function renderComponent(snapshotOverrides: Record<string, unknown> = {}) {
  const snapshot = makeBaseSnapshot(snapshotOverrides)
  projectResourcesApiMock.fetchProjectResourcesSnapshot.mockResolvedValue(snapshot)

  root = createRoot(container)
  await act(async () => {
    root?.render(createElement(SettingsProjectResources, {
      managers: [{ agentId: 'session-a', profileId: 'profile-a', role: 'manager', cwd: '/test/workspace' } as never],
      previewSession: { agentId: 'session-a', profileId: 'profile-a' },
      apiClient: { fetchJson: vi.fn() } as unknown as SettingsApiClient,
    }))
    await Promise.resolve()
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
    await act(async () => {
      root?.render(createElement(SettingsProjectResources, {
        managers: [{ agentId: 'session-alpha', profileId: 'project-alpha', role: 'manager' } as never],
        previewSession: { agentId: 'session-alpha', profileId: 'project-alpha' },
        projectContext: { profileId: 'project-beta', sessionAgentId: 'session-beta' },
        apiClient: { fetchJson: vi.fn() } as unknown as SettingsApiClient,
      }))
      await Promise.resolve()
    })
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
    await act(async () => {
      root?.render(createElement(SettingsProjectResources, {
        managers: [{ agentId: 'session-a', profileId: 'profile-a', role: 'manager', cwd: '/missing/workspace' } as never],
        previewSession: { agentId: 'session-a', profileId: 'profile-a' },
        apiClient: { fetchJson: vi.fn() } as unknown as SettingsApiClient,
      }))
      await Promise.resolve()
    })
    expect(getByText(container, 'Repository unavailable')).toBeTruthy()
    expect(getByText(container, 'Session working directory is unavailable: path does not exist')).toBeTruthy()
  })

  it('renders project agent inventory section with valid definitions', async () => {
    await renderComponent({
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
    expect(getByText(container, 'Project Agent Definitions')).toBeTruthy()

    // Section title is visible
    expect(container.querySelector('h3')?.textContent || container.textContent).toContain('Project Agent Definitions')

    // Both agent handles rendered
    expect(container.textContent).toContain('@docs')
    expect(container.textContent).toContain('@releases')

    // Display name rendered
    expect(container.textContent).toContain('Documentation Agent')

    // When-to-use rendered
    expect(container.textContent).toContain('Use for documentation tasks')

    // Active badge for activated agent
    expect(container.textContent).toContain('Active')

    // Activate button for non-activated valid agent
    expect(getByRole(container, 'button', { name: 'Activate' })).toBeTruthy()
  })

  it('renders invalid status badges and diagnostics', async () => {
    await renderComponent({
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
    expect(getByText(container, '@broken')).toBeTruthy()

    expect(container.textContent).toContain('@broken')
    expect(container.textContent).toContain('Invalid')
    expect(container.textContent).toContain('prompt.md is missing')

    // No activate button for invalid definitions
    expect(queryByRole(container, 'button', { name: 'Activate' })).toBeNull()
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

    await renderComponent({
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
    expect(getByRole(container, 'button', { name: 'Activate' })).toBeTruthy()

    await act(async () => {
      fireEvent.click(getByRole(container, 'button', { name: 'Activate' }))
      await Promise.resolve()
    })

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
    await renderComponent()
    expect(getByText(container, 'Inventory')).toBeTruthy()

    expect(container.textContent).not.toContain('Project Agent Definitions')
  })
})
