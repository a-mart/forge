/** @vitest-environment jsdom */

import { fireEvent, getAllByRole, getByRole, queryByRole } from '@testing-library/dom'
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
    projectDefaultManagerPosture: 'delegation_first',
    delegationRosterId: 'balanced',
    delegationRosterOrigin: 'global_default',
    projectDefaultDelegationRosterId: 'balanced',
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
    fireEvent.pointerDown(getByRole(container, 'button', { name: /coordination:/i }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
  })
  await flushAsyncWork()
}

async function openSubmenu(name: RegExp) {
  const trigger = getByRole(document.body, 'menuitem', { name })
  flushSync(() => {
    fireEvent.pointerMove(trigger, {
      pointerType: 'mouse',
      clientX: 10,
      clientY: 10,
    })
  })
  await new Promise((resolve) => setTimeout(resolve, 150))
}

async function flushAsyncWork() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('SessionCoordinationPicker', () => {
  it('uses a compact menu with one posture item per value and marks the project default', async () => {
    renderPicker(makeConfig())
    await openPicker()

    expect(getByRole(document.body, 'menu')).toBeTruthy()
    expect(queryByRole(document.body, 'button', { name: 'Apply' })).toBeNull()
    expect(document.body.textContent).not.toContain('prompt-cache miss')

    await openSubmenu(/Manager posture/)
    expect(getAllByRole(document.body, 'menuitemradio', {
      name: /Delegation-first/,
    })).toHaveLength(1)
    expect(getByRole(document.body, 'menuitemradio', {
      name: /Delegation-first.*Project default/,
    })).toBeTruthy()
  })

  it('applies a session posture override immediately', async () => {
    const config = makeConfig()
    renderPicker(config)
    await openPicker()
    await openSubmenu(/Manager posture/)

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'menuitemradio', { name: 'Hands-on' }))
    })
    await flushAsyncWork()

    expect(config.onUpdateProjectDefaults).not.toHaveBeenCalled()
    expect(config.onUpdateSession).toHaveBeenCalledWith('manager-1', {
      managerPosture: { mode: 'override', value: 'hands_on' },
    })
  })

  it('returns an overridden posture to the project default without duplicating values', async () => {
    const config = makeConfig({
      managerPosture: 'hands_on',
      managerPostureOrigin: 'session_override',
    })
    renderPicker(config)
    await openPicker()
    await openSubmenu(/Manager posture/)

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'menuitem', { name: 'Use project default' }))
    })
    await flushAsyncWork()

    expect(config.onUpdateSession).toHaveBeenCalledWith('manager-1', {
      managerPosture: { mode: 'inherit' },
    })
  })

  it('can make the current posture the project default and resume inheritance', async () => {
    const config = makeConfig({
      managerPosture: 'hands_on',
      managerPostureOrigin: 'session_override',
    })
    renderPicker(config)
    await openPicker()
    await openSubmenu(/Manager posture/)

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'menuitem', {
        name: 'Make Hands-on project default',
      }))
    })
    await flushAsyncWork()

    expect(config.onUpdateProjectDefaults).toHaveBeenCalledWith('project-1', {
      managerPosture: 'hands_on',
    })
    expect(config.onUpdateSession).toHaveBeenCalledWith('manager-1', {
      managerPosture: { mode: 'inherit' },
    })
  })

  it('selects a roster immediately and marks the project default once', async () => {
    const config = makeConfig()
    renderPicker(config)
    await openPicker()
    await openSubmenu(/Delegation roster/)

    expect(getAllByRole(document.body, 'menuitemradio', {
      name: /Balanced.*Project default/,
    })).toHaveLength(1)
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'menuitemradio', {
        name: 'Provider Diverse',
      }))
    })
    await flushAsyncWork()

    expect(config.onUpdateSession).toHaveBeenCalledWith('manager-1', {
      delegationRoster: { mode: 'override', rosterId: 'diverse' },
    })
  })
})
