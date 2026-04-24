/** @vitest-environment jsdom */

import { fireEvent, getByRole, getByText, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsModels } from './SettingsModels'
import type { ModelOverrideEntry } from '@forge/protocol'

const modelsApiMock = vi.hoisted(() => ({
  fetchModelOverrides: vi.fn(),
  updateModelOverride: vi.fn(),
  deleteModelOverride: vi.fn(),
  resetAllModelOverrides: vi.fn(),
}))

vi.mock('./models-api', () => ({
  fetchModelOverrides: (...args: Parameters<typeof modelsApiMock.fetchModelOverrides>) =>
    modelsApiMock.fetchModelOverrides(...args),
  updateModelOverride: (...args: Parameters<typeof modelsApiMock.updateModelOverride>) =>
    modelsApiMock.updateModelOverride(...args),
  deleteModelOverride: (...args: Parameters<typeof modelsApiMock.deleteModelOverride>) =>
    modelsApiMock.deleteModelOverride(...args),
  resetAllModelOverrides: (...args: Parameters<typeof modelsApiMock.resetAllModelOverrides>) =>
    modelsApiMock.resetAllModelOverrides(...args),
}))

vi.mock('./SettingsOpenRouter', () => ({
  SettingsOpenRouter: () => null,
}))

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  modelsApiMock.updateModelOverride.mockResolvedValue(undefined)
  modelsApiMock.deleteModelOverride.mockResolvedValue(undefined)
  modelsApiMock.resetAllModelOverrides.mockResolvedValue(undefined)
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

async function renderSettingsModels(overrides: Record<string, ModelOverrideEntry>): Promise<void> {
  modelsApiMock.fetchModelOverrides.mockResolvedValue({
    version: 1,
    overrides,
    providerAvailability: {
      'openai-codex': true,
      anthropic: true,
      xai: true,
    },
  })

  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(SettingsModels, { wsUrl: 'ws://127.0.0.1:47187', modelConfigChangeKey: 0 }))
  })

  await flushPromises()
  await flushPromises()
  await expandAllProviderGroups()
}

async function expandAllProviderGroups(): Promise<void> {
  const collapsedButtons = Array.from(container.querySelectorAll('button[aria-expanded="false"]'))

  for (const button of collapsedButtons) {
    flushSync(() => {
      fireEvent.click(button)
    })
  }

  await flushPromises()
}

async function expandProvider(providerDisplayName: string): Promise<void> {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) =>
      candidate.getAttribute('aria-expanded') === 'false' &&
      candidate.textContent?.includes(providerDisplayName),
  )

  if (!button) {
    // Already expanded or not found — silently skip
    return
  }

  flushSync(() => {
    fireEvent.click(button)
  })
  await flushPromises()
}

async function expandModel(displayName: string): Promise<void> {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.includes(displayName) && candidate.textContent?.includes('Context'),
  )

  if (!button) {
    throw new Error(`Unable to find card toggle button for ${displayName}`)
  }

  flushSync(() => {
    fireEvent.click(button)
  })
  await flushPromises()
}

