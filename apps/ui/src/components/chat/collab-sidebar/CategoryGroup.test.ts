/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dnd = vi.hoisted(() => ({
  useDroppable: vi.fn(() => ({ isOver: false, setNodeRef: vi.fn() })),
  useSortable: vi.fn(() => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, transition: undefined, isDragging: false })),
}))
vi.mock('@dnd-kit/core', () => ({ DndContext: ({ children }: { children: unknown }) => children, useDroppable: dnd.useDroppable }))
vi.mock('@dnd-kit/sortable', () => ({ SortableContext: ({ children }: { children: unknown }) => children, verticalListSortingStrategy: {}, useSortable: dnd.useSortable }))
vi.mock('./ChannelRowItem', () => ({ ChannelRowItem: () => createElement('div', null, 'channel-row') }))

import { CategoryGroup } from './CategoryGroup'

let container: HTMLDivElement
let root: Root | null = null

const category = {
  categoryId: 'category-1', workspaceId: 'workspace-1', name: 'General',
  defaultSelectedSpecialistHandles: [], position: 1,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}

function renderGroup(overrides: Record<string, unknown> = {}) {
  const props = {
    category, channels: [], categoryUnreadCount: 0, selectedChannelId: undefined,
    unreadByChannelId: {}, mutedByChannelId: {}, collapsed: false, canManage: true,
    onToggleCollapsed: vi.fn(), onSelectChannel: vi.fn(), onRenameCategory: vi.fn(),
    onDeleteCategory: vi.fn(), onRenameChannel: vi.fn(), onArchiveChannel: vi.fn(),
    onToggleMute: vi.fn(), onMarkAsRead: vi.fn(), onOpenChannelSettings: vi.fn(),
    ...overrides,
  }
  root = createRoot(container)
  flushSync(() => root?.render(createElement(CategoryGroup, props)))
  return props
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  dnd.useDroppable.mockClear()
  dnd.useSortable.mockClear()
})

afterEach(() => {
  if (root) flushSync(() => root?.unmount())
  root = null
  container.remove()
})

describe('CategoryGroup', () => {
  it('registers the empty category drop target with stable identity and attached ref', () => {
    renderGroup()

    expect(dnd.useDroppable).toHaveBeenCalledWith({
      id: 'category-drop:category-1',
      data: { type: 'category-drop', categoryId: 'category-1' },
      disabled: false,
    })
    const { setNodeRef } = dnd.useDroppable.mock.results[0]!.value
    expect(setNodeRef).toHaveBeenCalledWith(expect.any(HTMLElement))
    expect(container.textContent).toContain('Drop channels here')
  })

  it.each([
    ['cannot manage', { canManage: false }, true],
    ['is collapsed', { collapsed: true }, true],
    ['already has channels', { channels: [{ channelId: 'channel-1' }] }, true],
  ])('disables the channel drop target when it %s', (_label, overrides, disabled) => {
    renderGroup(overrides)
    expect(dnd.useDroppable).toHaveBeenCalledWith(expect.objectContaining({ disabled }))
  })
})
