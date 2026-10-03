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

  })
})
