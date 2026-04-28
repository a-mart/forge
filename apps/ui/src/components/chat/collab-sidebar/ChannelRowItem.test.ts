/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DndContext } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { CollaborationChannel } from '@forge/protocol'
import { ChannelRowItem } from './ChannelRowItem'

let root: Root
let container: HTMLDivElement

const channel: CollaborationChannel = {
  channelId: 'channel-1',
  workspaceId: 'workspace-1',
  sessionAgentId: 'session-1',
  name: 'support',
  slug: 'support',
  aiEnabled: true,
  position: 0,
  archived: false,
  lastMessageSeq: 2,
  createdAt: '2026-04-14T12:00:00.000Z',
  updatedAt: '2026-04-14T12:00:00.000Z',
}

function renderRow() {
  flushSync(() => {
    root.render(
      createElement(
        DndContext,
        null,
        createElement(SortableContext, {
          items: [`channel:${channel.channelId}`],
          strategy: verticalListSortingStrategy,
          children: createElement(ChannelRowItem, {
            channel,
            unreadCount: 3,
            muted: true,
            isActive: false,
            canManage: false,
            onSelect: vi.fn(),
            onRename: vi.fn(),
            onArchive: vi.fn(),
            onToggleMute: vi.fn(),
            onMarkAsRead: vi.fn(),
            onOpenSettings: vi.fn(),
          }),
        }),
      ),
    )
  })
}

describe('ChannelRowItem', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    flushSync(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('shows unread indicators even when the channel is muted', () => {
    renderRow()

    expect(container.textContent).toContain('3')
    const label = Array.from(container.querySelectorAll('span')).find((node) => node.textContent === '#support')
    expect(label?.className).toContain('font-semibold')
  })
})
