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
})
