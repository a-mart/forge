import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — must be declared before module imports
// ---------------------------------------------------------------------------

vi.mock('./backend-url', () => ({
  resolveBackendWsUrl: () => 'ws://127.0.0.1:47187',
}))

vi.mock('./api-endpoint', () => ({
  resolveApiEndpoint: (wsUrl: string, path: string) => {
    const url = new URL(wsUrl.replace('ws:', 'http:').replace('wss:', 'https:'))
    return new URL(path, url.origin).toString()
  },
}))

// ---------------------------------------------------------------------------
// localStorage mock
// ---------------------------------------------------------------------------

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key]
    }),
    clear: vi.fn(() => {
      store = {}
    }),
    _store: () => store,
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

// ---------------------------------------------------------------------------
// Constants for test setup
// ---------------------------------------------------------------------------

const REGISTRY_KEY = 'forge:collab:connections:v1'
const MALFORMED_KEY = 'forge:collab:connections:v1:malformed'
const LEGACY_URL_KEY = 'forge-collab-server-url'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('collaboration-connections', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorageMock.clear()
    vi.mocked(window.dispatchEvent).mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorageMock.clear()
  })

  // -----------------------------------------------------------------------
  // normalizeServerUrl
  // -----------------------------------------------------------------------

  describe('normalizeServerUrl', () => {
    it('trims whitespace', async () => {
      const { normalizeServerUrl } = await import('./collaboration-connections')
      expect(normalizeServerUrl('  https://collab.example.com  ')).toBe(
        'https://collab.example.com',
      )
    })

    it('returns origin only (strips path)', async () => {
      const { normalizeServerUrl } = await import('./collaboration-connections')
      expect(normalizeServerUrl('https://collab.example.com/api/v1')).toBe(
        'https://collab.example.com',
      )
    })

    it('normalizes localhost to 127.0.0.1', async () => {
      const { normalizeServerUrl } = await import('./collaboration-connections')
      expect(normalizeServerUrl('http://localhost:3000')).toBe(
        'http://127.0.0.1:3000',
      )
    })

    it('returns null for empty/null/undefined', async () => {
      const { normalizeServerUrl } = await import('./collaboration-connections')
      expect(normalizeServerUrl(null)).toBeNull()
      expect(normalizeServerUrl(undefined)).toBeNull()
      expect(normalizeServerUrl('')).toBeNull()
      expect(normalizeServerUrl('   ')).toBeNull()
    })

    it('returns null for non-http(s) protocols', async () => {
      const { normalizeServerUrl } = await import('./collaboration-connections')
      expect(normalizeServerUrl('ftp://example.com')).toBeNull()
    })

    it('returns null for unparseable URLs', async () => {
      const { normalizeServerUrl } = await import('./collaboration-connections')
      expect(normalizeServerUrl('not a url at all')).toBeNull()
    })

    it('accepts http:// URLs', async () => {
      const { normalizeServerUrl } = await import('./collaboration-connections')
      expect(normalizeServerUrl('http://192.168.1.10:3000')).toBe(
        'http://192.168.1.10:3000',
      )
    })

    it('accepts https:// URLs', async () => {
      const { normalizeServerUrl } = await import('./collaboration-connections')
      expect(normalizeServerUrl('https://collab.work.com')).toBe(
        'https://collab.work.com',
      )
    })
  })

  // -----------------------------------------------------------------------
  // connectionIdFromOrigin
  // -----------------------------------------------------------------------

  describe('connectionIdFromOrigin', () => {
    it('produces a deterministic conn_ prefixed ID', async () => {
      const { connectionIdFromOrigin } = await import(
        './collaboration-connections'
      )
      const id1 = connectionIdFromOrigin('https://collab.example.com')
      const id2 = connectionIdFromOrigin('https://collab.example.com')
      expect(id1).toBe(id2)
      expect(id1).toMatch(/^conn_[a-z0-9]+$/)
    })

    it('produces different IDs for different origins', async () => {
      const { connectionIdFromOrigin } = await import(
        './collaboration-connections'
      )
      const id1 = connectionIdFromOrigin('https://collab.work.com')
      const id2 = connectionIdFromOrigin('https://collab.side.dev')
      expect(id1).not.toBe(id2)
    })
  })

  // -----------------------------------------------------------------------
  // buildSameOriginTarget
  // -----------------------------------------------------------------------

  describe('buildSameOriginTarget', () => {
    it('uses SAME_ORIGIN_CONNECTION_ID and local backend URLs', async () => {
      const { buildSameOriginTarget, SAME_ORIGIN_CONNECTION_ID } = await import(
        './collaboration-connections'
      )
      const target = buildSameOriginTarget()
      expect(target.connectionId).toBe(SAME_ORIGIN_CONNECTION_ID)
      expect(target.connectionId).toBe('conn_same_origin')
      expect(target.kind).toBe('same-origin')
      expect(target.isRemote).toBe(false)
      expect(target.virtual).toBe(true)
      expect(target.wsUrl).toBe('ws://127.0.0.1:47187')
      expect(target.apiBaseUrl).toBe('http://127.0.0.1:47187/')
      expect(target.label).toBe('Local')
    })
  })

  // -----------------------------------------------------------------------
  // loadRegistry — empty state
  // -----------------------------------------------------------------------

  describe('loadRegistry', () => {
    it('returns empty registry when no storage exists', async () => {
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.version).toBe(1)
      expect(reg.connections).toEqual([])
      expect(reg.lastActiveConnectionId).toBeUndefined()
    })

    // -------------------------------------------------------------------
    // Legacy migration
    // -------------------------------------------------------------------

    it('migrates a legacy forge-collab-server-url to a one-entry registry', async () => {
      localStorageMock.setItem(LEGACY_URL_KEY, 'https://collab.example.com')
      const { loadRegistry, connectionIdFromOrigin } = await import(
        './collaboration-connections'
      )
      const reg = loadRegistry()

      expect(reg.connections).toHaveLength(1)
      const conn = reg.connections[0]!
      expect(conn.kind).toBe('remote')
      expect(conn.serverUrl).toBe('https://collab.example.com')
      expect(conn.apiBaseUrl).toBe('https://collab.example.com/')
      expect(conn.wsUrl).toBe('wss://collab.example.com')
      expect(conn.source).toBe('legacy')
      expect(conn.id).toBe(
        connectionIdFromOrigin('https://collab.example.com'),
      )
      expect(reg.lastActiveConnectionId).toBe(conn.id)

      // Persists the registry
      expect(localStorageMock.getItem(REGISTRY_KEY)).toBeTruthy()

      // Keeps legacy key intact
      expect(localStorageMock.getItem(LEGACY_URL_KEY)).toBe(
        'https://collab.example.com',
      )
    })

    it('normalizes legacy localhost URL during migration', async () => {
      localStorageMock.setItem(LEGACY_URL_KEY, 'http://localhost:47387')
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()

      expect(reg.connections).toHaveLength(1)
      expect(reg.connections[0]!.serverUrl).toBe('http://127.0.0.1:47387')
    })

    it('returns empty registry for invalid legacy URL', async () => {
      localStorageMock.setItem(LEGACY_URL_KEY, 'not a url')
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toEqual([])
    })

    // -------------------------------------------------------------------
    // Malformed registry recovery
    // -------------------------------------------------------------------

    it('recovers from malformed registry to legacy URL', async () => {
      localStorageMock.setItem(REGISTRY_KEY, '{invalid json!!!}')
      localStorageMock.setItem(LEGACY_URL_KEY, 'https://backup.example.com')
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()

      // Should have recovered from legacy
      expect(reg.connections).toHaveLength(1)
      expect(reg.connections[0]!.serverUrl).toBe('https://backup.example.com')

      // Malformed backup preserved
      const backup = localStorageMock.getItem(MALFORMED_KEY)
      expect(backup).toBeTruthy()
      const parsed = JSON.parse(backup!)
      expect(parsed.raw).toBe('{invalid json!!!}')
      expect(parsed.backedUpAt).toBeTruthy()

      // Malformed registry key removed
      // (loadRegistry removed it, then set the new migrated one)
    })

    it('recovers from structurally invalid registry (wrong version)', async () => {
      localStorageMock.setItem(
        REGISTRY_KEY,
        JSON.stringify({ version: 99, connections: [] }),
      )
      localStorageMock.setItem(LEGACY_URL_KEY, 'https://fallback.com')
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(1)
      expect(reg.connections[0]!.serverUrl).toBe('https://fallback.com')
    })

    it('recovers from registry missing connections array', async () => {
      localStorageMock.setItem(
        REGISTRY_KEY,
        JSON.stringify({ version: 1 }),
      )
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toEqual([])
    })

    it('falls back to empty when both registry and legacy are bad', async () => {
      localStorageMock.setItem(REGISTRY_KEY, 'garbage')
      localStorageMock.setItem(LEGACY_URL_KEY, 'not-a-url')
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toEqual([])
    })

    // -------------------------------------------------------------------
    // Valid registry
    // -------------------------------------------------------------------

    it('loads a valid persisted registry directly', async () => {
      const validRegistry = {
        version: 1,
        lastActiveConnectionId: 'conn_abc',
        connections: [
          {
            id: 'conn_abc',
            kind: 'remote',
            label: 'Test',
            serverUrl: 'https://test.com',
            apiBaseUrl: 'https://test.com/',
            wsUrl: 'wss://test.com',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
      localStorageMock.setItem(REGISTRY_KEY, JSON.stringify(validRegistry))
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(1)
      expect(reg.connections[0]!.id).toBe('conn_abc')
      expect(reg.lastActiveConnectionId).toBe('conn_abc')
    })

    // -------------------------------------------------------------------
    // Per-record validation (Fix 2)
    // -------------------------------------------------------------------

    it('drops records missing required fields (id)', async () => {
      const registry = {
        version: 1,
        connections: [
          {
            // missing id
            kind: 'remote',
            label: 'No ID',
            serverUrl: 'https://test.com',
            apiBaseUrl: 'https://test.com/',
            wsUrl: 'wss://test.com',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          {
            id: 'conn_good',
            kind: 'remote',
            label: 'Good',
            serverUrl: 'https://good.com',
            apiBaseUrl: 'https://good.com/',
            wsUrl: 'wss://good.com',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
      localStorageMock.setItem(REGISTRY_KEY, JSON.stringify(registry))
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(1)
      expect(reg.connections[0]!.id).toBe('conn_good')
    })

    it('drops records missing apiBaseUrl', async () => {
      const registry = {
        version: 1,
        connections: [
          {
            id: 'conn_bad',
            kind: 'remote',
            label: 'Bad',
            serverUrl: 'https://bad.com',
            // missing apiBaseUrl
            wsUrl: 'wss://bad.com',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
      localStorageMock.setItem(REGISTRY_KEY, JSON.stringify(registry))
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(0)
    })

    it('drops records missing wsUrl', async () => {
      const registry = {
        version: 1,
        connections: [
          {
            id: 'conn_bad',
            kind: 'remote',
            label: 'Bad',
            serverUrl: 'https://bad.com',
            apiBaseUrl: 'https://bad.com/',
            // missing wsUrl
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
      localStorageMock.setItem(REGISTRY_KEY, JSON.stringify(registry))
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(0)
    })

    it('drops records with empty id', async () => {
      const registry = {
        version: 1,
        connections: [
          {
            id: '',
            kind: 'remote',
            label: 'Empty ID',
            serverUrl: 'https://bad.com',
            apiBaseUrl: 'https://bad.com/',
            wsUrl: 'wss://bad.com',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
      localStorageMock.setItem(REGISTRY_KEY, JSON.stringify(registry))
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(0)
    })

    it('drops records with invalid kind', async () => {
      const registry = {
        version: 1,
        connections: [
          {
            id: 'conn_bad',
            kind: 'invalid_kind',
            label: 'Bad Kind',
            serverUrl: 'https://bad.com',
            apiBaseUrl: 'https://bad.com/',
            wsUrl: 'wss://bad.com',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
      localStorageMock.setItem(REGISTRY_KEY, JSON.stringify(registry))
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(0)
    })

    it('drops records missing label', async () => {
      const registry = {
        version: 1,
        connections: [
          {
            id: 'conn_bad',
            kind: 'remote',
            // missing label
            serverUrl: 'https://bad.com',
            apiBaseUrl: 'https://bad.com/',
            wsUrl: 'wss://bad.com',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
      localStorageMock.setItem(REGISTRY_KEY, JSON.stringify(registry))
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(0)
    })

    it('drops null entries in connections array', async () => {
      const registry = {
        version: 1,
        connections: [
          null,
          {
            id: 'conn_good',
            kind: 'remote',
            label: 'Good',
            serverUrl: 'https://good.com',
            apiBaseUrl: 'https://good.com/',
            wsUrl: 'wss://good.com',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
      localStorageMock.setItem(REGISTRY_KEY, JSON.stringify(registry))
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(1)
      expect(reg.connections[0]!.id).toBe('conn_good')
    })

    it('drops records missing timestamps', async () => {
      const registry = {
        version: 1,
        connections: [
          {
            id: 'conn_bad',
            kind: 'remote',
            label: 'No Timestamps',
            serverUrl: 'https://bad.com',
            apiBaseUrl: 'https://bad.com/',
            wsUrl: 'wss://bad.com',
            // missing createdAt, updatedAt
          },
        ],
      }
      localStorageMock.setItem(REGISTRY_KEY, JSON.stringify(registry))
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(0)
    })

    // -------------------------------------------------------------------
    // URL parseability validation
    // -------------------------------------------------------------------

    it('drops records with unparseable apiBaseUrl', async () => {
      const registry = {
        version: 1,
        connections: [
          {
            id: 'conn_bad',
            kind: 'remote',
            label: 'Bad API URL',
            serverUrl: 'https://ok.com',
            apiBaseUrl: 'not a url at all',
            wsUrl: 'wss://ok.com',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          {
            id: 'conn_good',
            kind: 'remote',
            label: 'Good',
            serverUrl: 'https://good.com',
            apiBaseUrl: 'https://good.com/',
            wsUrl: 'wss://good.com',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
      localStorageMock.setItem(REGISTRY_KEY, JSON.stringify(registry))
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(1)
      expect(reg.connections[0]!.id).toBe('conn_good')
    })

    it('drops records with unparseable wsUrl', async () => {
      const registry = {
        version: 1,
        connections: [
          {
            id: 'conn_bad',
            kind: 'remote',
            label: 'Bad WS URL',
            serverUrl: 'https://ok.com',
            apiBaseUrl: 'https://ok.com/',
            wsUrl: '://broken',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
      localStorageMock.setItem(REGISTRY_KEY, JSON.stringify(registry))
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(0)
    })

    it('drops records with wsUrl using wrong protocol (http instead of ws)', async () => {
      const registry = {
        version: 1,
        connections: [
          {
            id: 'conn_bad',
            kind: 'remote',
            label: 'HTTP as WS',
            serverUrl: 'https://ok.com',
            apiBaseUrl: 'https://ok.com/',
            wsUrl: 'https://ok.com',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
      localStorageMock.setItem(REGISTRY_KEY, JSON.stringify(registry))
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(0)
    })

    it('drops records with apiBaseUrl using wrong protocol (ws instead of http)', async () => {
      const registry = {
        version: 1,
        connections: [
          {
            id: 'conn_bad',
            kind: 'remote',
            label: 'WS as API',
            serverUrl: 'https://ok.com',
            apiBaseUrl: 'wss://ok.com/',
            wsUrl: 'wss://ok.com',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
      localStorageMock.setItem(REGISTRY_KEY, JSON.stringify(registry))
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(0)
    })

    it('drops remote records with unparseable serverUrl', async () => {
      const registry = {
        version: 1,
        connections: [
          {
            id: 'conn_bad',
            kind: 'remote',
            label: 'Bad Server URL',
            serverUrl: 'garbage string',
            apiBaseUrl: 'https://ok.com/',
            wsUrl: 'wss://ok.com',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
      localStorageMock.setItem(REGISTRY_KEY, JSON.stringify(registry))
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(0)
    })

    it('drops remote records with missing serverUrl', async () => {
      const registry = {
        version: 1,
        connections: [
          {
            id: 'conn_bad',
            kind: 'remote',
            label: 'No Server URL',
            // serverUrl omitted
            apiBaseUrl: 'https://ok.com/',
            wsUrl: 'wss://ok.com',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
      localStorageMock.setItem(REGISTRY_KEY, JSON.stringify(registry))
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(0)
    })

    it('drops remote records with serverUrl using non-http protocol', async () => {
      const registry = {
        version: 1,
        connections: [
          {
            id: 'conn_bad',
            kind: 'remote',
            label: 'FTP Server URL',
            serverUrl: 'ftp://files.example.com',
            apiBaseUrl: 'https://files.example.com/',
            wsUrl: 'wss://files.example.com',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
      localStorageMock.setItem(REGISTRY_KEY, JSON.stringify(registry))
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(0)
    })

    it('allows same-origin records without serverUrl', async () => {
      const registry = {
        version: 1,
        connections: [
          {
            id: 'conn_same_origin',
            kind: 'same-origin',
            label: 'Local',
            // serverUrl intentionally absent for same-origin
            apiBaseUrl: 'http://127.0.0.1:47187/',
            wsUrl: 'ws://127.0.0.1:47187',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
      localStorageMock.setItem(REGISTRY_KEY, JSON.stringify(registry))
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(1)
      expect(reg.connections[0]!.id).toBe('conn_same_origin')
    })

    it('keeps valid records and drops only malformed URL records in mixed registry', async () => {
      const registry = {
        version: 1,
        connections: [
          {
            id: 'conn_good',
            kind: 'remote',
            label: 'Good',
            serverUrl: 'https://good.com',
            apiBaseUrl: 'https://good.com/',
            wsUrl: 'wss://good.com',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          {
            id: 'conn_bad_ws',
            kind: 'remote',
            label: 'Bad WS',
            serverUrl: 'https://bad.com',
            apiBaseUrl: 'https://bad.com/',
            wsUrl: 'not-a-ws-url',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          {
            id: 'conn_bad_api',
            kind: 'remote',
            label: 'Bad API',
            serverUrl: 'https://bad2.com',
            apiBaseUrl: '',
            wsUrl: 'wss://bad2.com',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          {
            id: 'conn_also_good',
            kind: 'remote',
            label: 'Also Good',
            serverUrl: 'https://also-good.com',
            apiBaseUrl: 'https://also-good.com/',
            wsUrl: 'wss://also-good.com',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
      localStorageMock.setItem(REGISTRY_KEY, JSON.stringify(registry))
      const { loadRegistry } = await import('./collaboration-connections')
      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(2)
      expect(reg.connections.map((c) => c.id)).toEqual(['conn_good', 'conn_also_good'])
    })
  })

  // -----------------------------------------------------------------------
  // getCollaborationConnectionOptions
  // -----------------------------------------------------------------------

  describe('getCollaborationConnectionOptions', () => {
    it('returns virtual same-origin when no remotes exist', async () => {
      const { getCollaborationConnectionOptions, SAME_ORIGIN_CONNECTION_ID } =
        await import('./collaboration-connections')
      const options = getCollaborationConnectionOptions()
      expect(options).toHaveLength(1)
      expect(options[0]!.connectionId).toBe(SAME_ORIGIN_CONNECTION_ID)
      expect(options[0]!.kind).toBe('same-origin')
      expect(options[0]!.isRemote).toBe(false)
      expect(options[0]!.virtual).toBe(true)
    })

    it('excludes virtual same-origin when remotes exist', async () => {
      localStorageMock.setItem(LEGACY_URL_KEY, 'https://collab.example.com')
      const { getCollaborationConnectionOptions, SAME_ORIGIN_CONNECTION_ID } =
        await import('./collaboration-connections')
      const options = getCollaborationConnectionOptions()
      expect(options).toHaveLength(1)
      expect(options[0]!.kind).toBe('remote')
      expect(
        options.some((o) => o.connectionId === SAME_ORIGIN_CONNECTION_ID),
      ).toBe(false)
    })

    it('includes explicit same-origin alongside remotes', async () => {
      const { upsertCollaborationConnection, addSameOriginConnection, getCollaborationConnectionOptions, SAME_ORIGIN_CONNECTION_ID } =
        await import('./collaboration-connections')
      upsertCollaborationConnection({
        serverUrl: 'https://collab.example.com',
      })
      addSameOriginConnection()
      const options = getCollaborationConnectionOptions()
      expect(options).toHaveLength(2)
      expect(options.some((o) => o.kind === 'remote')).toBe(true)
      const sameOrigin = options.find((o) => o.connectionId === SAME_ORIGIN_CONNECTION_ID)
      expect(sameOrigin).toBeTruthy()
      expect(sameOrigin!.virtual).toBeFalsy()
    })
  })

  // -----------------------------------------------------------------------
  // getDefaultCollaborationConnection
  // -----------------------------------------------------------------------

  describe('getDefaultCollaborationConnection', () => {
    it('returns same-origin when no connections exist', async () => {
      const { getDefaultCollaborationConnection, SAME_ORIGIN_CONNECTION_ID } =
        await import('./collaboration-connections')
      const def = getDefaultCollaborationConnection()
      expect(def.connectionId).toBe(SAME_ORIGIN_CONNECTION_ID)
      expect(def.kind).toBe('same-origin')
    })

    it('returns the last-active connection', async () => {
      const { upsertCollaborationConnection, setLastActiveCollaborationConnection, getDefaultCollaborationConnection } =
        await import('./collaboration-connections')
      upsertCollaborationConnection({
        serverUrl: 'https://a.com',
      })
      const id2 = upsertCollaborationConnection({
        serverUrl: 'https://b.com',
      })
      setLastActiveCollaborationConnection(id2)
      const def = getDefaultCollaborationConnection()
      expect(def.connectionId).toBe(id2)
    })

    it('recovers from stale lastActiveConnectionId', async () => {
      const registry = {
        version: 1,
        lastActiveConnectionId: 'conn_nonexistent',
        connections: [
          {
            id: 'conn_real',
            kind: 'remote',
            label: 'Real',
            serverUrl: 'https://real.com',
            apiBaseUrl: 'https://real.com/',
            wsUrl: 'wss://real.com',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
      localStorageMock.setItem(REGISTRY_KEY, JSON.stringify(registry))
      const { getDefaultCollaborationConnection } = await import(
        './collaboration-connections'
      )
      const def = getDefaultCollaborationConnection()
      // Should fall back to first remote instead of crashing
      expect(def.connectionId).toBe('conn_real')
    })
  })

  // -----------------------------------------------------------------------
  // upsertCollaborationConnection
  // -----------------------------------------------------------------------

  describe('upsertCollaborationConnection', () => {
    it('adds a new remote connection', async () => {
      const { upsertCollaborationConnection, loadRegistry } = await import(
        './collaboration-connections'
      )
      const id = upsertCollaborationConnection({
        serverUrl: 'https://collab.work.com',
        label: 'Work',
      })
      expect(id).toMatch(/^conn_/)

      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(1)
      const conn = reg.connections[0]!
      expect(conn.id).toBe(id)
      expect(conn.label).toBe('Work')
      expect(conn.serverUrl).toBe('https://collab.work.com')
      expect(conn.apiBaseUrl).toBe('https://collab.work.com/')
      expect(conn.wsUrl).toBe('wss://collab.work.com')
      expect(conn.kind).toBe('remote')
      expect(conn.source).toBe('manual')
    })

    it('updates existing connection when origin matches (dedup)', async () => {
      const { upsertCollaborationConnection, loadRegistry } = await import(
        './collaboration-connections'
      )
      const id1 = upsertCollaborationConnection({
        serverUrl: 'https://collab.work.com',
        label: 'Work v1',
      })
      const id2 = upsertCollaborationConnection({
        serverUrl: 'https://collab.work.com',
        label: 'Work v2',
      })
      expect(id1).toBe(id2)

      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(1)
      expect(reg.connections[0]!.label).toBe('Work v2')
    })

    it('normalizes localhost to 127.0.0.1 for dedup', async () => {
      const { upsertCollaborationConnection, loadRegistry } = await import(
        './collaboration-connections'
      )
      const id1 = upsertCollaborationConnection({
        serverUrl: 'http://localhost:3000',
      })
      const id2 = upsertCollaborationConnection({
        serverUrl: 'http://127.0.0.1:3000',
      })
      expect(id1).toBe(id2)

      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(1)
    })

    it('sets lastActiveConnectionId for the first remote', async () => {
      const { upsertCollaborationConnection, loadRegistry } = await import(
        './collaboration-connections'
      )
      const id = upsertCollaborationConnection({
        serverUrl: 'https://first.com',
      })
      const reg = loadRegistry()
      expect(reg.lastActiveConnectionId).toBe(id)
    })

    it('throws for invalid URL', async () => {
      const { upsertCollaborationConnection } = await import(
        './collaboration-connections'
      )
      expect(() =>
        upsertCollaborationConnection({ serverUrl: 'not a url' }),
      ).toThrow('Invalid server URL')
    })

    it('auto-generates label from hostname when not provided', async () => {
      const { upsertCollaborationConnection, loadRegistry } = await import(
        './collaboration-connections'
      )
      upsertCollaborationConnection({
        serverUrl: 'https://collab.myteam.dev',
      })
      const reg = loadRegistry()
      expect(reg.connections[0]!.label).toBe('collab.myteam.dev')
    })

    it('mirrors legacy URL after add', async () => {
      const { upsertCollaborationConnection } = await import(
        './collaboration-connections'
      )
      upsertCollaborationConnection({
        serverUrl: 'https://collab.work.com',
      })
      expect(localStorageMock.getItem(LEGACY_URL_KEY)).toBe(
        'https://collab.work.com',
      )
    })

    it('dispatches change events', async () => {
      const { upsertCollaborationConnection } = await import(
        './collaboration-connections'
      )
      upsertCollaborationConnection({
        serverUrl: 'https://collab.example.com',
      })
      const events = vi
        .mocked(window.dispatchEvent)
        .mock.calls.map((c) => (c[0] as Event).type)
      expect(events).toContain('forge-collab-connections-change')
      expect(events).toContain('forge-collab-server-url-change')
    })
  })

  // -----------------------------------------------------------------------
  // editCollaborationConnectionUrl
  // -----------------------------------------------------------------------

  describe('editCollaborationConnectionUrl', () => {
    it('creates a new ID when origin changes', async () => {
      const {
        upsertCollaborationConnection,
        editCollaborationConnectionUrl,
        loadRegistry,
      } = await import('./collaboration-connections')
      const oldId = upsertCollaborationConnection({
        serverUrl: 'https://old.com',
      })
      const newId = editCollaborationConnectionUrl(oldId, {
        serverUrl: 'https://new.com',
      })

      expect(newId).not.toBe(oldId)
      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(1)
      expect(reg.connections[0]!.id).toBe(newId)
      expect(reg.connections[0]!.serverUrl).toBe('https://new.com')
    })

    it('preserves ID when origin is unchanged', async () => {
      const {
        upsertCollaborationConnection,
        editCollaborationConnectionUrl,
        loadRegistry,
      } = await import('./collaboration-connections')
      const id = upsertCollaborationConnection({
        serverUrl: 'https://same.com',
        label: 'Old Label',
      })
      const resultId = editCollaborationConnectionUrl(id, {
        serverUrl: 'https://same.com',
        label: 'New Label',
      })

      expect(resultId).toBe(id)
      const reg = loadRegistry()
      expect(reg.connections[0]!.label).toBe('New Label')
    })

    it('deduplicates when new origin already exists', async () => {
      const {
        upsertCollaborationConnection,
        editCollaborationConnectionUrl,
        loadRegistry,
      } = await import('./collaboration-connections')
      const idA = upsertCollaborationConnection({
        serverUrl: 'https://a.com',
        label: 'A',
      })
      const idB = upsertCollaborationConnection({
        serverUrl: 'https://b.com',
        label: 'B',
      })

      // Edit A's URL to match B's origin → should return B's ID, remove A
      const resultId = editCollaborationConnectionUrl(idA, {
        serverUrl: 'https://b.com',
      })
      expect(resultId).toBe(idB)

      const reg = loadRegistry()
      expect(reg.connections).toHaveLength(1)
      expect(reg.connections[0]!.id).toBe(idB)
    })

    it('transfers lastActiveConnectionId when origin changes', async () => {
      const {
        upsertCollaborationConnection,
        setLastActiveCollaborationConnection,
        editCollaborationConnectionUrl,
        loadRegistry,
      } = await import('./collaboration-connections')
      const id = upsertCollaborationConnection({
        serverUrl: 'https://old.com',
      })
      setLastActiveCollaborationConnection(id)

      const newId = editCollaborationConnectionUrl(id, {
        serverUrl: 'https://new.com',
      })
      const reg = loadRegistry()
      expect(reg.lastActiveConnectionId).toBe(newId)
    })

    it('throws for same-origin connection', async () => {
      const { editCollaborationConnectionUrl, SAME_ORIGIN_CONNECTION_ID } =
        await import('./collaboration-connections')
      expect(() =>
        editCollaborationConnectionUrl(SAME_ORIGIN_CONNECTION_ID, {
          serverUrl: 'https://new.com',
        }),
      ).toThrow('Cannot edit the same-origin connection URL')
    })

    it('throws for invalid URL', async () => {
      const {
        upsertCollaborationConnection,
        editCollaborationConnectionUrl,
      } = await import('./collaboration-connections')
      const id = upsertCollaborationConnection({
        serverUrl: 'https://old.com',
      })
      expect(() =>
        editCollaborationConnectionUrl(id, { serverUrl: 'bad' }),
      ).toThrow('Invalid server URL')
    })
  })

  // -----------------------------------------------------------------------
  // renameCollaborationConnection
  // -----------------------------------------------------------------------

  describe('renameCollaborationConnection', () => {
    it('updates label and preserves ID', async () => {
      const {
        upsertCollaborationConnection,
        renameCollaborationConnection,
        loadRegistry,
      } = await import('./collaboration-connections')
      const id = upsertCollaborationConnection({
        serverUrl: 'https://collab.com',
        label: 'Old Name',
      })
      renameCollaborationConnection(id, 'New Name')
      const reg = loadRegistry()
      expect(reg.connections[0]!.id).toBe(id)
      expect(reg.connections[0]!.label).toBe('New Name')
    })

    it('no-ops for nonexistent connection', async () => {
      const { renameCollaborationConnection, loadRegistry } = await import(
        './collaboration-connections'
      )
      renameCollaborationConnection('conn_nonexistent', 'Test')
      const reg = loadRegistry()
      expect(reg.connections).toEqual([])
    })

    it('no-ops for virtual same-origin (not persisted)', async () => {
      const { renameCollaborationConnection, loadRegistry, SAME_ORIGIN_CONNECTION_ID } =
        await import('./collaboration-connections')
      // No explicit same-origin record — rename targets the virtual fallback
      renameCollaborationConnection(SAME_ORIGIN_CONNECTION_ID, 'Custom Local')
      const reg = loadRegistry()
      expect(reg.connections).toEqual([])
    })

    it('renames explicitly persisted same-origin', async () => {
      const {
        addSameOriginConnection,
        renameCollaborationConnection,
        loadRegistry,
        SAME_ORIGIN_CONNECTION_ID,
      } = await import('./collaboration-connections')
      addSameOriginConnection()
      renameCollaborationConnection(SAME_ORIGIN_CONNECTION_ID, 'My Local')
      const reg = loadRegistry()
      const conn = reg.connections.find((c) => c.id === SAME_ORIGIN_CONNECTION_ID)
      expect(conn).toBeTruthy()
      expect(conn!.label).toBe('My Local')
    })
  })

  // -----------------------------------------------------------------------
  // removeCollaborationConnection
  // -----------------------------------------------------------------------

  describe('removeCollaborationConnection', () => {
    it('removes a remote connection', async () => {
      const {
        upsertCollaborationConnection,
        removeCollaborationConnection,
        loadRegistry,
      } = await import('./collaboration-connections')
      const id = upsertCollaborationConnection({
        serverUrl: 'https://collab.com',
      })
      removeCollaborationConnection(id)
      const reg = loadRegistry()
      expect(reg.connections).toEqual([])
    })

    it('clears lastActiveConnectionId when removed connection was active', async () => {
      const {
        upsertCollaborationConnection,
        removeCollaborationConnection,
        loadRegistry,
      } = await import('./collaboration-connections')
      const id = upsertCollaborationConnection({
        serverUrl: 'https://collab.com',
      })
      removeCollaborationConnection(id)
      const reg = loadRegistry()
      expect(reg.lastActiveConnectionId).toBeUndefined()
    })

    it('transfers lastActive to next remote when active is removed', async () => {
      const {
        upsertCollaborationConnection,
        setLastActiveCollaborationConnection,
        removeCollaborationConnection,
        loadRegistry,
      } = await import('./collaboration-connections')
      const id1 = upsertCollaborationConnection({
        serverUrl: 'https://a.com',
      })
      const id2 = upsertCollaborationConnection({
        serverUrl: 'https://b.com',
      })
      setLastActiveCollaborationConnection(id1)
      removeCollaborationConnection(id1)
      const reg = loadRegistry()
      expect(reg.lastActiveConnectionId).toBe(id2)
    })

    it('clears legacy URL when last remote is removed', async () => {
      const {
        upsertCollaborationConnection,
        removeCollaborationConnection,
      } = await import('./collaboration-connections')
      const id = upsertCollaborationConnection({
        serverUrl: 'https://collab.com',
      })
      // Legacy key should be set after upsert
      expect(localStorageMock.getItem(LEGACY_URL_KEY)).toBe('https://collab.com')

      removeCollaborationConnection(id)
      // Legacy key must be cleared when no remotes remain
      expect(localStorageMock.getItem(LEGACY_URL_KEY)).toBeNull()
    })

    it('mirrors next remote to legacy when active remote is removed but others exist', async () => {
      const {
        upsertCollaborationConnection,
        setLastActiveCollaborationConnection,
        removeCollaborationConnection,
      } = await import('./collaboration-connections')
      const id1 = upsertCollaborationConnection({
        serverUrl: 'https://a.com',
      })
      upsertCollaborationConnection({
        serverUrl: 'https://b.com',
      })
      setLastActiveCollaborationConnection(id1)

      removeCollaborationConnection(id1)
      // Should now mirror b.com
      expect(localStorageMock.getItem(LEGACY_URL_KEY)).toBe('https://b.com')
    })

    it('dispatches change events on removal', async () => {
      const {
        upsertCollaborationConnection,
        removeCollaborationConnection,
      } = await import('./collaboration-connections')
      const id = upsertCollaborationConnection({
        serverUrl: 'https://collab.com',
      })
      vi.mocked(window.dispatchEvent).mockClear()
      removeCollaborationConnection(id)
      const events = vi
        .mocked(window.dispatchEvent)
        .mock.calls.map((c) => (c[0] as Event).type)
      expect(events).toContain('forge-collab-connections-change')
    })
  })

  // -----------------------------------------------------------------------
  // addSameOriginConnection
  // -----------------------------------------------------------------------

  describe('addSameOriginConnection', () => {
    it('adds explicit same-origin record', async () => {
      const { addSameOriginConnection, loadRegistry, SAME_ORIGIN_CONNECTION_ID } =
        await import('./collaboration-connections')
      const id = addSameOriginConnection()
      expect(id).toBe(SAME_ORIGIN_CONNECTION_ID)

      const reg = loadRegistry()
      const conn = reg.connections.find(
        (c) => c.id === SAME_ORIGIN_CONNECTION_ID,
      )
      expect(conn).toBeTruthy()
      expect(conn!.kind).toBe('same-origin')
    })

    it('is idempotent', async () => {
      const { addSameOriginConnection, loadRegistry } = await import(
        './collaboration-connections'
      )
      addSameOriginConnection()
      addSameOriginConnection()
      const reg = loadRegistry()
      expect(
        reg.connections.filter((c) => c.kind === 'same-origin'),
      ).toHaveLength(1)
    })
  })

  // -----------------------------------------------------------------------
  // resolveCollaborationTarget
  // -----------------------------------------------------------------------

  describe('resolveCollaborationTarget', () => {
    it('resolves default target when no connectionId', async () => {
      const { resolveCollaborationTarget, SAME_ORIGIN_CONNECTION_ID } =
        await import('./collaboration-connections')
      const target = resolveCollaborationTarget()
      expect(target.connectionId).toBe(SAME_ORIGIN_CONNECTION_ID)
    })

    it('resolves a specific connection', async () => {
      const {
        upsertCollaborationConnection,
        resolveCollaborationTarget,
      } = await import('./collaboration-connections')
      const id = upsertCollaborationConnection({
        serverUrl: 'https://specific.com',
        label: 'Specific',
      })
      const target = resolveCollaborationTarget(id)
      expect(target.connectionId).toBe(id)
      expect(target.apiBaseUrl).toBe('https://specific.com/')
      expect(target.wsUrl).toBe('wss://specific.com')
      expect(target.isRemote).toBe(true)
      expect(target.label).toBe('Specific')
    })

    it('resolves conn_same_origin explicitly', async () => {
      const { resolveCollaborationTarget, SAME_ORIGIN_CONNECTION_ID } =
        await import('./collaboration-connections')
      const target = resolveCollaborationTarget(SAME_ORIGIN_CONNECTION_ID)
      expect(target.connectionId).toBe(SAME_ORIGIN_CONNECTION_ID)
      expect(target.kind).toBe('same-origin')
      expect(target.isRemote).toBe(false)
    })

    it('falls back to default for stale/unknown connectionId', async () => {
      localStorageMock.setItem(LEGACY_URL_KEY, 'https://collab.com')
      const { resolveCollaborationTarget } = await import(
        './collaboration-connections'
      )
      const target = resolveCollaborationTarget('conn_nonexistent')
      // Should fall back to the legacy-migrated connection (default)
      expect(target.serverUrl).toBe('https://collab.com')
    })
  })

  // -----------------------------------------------------------------------
  // resolveCollaborationApiBaseUrlForTarget / WsUrl / isRemote
  // -----------------------------------------------------------------------

  describe('target-aware resolution helpers', () => {
    it('resolveCollaborationApiBaseUrlForTarget with no arg returns default', async () => {
      const { resolveCollaborationApiBaseUrlForTarget } = await import(
        './collaboration-connections'
      )
      const url = resolveCollaborationApiBaseUrlForTarget()
      expect(url).toBe('http://127.0.0.1:47187/')
    })

    it('resolveCollaborationApiBaseUrlForTarget with connectionId', async () => {
      const {
        upsertCollaborationConnection,
        resolveCollaborationApiBaseUrlForTarget,
      } = await import('./collaboration-connections')
      const id = upsertCollaborationConnection({
        serverUrl: 'https://test.com',
      })
      expect(resolveCollaborationApiBaseUrlForTarget(id)).toBe(
        'https://test.com/',
      )
    })

    it('resolveCollaborationApiBaseUrlForTarget with target object', async () => {
      const { buildSameOriginTarget, resolveCollaborationApiBaseUrlForTarget } =
        await import('./collaboration-connections')
      const target = buildSameOriginTarget()
      expect(resolveCollaborationApiBaseUrlForTarget(target)).toBe(
        target.apiBaseUrl,
      )
    })

    it('resolveCollaborationWsUrlForTarget returns correct WS URL', async () => {
      const {
        upsertCollaborationConnection,
        resolveCollaborationWsUrlForTarget,
      } = await import('./collaboration-connections')
      const id = upsertCollaborationConnection({
        serverUrl: 'https://test.com',
      })
      expect(resolveCollaborationWsUrlForTarget(id)).toBe('wss://test.com')
    })

    it('isCollabConnectionRemote is false for same-origin', async () => {
      const { isCollabConnectionRemote, SAME_ORIGIN_CONNECTION_ID } =
        await import('./collaboration-connections')
      expect(isCollabConnectionRemote(SAME_ORIGIN_CONNECTION_ID)).toBe(false)
    })

    it('isCollabConnectionRemote is true for remote', async () => {
      const { upsertCollaborationConnection, isCollabConnectionRemote } =
        await import('./collaboration-connections')
      const id = upsertCollaborationConnection({
        serverUrl: 'https://remote.com',
      })
      expect(isCollabConnectionRemote(id)).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // subscribeToRegistryChanges
  // -----------------------------------------------------------------------

  describe('subscribeToRegistryChanges', () => {
    it('adds and removes event listeners', async () => {
      const { subscribeToRegistryChanges } = await import(
        './collaboration-connections'
      )
      const cb = vi.fn()
      const unsub = subscribeToRegistryChanges(cb)

      expect(window.addEventListener).toHaveBeenCalledWith(
        'forge-collab-connections-change',
        expect.any(Function),
      )
      expect(window.addEventListener).toHaveBeenCalledWith(
        'storage',
        expect.any(Function),
      )

      unsub()
      expect(window.removeEventListener).toHaveBeenCalledTimes(2)
    })
  })

  // -----------------------------------------------------------------------
  // setLastActiveCollaborationConnection
  // -----------------------------------------------------------------------

  describe('setLastActiveCollaborationConnection', () => {
    it('updates lastActiveConnectionId', async () => {
      const {
        upsertCollaborationConnection,
        setLastActiveCollaborationConnection,
        loadRegistry,
      } = await import('./collaboration-connections')
      upsertCollaborationConnection({
        serverUrl: 'https://a.com',
      })
      const id2 = upsertCollaborationConnection({
        serverUrl: 'https://b.com',
      })
      setLastActiveCollaborationConnection(id2)
      const reg = loadRegistry()
      expect(reg.lastActiveConnectionId).toBe(id2)
    })

    it('clears lastActiveConnectionId with null', async () => {
      const {
        upsertCollaborationConnection,
        setLastActiveCollaborationConnection,
        loadRegistry,
      } = await import('./collaboration-connections')
      upsertCollaborationConnection({ serverUrl: 'https://a.com' })
      setLastActiveCollaborationConnection(null)
      const reg = loadRegistry()
      expect(reg.lastActiveConnectionId).toBeUndefined()
    })

    it('mirrors the active remote URL to legacy key', async () => {
      const {
        upsertCollaborationConnection,
        setLastActiveCollaborationConnection,
      } = await import('./collaboration-connections')
      const id = upsertCollaborationConnection({
        serverUrl: 'https://mirrored.com',
      })
      setLastActiveCollaborationConnection(id)
      expect(localStorageMock.getItem(LEGACY_URL_KEY)).toBe(
        'https://mirrored.com',
      )
    })
  })

  // -----------------------------------------------------------------------
  // Test helpers
  // -----------------------------------------------------------------------

  describe('_resetRegistryForTesting', () => {
    it('clears all storage keys', async () => {
      localStorageMock.setItem(REGISTRY_KEY, '{}')
      localStorageMock.setItem(MALFORMED_KEY, '{}')
      localStorageMock.setItem(LEGACY_URL_KEY, 'http://x.com')
      const { _resetRegistryForTesting } = await import(
        './collaboration-connections'
      )
      _resetRegistryForTesting()
      expect(localStorageMock.getItem(REGISTRY_KEY)).toBeNull()
      expect(localStorageMock.getItem(MALFORMED_KEY)).toBeNull()
      expect(localStorageMock.getItem(LEGACY_URL_KEY)).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // Multiple connections — integration scenarios
  // -----------------------------------------------------------------------

  describe('multiple connection scenarios', () => {
    it('supports two remote connections simultaneously', async () => {
      const {
        upsertCollaborationConnection,
        getCollaborationConnectionOptions,
      } = await import('./collaboration-connections')
      upsertCollaborationConnection({
        serverUrl: 'https://work.com',
        label: 'Work',
      })
      upsertCollaborationConnection({
        serverUrl: 'https://side.dev',
        label: 'Side Project',
      })
      const options = getCollaborationConnectionOptions()
      expect(options).toHaveLength(2)
      expect(options.map((o) => o.label).sort()).toEqual([
        'Side Project',
        'Work',
      ])
    })

    it('different ports on same host produce different connections', async () => {
      const {
        upsertCollaborationConnection,
        getCollaborationConnectionOptions,
      } = await import('./collaboration-connections')
      upsertCollaborationConnection({
        serverUrl: 'http://127.0.0.1:3000',
      })
      upsertCollaborationConnection({
        serverUrl: 'http://127.0.0.1:4000',
      })
      const options = getCollaborationConnectionOptions()
      expect(options).toHaveLength(2)
    })

    it('http and https on same host produce different connections', async () => {
      const {
        upsertCollaborationConnection,
        getCollaborationConnectionOptions,
      } = await import('./collaboration-connections')
      upsertCollaborationConnection({ serverUrl: 'http://test.com' })
      upsertCollaborationConnection({ serverUrl: 'https://test.com' })
      const options = getCollaborationConnectionOptions()
      expect(options).toHaveLength(2)
    })
  })

  // -----------------------------------------------------------------------
  // getDefaultConnectionIdFromTargets
  // -----------------------------------------------------------------------

  describe('getDefaultConnectionIdFromTargets', () => {
    it('returns null for empty targets array', async () => {
      const { getDefaultConnectionIdFromTargets } = await import(
        './collaboration-connections'
      )
      expect(getDefaultConnectionIdFromTargets([])).toBeNull()
    })

    it('returns first target when no lastActiveConnectionId', async () => {
      const { getDefaultConnectionIdFromTargets, buildSameOriginTarget } =
        await import('./collaboration-connections')
      const target = buildSameOriginTarget()
      expect(getDefaultConnectionIdFromTargets([target])).toBe(
        target.connectionId,
      )
    })

    it('returns lastActiveConnectionId when it exists in targets — [A, B] with lastActive=B returns B', async () => {
      const {
        upsertCollaborationConnection,
        setLastActiveCollaborationConnection,
        getCollaborationConnectionOptions,
        getDefaultConnectionIdFromTargets,
      } = await import('./collaboration-connections')

      const idA = upsertCollaborationConnection({
        serverUrl: 'https://a.com',
        label: 'A',
      })
      const idB = upsertCollaborationConnection({
        serverUrl: 'https://b.com',
        label: 'B',
      })
      setLastActiveCollaborationConnection(idB)

      const targets = getCollaborationConnectionOptions()
      // Verify insertion order: A is first
      expect(targets[0]!.connectionId).toBe(idA)
      expect(targets[1]!.connectionId).toBe(idB)

      // Canonical default should be B (lastActive), not A (targets[0])
      const defaultId = getDefaultConnectionIdFromTargets(targets)
      expect(defaultId).toBe(idB)
    })

    it('falls back to first target when lastActive is stale', async () => {
      // Persist a registry with lastActive pointing to a nonexistent connection
      const registry = {
        version: 1,
        lastActiveConnectionId: 'conn_deleted',
        connections: [
          {
            id: 'conn_real',
            kind: 'remote',
            label: 'Real',
            serverUrl: 'https://real.com',
            apiBaseUrl: 'https://real.com/',
            wsUrl: 'wss://real.com',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      }
      localStorageMock.setItem(REGISTRY_KEY, JSON.stringify(registry))

      const {
        getCollaborationConnectionOptions,
        getDefaultConnectionIdFromTargets,
      } = await import('./collaboration-connections')
      const targets = getCollaborationConnectionOptions()
      const defaultId = getDefaultConnectionIdFromTargets(targets)
      expect(defaultId).toBe('conn_real')
    })

    it('[A, B] registry with lastActive=B and no route collab — fallback/auth/UI use B', async () => {
      // End-to-end scenario: two backends, last-active set to B.
      // When there's no route `collab` param, all resolution paths should
      // converge on B, not A.
      const {
        upsertCollaborationConnection,
        setLastActiveCollaborationConnection,
        getCollaborationConnectionOptions,
        getDefaultConnectionIdFromTargets,
        getDefaultCollaborationConnection,
      } = await import('./collaboration-connections')

      upsertCollaborationConnection({
        serverUrl: 'https://a.com',
        label: 'A',
      })
      const idB = upsertCollaborationConnection({
        serverUrl: 'https://b.com',
        label: 'B',
      })
      setLastActiveCollaborationConnection(idB)

      // getDefaultCollaborationConnection should return B
      const defaultConn = getDefaultCollaborationConnection()
      expect(defaultConn.connectionId).toBe(idB)
      expect(defaultConn.apiBaseUrl).toBe('https://b.com/')

      // getDefaultConnectionIdFromTargets should return B
      const targets = getCollaborationConnectionOptions()
      const defaultId = getDefaultConnectionIdFromTargets(targets)
      expect(defaultId).toBe(idB)
    })
  })
})
