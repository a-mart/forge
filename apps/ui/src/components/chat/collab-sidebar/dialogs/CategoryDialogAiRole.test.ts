/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationCategory } from '@forge/protocol'

// Radix UI components require ResizeObserver in jsdom
globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver

vi.mock('@/lib/model-preset', () => ({
  useModelPresets: () => [],
  getAvailableChangeManagerFamilies: () => [],
}))

const apiMocks = vi.hoisted(() => ({
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
}))

vi.mock('@/lib/collaboration-api', () => ({
  createCategory: apiMocks.createCategory,
  updateCategory: apiMocks.updateCategory,
}))

const { CreateCategoryDialog } = await import('./CreateCategoryDialog')
const { RenameCategoryDialog } = await import('./RenameCategoryDialog')

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  apiMocks.createCategory.mockReset()
  apiMocks.updateCategory.mockReset()
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('CreateCategoryDialog defaultAiRole', () => {
  it('renders a Default AI role selector defaulting to Channel Assistant', () => {
    flushSync(() => {
      root.render(
        createElement(CreateCategoryDialog, {
          open: true,
          onClose: vi.fn(),
        }),
      )
    })

    const trigger = document.getElementById('collab-create-category-default-ai-role')
    expect(trigger).toBeTruthy()
    expect(trigger?.textContent).toContain('Channel Assistant')
  })

  it('submits defaultAiRole to createCategory', async () => {
    const returnedCategory: CollaborationCategory = {
      categoryId: 'new-cat',
      workspaceId: 'workspace-1',
      name: 'Test',
      defaultAiRoleId: 'channel_assistant',
      defaultAiRole: 'channel_assistant',
      position: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    apiMocks.createCategory.mockResolvedValue(returnedCategory)

    const onCreated = vi.fn()
    flushSync(() => {
      root.render(
        createElement(CreateCategoryDialog, {
          open: true,
          onClose: vi.fn(),
          onCreated,
        }),
      )
    })

    // Fill in the name
    const nameInput = document.getElementById('collab-create-category-name') as HTMLInputElement | null
    expect(nameInput).toBeTruthy()
    if (nameInput) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(nameInput, 'Test')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      nameInput.dispatchEvent(new Event('change', { bubbles: true }))
    }

    // Submit
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
    expect(callArgs.defaultAiRoleId).toBe('channel_assistant')
  })
})

describe('RenameCategoryDialog defaultAiRole', () => {
  const category: CollaborationCategory = {
    categoryId: 'cat-1',
    workspaceId: 'workspace-1',
    name: 'Engineering',
    defaultAiRoleId: 'work_coordinator',
    defaultAiRole: 'work_coordinator',
    position: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  it('initialises the Default AI role selector from the category prop', () => {
    flushSync(() => {
      root.render(
        createElement(RenameCategoryDialog, {
          open: true,
          category,
          onClose: vi.fn(),
        }),
      )
    })

    const trigger = document.getElementById('collab-rename-category-default-ai-role')
    expect(trigger).toBeTruthy()
    expect(trigger?.textContent).toContain('Work Coordinator')
  })

  it('submits defaultAiRole to updateCategory', async () => {
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

    // Submit unchanged form (name already filled, role already set)
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
    expect(callArgs.defaultAiRoleId).toBe('work_coordinator')
  })
})
