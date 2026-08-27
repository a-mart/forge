import { describe, expect, it, vi } from 'vitest'
import { secureManagedBrowserWebContents } from '../browser-webview-security.js'

vi.mock('electron', () => ({ session: { fromPartition: vi.fn() } }))

describe('managed browser security', () => {
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
