/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock useModelPresets to return empty (static families only, no server filtering)
vi.mock('@/lib/model-preset', () => ({
  useModelPresets: () => [],
  inferModelPreset: () => undefined,
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

function renderDialog(overrides: Record<string, unknown> = {}) {
  const defaultProps = {
    wsUrl: undefined,
    sessionAgentId: 'session-1',
    sessionLabel: 'Test Session',
    currentPreset: 'pi-opus' as const,
    currentReasoningLevel: 'xhigh' as const,
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

  act(() => {
    root = createRoot(container)
    root.render(createElement(SessionModelDialog, defaultProps))
  })
}

// Radix Dialog renders content in a portal on document.body, so query from there
function findSubmitButton(): HTMLButtonElement | null {
  return document.body.querySelector('button[type="submit"]')
}

describe('SessionModelDialog', () => {
  describe('inherited session (profile_default)', () => {
    it('initializes in inherit mode with submit disabled', () => {
      renderDialog({ modelOrigin: 'profile_default' })

      const submitButton = findSubmitButton()
      expect(submitButton).toBeTruthy()
      expect(submitButton!.disabled).toBe(true)
      expect(submitButton!.textContent).toBe('Use Project Default')
    })

    it('initializes in inherit mode when modelOrigin is undefined', () => {
      renderDialog({ modelOrigin: undefined })

      const submitButton = findSubmitButton()
      expect(submitButton).toBeTruthy()
      expect(submitButton!.disabled).toBe(true)
      expect(submitButton!.textContent).toBe('Use Project Default')
    })

    it('shows project default description text', () => {
      renderDialog({ modelOrigin: 'profile_default' })

      const description = document.body.querySelector('[role="dialog"]')
      expect(description?.textContent).toContain('project default model')
      expect(description?.textContent).toContain('anthropic/claude-sonnet-4-20250514')
    })
  })

  describe('overridden session (session_override)', () => {
    it('initializes in override mode with submit disabled', () => {
      renderDialog({ modelOrigin: 'session_override' })

      const submitButton = findSubmitButton()
      expect(submitButton).toBeTruthy()
      // No changes yet, same model/reasoning — disabled
      expect(submitButton!.disabled).toBe(true)
      expect(submitButton!.textContent).toBe('Override')
    })
  })
})
