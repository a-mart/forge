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
  value: { localStorage: localStorageMock },
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
})
