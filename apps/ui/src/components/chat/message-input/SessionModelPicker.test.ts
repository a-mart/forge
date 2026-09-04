/** @vitest-environment jsdom */

import { fireEvent, getAllByRole, getByRole, queryByRole } from '@testing-library/dom'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type { SessionModelPickerConfig } from './types'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import {
  FUTURE_MODEL,
  OPENROUTER_GLM,
  makeManagerSelectionCatalog,
} from '@/lib/manager-selection-catalog.fixture'

const catalogApiMock = vi.hoisted(() => ({
  fetchManagerSelectionCatalog: vi.fn(),
}))

vi.mock('@/lib/manager-selection-catalog-api', () => ({
  fetchManagerSelectionCatalog: (...args: unknown[]) =>
    catalogApiMock.fetchManagerSelectionCatalog(...args),
}))

const { SessionModelPicker } = await import('./SessionModelPicker')
const { isSessionModelPickerEligible } = await import('./session-model-picker-eligibility')
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
  catalogApiMock.fetchManagerSelectionCatalog.mockReset()
  catalogApiMock.fetchManagerSelectionCatalog.mockResolvedValue(makeManagerSelectionCatalog())
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
  invalidateManagerSelectionCatalog()
  vi.clearAllMocks()
})

const pickerApiClient = { target: { kind: 'builder' } } as unknown as SettingsApiClient
const pickerHttpClientRef = { current: pickerApiClient }

