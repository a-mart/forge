/** @vitest-environment jsdom */

import { fireEvent, getAllByRole, getByRole } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationCategory, ModelPresetInfo } from '@forge/protocol'

// Radix UI components require ResizeObserver in jsdom
globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver

const modelPresetMocks = vi.hoisted(() => ({
  presets: [] as ModelPresetInfo[],
}))

vi.mock('@/lib/model-preset', () => ({
  useModelPresets: () => modelPresetMocks.presets,
  getAvailableChangeManagerFamilies: (presets: ModelPresetInfo[]) => presets.map((preset) => ({
    familyId: preset.presetId,
    displayName: preset.displayName,
  })),
}))

const apiMocks = vi.hoisted(() => ({
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
}))

vi.mock('@/lib/collaboration-api', () => ({
  createCategory: apiMocks.createCategory,
  updateCategory: apiMocks.updateCategory,
}))

vi.mock('@/lib/collaboration-endpoints', () => ({
  resolveCollaborationApiBaseUrl: () => 'http://localhost:47187',
}))

const specialistApiMocks = vi.hoisted(() => ({
  fetchSharedSpecialists: vi.fn(),
}))

vi.mock('@/components/settings/specialists-api', () => ({
  fetchSharedSpecialists: specialistApiMocks.fetchSharedSpecialists,
}))

const { CreateCategoryDialog } = await import('./CreateCategoryDialog')
const { RenameCategoryDialog } = await import('./RenameCategoryDialog')

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  Element.prototype.hasPointerCapture ??= vi.fn(() => false)
  Element.prototype.setPointerCapture ??= vi.fn()
  Element.prototype.releasePointerCapture ??= vi.fn()
  Element.prototype.scrollIntoView ??= vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  apiMocks.createCategory.mockReset()
  apiMocks.updateCategory.mockReset()
  modelPresetMocks.presets = []
  specialistApiMocks.fetchSharedSpecialists.mockResolvedValue([])
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('CreateCategoryDialog', () => {
  it('renders the default model selector', () => {
    flushSync(() => {
      root.render(
        createElement(CreateCategoryDialog, {
          open: true,
          onClose: vi.fn(),
        }),
      )
    })

    expect(document.getElementById('collab-create-category-default-model')).toBeTruthy()
    const labels = Array.from(document.body.querySelectorAll('label')).map((node) => node.textContent)
    expect(labels).toEqual(expect.arrayContaining(['Name', 'Default model']))
  })

  it('shows distinct Extra High, Max, and Ultra reasoning choices for GPT-5.6 Sol', async () => {
    modelPresetMocks.presets = [{
      presetId: 'pi-5.6',
      displayName: 'GPT-5.6 Sol',
      provider: 'openai-codex',
      modelId: 'gpt-5.6-sol',
      defaultReasoningLevel: 'max',
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    }]

    flushSync(() => {
      root.render(
        createElement(CreateCategoryDialog, {
          open: true,
          onClose: vi.fn(),
        }),
      )
    })

    const modelTrigger = document.getElementById('collab-create-category-default-model')
    expect(modelTrigger).toBeTruthy()
    flushSync(() => {
      fireEvent.pointerDown(modelTrigger!, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    })
    await vi.waitFor(() => expect(getByRole(document.body, 'option', { name: 'GPT-5.6 Sol' })).toBeTruthy())
    flushSync(() => {
      fireEvent.click(getByRole(document.body, 'option', { name: 'GPT-5.6 Sol' }))
    })

    const reasoningTrigger = await vi.waitFor(() => {
      const trigger = document.getElementById('collab-create-category-reasoning-level')
      expect(trigger).toBeTruthy()
      return trigger!
    })
    flushSync(() => {
      fireEvent.pointerDown(reasoningTrigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    })
    await vi.waitFor(() => expect(getByRole(document.body, 'option', { name: 'Extra High' })).toBeTruthy())
    expect(getAllByRole(document.body, 'option').map((option) => option.textContent?.trim() ?? '')).toEqual([
      'Low',
      'Medium',
      'High',
      'Extra High',
      'Max',
      'Ultra',
    ])
  })

  it('submits the expected create payload', async () => {
    const returnedCategory: CollaborationCategory = {
      categoryId: 'new-cat',
      workspaceId: 'workspace-1',
      name: 'Test',
      defaultSelectedSpecialistHandles: [],
      position: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    apiMocks.createCategory.mockResolvedValue(returnedCategory)

    flushSync(() => {
      root.render(
        createElement(CreateCategoryDialog, {
          open: true,
          onClose: vi.fn(),
          onCreated: vi.fn(),
        }),
      )
    })

    const nameInput = document.getElementById('collab-create-category-name') as HTMLInputElement | null
    expect(nameInput).toBeTruthy()
    if (nameInput) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(nameInput, 'Test')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      nameInput.dispatchEvent(new Event('change', { bubbles: true }))
    }

    const submitButton = Array.from(document.body.querySelectorAll('button[type="submit"]')).find(
      (btn) => btn.textContent?.includes('Create category'),
    ) as HTMLButtonElement | undefined
    expect(submitButton).toBeTruthy()
    if (submitButton) {
      flushSync(() => { submitButton.click() })
    }

    await vi.waitFor(() => {
      expect(apiMocks.createCategory).toHaveBeenCalled()
    })

    const callArgs = apiMocks.createCategory.mock.calls[0][0] as Record<string, unknown>
    expect(callArgs).toEqual({ name: 'Test' })
  })

  it('includes selected specialist handles in the create payload', async () => {
    specialistApiMocks.fetchSharedSpecialists.mockResolvedValue([
      {
        specialistId: 'backend',
        displayName: 'Backend',
        color: '#2563eb',
        enabled: true,
        whenToUse: 'Backend tasks',
        modelId: 'gpt-5.5',
        provider: 'openai-codex',
        builtin: false,
        pinned: false,
        targetSpace: ['collaboration'],
        promptBody: 'You are a backend specialist.',
        sourceKind: 'global',
        available: true,
        availabilityCode: 'ok',
        shadowsGlobal: false,
      },
    ])

    const returnedCategory: CollaborationCategory = {
      categoryId: 'new-cat',
      workspaceId: 'workspace-1',
      name: 'Test',
      defaultSelectedSpecialistHandles: ['backend'],
      position: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    apiMocks.createCategory.mockResolvedValue(returnedCategory)

    flushSync(() => {
      root.render(
        createElement(CreateCategoryDialog, {
          open: true,
          onClose: vi.fn(),
          onCreated: vi.fn(),
        }),
      )
    })

    // Wait for specialists to load
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Backend')
    })

    // Toggle the specialist checkbox
    const checkbox = document.body.querySelector('[role="checkbox"]')
    expect(checkbox).toBeTruthy()
    if (checkbox) {
      flushSync(() => { (checkbox as HTMLElement).click() })
    }

    // Fill in name
    const nameInput = document.getElementById('collab-create-category-name') as HTMLInputElement | null
    if (nameInput) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(nameInput, 'Test')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      nameInput.dispatchEvent(new Event('change', { bubbles: true }))
    }

    const submitButton = Array.from(document.body.querySelectorAll('button[type="submit"]')).find(
      (btn) => btn.textContent?.includes('Create category'),
    ) as HTMLButtonElement | undefined
    if (submitButton) {
      flushSync(() => { submitButton.click() })
    }

    await vi.waitFor(() => {
      expect(apiMocks.createCategory).toHaveBeenCalled()
    })

    const callArgs = apiMocks.createCategory.mock.calls[0][0] as Record<string, unknown>
    expect(callArgs).toEqual({
      name: 'Test',
      defaultSelectedSpecialistHandles: ['backend'],
    })
  })

  it('fetches specialists with collaboration targetSpace', async () => {
    flushSync(() => {
      root.render(
        createElement(CreateCategoryDialog, {
          open: true,
          onClose: vi.fn(),
          wsUrl: 'ws://127.0.0.1:47187',
        }),
      )
    })

    await vi.waitFor(() => {
      expect(specialistApiMocks.fetchSharedSpecialists).toHaveBeenCalledWith(
        'ws://127.0.0.1:47187',
        { targetSpace: 'collaboration' },
      )
    })
  })
})

