/** @vitest-environment jsdom */

import { fireEvent, getAllByRole, getByRole } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type { SessionCoordinationPickerConfig } from './types'

const apiMock = vi.hoisted(() => ({
  fetchDelegationRosterSettings: vi.fn(),
}))

vi.mock('@/components/settings/specialists-api', () => ({
  fetchDelegationRosterSettings: (...args: unknown[]) =>
    apiMock.fetchDelegationRosterSettings(...args),
}))

const { SessionCoordinationPicker } = await import('./SessionCoordinationPicker')

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  Element.prototype.hasPointerCapture ??= vi.fn(() => false)
  Element.prototype.setPointerCapture ??= vi.fn()
  Element.prototype.releasePointerCapture ??= vi.fn()
  Element.prototype.scrollIntoView ??= vi.fn()
  apiMock.fetchDelegationRosterSettings.mockResolvedValue({
    version: 1,
    defaultRosterId: 'balanced',
    rosters: [
      { rosterId: 'balanced', name: 'Balanced', revision: 1, defaultRouteId: 'fast', routes: [] },
      { rosterId: 'diverse', name: 'Provider Diverse', revision: 1, defaultRouteId: 'fast', routes: [] },
    ],
  })
})

afterEach(() => {
  if (root) flushSync(() => root?.unmount())
  root = null
  container.remove()
  vi.clearAllMocks()
})

function makeConfig(
  overrides: Partial<SessionCoordinationPickerConfig> = {},
): SessionCoordinationPickerConfig {
  return {
    originId: 'local',
    httpClientRef: {
      current: { target: { kind: 'builder' } } as unknown as SettingsApiClient,
    },
    sessionAgentId: 'manager-1',
    profileId: 'project-1',
    managerPosture: 'delegation_first',
    managerPostureOrigin: 'product_default',
    delegationRosterId: 'balanced',
    delegationRosterOrigin: 'global_default',
    onUpdateProjectDefaults: vi.fn(async () => {}),
    onUpdateSession: vi.fn(async () => {}),
    ...overrides,
  }
}

function renderPicker(config: SessionCoordinationPickerConfig) {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(SessionCoordinationPicker, { config }))
  })
}

async function openPicker() {
  flushSync(() => {
    fireEvent.click(getByRole(container, 'button', { name: /coordination:/i }))
  })
  await flushAsyncWork()
}

async function flushAsyncWork() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('SessionCoordinationPicker', () => {
  it('inherits both controls without changing project defaults', async () => {
    const config = makeConfig()
    renderPicker(config)
    await openPicker()

    expect(document.body.textContent).toContain('may cause one prompt-cache miss')
    expect(document.body.textContent).toContain('Running attempts keep their selected model')
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Apply' }))
    })
    await flushAsyncWork()

    expect(config.onUpdateProjectDefaults).not.toHaveBeenCalled()
    expect(config.onUpdateSession).toHaveBeenCalledWith('manager-1', {
      managerPosture: { mode: 'inherit' },
      delegationRoster: { mode: 'inherit' },
    })
  })

  it('can make Hands-on the project default without remembering an implicit session choice', async () => {
    const config = makeConfig()
    renderPicker(config)
    await openPicker()

    const [postureSelect] = getAllByRole(document.body, 'combobox')
    flushSync(() => {
      fireEvent.pointerDown(postureSelect!, {
        button: 0,
        ctrlKey: false,
        pointerType: 'mouse',
      })
    })
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'option', { name: 'Hands-on' }))
    })
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'checkbox', {
        name: /Use Hands-on by default for this project/i,
      }))
    })
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Apply' }))
    })
    await flushAsyncWork()

    expect(config.onUpdateProjectDefaults).toHaveBeenCalledWith('project-1', {
      managerPosture: 'hands_on',
    })
    expect(config.onUpdateSession).toHaveBeenCalledWith('manager-1', {
      managerPosture: { mode: 'inherit' },
      delegationRoster: { mode: 'inherit' },
    })
  })

  it('keeps explicit session overrides scoped to the session', async () => {
    const config = makeConfig({
      managerPosture: 'hands_on',
      managerPostureOrigin: 'session_override',
      delegationRosterId: 'diverse',
      delegationRosterOrigin: 'session_override',
    })
    renderPicker(config)
    await openPicker()

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', { name: 'Apply' }))
    })
    await flushAsyncWork()

    expect(config.onUpdateProjectDefaults).not.toHaveBeenCalled()
    expect(config.onUpdateSession).toHaveBeenCalledWith('manager-1', {
      managerPosture: { mode: 'override', value: 'hands_on' },
      delegationRoster: { mode: 'override', rosterId: 'diverse' },
    })
  })
})
