/** @vitest-environment jsdom */

import { fireEvent, getByRole, queryByRole } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionContextModeSnapshot } from '@forge/protocol'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type { SessionContextModePickerConfig } from './types'
import { SessionContextModePicker } from './SessionContextModePicker'

const apiMock = vi.hoisted(() => ({
  fetchSessionContextMode: vi.fn(),
  updateSessionContextMode: vi.fn(),
}))

vi.mock('@/components/settings/context-mode-api', () => ({
  fetchSessionContextMode: (...args: unknown[]) => apiMock.fetchSessionContextMode(...args),
  updateSessionContextMode: (...args: unknown[]) => apiMock.updateSessionContextMode(...args),
}))

let container: HTMLDivElement
let root: Root | null = null
const apiClient = { target: { kind: 'builder' } } as unknown as SettingsApiClient

function makeSnapshot(overrides: Partial<SessionContextModeSnapshot> = {}): SessionContextModeSnapshot {
  return {
    sessionAgentId: 'manager-1',
    profileId: 'forge',
    projectDefault: 'summary',
    effectiveMode: 'summary',
    freshSupported: true,
    ...overrides,
  }
}

function makeConfig(overrides: Partial<SessionContextModePickerConfig> = {}): SessionContextModePickerConfig {
  return {
    originId: 'local',
    httpClientRef: { current: apiClient },
    sessionAgentId: 'manager-1',
    ...overrides,
  }
}

function renderPicker(config: SessionContextModePickerConfig) {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(SessionContextModePicker, { config }))
  })
}

function rerenderPicker(config: SessionContextModePickerConfig) {
  flushSync(() => {
    root?.render(createElement(SessionContextModePicker, { config }))
  })
}

async function flushAsyncWork() {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

async function openPicker() {
  flushSync(() => {
    fireEvent.click(getByRole(container, 'button', { name: /context management:/i }))
  })
  await flushAsyncWork()
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  Element.prototype.hasPointerCapture ??= vi.fn(() => false)
  Element.prototype.setPointerCapture ??= vi.fn()
  Element.prototype.releasePointerCapture ??= vi.fn()
  Element.prototype.scrollIntoView ??= vi.fn()
  apiMock.fetchSessionContextMode.mockReset()
  apiMock.updateSessionContextMode.mockReset()
  apiMock.fetchSessionContextMode.mockResolvedValue(makeSnapshot())
  apiMock.updateSessionContextMode.mockImplementation(async (_client, _agentId, mode: 'summary' | 'fresh' | null) => {
    if (mode === null) {
      return makeSnapshot({ projectDefault: 'fresh', effectiveMode: 'fresh' })
    }
    return makeSnapshot({
      projectDefault: 'fresh',
      sessionOverride: mode,
      effectiveMode: mode,
    })
  })
})

afterEach(() => {
  if (root) flushSync(() => root?.unmount())
  root = null
  container.remove()
  vi.clearAllMocks()
})

