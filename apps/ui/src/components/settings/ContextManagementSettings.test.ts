/** @vitest-environment jsdom */

import { fireEvent, getByRole, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectContextModeSnapshot } from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'
import { ContextManagementSettings } from './ContextManagementSettings'

const apiMock = vi.hoisted(() => ({
  fetchProjectContextMode: vi.fn(),
  updateProjectContextMode: vi.fn(),
}))

vi.mock('./context-mode-api', () => ({
  fetchProjectContextMode: (...args: unknown[]) => apiMock.fetchProjectContextMode(...args),
  updateProjectContextMode: (...args: unknown[]) => apiMock.updateProjectContextMode(...args),
}))

let container: HTMLDivElement
let root: Root | null = null
const apiClient = { target: { kind: 'builder' } } as unknown as SettingsApiClient

function snapshot(mode: 'summary' | 'fresh' = 'summary'): ProjectContextModeSnapshot {
  return { profileId: 'forge', mode }
}

async function flushAsyncWork() {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

function renderSettings(
  liveMode?: 'summary' | 'fresh',
  connectionEpoch = 1,
  overrides: { apiClient?: SettingsApiClient; profileId?: string } = {},
) {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(ContextManagementSettings, {
      apiClient: overrides.apiClient ?? apiClient,
      profileId: overrides.profileId ?? 'forge',
      connectionEpoch,
      liveMode,
    }))
  })
}

