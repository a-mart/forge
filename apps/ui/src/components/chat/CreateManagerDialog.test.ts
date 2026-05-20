/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Radix UI components require ResizeObserver in jsdom
globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver

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

function findScaffoldCheckbox(): HTMLButtonElement | null {
  return document.body.querySelector('#scaffold-forge-resources')
}

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    wsUrl: undefined as string | undefined,
    isCreatingManager: false,
    isValidatingDirectory: false,
    isPickingDirectory: false,
    newManagerName: 'test',
    newManagerCwd: '/tmp/test',
    newManagerModelSelection: undefined,
    newManagerReasoningLevel: undefined,
    scaffoldForgeResources: true,
    createManagerError: null,
    browseError: null,
    onOpenChange: vi.fn(),
    onNameChange: vi.fn(),
    onCwdChange: vi.fn(),
    onModelSelectionChange: vi.fn(),
    onReasoningLevelChange: vi.fn(),
    onScaffoldForgeResourcesChange: vi.fn(),
    onBrowseDirectory: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  }
}

describe('CreateManagerDialog', () => {
  describe('empty available models', () => {
    it('disables submit and shows guidance when no manager models are available', async () => {
      const props = defaultProps()

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

  describe('scaffold forge resources checkbox', () => {
    it('renders checked by default when scaffoldForgeResources is true', async () => {
      const props = defaultProps({ scaffoldForgeResources: true })

      await act(async () => {
        root = createRoot(container)
        root.render(createElement(CreateManagerDialog, props))
      })

      const checkbox = findScaffoldCheckbox()
      expect(checkbox).toBeTruthy()
      expect(checkbox!.getAttribute('data-state')).toBe('checked')
      expect(checkbox!.getAttribute('aria-checked')).toBe('true')

      const dialog = document.body.querySelector('[role="dialog"]')
      expect(dialog?.textContent).toContain('Create .forge project resources')
      expect(dialog?.textContent).toContain('project-level skills, specialists, and extensions')
    })

    it('renders unchecked when scaffoldForgeResources is false', async () => {
      const props = defaultProps({ scaffoldForgeResources: false })

      await act(async () => {
        root = createRoot(container)
        root.render(createElement(CreateManagerDialog, props))
      })

      const checkbox = findScaffoldCheckbox()
      expect(checkbox).toBeTruthy()
      expect(checkbox!.getAttribute('data-state')).toBe('unchecked')
      expect(checkbox!.getAttribute('aria-checked')).toBe('false')
    })

    it('calls onScaffoldForgeResourcesChange when clicked', async () => {
      const props = defaultProps({ scaffoldForgeResources: true })

      await act(async () => {
        root = createRoot(container)
        root.render(createElement(CreateManagerDialog, props))
      })

      const checkbox = findScaffoldCheckbox()
      expect(checkbox).toBeTruthy()

      await act(async () => {
        checkbox!.click()
      })

      expect(props.onScaffoldForgeResourcesChange).toHaveBeenCalledWith(false)
    })

    it('is disabled while creating manager', async () => {
      const props = defaultProps({ isCreatingManager: true })

      await act(async () => {
        root = createRoot(container)
        root.render(createElement(CreateManagerDialog, props))
      })

      const checkbox = findScaffoldCheckbox()
      expect(checkbox).toBeTruthy()
      expect(checkbox!.disabled).toBe(true)
    })
  })
})
