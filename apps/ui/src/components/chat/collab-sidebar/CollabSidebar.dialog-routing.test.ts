/** @vitest-environment jsdom */
/**
 * Tests that dialog/mutation actions in CollabSidebar always target the
 * owning connection's backend, even when the clicked item belongs to an
 * inactive connection.
 *
 * Strategy: mock ConnectionSection with trigger buttons and dialog
 * components with data-attribute renderers so we can verify apiBaseUrl
 * routing without relying on Radix context-menu DOM events.
 */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollabConnectionsValue } from '@/hooks/index-page/use-collab-connections'
import type { CollabWsState } from '@/lib/collab-ws-state'
import { createInitialCollabWsState } from '@/lib/collab-ws-state'
import type { CollaborationEndpointTarget } from '@/lib/collaboration-connections'
import type { CollaborationCategory, CollaborationChannel } from '@forge/protocol'
import type { MutableRefObject } from 'react'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CHANNEL_ON_A: CollaborationChannel = {
  channelId: 'ch-a',
  workspaceId: 'ws-a',
  sessionAgentId: 's-a',
  name: 'alpha-channel',
  slug: 'alpha-channel',
  categoryId: 'cat-a',
  aiEnabled: true,
  activeSelectedSpecialistHandles: [],
  position: 0,
  archived: false,
  lastMessageSeq: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const CHANNEL_ON_B: CollaborationChannel = {
  channelId: 'ch-b',
  workspaceId: 'ws-b',
  sessionAgentId: 's-b',
  name: 'beta-channel',
  slug: 'beta-channel',
  categoryId: 'cat-b',
  aiEnabled: true,
  activeSelectedSpecialistHandles: [],
  position: 0,
  archived: false,
  lastMessageSeq: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const CATEGORY_ON_A: CollaborationCategory = {
  categoryId: 'cat-a',
  workspaceId: 'ws-a',
  name: 'Alpha Category',
  position: 0,
  defaultSelectedSpecialistHandles: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const CATEGORY_ON_B: CollaborationCategory = {
  categoryId: 'cat-b',
  workspaceId: 'ws-b',
  name: 'Beta Category',
  position: 0,
  defaultSelectedSpecialistHandles: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

// ---------------------------------------------------------------------------
// Mocks — hoisted before imports
// ---------------------------------------------------------------------------

const connectionsValue: { current: CollabConnectionsValue } = {
  current: null as unknown as CollabConnectionsValue,
}

vi.mock('@/hooks/index-page/use-collab-connections', () => ({
  CollabConnectionsProvider: ({ children }: { value: unknown; children: unknown }) => children,
  useCollabConnectionsContext: () => connectionsValue.current,
}))

vi.mock('@/hooks/index-page/use-collab-ws-connection', () => ({
  CollabWsProvider: ({ children }: { value: unknown; children: unknown }) => children,
  useCollabWsContext: () => ({
    clientRef: { current: null },
    state: createInitialCollabWsState(),
  }),
}))

vi.mock('@/lib/connection-health-store', () => ({
  useConnectionHealth: () => ({ builder: 'disconnected', collab: 'disconnected' }),
}))

vi.mock('@/lib/collab-local-channel-state', () => ({
  isMuted: () => false,
  toggleMute: vi.fn(),
  subscribeToMuteChanges: () => () => {},
}))

vi.mock('@/lib/collaboration-api', () => ({
  reorderCategories: vi.fn(),
  reorderChannels: vi.fn(),
  updateChannel: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mock ConnectionSection — renders trigger buttons that invoke callbacks
// with entities belonging to this section's connection.
// ---------------------------------------------------------------------------

vi.mock('./ConnectionSection', () => ({
  ConnectionSection: (props: {
    connectionId: string
    state: CollabWsState
    onRenameChannel: (ch: CollaborationChannel) => void
    onArchiveChannel: (ch: CollaborationChannel) => void
    onOpenChannelSettings: (ch: CollaborationChannel) => void
    onRenameCategory: (cat: CollaborationCategory) => void
    onDeleteCategory: (cat: CollaborationCategory) => void
    onCreateChannelInCategory: (catId: string) => void
    onOpenCreateCategory: () => void
    [key: string]: unknown
  }) => {
    const ch = props.state.channels[0]
    const cat = props.state.categories[0]
    return createElement('div', { 'data-testid': `section-${props.connectionId}` },
      ch ? createElement('button', {
        'data-testid': `trigger-rename-channel-${props.connectionId}`,
        onClick: () => props.onRenameChannel(ch),
      }) : null,
      ch ? createElement('button', {
        'data-testid': `trigger-archive-channel-${props.connectionId}`,
        onClick: () => props.onArchiveChannel(ch),
      }) : null,
      ch ? createElement('button', {
        'data-testid': `trigger-settings-channel-${props.connectionId}`,
        onClick: () => props.onOpenChannelSettings(ch),
      }) : null,
      cat ? createElement('button', {
        'data-testid': `trigger-rename-category-${props.connectionId}`,
        onClick: () => props.onRenameCategory(cat),
      }) : null,
      cat ? createElement('button', {
        'data-testid': `trigger-delete-category-${props.connectionId}`,
        onClick: () => props.onDeleteCategory(cat),
      }) : null,
      cat ? createElement('button', {
        'data-testid': `trigger-create-channel-in-cat-${props.connectionId}`,
        onClick: () => props.onCreateChannelInCategory(cat.categoryId),
      }) : null,
      createElement('button', {
        'data-testid': `trigger-create-category-${props.connectionId}`,
        onClick: () => props.onOpenCreateCategory(),
      }),
    )
  },
}))

vi.mock('./ConnectionSectionHeader', () => ({
  ConnectionSectionHeader: () => null,
}))

// ---------------------------------------------------------------------------
// Mock dialog components — render data attributes for assertion
// ---------------------------------------------------------------------------

vi.mock('./dialogs/RenameChannelDialog', () => ({
  RenameChannelDialog: (props: { open: boolean; apiBaseUrl?: string; channel?: CollaborationChannel }) =>
    props.open ? createElement('div', {
      'data-testid': 'dialog-rename-channel',
      'data-api-base-url': props.apiBaseUrl ?? '',
      'data-channel-id': props.channel?.channelId ?? '',
    }) : null,
}))

vi.mock('./dialogs/ArchiveChannelDialog', () => ({
  ArchiveChannelDialog: (props: { open: boolean; apiBaseUrl?: string; channel?: CollaborationChannel }) =>
    props.open ? createElement('div', {
      'data-testid': 'dialog-archive-channel',
      'data-api-base-url': props.apiBaseUrl ?? '',
      'data-channel-id': props.channel?.channelId ?? '',
    }) : null,
}))

vi.mock('./dialogs/RenameChannelDialog', () => ({
  RenameChannelDialog: (props: { open: boolean; apiBaseUrl?: string; channel?: CollaborationChannel }) =>
    props.open ? createElement('div', {
      'data-testid': 'dialog-rename-channel',
      'data-api-base-url': props.apiBaseUrl ?? '',
      'data-channel-id': props.channel?.channelId ?? '',
    }) : null,
}))

vi.mock('./dialogs/RenameCategoryDialog', () => ({
  RenameCategoryDialog: (props: { open: boolean; apiBaseUrl?: string; category?: CollaborationCategory }) =>
    props.open ? createElement('div', {
      'data-testid': 'dialog-rename-category',
      'data-api-base-url': props.apiBaseUrl ?? '',
      'data-category-id': props.category?.categoryId ?? '',
    }) : null,
}))

vi.mock('./dialogs/DeleteCategoryDialog', () => ({
  DeleteCategoryDialog: (props: { open: boolean; apiBaseUrl?: string; category?: CollaborationCategory }) =>
    props.open ? createElement('div', {
      'data-testid': 'dialog-delete-category',
      'data-api-base-url': props.apiBaseUrl ?? '',
      'data-category-id': props.category?.categoryId ?? '',
    }) : null,
}))

vi.mock('./dialogs/CreateChannelDialog', () => ({
  CreateChannelDialog: (props: {
    open: boolean
    apiBaseUrl?: string
    categories?: CollaborationCategory[]
    defaultCategoryId?: string
  }) =>
    props.open ? createElement('div', {
      'data-testid': 'dialog-create-channel',
      'data-api-base-url': props.apiBaseUrl ?? '',
      'data-category-count': String(props.categories?.length ?? 0),
      'data-default-category-id': props.defaultCategoryId ?? '',
    }) : null,
}))

vi.mock('./dialogs/CreateCategoryDialog', () => ({
  CreateCategoryDialog: (props: { open: boolean; apiBaseUrl?: string }) =>
    props.open ? createElement('div', {
      'data-testid': 'dialog-create-category',
      'data-api-base-url': props.apiBaseUrl ?? '',
    }) : null,
}))

vi.mock('@/components/chat/collab/ChannelSettingsSheet', () => ({
  ChannelSettingsSheet: (props: {
    open: boolean
    apiBaseUrl?: string
    channel?: CollaborationChannel
    categories?: CollaborationCategory[]
  }) =>
    props.open ? createElement('div', {
      'data-testid': 'dialog-channel-settings',
      'data-api-base-url': props.apiBaseUrl ?? '',
      'data-channel-id': props.channel?.channelId ?? '',
      'data-category-count': String(props.categories?.length ?? 0),
    }) : null,
}))

// ---------------------------------------------------------------------------
// Import component under test
// ---------------------------------------------------------------------------

import { CollabSidebar } from './CollabSidebar'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(connectionId: string, label: string): CollaborationEndpointTarget {
  return {
    connectionId,
    kind: 'remote',
    label,
    serverUrl: `http://${label}.example.com`,
    apiBaseUrl: `http://${label}.example.com/`,
    wsUrl: `ws://${label}.example.com`,
    isRemote: true,
  }
}

function makeState(overrides: Partial<CollabWsState> = {}): CollabWsState {
  return {
    ...createInitialCollabWsState(),
    hasBootstrapped: true,
    connected: true,
    workspace: {
      workspaceId: 'ws-default',
      displayName: 'Workspace',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    currentUser: { userId: 'u-1', role: 'admin', name: 'Admin', email: 'admin@test.com', disabled: false },
    ...overrides,
  }
}

/**
 * Two-backend setup: conn-a is ACTIVE, conn-b is INACTIVE.
 * Both are admin-capable.
 */
function setupTwoBackends() {
  const stateA = makeState({
    workspace: { workspaceId: 'ws-a', displayName: 'Alpha', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    categories: [CATEGORY_ON_A],
    channels: [CHANNEL_ON_A],
  })

  const stateB = makeState({
    workspace: { workspaceId: 'ws-b', displayName: 'Beta', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    categories: [CATEGORY_ON_B],
    channels: [CHANNEL_ON_B],
  })

  connectionsValue.current = {
    connectionStates: { 'conn-a': stateA, 'conn-b': stateB },
    connectionIds: ['conn-a', 'conn-b'],
    targets: [makeTarget('conn-a', 'alpha'), makeTarget('conn-b', 'beta')],
    activeConnectionId: 'conn-a', // A is active
    activeChannelId: null,
    setActiveChannel: vi.fn(),
    getClient: () => null,
    managerRef: { current: null } as MutableRefObject<null>,
  }
}

let root: Root
let container: HTMLDivElement

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

function renderSidebar() {
  flushSync(() => {
    root.render(
      createElement(CollabSidebar, {
        activeSurface: 'collab' as const,
        onSelectChannel: vi.fn(),
        onSelectSurface: vi.fn(),
      }),
    )
  })
}

function clickTrigger(testId: string) {
  const btn = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null
  expect(btn).not.toBeNull()
  flushSync(() => {
    btn!.click()
  })
}

function getDialogAttr(dialogTestId: string, attr: string): string | null {
  const el = container.querySelector(`[data-testid="${dialogTestId}"]`)
  return el?.getAttribute(attr) ?? null
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CollabSidebar — dialog action target routing', () => {
  const ACTIVE_URL = 'http://alpha.example.com/'
  const INACTIVE_URL = 'http://beta.example.com/'

  describe('actions on inactive connection use inactive backend URL', () => {
    it('rename channel on inactive connection targets inactive backend', () => {
      setupTwoBackends()
      renderSidebar()

      clickTrigger('trigger-rename-channel-conn-b')

      expect(getDialogAttr('dialog-rename-channel', 'data-api-base-url')).toBe(INACTIVE_URL)
      expect(getDialogAttr('dialog-rename-channel', 'data-channel-id')).toBe('ch-b')
    })

    it('archive channel on inactive connection targets inactive backend', () => {
      setupTwoBackends()
      renderSidebar()

      clickTrigger('trigger-archive-channel-conn-b')

      expect(getDialogAttr('dialog-archive-channel', 'data-api-base-url')).toBe(INACTIVE_URL)
      expect(getDialogAttr('dialog-archive-channel', 'data-channel-id')).toBe('ch-b')
    })

    it('channel settings on inactive connection targets inactive backend', () => {
      setupTwoBackends()
      renderSidebar()

      clickTrigger('trigger-settings-channel-conn-b')

      expect(getDialogAttr('dialog-channel-settings', 'data-api-base-url')).toBe(INACTIVE_URL)
      expect(getDialogAttr('dialog-channel-settings', 'data-channel-id')).toBe('ch-b')
    })

    it('channel settings receives categories from inactive connection, not active', () => {
      setupTwoBackends()
      renderSidebar()

      clickTrigger('trigger-settings-channel-conn-b')

      // conn-b has 1 category (CATEGORY_ON_B). If it received active categories
      // by mistake, count would be wrong or the category would be CATEGORY_ON_A.
      expect(getDialogAttr('dialog-channel-settings', 'data-category-count')).toBe('1')
    })

    it('rename category on inactive connection targets inactive backend', () => {
      setupTwoBackends()
      renderSidebar()

      clickTrigger('trigger-rename-category-conn-b')

      expect(getDialogAttr('dialog-rename-category', 'data-api-base-url')).toBe(INACTIVE_URL)
      expect(getDialogAttr('dialog-rename-category', 'data-category-id')).toBe('cat-b')
    })

    it('delete category on inactive connection targets inactive backend', () => {
      setupTwoBackends()
      renderSidebar()

      clickTrigger('trigger-delete-category-conn-b')

      expect(getDialogAttr('dialog-delete-category', 'data-api-base-url')).toBe(INACTIVE_URL)
      expect(getDialogAttr('dialog-delete-category', 'data-category-id')).toBe('cat-b')
    })

    it('create channel in category on inactive connection targets inactive backend', () => {
      setupTwoBackends()
      renderSidebar()

      clickTrigger('trigger-create-channel-in-cat-conn-b')

      expect(getDialogAttr('dialog-create-channel', 'data-api-base-url')).toBe(INACTIVE_URL)
      expect(getDialogAttr('dialog-create-channel', 'data-default-category-id')).toBe('cat-b')
    })

    it('create category from inactive connection section targets inactive backend', () => {
      setupTwoBackends()
      renderSidebar()

      clickTrigger('trigger-create-category-conn-b')

      expect(getDialogAttr('dialog-create-category', 'data-api-base-url')).toBe(INACTIVE_URL)
    })
  })

  describe('actions on active connection still use active backend URL', () => {
    it('rename channel on active connection targets active backend', () => {
      setupTwoBackends()
      renderSidebar()

      clickTrigger('trigger-rename-channel-conn-a')

      expect(getDialogAttr('dialog-rename-channel', 'data-api-base-url')).toBe(ACTIVE_URL)
      expect(getDialogAttr('dialog-rename-channel', 'data-channel-id')).toBe('ch-a')
    })

    it('channel settings on active connection uses active categories', () => {
      setupTwoBackends()
      renderSidebar()

      clickTrigger('trigger-settings-channel-conn-a')

      expect(getDialogAttr('dialog-channel-settings', 'data-api-base-url')).toBe(ACTIVE_URL)
      expect(getDialogAttr('dialog-channel-settings', 'data-category-count')).toBe('1')
    })
  })
})
