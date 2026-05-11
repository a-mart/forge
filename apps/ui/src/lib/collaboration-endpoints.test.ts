import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./backend-url', () => ({
  resolveBackendWsUrl: () => 'ws://127.0.0.1:47187',
}))

vi.mock('./api-endpoint', () => ({
  resolveApiEndpoint: (wsUrl: string, path: string) => {
    const url = new URL(wsUrl.replace('ws:', 'http:').replace('wss:', 'https:'))
    return new URL(path, url.origin).toString()
  },
}))

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
  }
})()

Object.defineProperty(globalThis, 'window', {
  value: {
    localStorage: localStorageMock,
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
  writable: true,
})

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

describe('collaboration-endpoints', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorageMock.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorageMock.clear()
  })

  // -----------------------------------------------------------------------
  // Compatibility wrappers — must preserve exact prior behavior
  // -----------------------------------------------------------------------

  it('resolveCollaborationApiBaseUrl falls back to Forge backend URL when no config', async () => {
    const { resolveCollaborationApiBaseUrl } = await import('./collaboration-endpoints')
    const baseUrl = resolveCollaborationApiBaseUrl()
    expect(baseUrl).toBe('http://127.0.0.1:47187/')
  })

  it('resolveCollaborationWsUrl falls back to Forge backend WS URL when no config', async () => {
    const { resolveCollaborationWsUrl } = await import('./collaboration-endpoints')
    const wsUrl = resolveCollaborationWsUrl()
    expect(wsUrl).toBe('ws://127.0.0.1:47187')
  })

  it('resolveCollaborationApiBaseUrl uses configured URL from localStorage', async () => {
    localStorageMock.setItem('forge-collab-server-url', 'https://collab.example.com')
    const { resolveCollaborationApiBaseUrl } = await import('./collaboration-endpoints')
    const baseUrl = resolveCollaborationApiBaseUrl()
    expect(baseUrl).toBe('https://collab.example.com/')
  })

  it('resolveCollaborationWsUrl derives wss:// from configured https:// URL', async () => {
    localStorageMock.setItem('forge-collab-server-url', 'https://collab.example.com')
    const { resolveCollaborationWsUrl } = await import('./collaboration-endpoints')
    const wsUrl = resolveCollaborationWsUrl()
    expect(wsUrl).toBe('wss://collab.example.com')
  })

  it('resolveCollaborationWsUrl derives ws:// from configured http:// URL', async () => {
    localStorageMock.setItem('forge-collab-server-url', 'http://192.168.1.10:3000')
    const { resolveCollaborationWsUrl } = await import('./collaboration-endpoints')
    const wsUrl = resolveCollaborationWsUrl()
    expect(wsUrl).toBe('ws://192.168.1.10:3000')
  })

  it('getCollabServerUrl returns null when not set', async () => {
    const { getCollabServerUrl } = await import('./collaboration-endpoints')
    expect(getCollabServerUrl()).toBeNull()
  })

  it('setCollabServerUrl persists and getCollabServerUrl retrieves', async () => {
    const { getCollabServerUrl, setCollabServerUrl } = await import('./collaboration-endpoints')
    setCollabServerUrl('https://my-server.com')
    expect(getCollabServerUrl()).toBe('https://my-server.com')
  })

  it('setCollabServerUrl(null) clears the stored URL', async () => {
    const { getCollabServerUrl, setCollabServerUrl } = await import('./collaboration-endpoints')
    setCollabServerUrl('https://my-server.com')
    setCollabServerUrl(null)
    expect(getCollabServerUrl()).toBeNull()
  })

  it('setCollabServerUrl trims whitespace', async () => {
    const { getCollabServerUrl, setCollabServerUrl } = await import('./collaboration-endpoints')
    setCollabServerUrl('  https://my-server.com  ')
    expect(getCollabServerUrl()).toBe('https://my-server.com')
  })

  it('canonicalizes localhost to 127.0.0.1 for loopback auth cookies', async () => {
    const { getCollabServerUrl, resolveCollaborationApiBaseUrl, resolveCollaborationWsUrl, setCollabServerUrl } = await import('./collaboration-endpoints')
    setCollabServerUrl('http://localhost:47387')
    expect(getCollabServerUrl()).toBe('http://127.0.0.1:47387')
    expect(resolveCollaborationApiBaseUrl()).toBe('http://127.0.0.1:47387/')
    expect(resolveCollaborationWsUrl()).toBe('ws://127.0.0.1:47387')
  })

  it('self-heals a previously stored localhost collaboration URL', async () => {
    localStorageMock.setItem('forge-collab-server-url', 'http://localhost:47387')
    const { getCollabServerUrl } = await import('./collaboration-endpoints')
    expect(getCollabServerUrl()).toBe('http://127.0.0.1:47387')
    expect(localStorageMock.getItem('forge-collab-server-url')).toBe('http://127.0.0.1:47387')
  })

  // -----------------------------------------------------------------------
  // isCollabServerRemote — compatibility wrapper
  // -----------------------------------------------------------------------

  describe('isCollabServerRemote', () => {
    it('returns false when no URL is configured', async () => {
      const { isCollabServerRemote } = await import('./collaboration-endpoints')
      expect(isCollabServerRemote()).toBe(false)
    })

    it('returns true for a remote https URL', async () => {
      localStorageMock.setItem('forge-collab-server-url', 'https://collab.example.com')
      const { isCollabServerRemote } = await import('./collaboration-endpoints')
      expect(isCollabServerRemote()).toBe(true)
    })

    it('returns true for a remote http URL with different port', async () => {
      localStorageMock.setItem('forge-collab-server-url', 'http://192.168.1.10:3000')
      const { isCollabServerRemote } = await import('./collaboration-endpoints')
      expect(isCollabServerRemote()).toBe(true)
    })

    it('returns false when configured URL matches backend origin (http)', async () => {
      // Backend is mocked at ws://127.0.0.1:47187
      localStorageMock.setItem('forge-collab-server-url', 'http://127.0.0.1:47187')
      const { isCollabServerRemote } = await import('./collaboration-endpoints')
      expect(isCollabServerRemote()).toBe(false)
    })

    it('returns false when configured URL matches backend origin (ws protocol)', async () => {
      localStorageMock.setItem('forge-collab-server-url', 'ws://127.0.0.1:47187')
      const { isCollabServerRemote } = await import('./collaboration-endpoints')
      expect(isCollabServerRemote()).toBe(false)
    })

    it('treats localhost as equivalent to 127.0.0.1', async () => {
      localStorageMock.setItem('forge-collab-server-url', 'http://localhost:47187')
      const { isCollabServerRemote } = await import('./collaboration-endpoints')
      expect(isCollabServerRemote()).toBe(false)
    })

    it('returns false for malformed URL (graceful fallback)', async () => {
      localStorageMock.setItem('forge-collab-server-url', 'not a url at all')
      const { isCollabServerRemote } = await import('./collaboration-endpoints')
      expect(isCollabServerRemote()).toBe(false)
    })

    it('ignores path component when comparing origins', async () => {
      localStorageMock.setItem('forge-collab-server-url', 'http://127.0.0.1:47187/collab/v1')
      const { isCollabServerRemote } = await import('./collaboration-endpoints')
      expect(isCollabServerRemote()).toBe(false)
    })

    it('distinguishes same hostname with different port as remote', async () => {
      localStorageMock.setItem('forge-collab-server-url', 'http://127.0.0.1:9999')
      const { isCollabServerRemote } = await import('./collaboration-endpoints')
      expect(isCollabServerRemote()).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // setCollabServerUrl registry sync (Fix 1)
  // -----------------------------------------------------------------------

  describe('setCollabServerUrl registry sync', () => {
    it('syncs set URL to registry so no-arg resolvers see the change', async () => {
      const { setCollabServerUrl, resolveCollaborationApiBaseUrl, resolveCollaborationWsUrl } =
        await import('./collaboration-endpoints')

      setCollabServerUrl('https://new-server.com')

      // The no-arg resolvers read from registry — must see the new URL
      expect(resolveCollaborationApiBaseUrl()).toBe('https://new-server.com/')
      expect(resolveCollaborationWsUrl()).toBe('wss://new-server.com')

      // Legacy key also updated
      expect(localStorageMock.getItem('forge-collab-server-url')).toBe('https://new-server.com')

      // Registry must have the connection
      const rawReg = localStorageMock.getItem('forge:collab:connections:v1')
      expect(rawReg).toBeTruthy()
      const reg = JSON.parse(rawReg!)
      expect(reg.connections).toHaveLength(1)
      expect(reg.connections[0].serverUrl).toBe('https://new-server.com')
    })

    it('switching URL via setCollabServerUrl updates resolvers', async () => {
      const { setCollabServerUrl, resolveCollaborationApiBaseUrl } =
        await import('./collaboration-endpoints')

      setCollabServerUrl('https://first.com')
      expect(resolveCollaborationApiBaseUrl()).toBe('https://first.com/')

      setCollabServerUrl('https://second.com')
      expect(resolveCollaborationApiBaseUrl()).toBe('https://second.com/')
    })

    it('clearing URL via setCollabServerUrl(null) reverts resolvers to same-origin', async () => {
      const { setCollabServerUrl, resolveCollaborationApiBaseUrl, resolveCollaborationWsUrl } =
        await import('./collaboration-endpoints')

      setCollabServerUrl('https://remote.com')
      expect(resolveCollaborationApiBaseUrl()).toBe('https://remote.com/')

      setCollabServerUrl(null)
      // Should fall back to same-origin
      expect(resolveCollaborationApiBaseUrl()).toBe('http://127.0.0.1:47187/')
      expect(resolveCollaborationWsUrl()).toBe('ws://127.0.0.1:47187')

      // Legacy key cleared
      expect(localStorageMock.getItem('forge-collab-server-url')).toBeNull()
    })

    it('set→clear→set cycle works correctly with registry', async () => {
      const { setCollabServerUrl, resolveCollaborationApiBaseUrl } =
        await import('./collaboration-endpoints')

      setCollabServerUrl('https://first.com')
      expect(resolveCollaborationApiBaseUrl()).toBe('https://first.com/')

      setCollabServerUrl(null)
      expect(resolveCollaborationApiBaseUrl()).toBe('http://127.0.0.1:47187/')

      setCollabServerUrl('https://third.com')
      expect(resolveCollaborationApiBaseUrl()).toBe('https://third.com/')
    })

    it('setCollabServerUrl works when registry already exists from prior migration', async () => {
      // Simulate a registry already existing from a previous migration
      localStorageMock.setItem('forge-collab-server-url', 'https://old.com')
      const { setCollabServerUrl, resolveCollaborationApiBaseUrl } =
        await import('./collaboration-endpoints')

      // First access triggers migration → registry now exists
      expect(resolveCollaborationApiBaseUrl()).toBe('https://old.com/')

      // Now use legacy setter to switch — must sync to registry
      setCollabServerUrl('https://new.com')
      expect(resolveCollaborationApiBaseUrl()).toBe('https://new.com/')
    })
  })

  // -----------------------------------------------------------------------
  // Registry-backed compatibility — verify wrappers delegate correctly
  // -----------------------------------------------------------------------

  describe('registry-backed compatibility', () => {
    it('resolves from registry when both registry and legacy exist', async () => {
      // Set up a valid registry with a different URL than legacy
      const registry = {
        version: 1,
        lastActiveConnectionId: 'conn_test',
        connections: [{
          id: 'conn_test',
          kind: 'remote',
          label: 'Test',
          serverUrl: 'https://registry.example.com',
          apiBaseUrl: 'https://registry.example.com/',
          wsUrl: 'wss://registry.example.com',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        }],
      }
      localStorageMock.setItem('forge:collab:connections:v1', JSON.stringify(registry))
      localStorageMock.setItem('forge-collab-server-url', 'https://legacy.example.com')

      const { resolveCollaborationApiBaseUrl, resolveCollaborationWsUrl } =
        await import('./collaboration-endpoints')

      // Should use registry, not legacy
      expect(resolveCollaborationApiBaseUrl()).toBe('https://registry.example.com/')
      expect(resolveCollaborationWsUrl()).toBe('wss://registry.example.com')
    })

    it('migrates legacy to registry on first access through wrapper', async () => {
      localStorageMock.setItem('forge-collab-server-url', 'https://collab.example.com')
      const { resolveCollaborationApiBaseUrl } = await import('./collaboration-endpoints')

      // First call triggers migration internally
      const baseUrl = resolveCollaborationApiBaseUrl()
      expect(baseUrl).toBe('https://collab.example.com/')

      // Registry should now be populated
      const rawRegistry = localStorageMock.getItem('forge:collab:connections:v1')
      expect(rawRegistry).toBeTruthy()
      const reg = JSON.parse(rawRegistry!)
      expect(reg.connections).toHaveLength(1)
      expect(reg.connections[0].serverUrl).toBe('https://collab.example.com')
    })

    it('target-aware helpers exist and resolve correctly', async () => {
      const {
        resolveCollaborationApiBaseUrlFor,
        resolveCollaborationWsUrlFor,
        isCollabServerRemoteFor,
      } = await import('./collaboration-endpoints')

      const target = {
        connectionId: 'conn_test',
        kind: 'remote' as const,
        label: 'Test',
        serverUrl: 'https://test.com',
        apiBaseUrl: 'https://test.com/',
        wsUrl: 'wss://test.com',
        isRemote: true,
      }

      expect(resolveCollaborationApiBaseUrlFor(target)).toBe('https://test.com/')
      expect(resolveCollaborationWsUrlFor(target)).toBe('wss://test.com')
      expect(isCollabServerRemoteFor(target)).toBe(true)
    })
  })
})
