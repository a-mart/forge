/** @vitest-environment jsdom */

import { fireEvent, getByRole, queryByRole } from '@testing-library/dom'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type { SessionModelPickerConfig } from './types'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'

const modelsApiMock = vi.hoisted(() => ({
  fetchModelOverrides: vi.fn(),
}))

vi.mock('@/components/settings/models-api', () => ({
  fetchModelOverrides: (...args: unknown[]) => modelsApiMock.fetchModelOverrides(...args),
}))

const { SessionModelPicker } = await import('./SessionModelPicker')
const { isSessionModelPickerEligible } = await import('./session-model-picker-eligibility')

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  Element.prototype.hasPointerCapture ??= vi.fn(() => false)
  Element.prototype.setPointerCapture ??= vi.fn()
  Element.prototype.releasePointerCapture ??= vi.fn()
  Element.prototype.scrollIntoView ??= vi.fn()
  modelsApiMock.fetchModelOverrides.mockResolvedValue({
    version: 1,
    overrides: {},
    providerAvailability: {
      'openai-codex': true,
      anthropic: true,
      'claude-sdk': true,
      'cursor-sdk': true,
      xai: true,
    },
    providerCredentials: {},
  })
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
  vi.clearAllMocks()
})

const pickerApiClient = { target: { kind: 'builder' } } as unknown as SettingsApiClient

function makeConfig(
  onUpdate: ReturnType<typeof vi.fn>,
  overrides: Partial<SessionModelPickerConfig> = {},
): SessionModelPickerConfig {
  return {
    originId: 'local',
    httpClientRef: { current: pickerApiClient },
    sessionAgentId: 'manager-1',
    sessionLabel: 'Main',
    currentModel: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'xhigh',
    },
    modelOrigin: 'profile_default',
    profileDefaultModel: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'xhigh',
    },
    onUpdate,
    ...overrides,
  }
}

function renderPicker(
  onUpdate: ReturnType<typeof vi.fn>,
  overrides: Partial<SessionModelPickerConfig> = {},
) {
  root = createRoot(container)
  rerenderPicker(onUpdate, overrides)
}

function rerenderPicker(
  onUpdate: ReturnType<typeof vi.fn>,
  overrides: Partial<SessionModelPickerConfig> = {},
) {
  flushSync(() => {
    root?.render(createElement(SessionModelPicker, {
      config: makeConfig(onUpdate, overrides),
    }))
  })
}

async function openPicker() {
  flushSync(() => {
    fireEvent.pointerDown(getByRole(container, 'button', { name: /change session model/i }), {
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

describe('isSessionModelPickerEligible', () => {
  const manager = {
    role: 'manager',
    profileId: 'profile-1',
    sessionSurface: 'builder',
  } as AgentDescriptor
  const profile = {
    profileId: 'profile-1',
    profileType: 'user',
  } as ManagerProfile

  it('allows only matching user-profile Builder managers', () => {
    expect(isSessionModelPickerEligible(manager, profile)).toBe(true)
    expect(isSessionModelPickerEligible({ ...manager, role: 'worker' }, profile)).toBe(false)
    expect(isSessionModelPickerEligible({ ...manager, sessionSurface: 'collab' }, profile)).toBe(false)
    expect(isSessionModelPickerEligible(manager, { ...profile, profileType: 'system' })).toBe(false)
    expect(isSessionModelPickerEligible(manager, { ...profile, profileId: 'other-profile' })).toBe(false)
    expect(isSessionModelPickerEligible(manager, null)).toBe(false)
  })
})

describe('SessionModelPicker compact menu', () => {
  it('loads the catalog into nested model and reasoning menus', async () => {
    const onUpdate = vi.fn()
    renderPicker(onUpdate)
    await openPicker()

    expect(modelsApiMock.fetchModelOverrides).toHaveBeenCalledWith(pickerApiClient)
    expect(queryByRole(document.body, 'dialog')).toBeNull()
    expect(getByRole(document.body, 'menuitem', { name: /Model.*GPT-5.5/ })).toBeTruthy()
    expect(getByRole(document.body, 'menuitem', { name: /Reasoning.*Max/ })).toBeTruthy()
  })

  it('applies a reasoning override immediately', async () => {
    const onUpdate = vi.fn(async () => {})
    renderPicker(onUpdate)
    await openPicker()
    await openSubmenu(/Reasoning/)

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'menuitemradio', { name: 'High' }))
    })
    await flushAsyncWork()

    expect(onUpdate).toHaveBeenCalledWith(
      'manager-1',
      'override',
      { provider: 'openai-codex', modelId: 'gpt-5.5' },
      'high',
    )
  })

  it('applies a model with its catalog default reasoning immediately', async () => {
    const onUpdate = vi.fn(async () => {})
    renderPicker(onUpdate)
    await openPicker()
    await openSubmenu(/Model/)

    const target = getByRole(document.body, 'menuitemradio', { name: 'GPT-5.6 Sol' })
    flushSync(() => {
      fireEvent.click(target)
    })
    await flushAsyncWork()

    expect(onUpdate).toHaveBeenCalledWith(
      'manager-1',
      'override',
      { provider: 'openai-codex', modelId: 'gpt-5.6-sol' },
      expect.any(String),
    )
  })

  it('returns an overridden session to the project default', async () => {
    const onUpdate = vi.fn(async () => {})
    renderPicker(onUpdate, { modelOrigin: 'session_override' })
    await openPicker()

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'menuitem', {
        name: /Use project default.*GPT-5.5/,
      }))
    })
    await flushAsyncWork()

    expect(onUpdate).toHaveBeenCalledWith('manager-1', 'inherit')
  })

  it.each([
    ['session', { sessionAgentId: 'manager-2' }],
    ['origin with an equal agent id', { originId: 'remote-2' }],
  ])('closes an open menu when the active %s changes', async (_scope, overrides) => {
    const onUpdate = vi.fn()
    renderPicker(onUpdate)
    await openPicker()
    expect(queryByRole(document.body, 'menu')).not.toBeNull()

    rerenderPicker(onUpdate, overrides)
    await act(async () => {})

    expect(queryByRole(document.body, 'menu')).toBeNull()
  })
})