describe('SessionContextModePicker', () => {
  it('loads inherit/summary/fresh choices and shows effective inheritance', async () => {
    renderPicker(makeConfig())
    await flushAsyncWork()
    expect(apiMock.fetchSessionContextMode).toHaveBeenCalledWith(apiClient, 'manager-1')
    expect(getByRole(container, 'button', {
      name: 'Context management: Summary (default). project default.',
    })).toBeTruthy()

    await openPicker()
    expect(getByRole(document.body, 'radio', { name: 'Use project default (Summary)' })).toBeTruthy()
    expect(getByRole(document.body, 'radio', { name: 'Summary (default)' })).toBeTruthy()
    expect(getByRole(document.body, 'radio', { name: 'Fresh windows (experimental)' })).toBeTruthy()
    expect(document.body.textContent).toContain('Effective: Summary · project default')
    expect(document.body.textContent).toContain('does not clear the current conversation')
  })

  it('sets a session override and can restore project inheritance', async () => {
    apiMock.fetchSessionContextMode.mockResolvedValue(makeSnapshot({
      projectDefault: 'fresh',
      effectiveMode: 'fresh',
    }))
    renderPicker(makeConfig())
    await flushAsyncWork()
    await openPicker()

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'radio', { name: 'Summary (default)' }))
    })
    await flushAsyncWork()
    expect(apiMock.updateSessionContextMode).toHaveBeenCalledWith(apiClient, 'manager-1', 'summary')
    expect(getByRole(container, 'button', {
      name: 'Context management: Summary (default). session override.',
    })).toBeTruthy()

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'radio', { name: 'Use project default (Fresh windows)' }))
    })
    await flushAsyncWork()
    expect(apiMock.updateSessionContextMode).toHaveBeenLastCalledWith(apiClient, 'manager-1', null)
  })

  it('rolls back the selected choice when a write fails', async () => {
    apiMock.updateSessionContextMode.mockRejectedValueOnce(new Error('Could not persist session context mode.'))
    renderPicker(makeConfig())
    await flushAsyncWork()
    await openPicker()

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'radio', { name: 'Fresh windows (experimental)' }))
    })
    await flushAsyncWork()

    expect(document.body.textContent).toContain('Could not persist session context mode.')
    expect((getByRole(document.body, 'radio', { name: 'Use project default (Summary)' }) as HTMLInputElement).checked).toBe(true)
    expect((getByRole(document.body, 'radio', { name: 'Fresh windows (experimental)' }) as HTMLInputElement).checked).toBe(false)
  })

  it('disables fresh windows on unsupported sessions and shows the reason', async () => {
    apiMock.fetchSessionContextMode.mockResolvedValue(makeSnapshot({
      freshSupported: false,
      unsupportedReason: 'Fresh windows are not supported for Cursor SDK runtimes.',
    }))
    renderPicker(makeConfig())
    await flushAsyncWork()
    await openPicker()

    const fresh = getByRole(document.body, 'radio', { name: /Fresh windows \(experimental\)/ }) as HTMLInputElement
    expect(fresh.disabled).toBe(true)
    expect(document.body.textContent).toContain('Fresh windows are not supported for Cursor SDK runtimes.')
    fireEvent.click(fresh)
    expect(apiMock.updateSessionContextMode).not.toHaveBeenCalled()
  })

  it('reloads after reconnect and keeps Compact/Smart Compact out of this control', async () => {
    renderPicker(makeConfig({ connectionEpoch: 1 }))
    await flushAsyncWork()
    expect(apiMock.fetchSessionContextMode).toHaveBeenCalledTimes(1)

    apiMock.fetchSessionContextMode.mockResolvedValueOnce(makeSnapshot({
      projectDefault: 'fresh',
      sessionOverride: 'summary',
      effectiveMode: 'summary',
    }))
    rerenderPicker(makeConfig({ connectionEpoch: 2 }))
    await flushAsyncWork()
    expect(apiMock.fetchSessionContextMode).toHaveBeenCalledTimes(2)
    expect(getByRole(container, 'button', {
      name: 'Context management: Summary (default). session override.',
    })).toBeTruthy()
    expect(queryByRole(container, 'button', { name: /compact/i })).toBeNull()
  })

  it('ignores a deferred save for a previous session after switching identity', async () => {
    let resolveSessionA: ((value: SessionContextModeSnapshot) => void) | undefined
    apiMock.updateSessionContextMode.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSessionA = resolve
    }))
    const clientA = { target: { kind: 'builder', id: 'a' } } as unknown as SettingsApiClient
    const clientB = { target: { kind: 'builder', id: 'b' } } as unknown as SettingsApiClient
    apiMock.fetchSessionContextMode.mockImplementation(async (_client, agentId: string) => (
      makeSnapshot({
        sessionAgentId: agentId,
        projectDefault: agentId === 'manager-b' ? 'summary' : 'fresh',
        effectiveMode: agentId === 'manager-b' ? 'summary' : 'fresh',
      })
    ))

    renderPicker(makeConfig({
      originId: 'origin-a',
      sessionAgentId: 'manager-a',
      connectionEpoch: 1,
      httpClientRef: { current: clientA },
    }))
    await flushAsyncWork()
    await openPicker()
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'radio', { name: 'Summary (default)' }))
    })
    await flushAsyncWork()
    expect(apiMock.updateSessionContextMode).toHaveBeenCalledWith(clientA, 'manager-a', 'summary')

    rerenderPicker(makeConfig({
      originId: 'origin-b',
      sessionAgentId: 'manager-b',
      connectionEpoch: 2,
      httpClientRef: { current: clientB },
    }))
    await flushAsyncWork()
    expect(getByRole(container, 'button', {
      name: 'Context management: Summary (default). project default.',
    })).toBeTruthy()
    expect(container.querySelector('[aria-label="Saving"]')).toBeNull()

    resolveSessionA?.(makeSnapshot({
      sessionAgentId: 'manager-a',
      projectDefault: 'fresh',
      sessionOverride: 'summary',
      effectiveMode: 'summary',
    }))
    await flushAsyncWork()
    expect(getByRole(container, 'button', {
      name: 'Context management: Summary (default). project default.',
    })).toBeTruthy()
    expect(document.body.textContent).not.toContain('Could not persist')

    await openPicker()
    apiMock.updateSessionContextMode.mockResolvedValueOnce(makeSnapshot({
      sessionAgentId: 'manager-b',
      sessionOverride: 'fresh',
      effectiveMode: 'fresh',
    }))
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'radio', { name: 'Fresh windows (experimental)' }))
    })
    await flushAsyncWork()
    expect(apiMock.updateSessionContextMode).toHaveBeenLastCalledWith(clientB, 'manager-b', 'fresh')
    expect(getByRole(container, 'button', {
      name: 'Context management: Fresh windows (experimental). session override.',
    })).toBeTruthy()
  })

  it('does not apply a rejected previous-session save after switching clients', async () => {
    let rejectSessionA: ((reason?: unknown) => void) | undefined
    apiMock.updateSessionContextMode.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectSessionA = reject
    }))
    const clientA = { target: { kind: 'builder', id: 'a' } } as unknown as SettingsApiClient
    const clientB = { target: { kind: 'builder', id: 'b' } } as unknown as SettingsApiClient
    apiMock.fetchSessionContextMode.mockImplementation(async (_client, agentId: string) => (
      makeSnapshot({ sessionAgentId: agentId, effectiveMode: 'summary' })
    ))

    renderPicker(makeConfig({
      originId: 'origin-a',
      sessionAgentId: 'manager-a',
      connectionEpoch: 1,
      httpClientRef: { current: clientA },
    }))
    await flushAsyncWork()
    await openPicker()
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'radio', { name: 'Fresh windows (experimental)' }))
    })
    await flushAsyncWork()

    rerenderPicker(makeConfig({
      originId: 'origin-b',
      sessionAgentId: 'manager-b',
      connectionEpoch: 4,
      httpClientRef: { current: clientB },
    }))
    await flushAsyncWork()
    rejectSessionA?.(new Error('stale session-a save'))
    await flushAsyncWork()
    await openPicker()

    expect(document.body.textContent).not.toContain('stale session-a save')
    expect((getByRole(document.body, 'radio', { name: 'Use project default (Summary)' }) as HTMLInputElement).checked).toBe(true)
    expect((getByRole(document.body, 'radio', { name: 'Fresh windows (experimental)' }) as HTMLInputElement).disabled).toBe(false)
  })
})
