import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { browserPartitionForProfile } from '../browser-session.js'
import { enforceBrowserWebviewAttachment } from '../browser-webview-security.js'

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
})
