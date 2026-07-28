import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ session: { fromPartition: vi.fn() } }))

let subject: typeof import('../browser-session.js')
let electronSession: typeof import('electron').session
beforeAll(async () => {
  subject = await import('../browser-session.js')
  electronSession = (await import('electron')).session
})

describe('browser profile sessions', () => {
  it('derives stable isolated persistent partitions', () => {
    const one = subject.browserPartitionForProfile('profile-one')
    expect(one).toMatch(/^persist:forge-browser-[a-f0-9]{20}$/)
    expect(subject.browserPartitionForProfile('profile-one')).toBe(one)
    expect(subject.browserPartitionForProfile('profile-two')).not.toBe(one)
    expect(subject.isBrowserPartition(one)).toBe(true)
    expect(subject.isBrowserPartition('persist:other')).toBe(false)
    expect(() => subject.browserPartitionForProfile('   ')).toThrow(/non-empty/u)
    expect(() => subject.browserPartitionForProfile('x'.repeat(257))).toThrow(/at most 256/u)
  })

  it('removes Electron and Forge product tokens from user agents', () => {
    expect(subject.sanitizeBrowserUserAgent('Mozilla/5.0 Electron/37.10.3 Chrome/138 Forge/0.22.0 Safari/537.36'))
      .toBe('Mozilla/5.0 Chrome/138 Safari/537.36')
  })

  it('configures and reuses a profile session with permission gates', async () => {
    let permissionRequestHandler!: (contents: unknown, permission: string, callback: (allowed: boolean) => void) => void
    let permissionCheckHandler!: (contents: unknown, permission: string) => boolean
    const browserSession = {
      getUserAgent: vi.fn(() => 'Chrome Electron/1 Forge/1'),
      setUserAgent: vi.fn(),
      setPermissionRequestHandler: vi.fn((handler) => { permissionRequestHandler = handler }),
      setPermissionCheckHandler: vi.fn((handler) => { permissionCheckHandler = handler }),
      clearStorageData: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
    }
    vi.mocked(electronSession.fromPartition).mockReturnValue(browserSession as never)
    const registry = new subject.BrowserSessionRegistry()
    const first = registry.getSession('profile-one')
    expect(registry.getSession('profile-one')).toBe(first)
    expect(electronSession.fromPartition).toHaveBeenCalledOnce()
    expect(browserSession.setUserAgent).toHaveBeenCalledWith('Chrome')

    const callback = vi.fn()
    permissionRequestHandler({}, 'notifications', callback)
    permissionRequestHandler({}, 'media', callback)
    expect(callback.mock.calls.map(([allowed]) => allowed)).toEqual([true, false])
    expect(permissionCheckHandler({}, 'geolocation')).toBe(true)
    expect(permissionCheckHandler({}, 'media')).toBe(false)

    await registry.clear()
    expect(browserSession.clearStorageData).toHaveBeenCalledWith({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers'] })
    expect(browserSession.clearCache).toHaveBeenCalledOnce()
  })

  it('allows exactly the T3 parity permission set', () => {
    expect([...subject.ALLOWED_BROWSER_PERMISSIONS].sort()).toEqual([
      'clipboard-read', 'clipboard-sanitized-write', 'geolocation', 'notifications',
    ])
    expect(subject.ALLOWED_BROWSER_PERMISSIONS.has('media')).toBe(false)
  })
})