describe('SettingsModels', () => {
  it('shows the built-in default instructions when no override exists', async () => {
    await renderSettingsModels({})
    await expandProvider('OpenAI Codex')
    await expandModel('GPT-5.3 Codex')

    expect(getByText(container, 'Using built-in default')).toBeTruthy()
    const textarea = getByRole(container, 'textbox') as HTMLTextAreaElement
    expect(textarea.value).toContain('Return the requested sections only, in the requested order.')
  })

  it('shows custom override text when present', async () => {
    await renderSettingsModels({
      'gpt-5.3-codex': {
        modelSpecificInstructions: 'Custom override text',
      },
    })
    await expandProvider('OpenAI Codex')
    await expandModel('GPT-5.3 Codex')

    expect(getByText(container, 'Custom override active')).toBeTruthy()
    const textarea = getByRole(container, 'textbox') as HTMLTextAreaElement
    expect(textarea.value).toBe('Custom override text')
  })

  it('shows an empty state for models without built-in defaults', async () => {
    await renderSettingsModels({})
    await expandProvider('xAI')
    await expandModel('Grok 4')

    expect(getByText(container, 'No built-in instructions for this model')).toBeTruthy()
    const textarea = getByRole(container, 'textbox') as HTMLTextAreaElement
    expect(textarea.value).toBe('')
    expect(textarea.placeholder).toBe('No built-in instructions for this model.')
  })

  it('disables Reset all button while a card-level save is in flight', async () => {
    // Use a deferred promise so the save stays in-flight
    let resolveSave!: () => void
    const savePromise = new Promise<void>((resolve) => { resolveSave = resolve })
    modelsApiMock.updateModelOverride.mockReturnValueOnce(savePromise)

    await renderSettingsModels({
      'gpt-5.3-codex': { enabled: false },
    })

    await expandProvider('OpenAI Codex')
    await expandModel('GPT-5.3 Codex')

    // Find and click the Enabled switch to trigger a save
    const enabledSwitch = container.querySelector('button[role="switch"]') as HTMLButtonElement
    expect(enabledSwitch).toBeTruthy()
    flushSync(() => {
      fireEvent.click(enabledSwitch)
    })
    await flushPromises()

    // While save is in flight, Reset all should be disabled
    const resetAllButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Reset all'),
    )
    expect(resetAllButton).toBeTruthy()
    expect(resetAllButton!.disabled).toBe(true)

    // Complete the save
    resolveSave()
    // Re-fetch resolves with overrides so the button state updates
    modelsApiMock.fetchModelOverrides.mockResolvedValueOnce({
      version: 1,
      overrides: { 'gpt-5.3-codex': { enabled: true } },
      providerAvailability: { 'openai-codex': true, anthropic: true, xai: true },
    })
    await flushPromises()
    await flushPromises()

    // Now Reset all should be enabled again (has overrides, no saves in flight)
    const resetAllAfter = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Reset all'),
    )
    expect(resetAllAfter).toBeTruthy()
    expect(resetAllAfter!.disabled).toBe(false)
  })

  it('keeps Reset all disabled when provider section is collapsed during a card save', async () => {
    // Deferred save — stays in-flight until we resolve it
    let resolveSave!: () => void
    const savePromise = new Promise<void>((resolve) => { resolveSave = resolve })
    modelsApiMock.updateModelOverride.mockReturnValueOnce(savePromise)

    await renderSettingsModels({
      'gpt-5.3-codex': { enabled: false },
    })

    await expandProvider('OpenAI Codex')
    await expandModel('GPT-5.3 Codex')

    // Trigger an in-flight save
    const enabledSwitch = container.querySelector('button[role="switch"]') as HTMLButtonElement
    expect(enabledSwitch).toBeTruthy()
    flushSync(() => {
      fireEvent.click(enabledSwitch)
    })
    await flushPromises()

    // Reset all should be disabled while save is in flight
    let resetAllButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Reset all'),
    )
    expect(resetAllButton!.disabled).toBe(true)

    // Collapse the provider section — this unmounts the ModelCard
    const providerToggle = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-expanded') === 'true' && b.textContent?.includes('OpenAI Codex'),
    )
    expect(providerToggle).toBeTruthy()
    flushSync(() => {
      fireEvent.click(providerToggle!)
    })
    await flushPromises()

    // After unmount, Reset all should STILL be disabled — the request is still in flight
    resetAllButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Reset all'),
    )
    expect(resetAllButton).toBeTruthy()
    expect(resetAllButton!.disabled).toBe(true)

    // Now resolve the save — Reset all should re-enable
    resolveSave()
    modelsApiMock.fetchModelOverrides.mockResolvedValueOnce({
      version: 1,
      overrides: { 'gpt-5.3-codex': { enabled: true } },
      providerAvailability: { 'openai-codex': true, anthropic: true, xai: true },
    })
    await flushPromises()
    await flushPromises()

    resetAllButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Reset all'),
    )
    expect(resetAllButton).toBeTruthy()
    expect(resetAllButton!.disabled).toBe(false)
  })

  it('disables Reset all during an inline Enabled reset', async () => {
    // Deferred save that stays in-flight
    let resolveSave!: () => void
    const savePromise = new Promise<void>((resolve) => { resolveSave = resolve })
    modelsApiMock.updateModelOverride.mockReturnValueOnce(savePromise)

    await renderSettingsModels({
      'gpt-5.3-codex': { enabled: false },
    })

    await expandProvider('OpenAI Codex')
    await expandModel('GPT-5.3 Codex')

    // Find the "Reset" button inside the Enabled section — it's the first Reset in the card
    const resetButtons = Array.from(container.querySelectorAll('button')).filter(
      (b) => b.textContent?.trim() === 'Reset' && !b.textContent?.includes('Reset all') && !b.textContent?.includes('Reset model'),
    )
    // Click the first card-level Reset (Enabled)
    expect(resetButtons.length).toBeGreaterThan(0)
    flushSync(() => {
      fireEvent.click(resetButtons[0])
    })
    await flushPromises()

    // Reset all should be disabled while inline reset is in flight
    const resetAllButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Reset all'),
    )
    expect(resetAllButton).toBeTruthy()
    expect(resetAllButton!.disabled).toBe(true)

    // Complete the save
    resolveSave()
    modelsApiMock.fetchModelOverrides.mockResolvedValueOnce({
      version: 1,
      overrides: {},
      providerAvailability: { 'openai-codex': true, anthropic: true, xai: true },
    })
    await flushPromises()
    await flushPromises()

    // Reset all should be disabled now (no overrides remain)
    const resetAllAfter = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Reset all'),
    )
    expect(resetAllAfter!.disabled).toBe(true)
  })

  it('disables Reset all during an inline Manager agents reset', async () => {
    let resolveSave!: () => void
    const savePromise = new Promise<void>((resolve) => { resolveSave = resolve })
    modelsApiMock.updateModelOverride.mockReturnValueOnce(savePromise)

    await renderSettingsModels({
      'gpt-5.3-codex': { managerEnabled: false },
    })

    await expandProvider('OpenAI Codex')
    await expandModel('GPT-5.3 Codex')

    // Find the "Reset" button in the Manager agents section
    // The Manager agents section contains the text "Manager agents" — find the enclosing div,
    // then look for a Reset button within it.
    const allButtons = Array.from(container.querySelectorAll('button'))
    const managerResetButton = allButtons.find((b) => {
      if (b.textContent?.trim() !== 'Reset') return false
      // Walk up to find an ancestor that has "Manager agents" in its text
      const parent = b.closest('.space-y-1\\.5')
      return parent?.textContent?.includes('Manager agents')
    })
    expect(managerResetButton).toBeTruthy()

    flushSync(() => {
      fireEvent.click(managerResetButton!)
    })
    await flushPromises()

    // Reset all should be disabled while Manager agents reset is in flight
    const resetAllButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Reset all'),
    )
    expect(resetAllButton).toBeTruthy()
    expect(resetAllButton!.disabled).toBe(true)

    // Complete the save
    resolveSave()
    modelsApiMock.fetchModelOverrides.mockResolvedValueOnce({
      version: 1,
      overrides: {},
      providerAvailability: { 'openai-codex': true, anthropic: true, xai: true },
    })
    await flushPromises()
    await flushPromises()

    // No overrides remain, so Reset all should be disabled (no overrides to reset)
    const resetAllAfter = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Reset all'),
    )
    expect(resetAllAfter!.disabled).toBe(true)
  })

  it('disables Reset all during an inline Context cap reset', async () => {
    let resolveSave!: () => void
    const savePromise = new Promise<void>((resolve) => { resolveSave = resolve })
    modelsApiMock.updateModelOverride.mockReturnValueOnce(savePromise)

    await renderSettingsModels({
      'gpt-5.3-codex': { contextWindowCap: 50000 },
    })

    await expandProvider('OpenAI Codex')
    await expandModel('GPT-5.3 Codex')

    // Find the "Reset" button in the Context window cap section
    const allButtons = Array.from(container.querySelectorAll('button'))
    const capResetButton = allButtons.find((b) => {
      if (b.textContent?.trim() !== 'Reset') return false
      const parent = b.closest('.space-y-1\\.5')
      return parent?.textContent?.includes('Context window cap')
    })
    expect(capResetButton).toBeTruthy()

    flushSync(() => {
      fireEvent.click(capResetButton!)
    })
    await flushPromises()

    // Reset all should be disabled while Context cap reset is in flight
    const resetAllButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Reset all'),
    )
    expect(resetAllButton).toBeTruthy()
    expect(resetAllButton!.disabled).toBe(true)

    // Complete the save
    resolveSave()
    modelsApiMock.fetchModelOverrides.mockResolvedValueOnce({
      version: 1,
      overrides: {},
      providerAvailability: { 'openai-codex': true, anthropic: true, xai: true },
    })
    await flushPromises()
    await flushPromises()

    // No overrides remain, so Reset all should be disabled
    const resetAllAfter = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Reset all'),
    )
    expect(resetAllAfter!.disabled).toBe(true)
  })

  it('resets back to the built-in default view', async () => {
    modelsApiMock.fetchModelOverrides
      .mockResolvedValueOnce({
        version: 1,
        overrides: {
          'gpt-5.3-codex': {
            modelSpecificInstructions: 'Custom override text',
          },
        },
        providerAvailability: {
          'openai-codex': true,
          anthropic: true,
          xai: true,
        },
      })
      .mockResolvedValueOnce({
        version: 1,
        overrides: {},
        providerAvailability: {
          'openai-codex': true,
          anthropic: true,
          xai: true,
        },
      })

    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(SettingsModels, { wsUrl: 'ws://127.0.0.1:47187', modelConfigChangeKey: 0 }))
    })

    await flushPromises()
    await flushPromises()
    await expandAllProviderGroups()

    await expandProvider('OpenAI Codex')
    await expandModel('GPT-5.3 Codex')
    const textarea = getByRole(container, 'textbox') as HTMLTextAreaElement
    const section = textarea.parentElement
    if (!section) {
      throw new Error('Unable to find instructions section')
    }

    fireEvent.click(getByText(section, 'Reset'))

    await waitFor(() => {
      expect(modelsApiMock.updateModelOverride).toHaveBeenCalledWith('ws://127.0.0.1:47187', 'gpt-5.3-codex', {
        modelSpecificInstructions: null,
      })
      expect(getByText(container, 'Using built-in default')).toBeTruthy()
      expect((getByRole(container, 'textbox') as HTMLTextAreaElement).value).toContain(
        'Return the requested sections only, in the requested order.',
      )
    })
  })
})
