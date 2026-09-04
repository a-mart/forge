/** @vitest-environment jsdom */

import { fireEvent, getAllByRole, getByRole, queryByRole } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type { SessionCoordinationPickerConfig } from './types'
import {
  FUTURE_WORK_MODE,
  makeManagerSelectionCatalog,
} from '@/lib/manager-selection-catalog.fixture'

const apiMock = vi.hoisted(() => ({
  fetchDelegationRosterSettings: vi.fn(),
  fetchManagerSelectionCatalog: vi.fn(),
}))

vi.mock('@/components/settings/specialists-api', () => ({
  fetchDelegationRosterSettings: (...args: unknown[]) =>
    apiMock.fetchDelegationRosterSettings(...args),
}))

vi.mock('@/lib/manager-selection-catalog-api', () => ({
  fetchManagerSelectionCatalog: (...args: unknown[]) =>
    apiMock.fetchManagerSelectionCatalog(...args),
}))

const { SessionCoordinationPicker } = await import('./SessionCoordinationPicker')
const { invalidateManagerSelectionCatalog } = await import('@/lib/use-manager-selection-catalog')

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  Element.prototype.hasPointerCapture ??= vi.fn(() => false)
  Element.prototype.setPointerCapture ??= vi.fn()
  Element.prototype.releasePointerCapture ??= vi.fn()
  Element.prototype.scrollIntoView ??= vi.fn()
  invalidateManagerSelectionCatalog()
  apiMock.fetchManagerSelectionCatalog.mockReset()
  apiMock.fetchManagerSelectionCatalog.mockResolvedValue(makeManagerSelectionCatalog())
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
  invalidateManagerSelectionCatalog()
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
    fireEvent.click(getByRole(container, 'button', { name: /work mode:/i }))
  })
  await flushAsyncWork()
}

async function flushAsyncWork() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('SessionCoordinationPicker', () => {
  it('shows work mode and roster choices together without nested menus', async () => {
    renderPicker(makeConfig())
    await openPicker()

    expect(getByRole(document.body, 'group', { name: 'Work mode' })).toBeTruthy()
    expect(getByRole(document.body, 'group', { name: 'Roster' })).toBeTruthy()
    expect(queryByRole(document.body, 'menu')).toBeNull()
    expect(queryByRole(document.body, 'button', { name: 'Apply' })).toBeNull()
    expect(document.body.textContent).not.toContain('prompt-cache miss')

    expect(getAllByRole(document.body, 'radio', {
      name: /Delegate first/,
    })).toHaveLength(1)
    expect(getByRole(document.body, 'radio', { name: 'Adaptive' })).toBeTruthy()
    expect(getByRole(document.body, 'radio', {
      name: /Delegate first.*Project default/,
    })).toBeTruthy()
    expect(getByRole(document.body, 'radio', {
      name: /Balanced.*Project default/,
    })).toBeTruthy()
  })

  it('applies a session posture override immediately and keeps the popover open', async () => {
    const config = makeConfig()
    renderPicker(config)
    await openPicker()

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'radio', { name: 'Hands-on' }))
    })
    await flushAsyncWork()

    expect(config.onUpdateProjectDefaults).not.toHaveBeenCalled()
    expect(config.onUpdateSession).toHaveBeenCalledWith('manager-1', {
      managerPosture: { mode: 'override', value: 'hands_on' },
    })
    expect(getByRole(document.body, 'group', { name: 'Roster' })).toBeTruthy()
  })

  it('forwards an advertised future Work Mode ID exactly', async () => {
    apiMock.fetchManagerSelectionCatalog.mockResolvedValue(makeManagerSelectionCatalog({
      workModes: [...makeManagerSelectionCatalog().workModes, FUTURE_WORK_MODE],
    }))
    const config = makeConfig()
    renderPicker(config)
    await openPicker()

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'radio', { name: 'Review led' }))
    })
    await flushAsyncWork()

    expect(config.onUpdateSession).toHaveBeenCalledWith('manager-1', {
      managerPosture: { mode: 'override', value: 'review_led' },
    })
  })

  it('renders an unknown current Work Mode honestly and read-only', async () => {
    const config = makeConfig({ managerPosture: 'server_removed' })
    renderPicker(config)
    await openPicker()

    expect(getByRole(container, 'button', { name: /Work mode: Server Removed/ })).toBeTruthy()
    const current = getByRole(document.body, 'radio', { name: /Server Removed.*Current/ })
    expect((current as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(current)
    expect(config.onUpdateSession).not.toHaveBeenCalled()
  })

  it('applies Adaptive as a session override', async () => {
    const config = makeConfig()
    renderPicker(config)
    await openPicker()

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'radio', { name: 'Adaptive' }))
    })
    await flushAsyncWork()

    expect(config.onUpdateSession).toHaveBeenCalledWith('manager-1', {
      managerPosture: { mode: 'override', value: 'adaptive' },
    })
  })

  it('returns an overridden posture to inheritance by selecting the project-default value', async () => {
    const config = makeConfig({
      managerPosture: 'hands_on',
      managerPostureOrigin: 'session_override',
    })
    renderPicker(config)
    await openPicker()

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'radio', {
        name: /Delegate first.*Project default/,
      }))
    })
    await flushAsyncWork()

    expect(config.onUpdateSession).toHaveBeenCalledWith('manager-1', {
      managerPosture: { mode: 'inherit' },
    })
  })

  it('uses the catalog default for inheritance when the project has no override', async () => {
    const config = makeConfig({
      managerPosture: 'hands_on',
      managerPostureOrigin: 'session_override',
      projectDefaultManagerPosture: undefined,
    })
    renderPicker(config)
    await openPicker()

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'radio', {
        name: /Delegate first.*Project default/,
      }))
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

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'button', {
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

    expect(getAllByRole(document.body, 'radio', {
      name: /Balanced.*Project default/,
    })).toHaveLength(1)
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'radio', {
        name: 'Provider Diverse',
      }))
    })
    await flushAsyncWork()

    expect(config.onUpdateSession).toHaveBeenCalledWith('manager-1', {
      delegationRoster: { mode: 'override', rosterId: 'diverse' },
    })
  })

  it('shows a single roster as compact metadata instead of a one-item picker', async () => {
    apiMock.fetchDelegationRosterSettings.mockResolvedValue({
      version: 1,
      defaultRosterId: 'balanced',
      rosters: [
        { rosterId: 'balanced', name: 'Balanced', revision: 1, defaultRouteId: 'fast', routes: [] },
      ],
    })
    renderPicker(makeConfig())
    await openPicker()

    expect(queryByRole(document.body, 'radio', { name: /Balanced/ })).toBeNull()
    expect(getByRole(document.body, 'group', { name: 'Roster' }).textContent)
      .toContain('Balanced')
  })
})
