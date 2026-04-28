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

// Stub model-preset so useModelPresets / getAvailableChangeManagerFamilies don't hit the WS
vi.mock('@/lib/model-preset', () => ({
  useModelPresets: () => [],
  getAvailableChangeManagerFamilies: () => [],
}))

// Hoisted mocks for collaboration-api
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
  aiRoleId: 'channel_assistant',
  aiRole: 'channel_assistant',
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

describe('ChannelSettingsSheet AI role plumbing', () => {
  it('renders the AI Role selector with the correct initial value', () => {
    renderSheet({ aiRoleId: 'work_coordinator', aiRole: 'work_coordinator' })

    const label = Array.from(document.body.querySelectorAll('label')).find(
      (node) => node.textContent === 'AI Role',
    )
    expect(label).toBeTruthy()

    const trigger = document.getElementById('collab-channel-settings-ai-role')
    expect(trigger).toBeTruthy()
    expect(trigger?.textContent).toContain('Work Coordinator')
  })

  it('renders "Additional instructions" label instead of "Prompt overlay"', () => {
    renderSheet()

    const labels = Array.from(document.body.querySelectorAll('label')).map(
      (node) => node.textContent,
    )

    expect(labels).toContain('Additional instructions')
    expect(labels).not.toContain('Prompt overlay')
  })

  it('renders the facilitator_scribe role correctly', () => {
    renderSheet({ aiRoleId: 'facilitator_scribe', aiRole: 'facilitator_scribe' })

    const trigger = document.getElementById('collab-channel-settings-ai-role')
    expect(trigger?.textContent).toContain('Facilitator & Scribe')
  })

  it('disables the AI Role selector for non-admin users', () => {
    renderSheet({}, { isAdmin: false })

    const trigger = document.getElementById('collab-channel-settings-ai-role')
    expect(trigger).toBeTruthy()
    // Radix Select sets disabled or aria-disabled on the trigger button
    const isDisabled =
      (trigger as HTMLButtonElement | null)?.disabled === true ||
      trigger?.getAttribute('aria-disabled') === 'true' ||
      trigger?.getAttribute('data-disabled') !== null
    expect(isDisabled).toBe(true)
  })

  it('shows Save button disabled when aiRole has not changed', () => {
    renderSheet({ aiRoleId: 'channel_assistant', aiRole: 'channel_assistant' })

    const saveButton = Array.from(document.body.querySelectorAll('button[type="submit"]')).find(
      (btn) => btn.textContent?.includes('Save'),
    ) as HTMLButtonElement | undefined

    expect(saveButton).toBeTruthy()
    expect(saveButton?.disabled).toBe(true)
  })
})
