/** @vitest-environment jsdom */

import { fireEvent, getByLabelText, getByRole, getByText, queryByLabelText, queryByRole } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getOpenRouterModelOverrideKey, type OpenRouterModelEntry } from '@forge/protocol'

const modelsApiMock = vi.hoisted(() => ({
  updateModelOverride: vi.fn(),
}))

vi.mock('./models-api', () => ({
  updateModelOverride: (...args: unknown[]) => modelsApiMock.updateModelOverride(...args),
}))

const { OpenRouterModelCard } = await import('./OpenRouterModelCard')

let container: HTMLDivElement
let root: Root | null = null

function toolCapableModel(overrides: Partial<OpenRouterModelEntry> = {}): OpenRouterModelEntry {
  return {
    modelId: 'z-ai/glm-5.1',
    displayName: 'Z.ai: GLM 5.1',
    contextWindow: 202_752,
    maxOutputTokens: 202_752,
    supportsReasoning: true,
    supportedReasoningLevels: ['none', 'low', 'medium', 'high'],
    inputModes: ['text'],
    addedAt: '2026-04-03T00:00:00.000Z',
    supportsTools: true,
    ...overrides,
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  modelsApiMock.updateModelOverride.mockResolvedValue(undefined)
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
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

function renderCard(props: {
  model?: OpenRouterModelEntry
  override?: { managerEnabled?: boolean; contextWindowCap?: number }
} = {}): { onRefresh: ReturnType<typeof vi.fn> } {
  const onRefresh = vi.fn(async () => {})
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(OpenRouterModelCard, {
      clientOrWsUrl: 'ws://127.0.0.1:47187',
      model: props.model ?? toolCapableModel(),
      override: props.override,
      onRemove: vi.fn(),
      isRemoving: false,
      onRefresh,
    }))
  })
  return { onRefresh }
}

describe('OpenRouterModelCard manager toggle', () => {
  it('defaults Manager agents off for a verified tool-capable model', () => {
    renderCard()

    expect(getByText(container, 'Manager agents')).toBeTruthy()
    expect(getByText(container, 'Show this model in manager create/change selectors.')).toBeTruthy()
    expect(getByText(container, 'Tools')).toBeTruthy()
    const toggle = getByLabelText(container, 'Enable Z.ai: GLM 5.1 for manager agents')
    expect(toggle.getAttribute('data-state')).toBe('unchecked')
    expect(getByRole(container, 'button', { name: 'Reset' })).toHaveProperty('disabled', true)
  })

  it('enables the model through the existing openrouter override key and then allows reset', async () => {
    const { onRefresh } = renderCard()
    const overrideKey = getOpenRouterModelOverrideKey('z-ai/glm-5.1')

    fireEvent.click(getByLabelText(container, 'Enable Z.ai: GLM 5.1 for manager agents'))
    await flushPromises()

    expect(modelsApiMock.updateModelOverride).toHaveBeenCalledWith('ws://127.0.0.1:47187', overrideKey, {
      managerEnabled: true,
    })
    expect(onRefresh).toHaveBeenCalledTimes(1)

    flushSync(() => {
      root?.render(createElement(OpenRouterModelCard, {
        clientOrWsUrl: 'ws://127.0.0.1:47187',
        model: toolCapableModel(),
        override: { managerEnabled: true },
        onRemove: vi.fn(),
        isRemoving: false,
        onRefresh,
      }))
    })

    expect(getByLabelText(container, 'Enable Z.ai: GLM 5.1 for manager agents').getAttribute('data-state')).toBe('checked')
    expect(getByText(container, 'Override')).toBeTruthy()
    const reset = getByRole(container, 'button', { name: 'Reset' })
    expect(reset).toHaveProperty('disabled', false)

    fireEvent.click(reset)
    await flushPromises()

    expect(modelsApiMock.updateModelOverride).toHaveBeenLastCalledWith('ws://127.0.0.1:47187', overrideKey, {
      managerEnabled: null,
    })
  })

  it('explains and hides the switch when tools are unsupported', () => {
    renderCard({ model: toolCapableModel({ supportsTools: false }), override: { managerEnabled: true } })

    expect(queryByLabelText(container, /manager agents/i)).toBeNull()
    expect(queryByRole(container, 'button', { name: 'Reset' })).toBeNull()
    expect(getByText(container, 'No tools')).toBeTruthy()
    expect(getByText(container, 'Not supported for manager agents. This model does not advertise tool calling.')).toBeTruthy()
  })

  it('explains and hides the switch when tools are unverified', () => {
    const unverified = toolCapableModel()
    delete (unverified as { supportsTools?: boolean }).supportsTools
    renderCard({ model: unverified, override: { managerEnabled: true } })

    expect(queryByLabelText(container, /manager agents/i)).toBeNull()
    expect(getByText(container, 'Tools unverified')).toBeTruthy()
    expect(getByText(container, 'Tool support could not be verified from OpenRouter. Reload this section to retry.')).toBeTruthy()
  })
})