describe('RenameCategoryDialog', () => {
  const category: CollaborationCategory = {
    categoryId: 'cat-1',
    workspaceId: 'workspace-1',
    name: 'Engineering',
    defaultSelectedSpecialistHandles: [],
    position: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  it('renders category settings dialog with correct labels', () => {
    flushSync(() => {
      root.render(
        createElement(RenameCategoryDialog, {
          open: true,
          category,
          onClose: vi.fn(),
        }),
      )
    })

    expect(document.body.textContent).toContain('Update the category name, default model, and specialist defaults.')
    const labels = Array.from(document.body.querySelectorAll('label')).map((node) => node.textContent)
    expect(labels).toEqual(expect.arrayContaining(['Name', 'Default model']))
  })

  it('fetches specialists with collaboration targetSpace', async () => {
    flushSync(() => {
      root.render(
        createElement(RenameCategoryDialog, {
          open: true,
          category,
          onClose: vi.fn(),
          wsUrl: 'ws://127.0.0.1:47187',
        }),
      )
    })

    await vi.waitFor(() => {
      expect(specialistApiMocks.fetchSharedSpecialists).toHaveBeenCalledWith(
        'ws://127.0.0.1:47187',
        { targetSpace: 'collaboration' },
      )
    })
  })

  it('submits the expected update payload with channelCreationDefaults cleared', async () => {
    apiMocks.updateCategory.mockResolvedValue({ ...category, name: 'Engineering' })

    flushSync(() => {
      root.render(
        createElement(RenameCategoryDialog, {
          open: true,
          category,
          onClose: vi.fn(),
          onRenamed: vi.fn(),
        }),
      )
    })

    const submitButton = Array.from(document.body.querySelectorAll('button[type="submit"]')).find(
      (btn) => btn.textContent?.includes('Save'),
    ) as HTMLButtonElement | undefined
    expect(submitButton).toBeTruthy()
    if (submitButton) {
      flushSync(() => { submitButton.click() })
    }

    await vi.waitFor(() => {
      expect(apiMocks.updateCategory).toHaveBeenCalled()
    })

    const callArgs = apiMocks.updateCategory.mock.calls[0][1] as Record<string, unknown>
    expect(callArgs).toEqual({
      name: 'Engineering',
      defaultModelId: null,
      channelCreationDefaults: null,
      defaultSelectedSpecialistHandles: [],
    })
  })
})
