/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Default mock: all manager models disabled via managerEnabled overrides
// so that availableRows ends up empty after successful load.
vi.mock('@/components/settings/models-api', () => ({
  fetchModelOverrides: vi.fn().mockResolvedValue({
    version: 1,
    overrides: {},
    providerAvailability: {
      // All managed-auth providers explicitly unavailable
      'openai-codex': false,
      'anthropic': false,
      'claude-sdk': false,
      'xai': false,
    },
  }),
}))

const { CreateManagerDialog } = await import('./CreateManagerDialog')

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

function findSubmitButton(): HTMLButtonElement | null {
  return document.body.querySelector('button[type="submit"]')
}

describe('CreateManagerDialog', () => {
  describe('empty available models', () => {
    it('disables submit and shows guidance when no manager models are available', async () => {
      const props = {
        open: true,
        wsUrl: undefined as string | undefined,
        isCreatingManager: false,
        isValidatingDirectory: false,
        isPickingDirectory: false,
        newManagerName: 'test',
        newManagerCwd: '/tmp/test',
        newManagerModelSelection: undefined,
        createManagerError: null,
        browseError: null,
        onOpenChange: vi.fn(),
        onNameChange: vi.fn(),
        onCwdChange: vi.fn(),
        onModelSelectionChange: vi.fn(),
        onBrowseDirectory: vi.fn(),
        onSubmit: vi.fn(),
      }

      await act(async () => {
        root = createRoot(container)
        root.render(createElement(CreateManagerDialog, props))
      })

      const dialog = document.body.querySelector('[role="dialog"]')

      // Should show empty-state guidance
      expect(dialog?.textContent).toContain('No manager models are currently available')
      expect(dialog?.textContent).toContain('Settings')
      expect(dialog?.textContent).toContain('Models')

      // Submit should be disabled
      const submitButton = findSubmitButton()
      expect(submitButton).toBeTruthy()
      expect(submitButton!.disabled).toBe(true)

      // onModelSelectionChange should never have been called (no auto-select)
      expect(props.onModelSelectionChange).not.toHaveBeenCalled()
    })
  })
})
