/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelOverridesResponse, OpenRouterModelEntry } from '@forge/protocol'

const modelsApiMock = vi.hoisted(() => ({
  fetchModelOverrides: vi.fn<(...args: unknown[]) => Promise<ModelOverridesResponse>>(() => Promise.resolve({
    version: 1,
    overrides: {},
    providerAvailability: {
      'openai-codex': true,
      anthropic: true,
      xai: true,
    },
    providerCredentials: {},
    discoveredModels: [],
    openRouterModels: [],
  })),
}))

vi.mock('@/components/settings/models-api', () => modelsApiMock)

// Must import after mock setup
const { ChangeModelDialog } = await import('./ChangeModelDialog')

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
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
  modelsApiMock.fetchModelOverrides.mockResolvedValue({
    version: 1,
    overrides: {},
    providerAvailability: {
      'openai-codex': true,
      anthropic: true,
      xai: true,
    },
    providerCredentials: {},
    discoveredModels: [],
    openRouterModels: [],
  })
})

async function renderDialog(overrides: Record<string, unknown> = {}) {
  const defaultProps = {
    wsUrl: undefined,
    profileId: 'profile-1',
    profileLabel: 'Test Profile',
    currentModel: {
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    },
    currentReasoningLevel: 'high' as const,
    onConfirm: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }

  await act(async () => {
    root = createRoot(container)
    root.render(createElement(ChangeModelDialog, defaultProps))
  })

  return defaultProps
}

function findSubmitButton(): HTMLButtonElement | null {
  return document.body.querySelector('button[type="submit"]')
}

function findReasoningTrigger(): HTMLButtonElement | null {
  const triggers = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button[role="combobox"]'))
  return triggers.find((t) => t.getAttribute('aria-labelledby') === 'change-model-reasoning-label') ?? null
}

function findModelTrigger(): HTMLButtonElement | null {
  const triggers = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button[role="combobox"]'))
  return triggers.find((t) => t.getAttribute('aria-labelledby') === 'change-model-model-label') ?? null
}

describe('ChangeModelDialog', () => {
  describe('hidden current model (unavailable)', () => {
    it('disables submit and reasoning selector when current model is unavailable', async () => {
      await renderDialog({
        currentModel: {
          provider: 'xai',
          modelId: 'grok-build',
          thinkingLevel: 'high',
        },
        currentReasoningLevel: 'high',
      })

      const dialog = document.body.querySelector('[role="dialog"]')
      expect(dialog?.textContent).toContain('(current)')

      // Submit must be disabled — the selected model is unavailable
      const submitButton = findSubmitButton()
      expect(submitButton).toBeTruthy()
      expect(submitButton!.disabled).toBe(true)

      // Reasoning selector must be disabled
      const reasoningTrigger = findReasoningTrigger()
      expect(reasoningTrigger).toBeTruthy()
      expect(reasoningTrigger!.disabled).toBe(true)
    })

    it('does not call onConfirm when unavailable model is selected', async () => {
      const props = await renderDialog({
        currentModel: {
          provider: 'cursor-sdk',
          modelId: 'cursor-model',
          thinkingLevel: 'medium',
        },
        currentReasoningLevel: 'medium',
      })

      // Even though the dialog is open, submit should be disabled
      const submitButton = findSubmitButton()
      expect(submitButton!.disabled).toBe(true)

      // Force-click the disabled submit — onConfirm must not fire
      act(() => {
        submitButton!.click()
      })

      expect(props.onConfirm).not.toHaveBeenCalled()
    })
  })

  describe('availability loading/error', () => {
    it('selectors are enabled after availability loads successfully', async () => {
      await renderDialog()

      const modelTrigger = findModelTrigger()
      expect(modelTrigger).toBeTruthy()
      expect(modelTrigger!.disabled).toBe(false)

      const reasoningTrigger = findReasoningTrigger()
      expect(reasoningTrigger).toBeTruthy()
      expect(reasoningTrigger!.disabled).toBe(false)
    })
  })

  describe('fetch failure', () => {
    it('disables selectors and submit, shows error with retry on fetch failure', async () => {
      // Override the mock for this test to simulate failure, then immediately restore
      // so the spy doesn't leak into other tests sharing this module mock.
      modelsApiMock.fetchModelOverrides.mockRejectedValueOnce(new Error('Network error'))

      const defaultProps = {
        wsUrl: undefined,
        profileId: 'profile-1',
        profileLabel: 'Test Profile',
        currentModel: {
          provider: 'anthropic',
          modelId: 'claude-opus-4-6',
          thinkingLevel: 'high',
        },
        currentReasoningLevel: 'high' as const,
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      }

      await act(async () => {
        root = createRoot(container)
        root.render(createElement(ChangeModelDialog, defaultProps))
      })

      const dialog = document.body.querySelector('[role="dialog"]')

      // Error message and retry should be shown
      expect(dialog?.textContent).toContain('Failed to load models')
      expect(dialog?.textContent).toContain('Retry')

      // Model selector should be disabled
      const modelTrigger = findModelTrigger()
      expect(modelTrigger!.disabled).toBe(true)

      // Submit should be disabled
      const submitButton = findSubmitButton()
      expect(submitButton!.disabled).toBe(true)
    })
  })

  describe('OpenRouter manager models', () => {
    const glm: OpenRouterModelEntry = {
      modelId: 'z-ai/glm-5.1',
      displayName: 'Z.ai: GLM 5.1',
      contextWindow: 202_752,
      maxOutputTokens: 202_752,
      supportsReasoning: true,
      supportedReasoningLevels: ['none', 'low', 'medium', 'high'],
      inputModes: ['text'],
      addedAt: '2026-04-03T00:00:00.000Z',
      supportsTools: true,
    }

    it('includes an enabled OpenRouter model in the change selector', async () => {
      modelsApiMock.fetchModelOverrides.mockResolvedValue({
        version: 1,
        overrides: { 'openrouter:z-ai/glm-5.1': { managerEnabled: true } },
        providerAvailability: {
          'openai-codex': true,
          anthropic: true,
          xai: true,
          openrouter: true,
        },
        providerCredentials: {},
        discoveredModels: [],
        openRouterModels: [glm],
      })

      await renderDialog()
      const dialog = document.body.querySelector('[role="dialog"]')
      expect(dialog?.textContent).toContain('Z.ai: GLM 5.1')
    })

    it('preserves an unavailable current OpenRouter model as a disabled current option', async () => {
      modelsApiMock.fetchModelOverrides.mockResolvedValue({
        version: 1,
        overrides: {},
        providerAvailability: {
          'openai-codex': true,
          anthropic: true,
          xai: true,
          openrouter: true,
        },
        providerCredentials: {},
        discoveredModels: [],
        openRouterModels: [glm],
      })

      await renderDialog({
        currentModel: {
          provider: 'openrouter',
          modelId: glm.modelId,
          thinkingLevel: 'medium',
        },
        currentReasoningLevel: 'medium',
      })

      const dialog = document.body.querySelector('[role="dialog"]')
      expect(dialog?.textContent).toContain('Z.ai: GLM 5.1')
      expect(dialog?.textContent).toContain('(current)')
      expect(findSubmitButton()?.disabled).toBe(true)
      expect(findReasoningTrigger()?.disabled).toBe(true)
    })
  })
})