function rerenderSettings(
  liveMode?: 'summary' | 'fresh',
  connectionEpoch = 1,
  overrides: { apiClient?: SettingsApiClient; profileId?: string } = {},
) {
  flushSync(() => {
    root?.render(createElement(ContextManagementSettings, {
      apiClient: overrides.apiClient ?? apiClient,
      profileId: overrides.profileId ?? 'forge',
      connectionEpoch,
      liveMode,
    }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  Element.prototype.hasPointerCapture ??= vi.fn(() => false)
  Element.prototype.setPointerCapture ??= vi.fn()
  Element.prototype.releasePointerCapture ??= vi.fn()
  Element.prototype.scrollIntoView ??= vi.fn()
  apiMock.fetchProjectContextMode.mockReset()
  apiMock.updateProjectContextMode.mockReset()
  apiMock.fetchProjectContextMode.mockResolvedValue(snapshot('summary'))
  apiMock.updateProjectContextMode.mockResolvedValue(snapshot('fresh'))
})

afterEach(() => {
  if (root) flushSync(() => root?.unmount())
  root = null
  container.remove()
  vi.clearAllMocks()
})

describe('ContextManagementSettings', () => {
  it('loads the project default and saves a fresh-window selection without clearing context', async () => {
    renderSettings()
    await flushAsyncWork()

    expect(apiMock.fetchProjectContextMode).toHaveBeenCalledWith(apiClient, 'forge')
    expect(container.textContent).toContain('Context management')
    expect(container.textContent).toContain('Summary generates a summary')
    expect(container.textContent).toContain('Fresh windows starts from a checkpoint')
    expect(container.textContent).toContain('History search uses lexical matching')
    expect(container.textContent).not.toContain('Full conversation history stays searchable')
    expect(container.textContent).not.toContain('does not use embeddings')
    expect(container.textContent).toContain('does not clear the current conversation')

    const trigger = getByRole(container, 'combobox', { name: 'Context management' })
    flushSync(() => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    })
    await waitFor(() => expect(getByRole(document.body, 'option', { name: 'Fresh windows (experimental)' })).toBeTruthy())
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'option', { name: 'Fresh windows (experimental)' }))
    })
    await flushAsyncWork()

    expect(apiMock.updateProjectContextMode).toHaveBeenCalledWith(apiClient, 'forge', 'fresh')
    expect(container.textContent).toContain('applies at the next context transition')
  })

  it('rolls back the selector when a project save fails', async () => {
    apiMock.updateProjectContextMode.mockRejectedValueOnce(new Error('Could not persist context mode.'))
    renderSettings()
    await flushAsyncWork()

    const trigger = getByRole(container, 'combobox', { name: 'Context management' })
    flushSync(() => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    })
    await waitFor(() => expect(getByRole(document.body, 'option', { name: 'Fresh windows (experimental)' })).toBeTruthy())
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'option', { name: 'Fresh windows (experimental)' }))
    })
    await flushAsyncWork()

    expect(container.textContent).toContain('Could not persist context mode.')
    expect(getByRole(container, 'combobox', { name: 'Context management' }).textContent).toContain('Summary (default)')
  })

  it('consumes live profile data and reloads after reconnect', async () => {
    renderSettings('summary', 1)
    await flushAsyncWork()
    expect(apiMock.fetchProjectContextMode).toHaveBeenCalledTimes(1)

    rerenderSettings('fresh', 1)
    await flushAsyncWork()
    expect(getByRole(container, 'combobox', { name: 'Context management' }).textContent).toContain('Fresh windows (experimental)')

    apiMock.fetchProjectContextMode.mockResolvedValueOnce(snapshot('summary'))
    rerenderSettings('fresh', 2)
    await flushAsyncWork()
    expect(apiMock.fetchProjectContextMode).toHaveBeenCalledTimes(2)
    expect(getByRole(container, 'combobox', { name: 'Context management' }).textContent).toContain('Summary (default)')
  })

  it('ignores a deferred save for a previous project after switching scopes', async () => {
    let resolveProjectA: ((value: ProjectContextModeSnapshot) => void) | undefined
    apiMock.updateProjectContextMode.mockImplementationOnce(() => new Promise((resolve) => {
      resolveProjectA = resolve
    }))
    const clientA = { target: { kind: 'builder', id: 'a' } } as unknown as SettingsApiClient
    const clientB = { target: { kind: 'builder', id: 'b' } } as unknown as SettingsApiClient
    apiMock.fetchProjectContextMode.mockImplementation(async (_client: SettingsApiClient, profileId: string) => (
      snapshot(profileId === 'project-b' ? 'summary' : 'summary')
    ))

    renderSettings('summary', 1, { apiClient: clientA, profileId: 'project-a' })
    await flushAsyncWork()

    const trigger = getByRole(container, 'combobox', { name: 'Context management' })
    flushSync(() => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    })
    await waitFor(() => expect(getByRole(document.body, 'option', { name: 'Fresh windows (experimental)' })).toBeTruthy())
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'option', { name: 'Fresh windows (experimental)' }))
    })
    await flushAsyncWork()
    expect(apiMock.updateProjectContextMode).toHaveBeenCalledWith(clientA, 'project-a', 'fresh')

    apiMock.fetchProjectContextMode.mockResolvedValue(snapshot('summary'))
    rerenderSettings('summary', 2, { apiClient: clientB, profileId: 'project-b' })
    await flushAsyncWork()
    expect(getByRole(container, 'combobox', { name: 'Context management' }).textContent).toContain('Summary (default)')
    expect(container.querySelector('[aria-label="Saving"]')).toBeNull()

    resolveProjectA?.(snapshot('fresh'))
    await flushAsyncWork()
    expect(getByRole(container, 'combobox', { name: 'Context management' }).textContent).toContain('Summary (default)')
    expect(container.textContent).not.toContain('Could not persist')

    apiMock.updateProjectContextMode.mockResolvedValueOnce({ profileId: 'project-b', mode: 'fresh' })
    const laterTrigger = getByRole(container, 'combobox', { name: 'Context management' })
    flushSync(() => {
      fireEvent.pointerDown(laterTrigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    })
    await waitFor(() => expect(getByRole(document.body, 'option', { name: 'Fresh windows (experimental)' })).toBeTruthy())
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'option', { name: 'Fresh windows (experimental)' }))
    })
    await flushAsyncWork()
    expect(apiMock.updateProjectContextMode).toHaveBeenLastCalledWith(clientB, 'project-b', 'fresh')
    expect(getByRole(container, 'combobox', { name: 'Context management' }).textContent).toContain('Fresh windows (experimental)')
  })

  it('does not apply a rejected previous-project save after switching clients', async () => {
    let rejectProjectA: ((reason?: unknown) => void) | undefined
    apiMock.updateProjectContextMode.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectProjectA = reject
    }))
    const clientA = { target: { kind: 'builder', id: 'a' } } as unknown as SettingsApiClient
    const clientB = { target: { kind: 'builder', id: 'b' } } as unknown as SettingsApiClient

    renderSettings('summary', 1, { apiClient: clientA, profileId: 'project-a' })
    await flushAsyncWork()
    const trigger = getByRole(container, 'combobox', { name: 'Context management' })
    flushSync(() => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    })
    await waitFor(() => expect(getByRole(document.body, 'option', { name: 'Fresh windows (experimental)' })).toBeTruthy())
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'option', { name: 'Fresh windows (experimental)' }))
    })
    await flushAsyncWork()

    rerenderSettings('summary', 3, { apiClient: clientB, profileId: 'project-b' })
    await flushAsyncWork()
    rejectProjectA?.(new Error('stale project-a save'))
    await flushAsyncWork()

    expect(container.textContent).not.toContain('stale project-a save')
    expect(getByRole(container, 'combobox', { name: 'Context management' }).textContent).toContain('Summary (default)')
    expect(getByRole(container, 'combobox', { name: 'Context management' }).hasAttribute('data-disabled')).toBe(false)
  })
})
