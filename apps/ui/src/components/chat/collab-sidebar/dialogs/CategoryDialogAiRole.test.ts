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

// Hoisted mocks for AI roles API
const aiRolesApiStub = vi.hoisted(() => {
  const stubData = {
    roles: [
      { roleId: 'channel_assistant', name: 'Channel Assistant', description: 'Helper.', prompt: '', builtin: true, usage: { workspaceDefault: true, categoryCount: 0, channelCount: 0, totalAssignments: 1, inUse: true } },
      { roleId: 'work_coordinator', name: 'Work Coordinator', description: 'Coordinator.', prompt: '', builtin: true, usage: { workspaceDefault: false, categoryCount: 0, channelCount: 0, totalAssignments: 0, inUse: false } },
      { roleId: 'facilitator_scribe', name: 'Facilitator & Scribe', description: 'Scribe.', prompt: '', builtin: true, usage: { workspaceDefault: false, categoryCount: 0, channelCount: 0, totalAssignments: 0, inUse: false } },
    ],
    workspaceDefaultAiRoleId: 'channel_assistant',
  }
  return { fetchAiRoles: vi.fn(() => Promise.resolve(stubData)), stubData }
})

vi.mock('@/lib/collaboration-ai-roles-api', () => ({
  fetchAiRoles: aiRolesApiStub.fetchAiRoles,
}))

vi.mock('@/lib/collaboration-endpoints', () => ({
  resolveCollaborationApiBaseUrl: () => 'http://localhost:47187',
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
  aiRolesApiStub.fetchAiRoles.mockClear()
  aiRolesApiStub.fetchAiRoles.mockResolvedValue(aiRolesApiStub.stubData)
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

  it('seeds default role from workspace default', async () => {
    aiRolesApiStub.fetchAiRoles.mockResolvedValue({
      ...aiRolesApiStub.stubData,
      workspaceDefaultAiRoleId: 'work_coordinator',
    })

    flushSync(() => {
      root.render(
        createElement(CreateCategoryDialog, {
          open: true,
          onClose: vi.fn(),
        }),
      )
    })

    await vi.waitFor(() => {
      const trigger = document.getElementById('collab-create-category-default-ai-role')
      expect(trigger?.textContent).toContain('Work Coordinator')
    })
  })

  it('submits custom workspace default role', async () => {
    aiRolesApiStub.fetchAiRoles.mockResolvedValue({
      ...aiRolesApiStub.stubData,
      workspaceDefaultAiRoleId: 'facilitator_scribe',
    })

    const returnedCategory: CollaborationCategory = {
      categoryId: 'new-cat-2',
      workspaceId: 'workspace-1',
      name: 'Test2',
      defaultAiRoleId: 'facilitator_scribe',
      defaultAiRole: 'facilitator_scribe',
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

    // Wait for workspace default to be seeded
    await vi.waitFor(() => {
      const trigger = document.getElementById('collab-create-category-default-ai-role')
      expect(trigger?.textContent).toContain('Facilitator & Scribe')
    })

    // Fill in the name
    const nameInput = document.getElementById('collab-create-category-name') as HTMLInputElement | null
    expect(nameInput).toBeTruthy()
    if (nameInput) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(nameInput, 'Test2')
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
    expect(callArgs.defaultAiRoleId).toBe('facilitator_scribe')
  })

  it('submits workspace default role when user does not override', async () => {
    // Workspace default is channel_assistant (from stubData default)
    const returnedCategory: CollaborationCategory = {
      categoryId: 'new-cat-3',
      workspaceId: 'workspace-1',
      name: 'Test3',
      defaultAiRoleId: 'channel_assistant',
      defaultAiRole: 'channel_assistant',
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

    // Fill in the name without changing role
    const nameInput = document.getElementById('collab-create-category-name') as HTMLInputElement | null
    expect(nameInput).toBeTruthy()
    if (nameInput) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(nameInput, 'Test3')
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
