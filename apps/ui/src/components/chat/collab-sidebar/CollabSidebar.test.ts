/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollabConnectionsValue } from '@/hooks/index-page/use-collab-connections'
import type { CollabWsState } from '@/lib/collab-ws-state'
import { createInitialCollabWsState } from '@/lib/collab-ws-state'
import type { CollaborationEndpointTarget } from '@/lib/collaboration-connections'
import type { MutableRefObject } from 'react'

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before module imports
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

// Now import the components under test
import { CollabSidebar } from './CollabSidebar'
import { ConnectionSectionHeader } from './ConnectionSectionHeader'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTarget(
  connectionId: string,
  label: string,
): CollaborationEndpointTarget {
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
    ...overrides,
  }
}

function makeConnections(entries: Array<{
  connectionId: string
  label: string
  state: CollabWsState
}>, activeId: string | null = null): CollabConnectionsValue {
  const connectionStates: Record<string, CollabWsState> = {}
  const connectionIds: string[] = []
  const targets: CollaborationEndpointTarget[] = []

  for (const entry of entries) {
    connectionStates[entry.connectionId] = entry.state
    connectionIds.push(entry.connectionId)
    targets.push(makeTarget(entry.connectionId, entry.label))
  }

  return {
    connectionStates,
    connectionIds,
    targets,
    activeConnectionId: activeId ?? connectionIds[0] ?? null,
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

describe('CollabSidebar — multi-backend rendering', () => {
  it('renders a single backend without section headers (zero extra chrome)', () => {
    connectionsValue.current = makeConnections([
      {
        connectionId: 'conn-1',
        label: 'Production',
        state: makeState({
          channels: [
            {
              channelId: 'ch-1',
              workspaceId: 'ws-1',
              sessionAgentId: 'session-1',
              name: 'general',
              slug: 'general',
              aiEnabled: true,
              activeSelectedSpecialistHandles: [],
              position: 0,
              archived: false,
              lastMessageSeq: 0,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      },
    ])

    renderSidebar()

    // Channel should be visible
    expect(container.textContent).toContain('#general')
    // No section header label for single backend
    expect(container.textContent).not.toContain('Production')
  })

  it('renders section headers with labels for multiple backends', () => {
    connectionsValue.current = makeConnections([
      {
        connectionId: 'conn-1',
        label: 'Production',
        state: makeState({
          channels: [
            {
              channelId: 'ch-1',
              workspaceId: 'ws-1',
              sessionAgentId: 'session-1',
              name: 'general',
              slug: 'general',
              aiEnabled: true,
              activeSelectedSpecialistHandles: [],
              position: 0,
              archived: false,
              lastMessageSeq: 0,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      },
      {
        connectionId: 'conn-2',
        label: 'Staging',
        state: makeState({
          workspace: {
            workspaceId: 'ws-2',
            displayName: 'Staging Workspace',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          channels: [
            {
              channelId: 'ch-2',
              workspaceId: 'ws-2',
              sessionAgentId: 'session-2',
              name: 'staging-chat',
              slug: 'staging-chat',
              aiEnabled: true,
              activeSelectedSpecialistHandles: [],
              position: 0,
              archived: false,
              lastMessageSeq: 0,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      },
    ], 'conn-1')

    renderSidebar()

    // Both section headers should be visible
    expect(container.textContent).toContain('Production')
    expect(container.textContent).toContain('Staging')
    // Both channels should be visible
    expect(container.textContent).toContain('#general')
    expect(container.textContent).toContain('#staging-chat')
  })

  it('shows health status dots for each connection header', () => {
    connectionsValue.current = makeConnections([
      {
        connectionId: 'conn-1',
        label: 'Production',
        state: makeState({ connected: true }),
      },
      {
        connectionId: 'conn-2',
        label: 'Staging',
        state: makeState({
          connected: false,
          hasBootstrapped: true,
          workspace: {
            workspaceId: 'ws-2',
            displayName: 'Staging',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        }),
      },
    ], 'conn-1')

    renderSidebar()

    // Find health status elements via aria-label
    const statusElements = container.querySelectorAll('[role="status"]')
    // 2 connection headers (multi-backend) + 2 from ModeSwitch = at least 4
    const labels = Array.from(statusElements).map((el) => el.getAttribute('aria-label'))
    expect(labels).toContain('Production Connected')
    expect(labels).toContain('Staging Reconnecting')
  })

  it('shows unread badges per connection header', () => {
    connectionsValue.current = makeConnections([
      {
        connectionId: 'conn-1',
        label: 'Production',
        state: makeState({
          channelUnreadCounts: { 'ch-1': 5, 'ch-2': 3 },
          channels: [
            {
              channelId: 'ch-1',
              workspaceId: 'ws-1',
              sessionAgentId: 's-1',
              name: 'general',
              slug: 'general',
              aiEnabled: true,
              activeSelectedSpecialistHandles: [],
              position: 0,
              archived: false,
              lastMessageSeq: 0,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
            {
              channelId: 'ch-2',
              workspaceId: 'ws-1',
              sessionAgentId: 's-2',
              name: 'random',
              slug: 'random',
              aiEnabled: true,
              activeSelectedSpecialistHandles: [],
              position: 1,
              archived: false,
              lastMessageSeq: 0,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      },
      {
        connectionId: 'conn-2',
        label: 'Staging',
        state: makeState({
          workspace: {
            workspaceId: 'ws-2',
            displayName: 'Staging',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          channelUnreadCounts: {},
          channels: [],
        }),
      },
    ], 'conn-1')

    renderSidebar()

    // Production should show total unread of 8
    expect(container.textContent).toContain('8')
  })

  it('highlights selected channel only on the active connection', () => {
    const onSelectChannel = vi.fn()

    connectionsValue.current = makeConnections([
      {
        connectionId: 'conn-1',
        label: 'Production',
        state: makeState({
          channels: [
            {
              channelId: 'ch-1',
              workspaceId: 'ws-1',
              sessionAgentId: 's-1',
              name: 'general',
              slug: 'general',
              aiEnabled: true,
              activeSelectedSpecialistHandles: [],
              position: 0,
              archived: false,
              lastMessageSeq: 0,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      },
      {
        connectionId: 'conn-2',
        label: 'Staging',
        state: makeState({
          workspace: {
            workspaceId: 'ws-2',
            displayName: 'Staging',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          channels: [
            {
              channelId: 'ch-1',
              workspaceId: 'ws-2',
              sessionAgentId: 's-2',
              name: 'general',
              slug: 'general',
              aiEnabled: true,
              activeSelectedSpecialistHandles: [],
              position: 0,
              archived: false,
              lastMessageSeq: 0,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      },
    ], 'conn-1')

    renderSidebar({
      selectedChannelId: 'ch-1',
      onSelectChannel,
    })

    // Both channels render with the same name
    const channelElements = container.querySelectorAll('[role="button"]')
    const channelButtons = Array.from(channelElements).filter(
      (el) => el.textContent?.includes('#general'),
    )
    expect(channelButtons.length).toBe(2)

    // The one on conn-1 (active) should have the active ring class
    const activeButton = channelButtons.find((el) => el.className.includes('ring-1'))
    const inactiveButton = channelButtons.find((el) => !el.className.includes('ring-1'))
    expect(activeButton).toBeTruthy()
    expect(inactiveButton).toBeTruthy()
  })

  it('passes connectionId with channelId when selecting a channel', () => {
    const onSelectChannel = vi.fn()

    connectionsValue.current = makeConnections([
      {
        connectionId: 'conn-1',
        label: 'Production',
        state: makeState({
          channels: [
            {
              channelId: 'ch-1',
              workspaceId: 'ws-1',
              sessionAgentId: 's-1',
              name: 'general',
              slug: 'general',
              aiEnabled: true,
              activeSelectedSpecialistHandles: [],
              position: 0,
              archived: false,
              lastMessageSeq: 0,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      },
    ])

    renderSidebar({ onSelectChannel })

    // Click the channel
    const channelButton = Array.from(container.querySelectorAll('[role="button"]')).find(
      (el) => el.textContent?.includes('#general'),
    )
    expect(channelButton).toBeTruthy()
    channelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(onSelectChannel).toHaveBeenCalledWith('ch-1', 'conn-1')
  })

  it('shows disconnected state for a backend that has not bootstrapped', () => {
    connectionsValue.current = makeConnections([
      {
        connectionId: 'conn-1',
        label: 'Production',
        state: makeState(),
      },
      {
        connectionId: 'conn-2',
        label: 'Staging',
        state: makeState({
          connected: false,
          hasBootstrapped: false,
          workspace: null,
        }),
      },
    ], 'conn-1')

    renderSidebar()

    const statusElements = container.querySelectorAll('[role="status"]')
    const labels = Array.from(statusElements).map((el) => el.getAttribute('aria-label'))
    expect(labels).toContain('Staging Disconnected')
  })

  it('renders empty state when no backends are configured', () => {
    connectionsValue.current = makeConnections([])

    renderSidebar()

    expect(container.textContent).toContain('No collaboration backends configured')
  })

  it('renders categories within each connection section', () => {
    connectionsValue.current = makeConnections([
      {
        connectionId: 'conn-1',
        label: 'Production',
        state: makeState({
          categories: [
            {
              categoryId: 'cat-1',
              workspaceId: 'ws-1',
              name: 'Engineering',
              position: 0,
              defaultSelectedSpecialistHandles: [],
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
          channels: [
            {
              channelId: 'ch-1',
              workspaceId: 'ws-1',
              sessionAgentId: 's-1',
              name: 'frontend',
              slug: 'frontend',
              categoryId: 'cat-1',
              aiEnabled: true,
              activeSelectedSpecialistHandles: [],
              position: 0,
              archived: false,
              lastMessageSeq: 0,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      },
      {
        connectionId: 'conn-2',
        label: 'Staging',
        state: makeState({
          workspace: {
            workspaceId: 'ws-2',
            displayName: 'Staging',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          categories: [
            {
              categoryId: 'cat-2',
              workspaceId: 'ws-2',
              name: 'Testing',
              position: 0,
              defaultSelectedSpecialistHandles: [],
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
          channels: [
            {
              channelId: 'ch-2',
              workspaceId: 'ws-2',
              sessionAgentId: 's-2',
              name: 'qa-channel',
              slug: 'qa-channel',
              categoryId: 'cat-2',
              aiEnabled: true,
              activeSelectedSpecialistHandles: [],
              position: 0,
              archived: false,
              lastMessageSeq: 0,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      },
    ], 'conn-1')

    renderSidebar()

    // Both categories and their channels visible
    expect(container.textContent).toContain('Engineering')
    expect(container.textContent).toContain('#frontend')
    expect(container.textContent).toContain('Testing')
    expect(container.textContent).toContain('#qa-channel')
  })
})

describe('ConnectionSectionHeader', () => {
  it('renders label and health dot', () => {
    flushSync(() => {
      root.render(
        createElement(ConnectionSectionHeader, {
          label: 'Production',
          health: 'connected',
          totalUnread: 0,
          isActive: true,
        }),
      )
    })

    expect(container.textContent).toContain('Production')
    const statusEl = container.querySelector('[role="status"]')
    expect(statusEl?.getAttribute('aria-label')).toBe('Production Connected')
  })

  it('shows unread badge when totalUnread > 0', () => {
    flushSync(() => {
      root.render(
        createElement(ConnectionSectionHeader, {
          label: 'Staging',
          health: 'reconnecting',
          totalUnread: 42,
          isActive: false,
        }),
      )
    })

    expect(container.textContent).toContain('42')
  })

  it('caps unread badge at 99+', () => {
    flushSync(() => {
      root.render(
        createElement(ConnectionSectionHeader, {
          label: 'Dev',
          health: 'disconnected',
          totalUnread: 150,
          isActive: false,
        }),
      )
    })

    expect(container.textContent).toContain('99+')
  })
})
