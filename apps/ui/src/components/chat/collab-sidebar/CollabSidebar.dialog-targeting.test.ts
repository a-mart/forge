/** @vitest-environment jsdom */

/**
 * Tests that dialog actions triggered from an *inactive* backend section
 * target the owning backend's apiBaseUrl — not the active connection's.
 */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollabConnectionsValue } from '@/hooks/index-page/use-collab-connections'
import type { CollabWsState } from '@/lib/collab-ws-state'
import { createInitialCollabWsState } from '@/lib/collab-ws-state'
import type { CollaborationEndpointTarget } from '@/lib/collaboration-connections'
import type { MutableRefObject } from 'react'
import type { CollaborationCategory, CollaborationChannel } from '@forge/protocol'

// ---------------------------------------------------------------------------
// Mocks
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
// Mock ConnectionSection to capture per-section callbacks
// ---------------------------------------------------------------------------

interface CapturedSectionProps {
  connectionId: string
  apiBaseUrl?: string
  onRenameChannel: (ch: CollaborationChannel) => void
  onArchiveChannel: (ch: CollaborationChannel) => void
  onOpenChannelSettings: (ch: CollaborationChannel) => void
  onRenameCategory: (cat: CollaborationCategory) => void
  onDeleteCategory: (cat: CollaborationCategory) => void
  onCreateChannelInCategory: (catId: string) => void
  onOpenCreateCategory: () => void
}

const sectionPropsByConnId: Record<string, CapturedSectionProps> = {}

vi.mock('./ConnectionSection', () => ({
  ConnectionSection: (props: CapturedSectionProps) => {
    sectionPropsByConnId[props.connectionId] = props
    return createElement('div', { 'data-testid': `section-${props.connectionId}` })
  },
}))

// ---------------------------------------------------------------------------
// Mock dialog components to capture their props
// ---------------------------------------------------------------------------

const dialogProps = {
  renameChannel: null as Record<string, unknown> | null,
  archiveChannel: null as Record<string, unknown> | null,
  channelSettings: null as Record<string, unknown> | null,
  renameCategory: null as Record<string, unknown> | null,
  deleteCategory: null as Record<string, unknown> | null,
  createChannel: null as Record<string, unknown> | null,
  createCategory: null as Record<string, unknown> | null,
}

vi.mock('./dialogs/RenameChannelDialog', () => ({
  RenameChannelDialog: (props: Record<string, unknown>) => {
    dialogProps.renameChannel = props
    return props.open ? createElement('div', { 'data-testid': 'rename-channel-dialog' }) : null
  },
}))

vi.mock('./dialogs/ArchiveChannelDialog', () => ({
  ArchiveChannelDialog: (props: Record<string, unknown>) => {
    dialogProps.archiveChannel = props
    return props.open ? createElement('div', { 'data-testid': 'archive-channel-dialog' }) : null
  },
}))

vi.mock('./dialogs/RenameCategoryDialog', () => ({
  RenameCategoryDialog: (props: Record<string, unknown>) => {
    dialogProps.renameCategory = props
    return props.open ? createElement('div', { 'data-testid': 'rename-category-dialog' }) : null
  },
}))

vi.mock('./dialogs/DeleteCategoryDialog', () => ({
  DeleteCategoryDialog: (props: Record<string, unknown>) => {
    dialogProps.deleteCategory = props
    return props.open ? createElement('div', { 'data-testid': 'delete-category-dialog' }) : null
  },
}))

vi.mock('./dialogs/CreateChannelDialog', () => ({
  CreateChannelDialog: (props: Record<string, unknown>) => {
    dialogProps.createChannel = props
    return props.open ? createElement('div', { 'data-testid': 'create-channel-dialog' }) : null
  },
}))

vi.mock('./dialogs/CreateCategoryDialog', () => ({
  CreateCategoryDialog: (props: Record<string, unknown>) => {
    dialogProps.createCategory = props
    return props.open ? createElement('div', { 'data-testid': 'create-category-dialog' }) : null
  },
}))

vi.mock('@/components/chat/collab/ChannelSettingsSheet', () => ({
  ChannelSettingsSheet: (props: Record<string, unknown>) => {
    dialogProps.channelSettings = props
    return props.open ? createElement('div', { 'data-testid': 'channel-settings-sheet' }) : null
  },
}))

