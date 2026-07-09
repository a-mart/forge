/** @vitest-environment jsdom */

import { fireEvent, getByLabelText, getByRole, getByText, queryByRole, queryByText, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationSessionInfo, CollaborationStatus } from '@forge/protocol'
import { SettingsCollaboration } from './SettingsCollaboration'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

const collabApiMock = vi.hoisted(() => ({
  fetchCollaborationStatus: vi.fn(),
  fetchCollaborationMe: vi.fn(),
  changeMyPassword: vi.fn(),
  fetchCollaborationUsers: vi.fn(),
  updateCollaborationUser: vi.fn(),
  resetUserPassword: vi.fn(),
  fetchCollaborationInvites: vi.fn(),
  createCollaborationInvite: vi.fn(),
  revokeCollaborationInvite: vi.fn(),
  isAuthError: vi.fn(),
}))

vi.mock('./collaboration-settings-api', () => ({
  fetchCollaborationStatus: (...args: unknown[]) => collabApiMock.fetchCollaborationStatus(...args),
  fetchCollaborationMe: (...args: unknown[]) => collabApiMock.fetchCollaborationMe(...args),
  changeMyPassword: (...args: unknown[]) => collabApiMock.changeMyPassword(...args),
  fetchCollaborationUsers: (...args: unknown[]) => collabApiMock.fetchCollaborationUsers(...args),
  updateCollaborationUser: (...args: unknown[]) => collabApiMock.updateCollaborationUser(...args),
  resetUserPassword: (...args: unknown[]) => collabApiMock.resetUserPassword(...args),
  fetchCollaborationInvites: (...args: unknown[]) => collabApiMock.fetchCollaborationInvites(...args),
  createCollaborationInvite: (...args: unknown[]) => collabApiMock.createCollaborationInvite(...args),
  revokeCollaborationInvite: (...args: unknown[]) => collabApiMock.revokeCollaborationInvite(...args),
  isAuthError: (...args: unknown[]) => collabApiMock.isAuthError(...args),
}))

/* ── Connection registry mock ── */

interface MockConnectionTarget {
  connectionId: string
  kind: 'remote' | 'same-origin'
  label: string
  serverUrl?: string
  apiBaseUrl: string
  wsUrl: string
  isRemote: boolean
  virtual?: boolean
  capabilities?: { collab: boolean; remoteBuild: boolean; protocolVersion: number }
  remoteProjectsEnabled?: boolean
}

const registryMock = vi.hoisted(() => ({
  connections: [] as MockConnectionTarget[],
  defaultConnectionId: 'conn_same_origin',
  subscribeCb: null as (() => void) | null,
}))

function remoteTarget(id: string, label: string, serverUrl: string): MockConnectionTarget {
  return {
    connectionId: id,
    kind: 'remote' as const,
    label,
    serverUrl,
    apiBaseUrl: serverUrl.endsWith('/') ? serverUrl : serverUrl + '/',
    wsUrl: serverUrl.replace(/^http(s?):\/\//, 'ws$1://'),
    isRemote: true,
  }
}

function sameOriginTarget(opts?: { virtual?: boolean }): MockConnectionTarget {
  return {
    connectionId: 'conn_same_origin',
    kind: 'same-origin' as const,
    label: 'Local',
    apiBaseUrl: 'http://127.0.0.1:47187/',
    wsUrl: 'ws://127.0.0.1:47187',
    isRemote: false,
    virtual: opts?.virtual ?? true,
  }
}

vi.mock('@/lib/collaboration-connections', () => ({
  getCollaborationConnectionOptions: () => registryMock.connections.map((conn) => ({ ...conn, capabilities: conn.capabilities ? { ...conn.capabilities } : undefined })),
  getDefaultCollaborationConnection: () => {
    const found = registryMock.connections.find(
      (c) => c.connectionId === registryMock.defaultConnectionId,
    )
    return found ?? registryMock.connections[0] ?? sameOriginTarget()
  },
  upsertCollaborationConnection: vi.fn((input: { serverUrl: string }) => {
    const id = 'conn_new_' + input.serverUrl.replace(/[^a-z0-9]/gi, '')
    const existing = registryMock.connections.find((c) => c.connectionId === id)
    if (!existing) {
      registryMock.connections.push(remoteTarget(id, new URL(input.serverUrl).host, input.serverUrl))
    }
    return id
  }),
  removeCollaborationConnection: vi.fn((connId: string) => {
    registryMock.connections = registryMock.connections.filter((c) => c.connectionId !== connId)
  }),
  renameCollaborationConnection: vi.fn((connId: string, label: string) => {
    const conn = registryMock.connections.find((c) => c.connectionId === connId)
    if (conn) conn.label = label
  }),
  setCollaborationConnectionRemoteProjects: vi.fn((connId: string, enabled: boolean) => {
    const conn = registryMock.connections.find((c) => c.connectionId === connId)
    if (conn) conn.remoteProjectsEnabled = enabled
  }),
  cacheCollaborationConnectionCapabilities: vi.fn((connId: string, capabilities: { collab: boolean; remoteBuild: boolean; protocolVersion: number }) => {
    const conn = registryMock.connections.find((c) => c.connectionId === connId)
    if (conn) conn.capabilities = capabilities
  }),
  subscribeToRegistryChanges: vi.fn((cb: () => void) => {
    registryMock.subscribeCb = cb
    return () => { registryMock.subscribeCb = null }
  }),
}))

/* ------------------------------------------------------------------ */
/*  Fixtures                                                          */
/* ------------------------------------------------------------------ */

function statusEnabled(overrides?: Partial<CollaborationStatus>): CollaborationStatus {
  return {
    enabled: true,
    ready: true,
    adminExists: true,
    baseUrl: 'https://collab.test',
    protocolVersion: 1,
    capabilities: { collab: true, remoteBuild: false },
    ...overrides,
  }
}

function statusDisabled() {
  return { ...statusEnabled(), enabled: false }
}

function adminSession() {
  return {
    authenticated: true,
    user: {
      userId: 'admin-1',
      email: 'admin@test.com',
      name: 'Admin User',
      role: 'admin' as const,
      disabled: false,
      authMethods: ['password' as const],
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
  }
}

function memberSession() {
  return {
    authenticated: true,
    user: {
      userId: 'member-1',
      email: 'member@test.com',
      name: 'Member User',
      role: 'member' as const,
      disabled: false,
      authMethods: ['password' as const],
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
  }
}

function passwordChangeRequiredSession() {
  return {
    ...memberSession(),
    passwordChangeRequired: true,
  }
}

function testUsers() {
  return [
    {
      userId: 'admin-1',
      email: 'admin@test.com',
      name: 'Admin User',
      role: 'admin' as const,
      disabled: false,
      authMethods: ['password' as const],
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    },
    {
      userId: 'member-1',
      email: 'member@test.com',
      name: 'Regular Member',
      role: 'member' as const,
      disabled: false,
      authMethods: ['password' as const],
      createdAt: '2025-01-02T00:00:00Z',
      updatedAt: '2025-01-02T00:00:00Z',
    },
    {
      userId: 'deactivated-1',
      email: 'deactivated@test.com',
      name: 'Deactivated User',
      role: 'member' as const,
      disabled: true,
      authMethods: ['password' as const],
      createdAt: '2025-01-03T00:00:00Z',
      updatedAt: '2025-01-03T00:00:00Z',
    },
  ]
}

function testInvites() {
  return [
    {
      inviteId: 'inv-1',
      email: 'pending@test.com',
      role: 'member' as const,
      status: 'pending' as const,
      createdAt: '2025-01-01T00:00:00Z',
      expiresAt: '2025-01-08T00:00:00Z',
    },
    {
      inviteId: 'inv-2',
      email: 'consumed@test.com',
      role: 'member' as const,
      status: 'consumed' as const,
      createdAt: '2025-01-01T00:00:00Z',
      expiresAt: '2025-01-08T00:00:00Z',
      consumedAt: '2025-01-02T00:00:00Z',
    },
    {
      inviteId: 'inv-3',
      email: 'revoked@test.com',
      role: 'member' as const,
      status: 'revoked' as const,
      createdAt: '2025-01-01T00:00:00Z',
      expiresAt: '2025-01-08T00:00:00Z',
      revokedAt: '2025-01-03T00:00:00Z',
    },
    {
      inviteId: 'inv-4',
      email: 'expired@test.com',
      role: 'member' as const,
      status: 'expired' as const,
      createdAt: '2024-12-01T00:00:00Z',
      expiresAt: '2024-12-08T00:00:00Z',
    },
  ]
}

/* ------------------------------------------------------------------ */
/*  Setup                                                             */
/* ------------------------------------------------------------------ */

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  collabApiMock.isAuthError.mockReturnValue(false)

  // Default: one remote connection configured
  const remote = remoteTarget('conn_remote_1', 'collab.example.com', 'https://collab.example.com')
  registryMock.connections = [remote]
  registryMock.defaultConnectionId = 'conn_remote_1'
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  registryMock.connections = []
  registryMock.defaultConnectionId = 'conn_same_origin'
  registryMock.subscribeCb = null
})

async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    await Promise.resolve()
    flushSync(() => {})
  }
}

