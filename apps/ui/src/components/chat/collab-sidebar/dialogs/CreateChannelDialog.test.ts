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

vi.mock('@/lib/collaboration-endpoints', () => ({
  resolveCollaborationApiBaseUrl: () => 'http://localhost:47187',
}))

const { CreateChannelDialog } = await import('./CreateChannelDialog')

const categories: CollaborationCategory[] = [
  {
    categoryId: 'cat-eng',
    workspaceId: 'workspace-1',
    name: 'Engineering',
    position: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    categoryId: 'cat-ops',
    workspaceId: 'workspace-1',
    name: 'Operations',
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

describe('CreateChannelDialog', () => {
  it('shows category and description controls for channel defaults', () => {
    renderDialog({ defaultCategoryId: 'cat-eng' })

    const categoryTrigger = document.getElementById('collab-create-channel-category')
    expect(categoryTrigger?.textContent).toContain('Engineering')
    expect(document.getElementById('collab-create-channel-description')).toBeTruthy()

    const labels = Array.from(document.body.querySelectorAll('label')).map((node) => node.textContent)
    expect(labels).toEqual(expect.arrayContaining(['Name', 'Category', 'Description']))
  })

  it('submits name, category, and description as a trimmed payload', async () => {
    const returnedChannel: CollaborationChannel = {
      channelId: 'new-1',
      workspaceId: 'workspace-1',
      sessionAgentId: 'session-new',
      name: 'test',
      slug: 'test',
      aiEnabled: true,
      position: 0,
      archived: false,
      lastMessageSeq: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    apiMocks.createChannel.mockResolvedValue(returnedChannel)

    renderDialog({ defaultCategoryId: 'cat-eng' })

    const nameInput = document.getElementById('collab-create-channel-name') as HTMLInputElement | null
    expect(nameInput).toBeTruthy()
    if (nameInput) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(nameInput, 'test')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      nameInput.dispatchEvent(new Event('change', { bubbles: true }))
    }

    const descriptionInput = document.getElementById('collab-create-channel-description') as HTMLTextAreaElement | null
    expect(descriptionInput).toBeTruthy()
    if (descriptionInput) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(descriptionInput, '  channel purpose  ')
      descriptionInput.dispatchEvent(new Event('input', { bubbles: true }))
      descriptionInput.dispatchEvent(new Event('change', { bubbles: true }))
    }

    const submitButton = Array.from(document.body.querySelectorAll('button[type="submit"]')).find(
      (btn) => btn.textContent?.includes('Create channel'),
    ) as HTMLButtonElement | undefined
    expect(submitButton).toBeTruthy()

    if (submitButton) {
      flushSync(() => {
        submitButton.click()
      })
    }

    await vi.waitFor(() => {
      expect(apiMocks.createChannel).toHaveBeenCalled()
    })

    const callArgs = apiMocks.createChannel.mock.calls[0][0] as Record<string, unknown>
    expect(callArgs).toEqual({
      name: 'test',
      categoryId: 'cat-eng',
      description: 'channel purpose',
    })
  })
})