// ---------------------------------------------------------------------------
// Import under test (after all mocks)
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
      workspaceId: 'ws-1',
      displayName: 'Test Workspace',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    currentUser: {
      userId: 'user-1',
      email: 'admin@test.com',
      name: 'Admin',
      role: 'admin',
      disabled: false,
    },
    ...overrides,
  }
}

const channelOnConn2: CollaborationChannel = {
  channelId: 'ch-B',
  workspaceId: 'ws-2',
  sessionAgentId: 'session-B',
  name: 'backend-b-channel',
  slug: 'backend-b-channel',
  aiEnabled: true,
  activeSelectedSpecialistHandles: [],
  position: 0,
  archived: false,
  lastMessageSeq: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const categoryOnConn2: CollaborationCategory = {
  categoryId: 'cat-B',
  workspaceId: 'ws-2',
  name: 'Backend-B Category',
  position: 0,
  defaultSelectedSpecialistHandles: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

function setupTwoBackends(): { onSelectChannel: ReturnType<typeof vi.fn> } {
  const onSelectChannel = vi.fn()

  connectionsValue.current = {
    connectionStates: {
      'conn-A': makeState({
        workspace: {
          workspaceId: 'ws-1',
          displayName: 'Backend A',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        channels: [{
          channelId: 'ch-A',
          workspaceId: 'ws-1',
          sessionAgentId: 'session-A',
          name: 'general',
          slug: 'general',
          aiEnabled: true,
          activeSelectedSpecialistHandles: [],
          position: 0,
          archived: false,
          lastMessageSeq: 0,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        }],
      }),
      'conn-B': makeState({
        workspace: {
          workspaceId: 'ws-2',
          displayName: 'Backend B',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        channels: [channelOnConn2],
        categories: [categoryOnConn2],
      }),
    },
    connectionIds: ['conn-A', 'conn-B'],
    targets: [
      makeTarget('conn-A', 'backend-a'),
      makeTarget('conn-B', 'backend-b'),
    ],
    // conn-A is the ACTIVE connection
    activeConnectionId: 'conn-A',
    activeChannelId: null,
    setActiveChannel: vi.fn(),
    getClient: () => null,
    managerRef: { current: null } as MutableRefObject<null>,
  }

  return { onSelectChannel }
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // Reset captured dialog props
  for (const key of Object.keys(dialogProps) as Array<keyof typeof dialogProps>) {
    dialogProps[key] = null
  }
  for (const key of Object.keys(sectionPropsByConnId)) {
    delete sectionPropsByConnId[key]
  }
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function renderSidebar(overrides: Partial<Parameters<typeof CollabSidebar>[0]> = {}) {
  flushSync(() => {
    root.render(
      createElement(CollabSidebar, {
        activeSurface: 'collab' as const,
        onSelectChannel: vi.fn(),
        onSelectSurface: vi.fn(),
        ...overrides,
      }),
    )
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CollabSidebar — inactive-backend dialog targeting', () => {
  it('rename channel from inactive backend uses that backend apiBaseUrl', () => {
    setupTwoBackends()
    renderSidebar()

    // conn-B is the INACTIVE connection; trigger rename from its section
    const conn2Section = sectionPropsByConnId['conn-B']
    expect(conn2Section).toBeDefined()

    flushSync(() => {
      conn2Section.onRenameChannel(channelOnConn2)
    })

    // Dialog should receive conn-B's apiBaseUrl, NOT conn-A's
    expect(dialogProps.renameChannel).not.toBeNull()
    expect(dialogProps.renameChannel!.apiBaseUrl).toBe('http://backend-b.example.com/')
    expect(dialogProps.renameChannel!.channel).toBe(channelOnConn2)
  })

  it('archive channel from inactive backend uses that backend apiBaseUrl', () => {
    setupTwoBackends()
    renderSidebar()

    const conn2Section = sectionPropsByConnId['conn-B']
    flushSync(() => {
      conn2Section.onArchiveChannel(channelOnConn2)
    })

    expect(dialogProps.archiveChannel).not.toBeNull()
    expect(dialogProps.archiveChannel!.apiBaseUrl).toBe('http://backend-b.example.com/')
  })

  it('channel settings from inactive backend uses that backend apiBaseUrl, wsUrl, and categories', () => {
    setupTwoBackends()
    renderSidebar()

    const conn2Section = sectionPropsByConnId['conn-B']
    flushSync(() => {
      conn2Section.onOpenChannelSettings(channelOnConn2)
    })

    expect(dialogProps.channelSettings).not.toBeNull()
    expect(dialogProps.channelSettings!.apiBaseUrl).toBe('http://backend-b.example.com/')
    // wsUrl must target the owning backend so model presets/specialists are read from B
    expect(dialogProps.channelSettings!.wsUrl).toBe('ws://backend-b.example.com')
    // Categories should come from conn-B, not conn-A
    const categories = dialogProps.channelSettings!.categories as CollaborationCategory[]
    expect(categories).toEqual([categoryOnConn2])
  })

  it('rename category from inactive backend uses that backend apiBaseUrl and wsUrl', () => {
    setupTwoBackends()
    renderSidebar()

    const conn2Section = sectionPropsByConnId['conn-B']
    flushSync(() => {
      conn2Section.onRenameCategory(categoryOnConn2)
    })

    expect(dialogProps.renameCategory).not.toBeNull()
    expect(dialogProps.renameCategory!.apiBaseUrl).toBe('http://backend-b.example.com/')
    // wsUrl must target the owning backend so model presets/specialists are read from B
    expect(dialogProps.renameCategory!.wsUrl).toBe('ws://backend-b.example.com')
    expect(dialogProps.renameCategory!.category).toBe(categoryOnConn2)
  })

  it('delete category from inactive backend uses that backend apiBaseUrl', () => {
    setupTwoBackends()
    renderSidebar()

    const conn2Section = sectionPropsByConnId['conn-B']
    flushSync(() => {
      conn2Section.onDeleteCategory(categoryOnConn2)
    })

    expect(dialogProps.deleteCategory).not.toBeNull()
    expect(dialogProps.deleteCategory!.apiBaseUrl).toBe('http://backend-b.example.com/')
  })

  it('create channel in category from inactive backend uses that backend apiBaseUrl', () => {
    setupTwoBackends()
    renderSidebar()

    const conn2Section = sectionPropsByConnId['conn-B']
    flushSync(() => {
      conn2Section.onCreateChannelInCategory('cat-B')
    })

    expect(dialogProps.createChannel).not.toBeNull()
    expect(dialogProps.createChannel!.apiBaseUrl).toBe('http://backend-b.example.com/')
    expect(dialogProps.createChannel!.defaultCategoryId).toBe('cat-B')
    // Categories list should come from conn-B
    const categories = dialogProps.createChannel!.categories as CollaborationCategory[]
    expect(categories).toEqual([categoryOnConn2])
  })

  it('create category from inactive backend uses that backend apiBaseUrl and wsUrl', () => {
    setupTwoBackends()
    renderSidebar()

    const conn2Section = sectionPropsByConnId['conn-B']
    flushSync(() => {
      conn2Section.onOpenCreateCategory()
    })

    expect(dialogProps.createCategory).not.toBeNull()
    expect(dialogProps.createCategory!.apiBaseUrl).toBe('http://backend-b.example.com/')
    // wsUrl must target the owning backend so model presets/specialists are read from B
    expect(dialogProps.createCategory!.wsUrl).toBe('ws://backend-b.example.com')
  })

  it('active-backend actions still use the active backend apiBaseUrl', () => {
    setupTwoBackends()
    renderSidebar()

    const conn1Section = sectionPropsByConnId['conn-A']
    const channelA: CollaborationChannel = {
      channelId: 'ch-A',
      workspaceId: 'ws-1',
      sessionAgentId: 'session-A',
      name: 'general',
      slug: 'general',
      aiEnabled: true,
      activeSelectedSpecialistHandles: [],
      position: 0,
      archived: false,
      lastMessageSeq: 0,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }

    flushSync(() => {
      conn1Section.onRenameChannel(channelA)
    })

    expect(dialogProps.renameChannel).not.toBeNull()
    expect(dialogProps.renameChannel!.apiBaseUrl).toBe('http://backend-a.example.com/')
  })
})