describe('OpenRouter context window', () => {
  it('saves only a cap through the canonical key and resets only the cap', async () => {
    const { onRefresh } = renderCard({ override: { managerEnabled: true, contextWindowCap: 80000 } })
    const input = getByRole(container, 'spinbutton')
    fireEvent.input(input, { target: { value: '50000' } })
    fireEvent.change(input, { target: { value: '50000' } })
    await flushPromises()
    fireEvent.click(getByRole(container, 'button', { name: 'Apply' }))
    await flushPromises()
    expect(modelsApiMock.updateModelOverride).toHaveBeenLastCalledWith(
      'ws://127.0.0.1:47187', getOpenRouterModelOverrideKey('z-ai/glm-5.1'), { contextWindowCap: 50000 },
    )
    expect(onRefresh).toHaveBeenCalledOnce()
    fireEvent.click(getByRole(container, 'button', { name: 'Reset context window' }))
    await flushPromises()
    expect(modelsApiMock.updateModelOverride).toHaveBeenLastCalledWith(
      'ws://127.0.0.1:47187', getOpenRouterModelOverrideKey('z-ai/glm-5.1'), { contextWindowCap: null },
    )
  })

  it('rejects invalid caps and lets a blank draft clear the cap', async () => {
    renderCard({ override: { contextWindowCap: 80000 } })
    const input = getByRole(container, 'spinbutton')
    for (const value of ['0', '-1', '1.5']) {
      fireEvent.change(input, { target: { value } })
      await flushPromises()
      expect(input.getAttribute('aria-invalid')).toBe('true')
      expect(getByRole(container, 'button', { name: 'Apply' })).toHaveProperty('disabled', true)
    }
    expect(modelsApiMock.updateModelOverride).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '' } })
    await flushPromises()
    fireEvent.click(getByRole(container, 'button', { name: 'Apply' }))
    await flushPromises()
    expect(modelsApiMock.updateModelOverride).toHaveBeenLastCalledWith(
      'ws://127.0.0.1:47187', getOpenRouterModelOverrideKey('z-ai/glm-5.1'), { contextWindowCap: null },
    )
  })

  it('keeps a draft across metadata refresh, clamps summary and resets drafts on model changes', async () => {
    renderCard({ override: { contextWindowCap: 80000 } })
    fireEvent.change(getByRole(container, 'spinbutton'), { target: { value: '70000' } })
    await flushPromises()
    const rerender = (model: OpenRouterModelEntry, cap?: number) => flushSync(() => {
      root?.render(createElement(OpenRouterModelCard, {
        clientOrWsUrl: 'ws://127.0.0.1:47187', model, override: { contextWindowCap: cap },
        onRemove: vi.fn(), isRemoving: false, onRefresh: vi.fn(async () => {}),
      }))
    })
    rerender(toolCapableModel({ contextWindow: 60000 }), 80000)
    await flushPromises()
    expect(getByRole(container, 'spinbutton')).toHaveProperty('value', '70000')
    expect(getByText(container, /60k effective.*60k default maximum/i)).toBeTruthy()
    rerender(toolCapableModel({ modelId: 'other/model' }), 30000)
    await flushPromises()
    expect(getByRole(container, 'spinbutton')).toHaveProperty('value', '30000')
    expect(modelsApiMock.updateModelOverride).not.toHaveBeenCalled()
  })

  it('surfaces save failure without discarding the draft', async () => {
    renderCard()
    modelsApiMock.updateModelOverride.mockRejectedValueOnce(new Error('Save failed'))
    fireEvent.change(getByRole(container, 'spinbutton'), { target: { value: '50000' } })
    await flushPromises()
    fireEvent.click(getByRole(container, 'button', { name: 'Apply' }))
    await flushPromises()
    expect(getByRole(container, 'alert').textContent).toBe('Save failed')
    expect(getByRole(container, 'spinbutton')).toHaveProperty('value', '50000')
  })
})
