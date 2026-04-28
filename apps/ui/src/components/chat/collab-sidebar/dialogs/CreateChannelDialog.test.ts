/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationCategory, CollaborationChannel } from '@forge/protocol'

// Radix UI components require ResizeObserver in jsdom
globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver

const apiMocks = vi.hoisted(() => ({
  createChannel: vi.fn(),
}))

vi.mock('@/lib/collaboration-api', () => ({
  createChannel: apiMocks.createChannel,
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

const { CreateChannelDialog } = await import('./CreateChannelDialog')

const categories: CollaborationCategory[] = [
  {
    categoryId: 'cat-eng',
    workspaceId: 'workspace-1',
    name: 'Engineering',
    defaultAiRoleId: 'work_coordinator',
    defaultAiRole: 'work_coordinator',
    position: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    categoryId: 'cat-ops',
    workspaceId: 'workspace-1',
    name: 'Operations',
    defaultAiRoleId: 'facilitator_scribe',
    defaultAiRole: 'facilitator_scribe',
    position: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
]

let root: Root
let container: HTMLDivElement

function renderDialog(props: {
  defaultCategoryId?: string
  onCreated?: (channel: CollaborationChannel) => void
}) {
  flushSync(() => {
    root.render(
      createElement(CreateChannelDialog, {
        open: true,
        categories,
        onClose: vi.fn(),
        ...props,
      }),
    )
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  apiMocks.createChannel.mockReset()
  aiRolesApiStub.fetchAiRoles.mockClear()
  aiRolesApiStub.fetchAiRoles.mockResolvedValue(aiRolesApiStub.stubData)
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('CreateChannelDialog AI role', () => {
  it('defaults to channel_assistant when no category is pre-selected', () => {
    renderDialog({})

    const trigger = document.getElementById('collab-create-channel-ai-role')
    expect(trigger).toBeTruthy()
    expect(trigger?.textContent).toContain('Channel Assistant')
  })

  it('inherits the category defaultAiRole when a category is pre-selected', () => {
    renderDialog({ defaultCategoryId: 'cat-eng' })

    const trigger = document.getElementById('collab-create-channel-ai-role')
    expect(trigger?.textContent).toContain('Work Coordinator')
  })

  it('submits the aiRole to createChannel', async () => {
    const returnedChannel: CollaborationChannel = {
      channelId: 'new-1',
      workspaceId: 'workspace-1',
      sessionAgentId: 'session-new',
      name: 'test',
      slug: 'test',
      aiEnabled: true,
      aiRoleId: 'work_coordinator',
      aiRole: 'work_coordinator',
      position: 0,
      archived: false,
      lastMessageSeq: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    apiMocks.createChannel.mockResolvedValue(returnedChannel)

    const onCreated = vi.fn()
    renderDialog({ defaultCategoryId: 'cat-eng', onCreated })

    // Fill in the name
    const nameInput = document.getElementById('collab-create-channel-name') as HTMLInputElement | null
    expect(nameInput).toBeTruthy()
    if (nameInput) {
      // Simulate typing
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      nativeInputValueSetter?.call(nameInput, 'test')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      nameInput.dispatchEvent(new Event('change', { bubbles: true }))
    }

    // Submit the form
    const submitButton = Array.from(document.body.querySelectorAll('button[type="submit"]')).find(
      (btn) => btn.textContent?.includes('Create channel'),
    ) as HTMLButtonElement | undefined
    expect(submitButton).toBeTruthy()

    if (submitButton) {
      flushSync(() => {
        submitButton.click()
      })
    }

    // Wait for the async submission
    await vi.waitFor(() => {
      expect(apiMocks.createChannel).toHaveBeenCalled()
    })

    const callArgs = apiMocks.createChannel.mock.calls[0][0] as Record<string, unknown>
    expect(callArgs.aiRoleId).toBe('work_coordinator')
  })

  it('renders the AI Role label', () => {
    renderDialog({})

    const label = Array.from(document.body.querySelectorAll('label')).find(
      (node) => node.textContent === 'AI Role',
    )
    expect(label).toBeTruthy()
  })

  it('seeds from non-channel_assistant workspace default', async () => {
    aiRolesApiStub.fetchAiRoles.mockResolvedValue({
      ...aiRolesApiStub.stubData,
      workspaceDefaultAiRoleId: 'work_coordinator',
    })

    renderDialog({})

    // Wait for the async fetch to resolve and update state
    await vi.waitFor(() => {
      const trigger = document.getElementById('collab-create-channel-ai-role')
      expect(trigger?.textContent).toContain('Work Coordinator')
    })
  })

  it('submits custom workspace default role', async () => {
    aiRolesApiStub.fetchAiRoles.mockResolvedValue({
      ...aiRolesApiStub.stubData,
      workspaceDefaultAiRoleId: 'facilitator_scribe',
    })

    const returnedChannel: CollaborationChannel = {
      channelId: 'new-2',
      workspaceId: 'workspace-1',
      sessionAgentId: 'session-new',
      name: 'test2',
      slug: 'test2',
      aiEnabled: true,
      aiRoleId: 'facilitator_scribe',
      aiRole: 'facilitator_scribe',
      position: 0,
      archived: false,
      lastMessageSeq: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    apiMocks.createChannel.mockResolvedValue(returnedChannel)

    renderDialog({})

    // Wait for the async fetch to resolve
    await vi.waitFor(() => {
      const trigger = document.getElementById('collab-create-channel-ai-role')
      expect(trigger?.textContent).toContain('Facilitator & Scribe')
    })

    // Fill in the name
    const nameInput = document.getElementById('collab-create-channel-name') as HTMLInputElement | null
    expect(nameInput).toBeTruthy()
    if (nameInput) {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      nativeInputValueSetter?.call(nameInput, 'test2')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      nameInput.dispatchEvent(new Event('change', { bubbles: true }))
    }

    // Submit
    const submitButton = Array.from(document.body.querySelectorAll('button[type="submit"]')).find(
      (btn) => btn.textContent?.includes('Create channel'),
    ) as HTMLButtonElement | undefined
    expect(submitButton).toBeTruthy()
    if (submitButton) {
      flushSync(() => { submitButton.click() })
    }

    await vi.waitFor(() => {
      expect(apiMocks.createChannel).toHaveBeenCalled()
    })

    const callArgs = apiMocks.createChannel.mock.calls[0][0] as Record<string, unknown>
    expect(callArgs.aiRoleId).toBe('facilitator_scribe')
  })

  it('pre-selected category role not overwritten when fetchAiRoles resolves later', async () => {
    // Slow down the fetch so category-based role is set first
    let resolveFetch!: (value: any) => void
    aiRolesApiStub.fetchAiRoles.mockReturnValue(
      new Promise((resolve) => { resolveFetch = resolve }),
    )

    // Open with cat-eng pre-selected → role should be work_coordinator from category
    renderDialog({ defaultCategoryId: 'cat-eng' })

    const trigger = document.getElementById('collab-create-channel-ai-role')
    expect(trigger?.textContent).toContain('Work Coordinator')

    // Now resolve fetchAiRoles with a different workspace default
    resolveFetch({
      ...aiRolesApiStub.stubData,
      workspaceDefaultAiRoleId: 'facilitator_scribe',
    })

    // The role should stay work_coordinator because the category pre-selected it
    // and the fetch should respect the category override
    await vi.waitFor(() => {
      expect(aiRolesApiStub.fetchAiRoles).toHaveBeenCalled()
    })

    // Category role from categories array takes priority
    expect(trigger?.textContent).toContain('Work Coordinator')
  })
})
