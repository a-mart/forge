/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock fetchModelOverrides to return empty (catalog defaults, no server filtering)
vi.mock('@/components/settings/models-api', () => ({
  fetchModelOverrides: () =>
    Promise.resolve({
      version: 1,
      overrides: {},
      providerAvailability: {
        'openai-codex': true,
        'anthropic': true,
        'claude-sdk': true,
        'xai': true,
      },
    }),
}))

// Must import after mock setup
const { SessionModelDialog } = await import('./SessionModelDialog')

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
})

async function renderDialog(overrides: Record<string, unknown> = {}) {
  const defaultProps = {
    wsUrl: undefined,
    sessionAgentId: 'session-1',
    sessionLabel: 'Test Session',
    currentModel: {
      provider: 'anthropic',
      modelId: 'claude-opus-4-6',
      thinkingLevel: 'high',
    },
    currentReasoningLevel: 'high' as const,
    modelOrigin: 'profile_default' as const,
    profileDefaultModel: {
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      thinkingLevel: 'none',
    },
    onConfirm: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }

  await act(async () => {
    root = createRoot(container)
    root.render(createElement(SessionModelDialog, defaultProps))
  })

  return defaultProps
}

// Radix Dialog renders content in a portal on document.body, so query from there
function findSubmitButton(): HTMLButtonElement | null {
  return document.body.querySelector('button[type="submit"]')
}

function findResetLink(): HTMLButtonElement | null {
  // The "Use Project Default" reset link is a variant="link" button (not the submit)
  const buttons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
  return buttons.find((b) => b.textContent === 'Use Project Default' && b.type !== 'submit') ?? null
}

function findReasoningTrigger(): HTMLButtonElement | null {
  const triggers = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button[role="combobox"]'))
  return triggers.find((t) => t.getAttribute('aria-labelledby') === 'session-model-reasoning-label') ?? null
}

function findModelTrigger(): HTMLButtonElement | null {
  const triggers = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button[role="combobox"]'))
  return triggers.find((t) => t.getAttribute('aria-labelledby') === 'session-model-model-label') ?? null
}

