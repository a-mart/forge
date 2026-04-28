/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationChannel } from '@forge/protocol'

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

vi.mock('@/lib/collaboration-endpoints', () => ({
  resolveCollaborationApiBaseUrl: () => 'http://localhost:47187',
}))

const apiMocks = vi.hoisted(() => ({
  getChannel: vi.fn(),
  updateChannel: vi.fn(),
}))

vi.mock('@/lib/collaboration-api', () => ({
  getChannel: apiMocks.getChannel,
  updateChannel: apiMocks.updateChannel,
}))

const { ChannelSettingsSheet } = await import('./ChannelSettingsSheet')

const channel: CollaborationChannel = {
  channelId: 'channel-1',
  workspaceId: 'workspace-1',
  sessionAgentId: 'session-1',
  name: 'engineering',
  slug: 'engineering',
  aiEnabled: true,
  position: 0,
  archived: false,
  lastMessageSeq: 1,
  createdAt: '2026-04-14T12:00:00.000Z',
  updatedAt: '2026-04-14T12:00:00.000Z',
}

let root: Root
let container: HTMLDivElement

function renderSheet(overrides: Partial<CollaborationChannel> = {}, extraProps: { isAdmin?: boolean } = {}) {
  const merged = { ...channel, ...overrides }
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    channel: merged,
    categories: [],
    isAdmin: extraProps.isAdmin ?? true,
  }
  apiMocks.getChannel.mockResolvedValue(merged)
  flushSync(() => {
    root.render(createElement(ChannelSettingsSheet, props))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  apiMocks.getChannel.mockReset()
  apiMocks.updateChannel.mockReset()
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('ChannelSettingsSheet', () => {
  it('renders Additional instructions with the updated labeling', () => {
    renderSheet()

    const labels = Array.from(document.body.querySelectorAll('label')).map((node) => node.textContent)
    expect(labels).toEqual(expect.arrayContaining([
      'Channel name',
      'Topic / description',
      'Category',
      'Model',
      'Auto-reply',
      'Additional instructions',
    ]))
    expect(labels).not.toContain('Prompt overlay')
  })

  it('shows Save button disabled when nothing has changed', () => {
    renderSheet()

    const saveButton = Array.from(document.body.querySelectorAll('button[type="submit"]')).find(
      (btn) => btn.textContent?.includes('Save'),
    ) as HTMLButtonElement | undefined

    expect(saveButton).toBeTruthy()
    expect(saveButton?.disabled).toBe(true)
  })

  it('submits updated instructions with the trimmed channel payload', async () => {
    renderSheet({ promptOverlay: 'Existing guidance' })

    const instructionsInput = document.getElementById('collab-channel-settings-prompt-overlay') as HTMLTextAreaElement | null
    expect(instructionsInput).toBeTruthy()
    if (instructionsInput) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(instructionsInput, '  Updated guidance  ')
      instructionsInput.dispatchEvent(new Event('input', { bubbles: true }))
      instructionsInput.dispatchEvent(new Event('change', { bubbles: true }))
    }

    const submitButton = Array.from(document.body.querySelectorAll('button[type="submit"]')).find(
      (btn) => btn.textContent?.includes('Save'),
    ) as HTMLButtonElement | undefined
    expect(submitButton?.disabled).toBe(false)

    if (submitButton) {
      flushSync(() => { submitButton.click() })
    }

    await vi.waitFor(() => {
      expect(apiMocks.updateChannel).toHaveBeenCalled()
    })

    const callArgs = apiMocks.updateChannel.mock.calls[0][1] as Record<string, unknown>
    expect(callArgs).toEqual({
      name: 'engineering',
      description: null,
      categoryId: null,
      aiEnabled: true,
      promptOverlay: 'Updated guidance',
    })
  })
})
