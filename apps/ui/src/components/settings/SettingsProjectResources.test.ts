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
}))

vi.mock('./project-resources-api', () => ({
  fetchProjectResourcesSnapshot: (...args: unknown[]) => projectResourcesApiMock.fetchProjectResourcesSnapshot(...args),
  updateProjectResourcesOverride: (...args: unknown[]) => projectResourcesApiMock.updateProjectResourcesOverride(...args),
  updateProjectResourcesTrust: (...args: unknown[]) => projectResourcesApiMock.updateProjectResourcesTrust(...args),
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

describe('SettingsProjectResources', () => {
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
})