function makeConfig(
  onUpdate: ReturnType<typeof vi.fn>,
  overrides: Partial<SessionModelPickerConfig> = {},
): SessionModelPickerConfig {
  return {
    originId: 'local',
    httpClientRef: pickerHttpClientRef,
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
  it('preloads the catalog into nested model and reasoning menus', async () => {
    const onUpdate = vi.fn()
    renderPicker(onUpdate)
    await openPicker()

    expect(catalogApiMock.fetchManagerSelectionCatalog).toHaveBeenCalledWith(pickerApiClient)
    expect(queryByRole(document.body, 'dialog')).toBeNull()
    expect(getByRole(document.body, 'menuitem', { name: /Model.*GPT-5.5/ })).toBeTruthy()
    expect(getByRole(document.body, 'menuitem', { name: /Reasoning.*Max/ })).toBeTruthy()
  })

  it('forces a validated catalog fetch when the picker is reopened', async () => {
    const onUpdate = vi.fn()
    renderPicker(onUpdate)
    await flushAsyncWork()

    expect(catalogApiMock.fetchManagerSelectionCatalog).toHaveBeenCalledTimes(1)

    await openPicker()
    expect(catalogApiMock.fetchManagerSelectionCatalog).toHaveBeenCalledTimes(2)

    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
    await flushAsyncWork()
    await openPicker()

    expect(catalogApiMock.fetchManagerSelectionCatalog).toHaveBeenCalledTimes(3)
  })

  it('distinguishes Opus 5 xhigh from max while keeping legacy GPT xhigh as Max', async () => {
    const onUpdate = vi.fn()
    renderPicker(onUpdate, {
      currentModel: { provider: 'anthropic', modelId: 'claude-opus-5', thinkingLevel: 'xhigh' },
    })
    await flushAsyncWork()

    expect(getByRole(container, 'button', { name: /Extra High/ })).toBeTruthy()
    await openPicker()
    await openSubmenu(/Reasoning/)
    expect(getByRole(document.body, 'menuitemradio', { name: 'Extra High' })).toBeTruthy()
    expect(getByRole(document.body, 'menuitemradio', { name: 'Max' })).toBeTruthy()
  })

  it('shows Extra High, Max, and Ultra for GPT-5.6 Sol', async () => {
    const onUpdate = vi.fn()
    renderPicker(onUpdate, {
      currentModel: { provider: 'openai-codex', modelId: 'gpt-5.6-sol', thinkingLevel: 'xhigh' },
    })
    await flushAsyncWork()

    expect(getByRole(container, 'button', { name: /Extra High/ })).toBeTruthy()
    await openPicker()
    await openSubmenu(/Reasoning/)
    expect(getByRole(document.body, 'menuitemradio', { name: 'Extra High' })).toBeTruthy()
    expect(getByRole(document.body, 'menuitemradio', { name: 'Max' })).toBeTruthy()
    expect(getByRole(document.body, 'menuitemradio', { name: 'Ultra' })).toBeTruthy()
  })

  it.each([
    ['gpt-5.6-terra', true],
    ['gpt-5.6-luna', false],
  ] as const)('shows model-specific deep reasoning choices for %s', async (modelId, supportsUltra) => {
    const onUpdate = vi.fn()
    renderPicker(onUpdate, {
      currentModel: { provider: 'openai-codex', modelId, thinkingLevel: 'xhigh' },
    })
    await flushAsyncWork()

    expect(getByRole(container, 'button', { name: /Extra High/ })).toBeTruthy()
    await openPicker()
    await openSubmenu(/Reasoning/)
    expect(getByRole(document.body, 'menuitemradio', { name: 'Extra High' })).toBeTruthy()
    expect(getByRole(document.body, 'menuitemradio', { name: 'Max' })).toBeTruthy()
    if (supportsUltra) {
      expect(getByRole(document.body, 'menuitemradio', { name: 'Ultra' })).toBeTruthy()
    } else {
      expect(queryByRole(document.body, 'menuitemradio', { name: 'Ultra' })).toBeNull()
    }
  })

  it('shows Grok 4.6 as the native xAI default while retaining Grok 4.5', async () => {
    const onUpdate = vi.fn()
    renderPicker(onUpdate, {
      currentModel: { provider: 'xai', modelId: 'grok-4.6', thinkingLevel: 'high' },
    })

    await openPicker()
    await openSubmenu(/Model/)
    expect(getByRole(document.body, 'menuitemradio', { name: 'Grok 4.6' })).toBeTruthy()
    expect(getAllByRole(document.body, 'menuitemradio', { name: 'Grok 4.5' }).length).toBeGreaterThan(0)
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

  it('keeps the picker open while applying a model and then a reasoning level', async () => {
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
    expect(document.body.querySelector('[data-slot="dropdown-menu-content"]')).not.toBeNull()

    rerenderPicker(onUpdate, {
      currentModel: { provider: 'openai-codex', modelId: 'gpt-5.6-sol', thinkingLevel: 'xhigh' },
    })
    await act(async () => {})
    await openSubmenu(/Reasoning/)

    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'menuitemradio', { name: 'High' }))
    })
    await flushAsyncWork()

    expect(onUpdate).toHaveBeenLastCalledWith(
      'manager-1',
      'override',
      { provider: 'openai-codex', modelId: 'gpt-5.6-sol' },
      'high',
    )
    expect(document.body.querySelector('[data-slot="dropdown-menu-content"]')).not.toBeNull()
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

  it('uses synthetic future models and Fable 5.1 from the server snapshot', async () => {
    catalogApiMock.fetchManagerSelectionCatalog.mockResolvedValue(makeManagerSelectionCatalog({
      models: [...makeManagerSelectionCatalog().models, FUTURE_MODEL],
    }))
    const onUpdate = vi.fn(async () => {})
    renderPicker(onUpdate)
    await openPicker()
    await openSubmenu(/Model/)

    expect(getByRole(document.body, 'menuitemradio', { name: 'Claude Fable 5.1' })).toBeTruthy()
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'menuitemradio', { name: 'Oracle 9' }))
    })
    await flushAsyncWork()

    expect(onUpdate).toHaveBeenCalledWith(
      'manager-1',
      'override',
      { provider: 'future-labs', modelId: 'oracle-9' },
      'high',
    )
  })

  it('includes an enabled OpenRouter model and refreshes after model_config_changed', async () => {
    catalogApiMock.fetchManagerSelectionCatalog.mockResolvedValue(makeManagerSelectionCatalog())

    const onUpdate = vi.fn()
    renderPicker(onUpdate, { modelConfigChangeKey: 0 })
    await openPicker()
    await openSubmenu(/Model/)
    expect(queryByRole(document.body, 'menuitemradio', { name: 'Z.ai: GLM 5.1' })).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
    await flushAsyncWork()

    catalogApiMock.fetchManagerSelectionCatalog.mockResolvedValue(makeManagerSelectionCatalog({
      models: [...makeManagerSelectionCatalog().models, OPENROUTER_GLM],
    }))
    rerenderPicker(onUpdate, { modelConfigChangeKey: 1 })
    await flushAsyncWork()
    await openPicker()
    await openSubmenu(/Model/)
    expect(getByRole(document.body, 'menuitemradio', { name: 'Z.ai: GLM 5.1' })).toBeTruthy()
    expect(catalogApiMock.fetchManagerSelectionCatalog).toHaveBeenCalledTimes(4)
  })

  it('refreshes enable and disable state on reopen without reconnect', async () => {
    const enabled = makeManagerSelectionCatalog()
    const disabled = makeManagerSelectionCatalog({
      models: enabled.models.map((model) => (
        model.modelId === 'claude-fable-5-1'
          ? {
              ...model,
              surfaces: {
                create: { selectable: false as const, unavailableReason: 'provider_not_configured' as const },
                change: { selectable: false as const, unavailableReason: 'provider_not_configured' as const },
              },
            }
          : model
      )),
    })
    catalogApiMock.fetchManagerSelectionCatalog
      .mockResolvedValueOnce(enabled)
      .mockResolvedValueOnce(enabled)
      .mockResolvedValueOnce(disabled)

    const onUpdate = vi.fn()
    renderPicker(onUpdate, { modelConfigChangeKey: 0, connectionEpoch: 1 })
    await openPicker()
    await openSubmenu(/Model/)
    expect(getByRole(document.body, 'menuitemradio', { name: 'Claude Fable 5.1' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
    await flushAsyncWork()

    await openPicker()
    await openSubmenu(/Model/)
    expect(queryByRole(document.body, 'menuitemradio', { name: 'Claude Fable 5.1' })).toBeNull()
    expect(catalogApiMock.fetchManagerSelectionCatalog).toHaveBeenCalledTimes(3)
  })

  it('keeps an unavailable current OpenRouter model as a disabled current option', async () => {
    catalogApiMock.fetchManagerSelectionCatalog.mockResolvedValue(makeManagerSelectionCatalog({
      models: [
        ...makeManagerSelectionCatalog().models,
        {
          ...OPENROUTER_GLM,
          surfaces: {
            create: { selectable: false, unavailableReason: 'disabled' },
            change: { selectable: false, unavailableReason: 'disabled' },
          },
        },
      ],
    }))

    const onUpdate = vi.fn()
    renderPicker(onUpdate, {
      currentModel: { provider: 'openrouter', modelId: OPENROUTER_GLM.modelId, thinkingLevel: 'medium' },
    })
    await openPicker()
    await openSubmenu(/Model/)
    const current = getByRole(document.body, 'menuitemradio', { name: /Z.ai: GLM 5.1/ })
    expect(current.getAttribute('data-disabled')).toBe('')
    expect(current.textContent).toContain('Current')
  })
})