function renderCollab(extraProps?: { initialApiBaseUrl?: string }): void {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(SettingsCollaboration, {
      wsUrl: 'ws://127.0.0.1:47187',
      ...extraProps,
    }))
  })
}

/* ================================================================== */
/*  Tests                                                             */
/* ================================================================== */

describe('SettingsCollaboration', () => {
  /* ---- Connection list ---- */

  describe('connection list', () => {
    it('renders connection items from the registry', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()

      const list = container.querySelector('[data-testid="connection-list"]')
      expect(list).not.toBeNull()
      expect(list!.textContent).toContain('collab.example.com')
    })

    it('shows "Add connection" button', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()

      const addBtn = container.querySelector('[data-testid="add-connection-btn"]')
      expect(addBtn).not.toBeNull()
    })

    it('shows multiple connections when configured', async () => {
      registryMock.connections = [
        remoteTarget('conn_a', 'server-a.test', 'https://server-a.test'),
        remoteTarget('conn_b', 'server-b.test', 'https://server-b.test'),
      ]
      registryMock.defaultConnectionId = 'conn_a'

      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()

      const list = container.querySelector('[data-testid="connection-list"]')
      expect(list!.textContent).toContain('server-a.test')
      expect(list!.textContent).toContain('server-b.test')
    })

    it('shows same-origin virtual fallback when no remotes exist', async () => {
      registryMock.connections = [sameOriginTarget()]
      registryMock.defaultConnectionId = 'conn_same_origin'

      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue({ authenticated: false })
      renderCollab()
      await flush()

      const list = container.querySelector('[data-testid="connection-list"]')
      expect(list!.textContent).toContain('Local')
    })

    it('shows add connection form when clicking add button', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()

      const addBtn = container.querySelector('[data-testid="add-connection-btn"]') as HTMLButtonElement
      fireEvent.click(addBtn)
      await flush()

      const addForm = container.querySelector('[data-testid="add-connection-form"]')
      expect(addForm).not.toBeNull()
    })

    it('enables remote projects by default for a newly added server whose tested capabilities support remote build', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => statusEnabled({ capabilities: { collab: true, remoteBuild: true }, protocolVersion: 7 }),
      }))
      renderCollab()
      await flush()

      fireEvent.click(container.querySelector('[data-testid="add-connection-btn"]') as HTMLButtonElement)
      await flush()
      const input = container.querySelector('#add-collab-url') as HTMLInputElement
      fireEvent.change(input, { target: { value: 'https://remote-build.test' } })
      fireEvent.click(getByRole(container, 'button', { name: 'Test' }))
      await waitFor(() => expect(container.textContent).toContain('Connection successful'))
      fireEvent.click(getByRole(container, 'button', { name: 'Add' }))
      await flush()

      const { setCollaborationConnectionRemoteProjects, cacheCollaborationConnectionCapabilities } = await import('@/lib/collaboration-connections')
      const expectedId = 'conn_new_httpsremotebuildtest'
      expect(setCollaborationConnectionRemoteProjects).toHaveBeenCalledWith(expectedId, true)
      expect(cacheCollaborationConnectionCapabilities).toHaveBeenCalledWith(expectedId, {
        collab: true,
        remoteBuild: true,
        protocolVersion: 7,
      })
      expect(registryMock.connections.find((conn) => conn.connectionId === expectedId)?.remoteProjectsEnabled).toBe(true)
    })

    it('does not change the remote projects preference when adding an already configured server', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      const existing = remoteTarget('conn_new_httpsremotebuildtest', 'remote-build.test', 'https://remote-build.test')
      existing.remoteProjectsEnabled = false
      registryMock.connections = [existing]
      registryMock.defaultConnectionId = existing.connectionId
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => statusEnabled({ capabilities: { collab: true, remoteBuild: true }, protocolVersion: 7 }),
      }))
      renderCollab()
      await flush()

      fireEvent.click(container.querySelector('[data-testid="add-connection-btn"]') as HTMLButtonElement)
      await flush()
      fireEvent.change(container.querySelector('#add-collab-url') as HTMLInputElement, { target: { value: 'https://remote-build.test' } })
      fireEvent.click(getByRole(container, 'button', { name: 'Test' }))
      await waitFor(() => expect(container.textContent).toContain('Connection successful'))
      fireEvent.click(getByRole(container, 'button', { name: 'Add' }))
      await flush()

      const { setCollaborationConnectionRemoteProjects } = await import('@/lib/collaboration-connections')
      expect(setCollaborationConnectionRemoteProjects).not.toHaveBeenCalled()
      expect(existing.remoteProjectsEnabled).toBe(false)
    })
  })

  /* ---- Connection rename ---- */

  describe('connection rename', () => {
    it('shows rename button for each connection', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()

      const renameBtn = getByRole(container, 'button', { name: 'Rename collab.example.com' })
      expect(renameBtn).toBeTruthy()
    })

    it('enters inline edit mode when rename button is clicked', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()

      const renameBtn = getByRole(container, 'button', { name: /rename collab\.example\.com/i })
      fireEvent.click(renameBtn)
      await flush()

      const input = getByRole(container, 'textbox', { name: /connection name/i }) as HTMLInputElement
      expect(input).toBeTruthy()
      expect(input.value).toBe('collab.example.com')
    })

    it('commits rename on Enter and calls renameCollaborationConnection', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()

      // Click rename button (accessible by aria-label)
      const renameBtn = getByRole(container, 'button', { name: /rename collab\.example\.com/i })
      fireEvent.click(renameBtn)
      await flush()

      // Rename input should be visible and accessible
      const input = getByRole(container, 'textbox', { name: /connection name/i }) as HTMLInputElement
      fireEvent.change(input, { target: { value: 'My Server' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await flush()

      // Verify rename was called
      const { renameCollaborationConnection } = await import('@/lib/collaboration-connections')
      expect(renameCollaborationConnection).toHaveBeenCalledWith('conn_remote_1', 'My Server')

      // Input should be gone
      expect(queryByRole(container, 'textbox', { name: /connection name/i })).toBeNull()
    })

    it('cancels rename on Escape without calling renameCollaborationConnection', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()

      // Click rename button
      const renameBtn = getByRole(container, 'button', { name: /rename collab\.example\.com/i })
      fireEvent.click(renameBtn)
      await flush()

      // Type new name then press Escape
      const input = getByRole(container, 'textbox', { name: /connection name/i }) as HTMLInputElement
      fireEvent.change(input, { target: { value: 'Different Name' } })
      fireEvent.keyDown(input, { key: 'Escape' })
      await flush()

      // Verify rename was NOT called
      const { renameCollaborationConnection } = await import('@/lib/collaboration-connections')
      expect(renameCollaborationConnection).not.toHaveBeenCalled()

      // Input should be gone
      expect(queryByRole(container, 'textbox', { name: /connection name/i })).toBeNull()
    })

    it('commits rename on blur', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()

      // Click rename button
      const renameBtn = getByRole(container, 'button', { name: /rename collab\.example\.com/i })
      flushSync(() => { fireEvent.click(renameBtn) })
      await flush()

      // Type new name — flush to ensure state is committed before blur
      const input = getByRole(container, 'textbox', { name: /connection name/i }) as HTMLInputElement
      flushSync(() => { fireEvent.change(input, { target: { value: 'Blurred Name' } }) })
      await flush()

      // Blur the input by focusing another element
      flushSync(() => { input.blur() })
      await flush()

      const { renameCollaborationConnection } = await import('@/lib/collaboration-connections')
      expect(renameCollaborationConnection).toHaveBeenCalledWith('conn_remote_1', 'Blurred Name')
    })

    it('hides rename button for virtual same-origin connections', async () => {
      registryMock.connections = [sameOriginTarget({ virtual: true })]
      registryMock.defaultConnectionId = 'conn_same_origin'

      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue({ authenticated: false })
      renderCollab()
      await flush()

      // No rename button should be present at all
      expect(container.querySelector('[data-testid="rename-connection-conn_same_origin"]')).toBeNull()
      // The connection item should still render
      expect(container.querySelector('[data-testid="connection-item-conn_same_origin"]')).not.toBeNull()
    })

    it('shows rename button for explicitly persisted same-origin connections', async () => {
      registryMock.connections = [sameOriginTarget({ virtual: false })]
      registryMock.defaultConnectionId = 'conn_same_origin'

      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue({ authenticated: false })
      renderCollab()
      await flush()

      const renameBtn = getByRole(container, 'button', { name: /rename local/i })
      expect(renameBtn).toBeTruthy()
    })

    it('virtual same-origin is the default when no connections configured', async () => {
      // Default fallback: getDefaultCollaborationConnection returns virtual same-origin
      registryMock.connections = [sameOriginTarget()]
      registryMock.defaultConnectionId = 'conn_same_origin'

      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue({ authenticated: false })
      renderCollab()
      await flush()

      // Connection renders with Local badge
      const item = container.querySelector('[data-testid="connection-item-conn_same_origin"]')
      expect(item).not.toBeNull()
      expect(item!.textContent).toContain('Local')

      // No rename affordance for virtual fallback
      expect(container.querySelector('[data-testid="rename-connection-conn_same_origin"]')).toBeNull()

      // Verify renameCollaborationConnection is never called
      const { renameCollaborationConnection } = await import('@/lib/collaboration-connections')
      expect(renameCollaborationConnection).not.toHaveBeenCalled()
    })

    it('remote rename still works alongside virtual same-origin', async () => {
      const remote = remoteTarget('conn_r1', 'my-server.com', 'https://my-server.com')
      registryMock.connections = [sameOriginTarget(), remote]
      registryMock.defaultConnectionId = 'conn_r1'

      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()

      // Virtual same-origin has no rename button
      expect(container.querySelector('[data-testid="rename-connection-conn_same_origin"]')).toBeNull()

      // Remote connection has a rename button
      const renameBtn = getByRole(container, 'button', { name: /rename my-server\.com/i })
      expect(renameBtn).toBeTruthy()

      // Rename the remote connection
      fireEvent.click(renameBtn)
      await flush()

      const input = getByRole(container, 'textbox', { name: /connection name/i }) as HTMLInputElement
      fireEvent.change(input, { target: { value: 'Renamed Remote' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      await flush()

      const { renameCollaborationConnection } = await import('@/lib/collaboration-connections')
      expect(renameCollaborationConnection).toHaveBeenCalledWith('conn_r1', 'Renamed Remote')
    })
  })

  /* ---- Status section ---- */

  describe('status display', () => {
    it('shows disabled badge when collab is not enabled', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusDisabled())
      renderCollab()
      await flush()

      expect(container.textContent).toContain('Disabled')
      expect(container.textContent).toContain('FORGE_COLLABORATION_ENABLED=true')
    })

    it('shows enabled badge when collab is active', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()

      expect(container.textContent).toContain('Enabled')
      expect(container.textContent).toContain('Configured')
    })

    it('shows base URL when available', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()

      expect(container.textContent).toContain('https://collab.test')
    })

    it('shows error state with retry', async () => {
      collabApiMock.fetchCollaborationStatus.mockRejectedValue(new Error('Connection failed'))
      renderCollab()
      await flush()

      expect(container.textContent).toContain('Connection failed')
      expect(container.textContent).toContain('Retry')
    })

    it('passes selected connection apiBaseUrl to fetchCollaborationStatus', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()

      expect(collabApiMock.fetchCollaborationStatus).toHaveBeenCalledWith('https://collab.example.com/')
    })
  })

  /* ---- Authentication section ---- */

  describe('authentication section', () => {
    it('shows sign-in form when collab is enabled but user is not authenticated', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue({ authenticated: false })
      renderCollab()
      await flush()
      await flush()

      await waitFor(() => {
        expect(getByText(container, 'Authentication')).toBeTruthy()
      })

      expect(getByLabelText(container, 'Email')).toBeTruthy()
      expect(getByLabelText(container, 'Password')).toBeTruthy()
      expect(getByRole(container, 'button', { name: 'Sign in' })).toBeTruthy()
    })

    it('does not show auth section when collab is disabled', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusDisabled())
      renderCollab()
      await flush()

      await waitFor(() => {
        expect(getByText(container, 'Disabled')).toBeTruthy()
      })

      expect(queryByText(container, 'Authentication')).toBeNull()
    })

    it('shows auth section for enabled same-origin hosted collaboration', async () => {
      registryMock.connections = [sameOriginTarget()]
      registryMock.defaultConnectionId = 'conn_same_origin'

      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue({ authenticated: false })
      renderCollab()
      await flush()
      await flush()

      expect(container.textContent).toContain('Enabled')
      expect(getByText(container, 'Authentication')).toBeTruthy()
      expect(getByLabelText(container, 'Email')).toBeTruthy()
      expect(getByRole(container, 'button', { name: 'Sign in' })).toBeTruthy()
    })

    it('shows signed-in state with user info and sign-out button', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()
      await flush()

      await waitFor(() => {
        expect(getByText(container, 'Admin User')).toBeTruthy()
      })
      const emailElements = container.querySelectorAll('*')
      const emailMatches = Array.from(emailElements).filter(
        (el) => el.textContent === 'admin@test.com' && el.children.length === 0,
      )
      expect(emailMatches.length).toBeGreaterThanOrEqual(1)
      expect(getByRole(container, 'button', { name: 'Sign out of collaboration server' })).toBeTruthy()
    })

    it('posts sign-in request with email and password to selected connection', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue({ authenticated: false })

      const fetchSpy = vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('/api/auth/sign-in/email')) {
          return { ok: true, json: async () => ({ success: true }) }
        }
        if (typeof url === 'string' && url.includes('/api/collaboration/me')) {
          return { ok: true, json: async () => adminSession() }
        }
        return { ok: false, json: async () => ({}) }
      })
      vi.stubGlobal('fetch', fetchSpy)

      renderCollab()
      await flush()
      await flush()

      await waitFor(() => {
        expect(getByLabelText(container, 'Email')).toBeTruthy()
      })

      fireEvent.change(getByLabelText(container, 'Email'), { target: { value: 'user@test.com' } })
      fireEvent.change(getByLabelText(container, 'Password'), { target: { value: 'secret123' } })
      fireEvent.click(getByRole(container, 'button', { name: 'Sign in' }))

      await waitFor(() => {
        const signInCall = fetchSpy.mock.calls.find(
          (call) => typeof call[0] === 'string' && call[0].includes('/api/auth/sign-in/email'),
        ) as unknown[] | undefined
        expect(signInCall).toBeTruthy()
        // Verify it targets the selected connection's URL
        expect(signInCall![0]).toContain('collab.example.com')
        expect(signInCall![1]).toEqual({
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'user@test.com', password: 'secret123' }),
        })
      })
    })

    it('posts sign-out request with JSON body', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])

      const fetchSpy = vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('/api/auth/sign-out')) {
          return { ok: true, json: async () => ({}) }
        }
        return { ok: false, json: async () => ({}) }
      })
      vi.stubGlobal('fetch', fetchSpy)

      renderCollab()
      await flush()
      await flush()

      await waitFor(() => {
        expect(getByRole(container, 'button', { name: 'Sign out of collaboration server' })).toBeTruthy()
      })

      fireEvent.click(getByRole(container, 'button', { name: 'Sign out of collaboration server' }))

      await waitFor(() => {
        const signOutCall = fetchSpy.mock.calls.find(
          (call) => typeof call[0] === 'string' && call[0].includes('/api/auth/sign-out'),
        ) as unknown[] | undefined
        expect(signOutCall).toBeTruthy()
        expect(signOutCall![0]).toContain('collab.example.com')
        expect(signOutCall![1]).toEqual({
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      })
    })
  })

  /* ---- Admin rendering ---- */

  describe('admin view', () => {
    it('loads session and shows admin panels when authenticated as admin', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue(testUsers())
      collabApiMock.fetchCollaborationInvites.mockResolvedValue(testInvites())
      renderCollab()
      await flush()
      await flush()

      // Current user info
      expect(container.textContent).toContain('Signed in as')
      expect(container.textContent).toContain('admin@test.com')

      // Members section
      expect(container.textContent).toContain('Members')
      expect(container.textContent).toContain('Admin User')
      expect(container.textContent).toContain('Regular Member')
      expect(container.textContent).toContain('Deactivated User')
      expect(container.textContent).toContain('Deactivated')

      // Invites section
      expect(container.textContent).toContain('Invites')
      expect(container.textContent).toContain('pending@test.com')
      expect(container.textContent).toContain('consumed@test.com')

      // Admin calls the admin endpoints
      expect(collabApiMock.fetchCollaborationUsers).toHaveBeenCalled()
      expect(collabApiMock.fetchCollaborationInvites).toHaveBeenCalled()
    })

    it('shows (you) label next to current user in members list', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue(testUsers())
      collabApiMock.fetchCollaborationInvites.mockResolvedValue(testInvites())
      renderCollab()
      await flush()
      await flush()

      expect(container.textContent).toContain('(you)')
    })

    it('does NOT show a delete button for any user', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue(testUsers())
      collabApiMock.fetchCollaborationInvites.mockResolvedValue(testInvites())
      renderCollab()
      await flush()
      await flush()

      const allButtons = container.querySelectorAll('button')
      for (const btn of allButtons) {
        expect(btn.textContent?.toLowerCase()).not.toContain('delete')
      }
    })
  })

  /* ---- Member rendering ---- */

  describe('member view', () => {
    it('shows password change form but not admin panels', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(memberSession())
      renderCollab()
      await flush()
      await flush()

      expect(container.textContent).toContain('Change Password')
      expect(container.textContent).not.toContain('Manage collaboration team members')
      expect(container.textContent).not.toContain('Invite new members')
    })

    it('does not call admin endpoints for member role', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(memberSession())
      renderCollab()
      await flush()
      await flush()

      expect(collabApiMock.fetchCollaborationUsers).not.toHaveBeenCalled()
      expect(collabApiMock.fetchCollaborationInvites).not.toHaveBeenCalled()
      expect(collabApiMock.resetUserPassword).not.toHaveBeenCalled()
      expect(collabApiMock.updateCollaborationUser).not.toHaveBeenCalled()
      expect(collabApiMock.createCollaborationInvite).not.toHaveBeenCalled()
      expect(collabApiMock.revokeCollaborationInvite).not.toHaveBeenCalled()
    })
  })

  /* ---- Password change required ---- */

  describe('password change required', () => {
    it('shows required password-change banner and hides admin panels', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(passwordChangeRequiredSession())
      renderCollab()
      await flush()
      await flush()

      expect(container.textContent).toContain('must change your temporary password')
      expect(container.querySelector('[data-testid="members-list"]')).toBeNull()
      expect(container.querySelector('[data-testid="invites-list"]')).toBeNull()
    })
  })

  /* ---- Password form validation ---- */

  describe('password change form', () => {
    it('validates that passwords match and does not fetch', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(memberSession())
      renderCollab()
      await flush()
      await flush()

      const form = container.querySelector('[data-testid="password-change-form"]') as HTMLFormElement
      expect(form).not.toBeNull()

      const inputs = form.querySelectorAll('input[type="password"]')
      expect(inputs.length).toBe(3)

      fireEvent.change(inputs[0]!, { target: { value: 'oldpass123' } })
      fireEvent.change(inputs[1]!, { target: { value: 'newpass123' } })
      fireEvent.change(inputs[2]!, { target: { value: 'mismatch99' } })

      fireEvent.submit(form)
      await flush()

      expect(container.textContent).toContain('Passwords do not match')
      expect(collabApiMock.changeMyPassword).not.toHaveBeenCalled()
    })

    it('validates minimum password length', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(memberSession())
      renderCollab()
      await flush()
      await flush()

      const form = container.querySelector('[data-testid="password-change-form"]') as HTMLFormElement
      const inputs = form.querySelectorAll('input[type="password"]')

      fireEvent.change(inputs[0]!, { target: { value: 'oldpass123' } })
      fireEvent.change(inputs[1]!, { target: { value: 'short' } })
      fireEvent.change(inputs[2]!, { target: { value: 'short' } })

      fireEvent.submit(form)
      await flush()

      expect(container.textContent).toContain('at least 8 characters')
      expect(collabApiMock.changeMyPassword).not.toHaveBeenCalled()
    })

    it('calls changeMyPassword with apiBaseUrl on valid submission', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(memberSession())
      collabApiMock.changeMyPassword.mockResolvedValue(undefined)
      renderCollab()
      await flush()
      await flush()

      const form = container.querySelector('[data-testid="password-change-form"]') as HTMLFormElement
      const inputs = form.querySelectorAll('input[type="password"]')

      fireEvent.change(inputs[0]!, { target: { value: 'oldpass123' } })
      fireEvent.change(inputs[1]!, { target: { value: 'newpass123' } })
      fireEvent.change(inputs[2]!, { target: { value: 'newpass123' } })

      fireEvent.submit(form)
      await flush()

      expect(collabApiMock.changeMyPassword).toHaveBeenCalledWith(
        'oldpass123',
        'newpass123',
        'https://collab.example.com/',
      )
    })
  })

  /* ---- Temp password reset ---- */

  describe('admin temp password reset', () => {
    it('renders action buttons for non-self users only', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue(testUsers())
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()
      await flush()

      const selfRow = container.querySelector('[data-testid="member-row-admin-1"]')!
      expect(selfRow.querySelector('button[aria-label]')).toBeNull()

      const memberRow = container.querySelector('[data-testid="member-row-member-1"]')!
      expect(memberRow.querySelector('button[aria-label]')).not.toBeNull()

      const deactivatedRow = container.querySelector('[data-testid="member-row-deactivated-1"]')!
      expect(deactivatedRow.querySelector('button[aria-label]')).not.toBeNull()
    })

    it('resetUserPassword is not called unless admin explicitly triggers reset', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue(testUsers())
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()
      await flush()

      expect(collabApiMock.resetUserPassword).not.toHaveBeenCalled()
    })
  })

  /* ---- Invite form validation ---- */

  describe('invite creation', () => {
    it('requires email for invite creation — blank email does not POST', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue(testUsers())
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      renderCollab()
      await flush()
      await flush()

      const form = container.querySelector('[data-testid="create-invite-form"]') as HTMLFormElement
      expect(form).not.toBeNull()

      fireEvent.submit(form)
      await flush()

      expect(container.textContent).toContain('Email is required')
      expect(collabApiMock.createCollaborationInvite).not.toHaveBeenCalled()
    })

    it('shows create response inviteUrl with copy button', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue(testUsers())
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      collabApiMock.createCollaborationInvite.mockResolvedValue({
        inviteId: 'new-inv',
        email: 'new@test.com',
        role: 'member',
        createdAt: '2025-01-10T00:00:00Z',
        expiresAt: '2025-01-17T00:00:00Z',
        inviteUrl: 'https://collab.test/collaboration/invite/abc123',
      })
      renderCollab()
      await flush()
      await flush()

      const form = container.querySelector('[data-testid="create-invite-form"]') as HTMLFormElement
      const emailInput = form.querySelector('input[type="email"]') as HTMLInputElement
      fireEvent.change(emailInput, { target: { value: 'new@test.com' } })
      fireEvent.submit(form)
      await flush()

      expect(collabApiMock.createCollaborationInvite).toHaveBeenCalledWith(
        'new@test.com',
        undefined,
        'https://collab.example.com/',
      )

      const banner = container.querySelector('[data-testid="created-invite-banner"]')
      expect(banner).not.toBeNull()
      expect(banner!.textContent).toContain('https://collab.test/collaboration/invite/abc123')
      expect(banner!.textContent).toContain('Copy link')
    })

    it('shows all invite statuses (pending/consumed/revoked/expired)', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue(testInvites())
      renderCollab()
      await flush()
      await flush()

      const text = container.textContent ?? ''
      expect(text).toContain('pending')
      expect(text).toContain('consumed')
      expect(text).toContain('revoked')
      expect(text).toContain('expired')
    })

    it('shows revoke button only for pending invites', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue(testInvites())
      renderCollab()
      await flush()
      await flush()

      const invitesList = container.querySelector('[data-testid="invites-list"]')!
      const revokeButtons = invitesList.querySelectorAll('button')
      const revokeTexts = Array.from(revokeButtons).filter(
        (btn) => btn.textContent?.trim() === 'Revoke',
      )
      expect(revokeTexts.length).toBe(1)
    })

    it('revoke calls revokeCollaborationInvite with inviteId and apiBaseUrl', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue(testInvites())
      collabApiMock.revokeCollaborationInvite.mockResolvedValue(undefined)
      renderCollab()
      await flush()
      await flush()

      const invitesList = container.querySelector('[data-testid="invites-list"]')!
      const revokeBtn = Array.from(invitesList.querySelectorAll('button')).find(
        (btn) => btn.textContent?.trim() === 'Revoke',
      )!
      fireEvent.click(revokeBtn)
      await flush()

      expect(collabApiMock.revokeCollaborationInvite).toHaveBeenCalledWith(
        'inv-1',
        'https://collab.example.com/',
      )
    })
  })

  /* ---- Auth error handling ---- */

  describe('auth error handling', () => {
    it('does NOT show auth error banner for normal unauthenticated state', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue({ authenticated: false })
      renderCollab()
      await flush()
      await flush()

      const errorBanner = container.querySelector('[data-testid="collab-auth-error"]')
      expect(errorBanner).toBeNull()
      expect(container.textContent).toContain('Authentication')
    })

    it('shows auth error banner on thrown 401/403', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      const authErr = new Error('401: Unauthorized') as Error & { status?: number }
      authErr.status = 401
      collabApiMock.fetchCollaborationMe.mockRejectedValue(authErr)
      collabApiMock.isAuthError.mockReturnValue(true)
      renderCollab()
      await flush()
      await flush()

      const errorBanner = container.querySelector('[data-testid="collab-auth-error"]')
      expect(errorBanner).not.toBeNull()
      expect(errorBanner!.textContent).toContain('session has ended')
      expect(errorBanner!.textContent).toContain('Sign in again')
    })

    it('clears auth error when onSignIn callback is invoked', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      const authErr = new Error('401: Unauthorized') as Error & { status?: number }
      authErr.status = 401
      collabApiMock.fetchCollaborationMe.mockRejectedValue(authErr)
      collabApiMock.isAuthError.mockReturnValue(true)
      renderCollab()
      await flush()
      await flush()

      let errorBanner = container.querySelector('[data-testid="collab-auth-error"]')
      expect(errorBanner).not.toBeNull()

      const signInButton = getByRole(errorBanner as HTMLElement, 'button', { name: /sign in again/i })
      fireEvent.click(signInButton)
      await flush()

      errorBanner = container.querySelector('[data-testid="collab-auth-error"]')
      expect(errorBanner).toBeNull()
    })
  })

  /* ---- Target-aware routing ---- */

  describe('target-aware API routing', () => {
    it('status and session APIs use the selected connection apiBaseUrl, not default', async () => {
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(memberSession())
      renderCollab()
      await flush()
      await flush()

      // Status should be called with the selected connection's apiBaseUrl
      expect(collabApiMock.fetchCollaborationStatus).toHaveBeenCalledWith('https://collab.example.com/')
      // Session should be called with the same
      expect(collabApiMock.fetchCollaborationMe).toHaveBeenCalledWith('https://collab.example.com/')
    })

    it('switches target when selecting a different connection', async () => {
      registryMock.connections = [
        remoteTarget('conn_a', 'server-a.test', 'https://server-a.test'),
        remoteTarget('conn_b', 'server-b.test', 'https://server-b.test'),
      ]
      registryMock.defaultConnectionId = 'conn_a'

      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(memberSession())
      renderCollab()
      await flush()
      await flush()

      // Initially targets conn_a
      expect(collabApiMock.fetchCollaborationStatus).toHaveBeenCalledWith('https://server-a.test/')

      // Click conn_b
      const connB = container.querySelector('[data-testid="connection-item-conn_b"]') as HTMLButtonElement
      fireEvent.click(connB)
      await flush()
      await flush()

      // Should now target conn_b
      const calls = collabApiMock.fetchCollaborationStatus.mock.calls
      const lastCall = calls[calls.length - 1]
      expect(lastCall[0]).toBe('https://server-b.test/')
    })
  })

  /* ---- Non-default target: all child components and API calls use selected, not default ---- */

  describe('non-default target routing (selected != default)', () => {
    /**
     * Set up two connections where conn_a is default but we select conn_b.
     * All operations must target conn_b's apiBaseUrl.
     */
    const NON_DEFAULT_URL = 'https://server-b.test/'

    function setupTwoConnectionsSelectNonDefault() {
      registryMock.connections = [
        remoteTarget('conn_a', 'server-a.test', 'https://server-a.test'),
        remoteTarget('conn_b', 'server-b.test', 'https://server-b.test'),
      ]
      registryMock.defaultConnectionId = 'conn_a'
    }

    it('status + session calls target selected (non-default) backend after switch', async () => {
      setupTwoConnectionsSelectNonDefault()
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(memberSession())

      renderCollab()
      await flush()
      await flush()

      // Switch to conn_b (non-default)
      collabApiMock.fetchCollaborationStatus.mockClear()
      collabApiMock.fetchCollaborationMe.mockClear()

      const connB = container.querySelector('[data-testid="connection-item-conn_b"]') as HTMLButtonElement
      fireEvent.click(connB)
      await flush()
      await flush()

      // After switch, ALL API calls must target server-b, not server-a (default)
      expect(collabApiMock.fetchCollaborationStatus).toHaveBeenCalledWith(NON_DEFAULT_URL)
      expect(collabApiMock.fetchCollaborationMe).toHaveBeenCalledWith(NON_DEFAULT_URL)

      // Must NOT have been called with the default backend
      for (const call of collabApiMock.fetchCollaborationStatus.mock.calls) {
        expect(call[0]).not.toBe('https://server-a.test/')
      }
      for (const call of collabApiMock.fetchCollaborationMe.mock.calls) {
        expect(call[0]).not.toBe('https://server-a.test/')
      }
    })

    it('Members component receives non-default apiBaseUrl when admin on non-default backend', async () => {
      setupTwoConnectionsSelectNonDefault()
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue(testUsers())
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])

      renderCollab()
      await flush()
      await flush()

      // Switch to conn_b
      collabApiMock.fetchCollaborationUsers.mockClear()

      const connB = container.querySelector('[data-testid="connection-item-conn_b"]') as HTMLButtonElement
      fireEvent.click(connB)
      await flush()
      await flush()

      // Members loads via fetchCollaborationUsers — must target conn_b
      // Second arg is the AbortSignal passed from the AbortController
      expect(collabApiMock.fetchCollaborationUsers).toHaveBeenCalledWith(NON_DEFAULT_URL, expect.any(AbortSignal))
    })

    it('Invites component receives non-default apiBaseUrl when admin on non-default backend', async () => {
      setupTwoConnectionsSelectNonDefault()
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue(testInvites())

      renderCollab()
      await flush()
      await flush()

      // Switch to conn_b
      collabApiMock.fetchCollaborationInvites.mockClear()

      const connB = container.querySelector('[data-testid="connection-item-conn_b"]') as HTMLButtonElement
      fireEvent.click(connB)
      await flush()
      await flush()

      // Invites loads via fetchCollaborationInvites — must target conn_b
      expect(collabApiMock.fetchCollaborationInvites).toHaveBeenCalledWith(NON_DEFAULT_URL, expect.any(AbortSignal))
    })

    it('password change targets non-default backend', async () => {
      setupTwoConnectionsSelectNonDefault()
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(memberSession())
      collabApiMock.changeMyPassword.mockResolvedValue(undefined)

      renderCollab()
      await flush()
      await flush()

      // Switch to conn_b
      const connB = container.querySelector('[data-testid="connection-item-conn_b"]') as HTMLButtonElement
      fireEvent.click(connB)
      await flush()
      await flush()

      // Fill password change form
      const form = container.querySelector('[data-testid="password-change-form"]') as HTMLFormElement
      const inputs = form.querySelectorAll('input[type="password"]')
      fireEvent.change(inputs[0]!, { target: { value: 'oldpass123' } })
      fireEvent.change(inputs[1]!, { target: { value: 'newpass123' } })
      fireEvent.change(inputs[2]!, { target: { value: 'newpass123' } })
      fireEvent.submit(form)
      await flush()

      // Must target conn_b, not conn_a (default)
      expect(collabApiMock.changeMyPassword).toHaveBeenCalledWith(
        'oldpass123',
        'newpass123',
        NON_DEFAULT_URL,
      )
    })

    it('sign-in targets non-default backend', async () => {
      setupTwoConnectionsSelectNonDefault()
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue({ authenticated: false })

      const fetchSpy = vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('/api/auth/sign-in/email')) {
          return { ok: true, json: async () => ({ success: true }) }
        }
        if (typeof url === 'string' && url.includes('/api/collaboration/me')) {
          return { ok: true, json: async () => adminSession() }
        }
        return { ok: false, json: async () => ({}) }
      })
      vi.stubGlobal('fetch', fetchSpy)

      renderCollab()
      await flush()
      await flush()

      // Switch to conn_b
      const connB = container.querySelector('[data-testid="connection-item-conn_b"]') as HTMLButtonElement
      fireEvent.click(connB)
      await flush()
      await flush()

      // Fill sign-in form
      await waitFor(() => {
        expect(getByLabelText(container, 'Email')).toBeTruthy()
      })
      fireEvent.change(getByLabelText(container, 'Email'), { target: { value: 'user@b.com' } })
      fireEvent.change(getByLabelText(container, 'Password'), { target: { value: 'pass' } })
      fireEvent.click(getByRole(container, 'button', { name: 'Sign in' }))

      await waitFor(() => {
        const signInCall = fetchSpy.mock.calls.find(
          (call) => typeof call[0] === 'string' && call[0].includes('/api/auth/sign-in/email'),
        ) as unknown[] | undefined
        expect(signInCall).toBeTruthy()
        // Must target server-b, NOT server-a (default)
        expect(signInCall![0]).toContain('server-b.test')
        expect(signInCall![0]).not.toContain('server-a.test')
      })
    })

    it('sign-out targets non-default backend', async () => {
      setupTwoConnectionsSelectNonDefault()
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])

      const fetchSpy = vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('/api/auth/sign-out')) {
          return { ok: true, json: async () => ({}) }
        }
        return { ok: false, json: async () => ({}) }
      })
      vi.stubGlobal('fetch', fetchSpy)

      renderCollab()
      await flush()
      await flush()

      // Switch to conn_b
      const connB = container.querySelector('[data-testid="connection-item-conn_b"]') as HTMLButtonElement
      fireEvent.click(connB)
      await flush()
      await flush()

      // Click sign out
      await waitFor(() => {
        expect(getByRole(container, 'button', { name: 'Sign out of collaboration server' })).toBeTruthy()
      })
      fireEvent.click(getByRole(container, 'button', { name: 'Sign out of collaboration server' }))

      await waitFor(() => {
        const signOutCall = fetchSpy.mock.calls.find(
          (call) => typeof call[0] === 'string' && call[0].includes('/api/auth/sign-out'),
        ) as unknown[] | undefined
        expect(signOutCall).toBeTruthy()
        // Must target server-b, NOT server-a (default)
        expect(signOutCall![0]).toContain('server-b.test')
        expect(signOutCall![0]).not.toContain('server-a.test')
      })
    })

    it('invite creation targets non-default backend', async () => {
      setupTwoConnectionsSelectNonDefault()
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])
      collabApiMock.createCollaborationInvite.mockResolvedValue({
        inviteId: 'new-inv',
        email: 'x@b.com',
        role: 'member',
        createdAt: '2025-01-10T00:00:00Z',
        expiresAt: '2025-01-17T00:00:00Z',
        inviteUrl: 'https://server-b.test/invite/abc',
      })

      renderCollab()
      await flush()
      await flush()

      // Switch to conn_b
      const connB = container.querySelector('[data-testid="connection-item-conn_b"]') as HTMLButtonElement
      fireEvent.click(connB)
      await flush()
      await flush()

      // Create invite
      const form = container.querySelector('[data-testid="create-invite-form"]') as HTMLFormElement
      const emailInput = form.querySelector('input[type="email"]') as HTMLInputElement
      fireEvent.change(emailInput, { target: { value: 'x@b.com' } })
      fireEvent.submit(form)
      await flush()

      // Must target conn_b
      expect(collabApiMock.createCollaborationInvite).toHaveBeenCalledWith(
        'x@b.com',
        undefined,
        NON_DEFAULT_URL,
      )
    })

    it('invite revoke targets non-default backend', async () => {
      setupTwoConnectionsSelectNonDefault()
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue(testInvites())
      collabApiMock.revokeCollaborationInvite.mockResolvedValue(undefined)

      renderCollab()
      await flush()
      await flush()

      // Switch to conn_b
      const connB = container.querySelector('[data-testid="connection-item-conn_b"]') as HTMLButtonElement
      fireEvent.click(connB)
      await flush()
      await flush()

      // Revoke pending invite
      const invitesList = container.querySelector('[data-testid="invites-list"]')!
      const revokeBtn = Array.from(invitesList.querySelectorAll('button')).find(
        (btn) => btn.textContent?.trim() === 'Revoke',
      )!
      fireEvent.click(revokeBtn)
      await flush()

      // Must target conn_b
      expect(collabApiMock.revokeCollaborationInvite).toHaveBeenCalledWith(
        'inv-1',
        NON_DEFAULT_URL,
      )
    })
  })

  /* ---- initialApiBaseUrl pre-selection (collab surface context) ---- */

  describe('initialApiBaseUrl pre-selection', () => {
    it('pre-selects the connection matching initialApiBaseUrl on mount', async () => {
      registryMock.connections = [
        remoteTarget('conn_a', 'server-a.test', 'https://server-a.test'),
        remoteTarget('conn_b', 'server-b.test', 'https://server-b.test'),
      ]
      registryMock.defaultConnectionId = 'conn_a'

      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])

      // Pass initialApiBaseUrl for conn_b (non-default)
      renderCollab({ initialApiBaseUrl: 'https://server-b.test/' })
      await flush()
      await flush()

      // conn_b should be pre-selected, not conn_a (the default)
      const connB = container.querySelector('[data-testid="connection-item-conn_b"]') as HTMLButtonElement
      expect(connB?.getAttribute('aria-pressed')).toBe('true')

      const connA = container.querySelector('[data-testid="connection-item-conn_a"]') as HTMLButtonElement
      expect(connA?.getAttribute('aria-pressed')).toBe('false')

      // All API calls should target conn_b, NOT conn_a
      expect(collabApiMock.fetchCollaborationStatus).toHaveBeenCalledWith('https://server-b.test/')
      expect(collabApiMock.fetchCollaborationMe).toHaveBeenCalledWith('https://server-b.test/')
    })

    it('falls back to default when initialApiBaseUrl does not match any connection', async () => {
      registryMock.connections = [
        remoteTarget('conn_a', 'server-a.test', 'https://server-a.test'),
      ]
      registryMock.defaultConnectionId = 'conn_a'

      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])

      // Pass a URL that matches no connection
      renderCollab({ initialApiBaseUrl: 'https://unknown-server.test/' })
      await flush()
      await flush()

      // Should fall back to conn_a (default)
      const connA = container.querySelector('[data-testid="connection-item-conn_a"]') as HTMLButtonElement
      expect(connA?.getAttribute('aria-pressed')).toBe('true')
      expect(collabApiMock.fetchCollaborationStatus).toHaveBeenCalledWith('https://server-a.test/')
    })

    it('initialApiBaseUrl ensures status/session/members/invites all target the pre-selected backend', async () => {
      registryMock.connections = [
        remoteTarget('conn_a', 'server-a.test', 'https://server-a.test'),
        remoteTarget('conn_b', 'server-b.test', 'https://server-b.test'),
      ]
      registryMock.defaultConnectionId = 'conn_a'

      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminSession())
      collabApiMock.fetchCollaborationUsers.mockResolvedValue(testUsers())
      collabApiMock.fetchCollaborationInvites.mockResolvedValue(testInvites())

      renderCollab({ initialApiBaseUrl: 'https://server-b.test/' })
      await flush()
      await flush()

      // ALL calls must target server-b, not server-a
      expect(collabApiMock.fetchCollaborationStatus).toHaveBeenCalledWith('https://server-b.test/')
      expect(collabApiMock.fetchCollaborationMe).toHaveBeenCalledWith('https://server-b.test/')
      expect(collabApiMock.fetchCollaborationUsers).toHaveBeenCalledWith('https://server-b.test/', expect.any(AbortSignal))
      expect(collabApiMock.fetchCollaborationInvites).toHaveBeenCalledWith('https://server-b.test/', expect.any(AbortSignal))

      // NONE should target server-a
      for (const call of collabApiMock.fetchCollaborationStatus.mock.calls) {
        expect(call[0]).not.toBe('https://server-a.test/')
      }
    })

    it('no initialApiBaseUrl falls back to default connection', async () => {
      registryMock.connections = [
        remoteTarget('conn_a', 'server-a.test', 'https://server-a.test'),
        remoteTarget('conn_b', 'server-b.test', 'https://server-b.test'),
      ]
      registryMock.defaultConnectionId = 'conn_a'

      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue(memberSession())

      // No initialApiBaseUrl — should use default (conn_a)
      renderCollab()
      await flush()
      await flush()

      expect(collabApiMock.fetchCollaborationStatus).toHaveBeenCalledWith('https://server-a.test/')
      const connA = container.querySelector('[data-testid="connection-item-conn_a"]') as HTMLButtonElement
      expect(connA?.getAttribute('aria-pressed')).toBe('true')
    })
  })

  /* ---- Stale-request race protection ---- */

  describe('stale-request race protection', () => {
    it('late-resolving status for backend A does not overwrite state after switching to B', async () => {
      registryMock.connections = [
        remoteTarget('conn_a', 'server-a.test', 'https://server-a.test'),
        remoteTarget('conn_b', 'server-b.test', 'https://server-b.test'),
      ]
      registryMock.defaultConnectionId = 'conn_a'

      // Backend A: slow — resolves after we switch away
      let resolveStatusA: ((v: CollaborationStatus) => void) | null = null
      const slowStatusA = new Promise<CollaborationStatus>((resolve) => { resolveStatusA = resolve })
      // Backend B: fast
      const statusB = { enabled: true, adminExists: true, baseUrl: 'https://server-b.test' }
      const sessionB = memberSession()

      // First call → conn_a (slow)
      collabApiMock.fetchCollaborationStatus.mockImplementationOnce(() => slowStatusA)

      renderCollab()
      await flush()

      // Switch to conn_b before A resolves
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusB)
      collabApiMock.fetchCollaborationMe.mockResolvedValue(sessionB)

      const connB = container.querySelector('[data-testid="connection-item-conn_b"]') as HTMLButtonElement
      fireEvent.click(connB)
      await flush()
      await flush()

      // B should now be showing
      expect(container.textContent).toContain('Enabled')

      // Now resolve the stale A response — it should be ignored
      resolveStatusA!({ enabled: false, adminExists: false })
      await flush()
      await flush()

      // UI must still show B's state (enabled), NOT A's stale disabled state
      expect(container.textContent).toContain('Enabled')
      expect(container.textContent).not.toContain('FORGE_COLLABORATION_ENABLED=true')
    })

    it('late-resolving session for backend A does not overwrite session after switching to B', async () => {
      registryMock.connections = [
        remoteTarget('conn_a', 'server-a.test', 'https://server-a.test'),
        remoteTarget('conn_b', 'server-b.test', 'https://server-b.test'),
      ]
      registryMock.defaultConnectionId = 'conn_a'

      // Backend A: status resolves fast, but session is slow
      let resolveSessionA: ((v: CollaborationSessionInfo) => void) | null = null
      const slowSessionA = new Promise<CollaborationSessionInfo>((resolve) => { resolveSessionA = resolve })

      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockImplementationOnce(() => slowSessionA)

      renderCollab()
      await flush()

      // Switch to conn_b before A's session resolves
      collabApiMock.fetchCollaborationMe.mockResolvedValue(memberSession())

      const connB = container.querySelector('[data-testid="connection-item-conn_b"]') as HTMLButtonElement
      fireEvent.click(connB)
      await flush()
      await flush()

      // B's session should be showing
      expect(container.textContent).toContain('Member User')

      // Now resolve A's stale session — admin user should NOT appear
      resolveSessionA!(adminSession())
      await flush()
      await flush()

      // UI must still show B's member, NOT A's stale admin
      expect(container.textContent).toContain('Member User')
      expect(container.textContent).not.toContain('Admin User')
    })

    it('late-resolving members for backend A do not overwrite list after switching to B', async () => {
      registryMock.connections = [
        remoteTarget('conn_a', 'server-a.test', 'https://server-a.test'),
        remoteTarget('conn_b', 'server-b.test', 'https://server-b.test'),
      ]
      registryMock.defaultConnectionId = 'conn_a'

      // Both backends: admin — so Members panel renders
      const adminA = adminSession()
      const adminB = { ...adminSession(), user: { ...adminSession().user!, userId: 'admin-b', name: 'Admin B', email: 'b@test.com' } }
      const usersA = [
        { userId: 'a-u1', email: 'alice@a.test', name: 'Alice A', role: 'member' as const, disabled: false, authMethods: ['password' as const], createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
      ]
      const usersB = [
        { userId: 'b-u1', email: 'bob@b.test', name: 'Bob B', role: 'member' as const, disabled: false, authMethods: ['password' as const], createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
      ]

      // Backend A: fast status/session, slow members
      let resolveUsersA: ((v: unknown) => void) | null = null
      const slowUsersA = new Promise((resolve) => { resolveUsersA = resolve })

      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValueOnce(adminA)
      collabApiMock.fetchCollaborationUsers.mockImplementationOnce(() => slowUsersA)
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])

      renderCollab()
      await flush()
      await flush()

      // Switch to B before A's members resolve
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminB)
      collabApiMock.fetchCollaborationUsers.mockResolvedValue(usersB)

      const connB = container.querySelector('[data-testid="connection-item-conn_b"]') as HTMLButtonElement
      fireEvent.click(connB)
      await flush()
      await flush()
      await flush()

      // B's members should be visible
      expect(container.textContent).toContain('Bob B')

      // Now resolve stale A users
      resolveUsersA!(usersA)
      await flush()
      await flush()

      // Must still show B's data
      expect(container.textContent).toContain('Bob B')
      expect(container.textContent).not.toContain('Alice A')
    })

    it('late-resolving invites for backend A do not overwrite list after switching to B', async () => {
      registryMock.connections = [
        remoteTarget('conn_a', 'server-a.test', 'https://server-a.test'),
        remoteTarget('conn_b', 'server-b.test', 'https://server-b.test'),
      ]
      registryMock.defaultConnectionId = 'conn_a'

      const adminA = adminSession()
      const adminB = { ...adminSession(), user: { ...adminSession().user!, userId: 'admin-b', name: 'Admin B', email: 'b@test.com' } }
      const invitesA = [
        { inviteId: 'inv-a1', email: 'pending-a@test.com', role: 'member' as const, status: 'pending' as const, createdAt: '2025-01-01T00:00:00Z', expiresAt: '2025-01-08T00:00:00Z' },
      ]
      const invitesB = [
        { inviteId: 'inv-b1', email: 'pending-b@test.com', role: 'member' as const, status: 'pending' as const, createdAt: '2025-02-01T00:00:00Z', expiresAt: '2025-02-08T00:00:00Z' },
      ]

      // Backend A: fast status/session/members, slow invites
      let resolveInvitesA: ((v: unknown) => void) | null = null
      const slowInvitesA = new Promise((resolve) => { resolveInvitesA = resolve })

      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValueOnce(adminA)
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockImplementationOnce(() => slowInvitesA)

      renderCollab()
      await flush()
      await flush()

      // Switch to B before A's invites resolve
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminB)
      collabApiMock.fetchCollaborationInvites.mockResolvedValue(invitesB)

      const connB = container.querySelector('[data-testid="connection-item-conn_b"]') as HTMLButtonElement
      fireEvent.click(connB)
      await flush()
      await flush()
      await flush()

      // B's invites should be visible
      expect(container.textContent).toContain('pending-b@test.com')

      // Now resolve stale A invites
      resolveInvitesA!(invitesA)
      await flush()
      await flush()

      // Must still show B's data
      expect(container.textContent).toContain('pending-b@test.com')
      expect(container.textContent).not.toContain('pending-a@test.com')
    })

    it('late sign-in success for backend A does not set session on backend B', async () => {
      registryMock.connections = [
        remoteTarget('conn_a', 'server-a.test', 'https://server-a.test'),
        remoteTarget('conn_b', 'server-b.test', 'https://server-b.test'),
      ]
      registryMock.defaultConnectionId = 'conn_a'

      // Both backends show sign-in form (not authenticated)
      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue({ authenticated: false })

      // Sign-in on A is slow
      let resolveSignInA: ((v: Response) => void) | null = null
      const slowSignIn = new Promise<Response>((resolve) => { resolveSignInA = resolve })

      const fetchSpy = vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('server-a.test') && url.includes('/api/auth/sign-in/email')) {
          return slowSignIn
        }
        if (typeof url === 'string' && url.includes('/api/collaboration/me')) {
          return { ok: true, json: async () => adminSession() }
        }
        return { ok: true, json: async () => ({}) }
      })
      vi.stubGlobal('fetch', fetchSpy)

      renderCollab()
      await flush()
      await flush()

      // Fill sign-in form on A and submit
      await waitFor(() => {
        expect(getByLabelText(container, 'Email')).toBeTruthy()
      })
      fireEvent.change(getByLabelText(container, 'Email'), { target: { value: 'user@a.com' } })
      fireEvent.change(getByLabelText(container, 'Password'), { target: { value: 'pass-a' } })
      fireEvent.click(getByRole(container, 'button', { name: 'Sign in' }))

      // Switch to B before A's sign-in resolves
      const connB = container.querySelector('[data-testid="connection-item-conn_b"]') as HTMLButtonElement
      fireEvent.click(connB)
      await flush()
      await flush()

      // B should still show sign-in form (not authenticated)
      await waitFor(() => {
        expect(getByLabelText(container, 'Email')).toBeTruthy()
      })

      // Now resolve A's stale sign-in success
      resolveSignInA!({ ok: true, json: async () => ({ success: true }) } as Response)
      await flush()
      await flush()

      // Must still show B's sign-in form — A's late success must NOT set B's session
      expect(queryByText(container, 'Admin User')).toBeNull()
      expect(getByLabelText(container, 'Email')).toBeTruthy()
    })

    it('late sign-in failure for backend A does not set error on backend B', async () => {
      registryMock.connections = [
        remoteTarget('conn_a', 'server-a.test', 'https://server-a.test'),
        remoteTarget('conn_b', 'server-b.test', 'https://server-b.test'),
      ]
      registryMock.defaultConnectionId = 'conn_a'

      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValue({ authenticated: false })

      // Sign-in on A is slow and will fail
      let resolveSignInA: ((v: Response) => void) | null = null
      const slowSignIn = new Promise<Response>((resolve) => { resolveSignInA = resolve })

      const fetchSpy = vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('server-a.test') && url.includes('/api/auth/sign-in/email')) {
          return slowSignIn
        }
        return { ok: true, json: async () => ({}) }
      })
      vi.stubGlobal('fetch', fetchSpy)

      renderCollab()
      await flush()
      await flush()

      // Fill sign-in form on A and submit
      await waitFor(() => {
        expect(getByLabelText(container, 'Email')).toBeTruthy()
      })
      fireEvent.change(getByLabelText(container, 'Email'), { target: { value: 'user@a.com' } })
      fireEvent.change(getByLabelText(container, 'Password'), { target: { value: 'bad-pass' } })
      fireEvent.click(getByRole(container, 'button', { name: 'Sign in' }))

      // Switch to B before A's sign-in resolves
      const connB = container.querySelector('[data-testid="connection-item-conn_b"]') as HTMLButtonElement
      fireEvent.click(connB)
      await flush()
      await flush()

      // Now resolve A's stale sign-in as failure
      resolveSignInA!({ ok: false, json: async () => ({ message: 'Bad credentials for A' }) } as Response)
      await flush()
      await flush()

      // B's view should NOT show A's error message
      expect(queryByText(container, 'Bad credentials for A')).toBeNull()
    })

    it('late sign-out for backend A does not clear session on backend B', async () => {
      registryMock.connections = [
        remoteTarget('conn_a', 'server-a.test', 'https://server-a.test'),
        remoteTarget('conn_b', 'server-b.test', 'https://server-b.test'),
      ]
      registryMock.defaultConnectionId = 'conn_a'

      // Both backends: authenticated admin
      const adminA = adminSession()
      const adminB = { ...adminSession(), user: { ...adminSession().user!, userId: 'admin-b', name: 'Admin B', email: 'b@test.com' } }

      collabApiMock.fetchCollaborationStatus.mockResolvedValue(statusEnabled())
      collabApiMock.fetchCollaborationMe.mockResolvedValueOnce(adminA)
      collabApiMock.fetchCollaborationUsers.mockResolvedValue([])
      collabApiMock.fetchCollaborationInvites.mockResolvedValue([])

      // Sign-out on A is slow
      let resolveSignOutA: ((v: Response) => void) | null = null
      const slowSignOut = new Promise<Response>((resolve) => { resolveSignOutA = resolve })

      const fetchSpy = vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('server-a.test') && url.includes('/api/auth/sign-out')) {
          return slowSignOut
        }
        return { ok: true, json: async () => ({}) }
      })
      vi.stubGlobal('fetch', fetchSpy)

      renderCollab()
      await flush()
      await flush()

      // Trigger sign-out on A
      await waitFor(() => {
        expect(getByRole(container, 'button', { name: 'Sign out of collaboration server' })).toBeTruthy()
      })
      fireEvent.click(getByRole(container, 'button', { name: 'Sign out of collaboration server' }))

      // Switch to B before A's sign-out resolves
      collabApiMock.fetchCollaborationMe.mockResolvedValue(adminB)

      const connB = container.querySelector('[data-testid="connection-item-conn_b"]') as HTMLButtonElement
      fireEvent.click(connB)
      await flush()
      await flush()

      // B should show the signed-in admin
      expect(container.textContent).toContain('Admin B')

      // Now resolve A's stale sign-out
      resolveSignOutA!({ ok: true, json: async () => ({}) } as Response)
      await flush()
      await flush()

      // Must still show B's session — A's late sign-out must NOT clear B's session
      expect(container.textContent).toContain('Admin B')
    })
  })
})
