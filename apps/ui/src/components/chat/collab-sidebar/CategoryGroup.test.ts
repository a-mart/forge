/** @vitest-environment jsdom */

import { createElement } from 'react'
import { DndContext } from '@dnd-kit/core'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CategoryGroup } from './CategoryGroup'

vi.mock('./ChannelRowItem', () => ({
  ChannelRowItem: () => createElement('div', null, 'channel-row'),
}))

let container: HTMLDivElement
let root: Root | null = null

function renderGroup(): void {
  root = createRoot(container)
  flushSync(() => {
    root?.render(
      createElement(
        DndContext,
        null,
        createElement(CategoryGroup, {
          category: {
            categoryId: 'category-1',
            workspaceId: 'workspace-1',
            name: 'General',
            defaultAiRoleId: 'channel_assistant',
            defaultAiRole: 'channel_assistant',
            position: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          channels: [],
          categoryUnreadCount: 0,
          selectedChannelId: undefined,
          unreadByChannelId: {},
          mutedByChannelId: {},
          collapsed: false,
          canManage: true,
          onToggleCollapsed: vi.fn(),
          onSelectChannel: vi.fn(),
          onRenameCategory: vi.fn(),
          onDeleteCategory: vi.fn(),
          onRenameChannel: vi.fn(),
          onArchiveChannel: vi.fn(),
          onToggleMute: vi.fn(),
          onMarkAsRead: vi.fn(),
          onOpenChannelSettings: vi.fn(),
        }),
      ),
    )
  })
}

beforeEach(() => {
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
})

describe('CategoryGroup', () => {
  it('renders an empty-category drop target for channel drag and drop', () => {
    renderGroup()

    expect(container.textContent).toContain('Drop channels here')
  })
})
