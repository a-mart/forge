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
})
