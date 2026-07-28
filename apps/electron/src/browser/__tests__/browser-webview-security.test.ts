import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { browserPartitionForProfile } from '../browser-session.js'
import { enforceBrowserWebviewAttachment, secureManagedBrowserWebContents } from '../browser-webview-security.js'

vi.mock('electron', () => ({ session: { fromPartition: vi.fn() } }))

describe('hosted webview security', () => {
  it('rejects non-browser partitions', () => {
    const event = { preventDefault: vi.fn() }
    expect(enforceBrowserWebviewAttachment(event, {}, { partition: 'persist:evil', src: 'https://example.com' }, '/trusted/guest-preload.js')).toBe(false)
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('overrides untrusted preferences and preload', () => {
    const event = { preventDefault: vi.fn() }
    const preferences: Record<string, unknown> = {
      preload: '/evil.js', sandbox: false, contextIsolation: false, nodeIntegration: true,
      nodeIntegrationInSubFrames: true, allowRunningInsecureContent: true, additionalArguments: ['--secret'],
    }
    expect(enforceBrowserWebviewAttachment(event, preferences, {
      partition: browserPartitionForProfile('profile'), src: 'http://127.0.0.1:3000', preload: '/evil.js',
    }, '/trusted/guest-preload.js')).toBe(true)
    expect(preferences).toMatchObject({
      preload: path.resolve('/trusted/guest-preload.js'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false,
    })
    expect(preferences).not.toHaveProperty('additionalArguments')
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('rejects non-HTTP initial guest navigation', () => {
    const event = { preventDefault: vi.fn() }
    expect(enforceBrowserWebviewAttachment(event, {}, { partition: browserPartitionForProfile('profile'), src: 'file:///etc/passwd' }, '/trusted.js')).toBe(false)
  })

  it('enforces navigation and new-window policy on actual managed contents and disposes listeners', async () => {
    const listeners = new Map<string, (event: { preventDefault: () => void }, url: string) => void>()
    let destroyed = false
    const contents = {
      on: vi.fn((event: string, listener: (event: { preventDefault: () => void }, url: string) => void) => listeners.set(event, listener)),
      off: vi.fn((event: string) => listeners.delete(event)),
      setWindowOpenHandler: vi.fn(),
      isDestroyed: vi.fn(() => destroyed),
      loadURL: vi.fn(async () => undefined),
    }
    const dispose = secureManagedBrowserWebContents(contents as never)
    const navigate = listeners.get('will-navigate')!
    const allowed = { preventDefault: vi.fn() }
    navigate(allowed, 'https://example.com')
    expect(allowed.preventDefault).not.toHaveBeenCalled()
    const blocked = { preventDefault: vi.fn() }
    navigate(blocked, 'file:///etc/passwd')
    expect(blocked.preventDefault).toHaveBeenCalledOnce()

    const windowHandler = contents.setWindowOpenHandler.mock.calls[0]![0] as (details: { url: string }) => { action: string }
    expect(windowHandler({ url: 'https://example.com/new' })).toEqual({ action: 'deny' })
    expect(contents.loadURL).toHaveBeenCalledWith('https://example.com/new')
    expect(windowHandler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })
    destroyed = true
    expect(windowHandler({ url: 'https://example.com/destroyed' })).toEqual({ action: 'deny' })
    expect(contents.loadURL).toHaveBeenCalledTimes(1)
    destroyed = false
    dispose()
    expect(contents.off).toHaveBeenCalledWith('will-navigate', navigate)
  })
})
