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
    await expandModel('GPT-5.3 Codex')

    expect(getByText(container, 'Custom override active')).toBeTruthy()
    const textarea = getByRole(container, 'textbox') as HTMLTextAreaElement
    expect(textarea.value).toBe('Custom override text')
  })

  it('shows an empty state for models without built-in defaults', async () => {
    await renderSettingsModels({})
    await expandModel('Grok 4')

    expect(getByText(container, 'No built-in instructions for this model')).toBeTruthy()
    const textarea = getByRole(container, 'textbox') as HTMLTextAreaElement
    expect(textarea.value).toBe('')
    expect(textarea.placeholder).toBe('No built-in instructions for this model.')
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