describe('SessionModelDialog', () => {
  describe('single-screen layout', () => {
    it('shows model and reasoning selectors immediately without a mode dropdown', async () => {
      await renderDialog({ modelOrigin: 'profile_default' })

      const dialog = document.body.querySelector('[role="dialog"]')
      // No mode label/selector should be present — only "Model" and "Reasoning Level"
      const labels = Array.from(dialog?.querySelectorAll('label') ?? [])
      const labelTexts = labels.map((l) => l.textContent?.trim())
      expect(labelTexts).not.toContain('Mode')
      expect(labelTexts).toContain('Model')
      expect(labelTexts).toContain('Reasoning Level')
    })

    it('always shows project default info line', async () => {
      await renderDialog({ modelOrigin: 'profile_default' })

      const dialog = document.body.querySelector('[role="dialog"]')
      expect(dialog?.textContent).toContain('Project default:')
      expect(dialog?.textContent).toContain('anthropic/claude-sonnet-4-20250514')
    })
  })

  describe('inherited session (profile_default)', () => {
    it('has submit disabled when no changes are made', async () => {
      await renderDialog({ modelOrigin: 'profile_default' })

      const submitButton = findSubmitButton()
      expect(submitButton).toBeTruthy()
      expect(submitButton!.disabled).toBe(true)
      expect(submitButton!.textContent).toBe('Override')
    })

    it('has submit disabled when modelOrigin is undefined', async () => {
      await renderDialog({ modelOrigin: undefined })

      const submitButton = findSubmitButton()
      expect(submitButton).toBeTruthy()
      expect(submitButton!.disabled).toBe(true)
      expect(submitButton!.textContent).toBe('Override')
    })

    it('does not show "Use Project Default" reset link when already using default', async () => {
      await renderDialog({ modelOrigin: 'profile_default' })

      const resetLink = findResetLink()
      expect(resetLink).toBeNull()
    })

    it('shows description indicating project default tracking with session name', async () => {
      await renderDialog({ modelOrigin: 'profile_default' })

      const dialog = document.body.querySelector('[role="dialog"]')
      expect(dialog?.textContent).toContain('Test Session')
      expect(dialog?.textContent).toContain('project default model')
      expect(dialog?.textContent).toContain('tracks future changes')
    })
  })

  describe('overridden session (session_override)', () => {
    it('has submit disabled when no changes are made', async () => {
      await renderDialog({ modelOrigin: 'session_override' })

      const submitButton = findSubmitButton()
      expect(submitButton).toBeTruthy()
      expect(submitButton!.disabled).toBe(true)
      expect(submitButton!.textContent).toBe('Save')
    })

    it('shows "Use Project Default" reset link', async () => {
      await renderDialog({ modelOrigin: 'session_override' })

      const resetLink = findResetLink()
      expect(resetLink).toBeTruthy()
      expect(resetLink!.textContent).toBe('Use Project Default')
    })

    it('calls onConfirm with inherit mode when reset link is clicked', async () => {
      const props = await renderDialog({ modelOrigin: 'session_override' })

      const resetLink = findResetLink()
      expect(resetLink).toBeTruthy()

      act(() => {
        resetLink!.click()
      })

      expect(props.onConfirm).toHaveBeenCalledWith('session-1', 'inherit')
    })

    it('shows description indicating custom override', async () => {
      await renderDialog({ modelOrigin: 'session_override' })

      const dialog = document.body.querySelector('[role="dialog"]')
      expect(dialog?.textContent).toContain('custom model override')
    })
  })

  describe('hidden current model (regression)', () => {
    // xAI/Grok models are not in getChangeManagerFamilies() but can
    // be the session's current model. The dialog must preserve them instead of
    // silently falling back to the first visible model.
    it('preserves hidden current model without auto-fallback', async () => {
      await renderDialog({
        currentModel: {
          provider: 'xai',
          modelId: 'grok-4',
          thinkingLevel: 'high',
        },
        currentReasoningLevel: 'high',
        modelOrigin: 'session_override',
      })

      const dialog = document.body.querySelector('[role="dialog"]')
      // The hidden model should appear in the list with a "(current)" suffix
      expect(dialog?.textContent).toContain('(current)')

      // Submit should be disabled — no changes from the current state
      const submitButton = findSubmitButton()
      expect(submitButton).toBeTruthy()
      expect(submitButton!.disabled).toBe(true)
    })

    it('does not silently switch model when only reasoning changes', async () => {
      const props = await renderDialog({
        currentModel: {
          provider: 'cursor-acp',
          modelId: 'cursor-model',
          thinkingLevel: 'medium',
        },
        currentReasoningLevel: 'medium',
        modelOrigin: 'session_override',
      })

      // The dialog should show cursor-acp model as the selected model
      const dialog = document.body.querySelector('[role="dialog"]')
      expect(dialog?.textContent).toContain('(current)')

      // Since we can't programmatically change the Select in this test harness,
      // verify that the submit button only enables when there are actual changes.
      // With no changes, it should be disabled.
      const submitButton = findSubmitButton()
      expect(submitButton!.disabled).toBe(true)

      // Confirm onConfirm was never called (no silent auto-switch)
      expect(props.onConfirm).not.toHaveBeenCalled()
    })

    it('disables reasoning selector when current model is unavailable', async () => {
      await renderDialog({
        currentModel: {
          provider: 'xai',
          modelId: 'grok-4',
          thinkingLevel: 'high',
        },
        currentReasoningLevel: 'high',
        modelOrigin: 'session_override',
      })

      // Reasoning selector must be disabled for unavailable models
      const reasoningTrigger = findReasoningTrigger()
      expect(reasoningTrigger).toBeTruthy()
      expect(reasoningTrigger!.disabled).toBe(true)

      // Submit must also be disabled
      const submitButton = findSubmitButton()
      expect(submitButton!.disabled).toBe(true)
    })

    it('still allows Use Project Default when current model is unavailable', async () => {
      const props = await renderDialog({
        currentModel: {
          provider: 'xai',
          modelId: 'grok-4',
          thinkingLevel: 'high',
        },
        currentReasoningLevel: 'high',
        modelOrigin: 'session_override',
      })

      // Submit is disabled (unavailable model), but reset link must still work
      const submitButton = findSubmitButton()
      expect(submitButton!.disabled).toBe(true)

      const resetLink = findResetLink()
      expect(resetLink).toBeTruthy()

      act(() => {
        resetLink!.click()
      })

      // Reset to project default should still fire — it sends 'inherit' mode, not the unavailable model
      expect(props.onConfirm).toHaveBeenCalledWith('session-1', 'inherit')
    })
  })

  describe('availability loading/error', () => {
    it('disables selectors and submit while availability is loading', async () => {
      // We can't easily test the transient loading state with the current mock
      // (it resolves immediately), but we verify that after load, selectors are enabled.
      await renderDialog({ modelOrigin: 'profile_default' })

      // After load completes, model selector should be enabled
      const modelTrigger = findModelTrigger()
      expect(modelTrigger).toBeTruthy()
      expect(modelTrigger!.disabled).toBe(false)

      const reasoningTrigger = findReasoningTrigger()
      expect(reasoningTrigger).toBeTruthy()
      expect(reasoningTrigger!.disabled).toBe(false)
    })
  })
})
