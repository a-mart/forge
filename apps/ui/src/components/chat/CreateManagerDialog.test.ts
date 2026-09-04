/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/dom'
import {
  FUTURE_MODEL,
  OPENROUTER_GLM,
  makeManagerSelectionCatalog,
} from '@/lib/manager-selection-catalog.fixture'

// Radix UI components require ResizeObserver in jsdom
globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver

const catalogApiMock = vi.hoisted(() => ({
  fetchManagerSelectionCatalog: vi.fn(),
}))

vi.mock('@/lib/manager-selection-catalog-api', () => ({
  fetchManagerSelectionCatalog: (...args: unknown[]) =>
    catalogApiMock.fetchManagerSelectionCatalog(...args),
}))

const { CreateManagerDialog } = await import('./CreateManagerDialog')
const { invalidateManagerSelectionCatalog } = await import('@/lib/use-manager-selection-catalog')

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  invalidateManagerSelectionCatalog()
  catalogApiMock.fetchManagerSelectionCatalog.mockReset()
  catalogApiMock.fetchManagerSelectionCatalog.mockResolvedValue(makeManagerSelectionCatalog({
    models: [],
    defaults: { workModeId: 'delegation_first' },
  }))
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
  invalidateManagerSelectionCatalog()
  vi.clearAllMocks()
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

  it('keeps the native picker for a true local Builder', async () => {
    const nativeBrowse = vi.fn()

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(CreateManagerDialog, defaultProps({ onBrowseDirectory: nativeBrowse })))
    })

    const browseButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent === 'Browse',
    )
    expect(browseButton).toBeTruthy()
    await act(async () => {
      browseButton?.click()
    })
    expect(nativeBrowse).toHaveBeenCalledOnce()
  })

  it('uses the server browser instead of the native picker when supplied', async () => {
    const nativeBrowse = vi.fn()
    const listDirectories = vi.fn().mockResolvedValue({
      path: '/workspaces',
      directories: [],
      resolvedPath: '/workspaces',
      roots: ['/workspaces'],
      entries: [],
    })

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(CreateManagerDialog, defaultProps({
        newManagerCwd: '/app',
        onBrowseDirectory: nativeBrowse,
        serverDirectoryBrowser: {
          client: {
            listDirectories,
            validateDirectory: vi.fn(),
          },
          canCreateDirectory: false,
        },
      })))
    })

    const browseButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Browse server…'),
    )
    expect(browseButton).toBeTruthy()
    await act(async () => {
      browseButton?.click()
    })

    await waitFor(() => expect(listDirectories).toHaveBeenCalledWith('/app'))
    expect(nativeBrowse).not.toHaveBeenCalled()
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

  describe('clone repository source mode', () => {
    function cloneProps(overrides: Record<string, unknown> = {}) {
      return defaultProps({
        cloneRepositoryEnabled: true,
        sourceMode: 'clone_repository',
        repositoryUrl: 'https://github.com/org/repo.git',
        repositoryFolder: 'repo',
        repositoryBasePath: '/tmp/repos',
        onSourceModeChange: vi.fn(),
        onRepositoryUrlChange: vi.fn(),
        onRepositoryFolderChange: vi.fn(),
        onRepositoryBasePathChange: vi.fn(),
        onCancelClone: vi.fn(),
        ...overrides,
      })
    }

    it('exposes toggle source selector semantics with aria-pressed', async () => {
      await act(async () => {
        root = createRoot(container)
        root.render(createElement(CreateManagerDialog, cloneProps({ sourceMode: 'local_folder' })))
      })

      const group = document.body.querySelector('[aria-label="Project source"]')
      expect(group).toBeTruthy()
      expect(group?.getAttribute('role')).not.toBe('radiogroup')
      const toggles = group!.querySelectorAll('button[aria-pressed]')
      expect(toggles.length).toBe(2)
      expect(toggles[0]?.getAttribute('aria-pressed')).toBe('true')
      expect(toggles[1]?.getAttribute('aria-pressed')).toBe('false')
      expect(toggles[0]?.getAttribute('role')).not.toBe('radio')
    })

    it('blocks generic dismiss while cloning and keeps Cancel clone through ack', async () => {
      const onOpenChange = vi.fn()
      const onCancelClone = vi.fn()

      await act(async () => {
        root = createRoot(container)
        root.render(
          createElement(
            CreateManagerDialog,
            cloneProps({
              isCreatingManager: true,
              cloneCancellable: true,
              cloneStage: 'cloning',
              clonePercent: 40,
              onOpenChange,
              onCancelClone,
            }),
          ),
        )
      })

      const status = document.body.querySelector('[role="status"][aria-live="polite"]')
      expect(status?.textContent).toMatch(/Cloning|40/)

      const cancelClone = Array.from(document.body.querySelectorAll('button')).find(
        (button) => button.textContent === 'Cancel clone',
      )
      expect(cancelClone).toBeTruthy()
      expect(cancelClone!.disabled).toBe(false)

      const genericCancel = Array.from(document.body.querySelectorAll('button')).find(
        (button) => button.textContent === 'Cancel',
      )
      expect(genericCancel).toBeUndefined()

      await act(async () => {
        cancelClone?.click()
      })
      expect(onCancelClone).toHaveBeenCalledOnce()
      expect(onOpenChange).not.toHaveBeenCalled()
    })

    it('keeps dialog open while cancelling and associates errors with alert', async () => {
      const onOpenChange = vi.fn()

      await act(async () => {
        root = createRoot(container)
        root.render(
          createElement(
            CreateManagerDialog,
            cloneProps({
              isCancellingClone: true,
              cloneCancellable: true,
              createManagerError: 'Clone was cancelled too late.',
              onOpenChange,
            }),
          ),
        )
      })

      const dialog = document.body.querySelector('[role="dialog"]')
      expect(dialog?.getAttribute('aria-describedby')).toBe('create-manager-error')
      const alert = document.body.querySelector('#create-manager-error[role="alert"]')
      expect(alert?.textContent).toContain('too late')

      const status = document.body.querySelector('[role="status"]')
      expect(status?.textContent).toMatch(/Cancelling/)

      const cancellingButton = Array.from(document.body.querySelectorAll('button')).find(
        (button) => button.textContent === 'Cancelling…',
      )
      expect(cancellingButton?.disabled).toBe(true)
    })
  })

  it('uses the server-advertised synthetic model and reasoning default exactly', async () => {
    catalogApiMock.fetchManagerSelectionCatalog.mockResolvedValue(makeManagerSelectionCatalog({
      models: [FUTURE_MODEL],
      defaults: {
        createManagerModel: {
          provider: FUTURE_MODEL.provider,
          modelId: FUTURE_MODEL.modelId,
          reasoningId: 'low',
        },
        workModeId: 'delegation_first',
      },
    }))
    const onModelSelectionChange = vi.fn()
    const onReasoningLevelChange = vi.fn()

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(CreateManagerDialog, defaultProps({
        onModelSelectionChange,
        onReasoningLevelChange,
      })))
    })

    expect(onModelSelectionChange).toHaveBeenCalledWith({
      provider: 'future-labs',
      modelId: 'oracle-9',
    })
    expect(onReasoningLevelChange).toHaveBeenCalledWith('low')
  })

  it('leaves the model unset when the server omits a create default', async () => {
    catalogApiMock.fetchManagerSelectionCatalog.mockResolvedValue(makeManagerSelectionCatalog({
      defaults: { workModeId: 'delegation_first' },
    }))
    const onModelSelectionChange = vi.fn()
    const onReasoningLevelChange = vi.fn()

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(CreateManagerDialog, defaultProps({
        onModelSelectionChange,
        onReasoningLevelChange,
      })))
    })

    expect(onModelSelectionChange).not.toHaveBeenCalled()
    expect(onReasoningLevelChange).not.toHaveBeenCalled()
    expect(findSubmitButton()?.disabled).toBe(true)
    expect(document.body.querySelector('[role="dialog"]')?.textContent)
      .not.toContain('No manager models are currently available')
  })

  describe('OpenRouter manager models', () => {
    it('includes an enabled tool-capable OpenRouter model in the create selector', async () => {
      const onModelSelectionChange = vi.fn()
      const onReasoningLevelChange = vi.fn()
      catalogApiMock.fetchManagerSelectionCatalog.mockResolvedValue(makeManagerSelectionCatalog({
        models: [OPENROUTER_GLM],
        defaults: {
          createManagerModel: {
            provider: OPENROUTER_GLM.provider,
            modelId: OPENROUTER_GLM.modelId,
            reasoningId: OPENROUTER_GLM.defaultReasoningId,
          },
          workModeId: 'delegation_first',
        },
      }))

      await act(async () => {
        root = createRoot(container)
        root.render(createElement(CreateManagerDialog, defaultProps({
          onModelSelectionChange,
          onReasoningLevelChange,
        })))
      })

      expect(onModelSelectionChange).toHaveBeenCalledWith({
        provider: 'openrouter',
        modelId: 'z-ai/glm-5.1',
      })
      expect(onReasoningLevelChange).toHaveBeenCalledWith('medium')

      await act(async () => {
        root?.render(createElement(CreateManagerDialog, defaultProps({
          onModelSelectionChange,
          onReasoningLevelChange,
          newManagerModelSelection: { provider: 'openrouter', modelId: 'z-ai/glm-5.1' },
          newManagerReasoningLevel: 'medium',
        })))
      })

      const dialog = document.body.querySelector('[role="dialog"]')
      expect(dialog?.textContent).not.toContain('No manager models are currently available')
      expect(findSubmitButton()?.disabled).toBe(false)
    })

    it('keeps OpenRouter models out of the create selector until managerEnabled is true', async () => {
      catalogApiMock.fetchManagerSelectionCatalog.mockResolvedValue(makeManagerSelectionCatalog({
        models: [],
        defaults: { workModeId: 'delegation_first' },
      }))

      await act(async () => {
        root = createRoot(container)
        root.render(createElement(CreateManagerDialog, defaultProps()))
      })

      const dialog = document.body.querySelector('[role="dialog"]')
      expect(dialog?.textContent).toContain('No manager models are currently available')
      expect(findSubmitButton()?.disabled).toBe(true)
    })
  })
})
