import { describe, expect, it } from 'vitest'
import { isDockManagedBrowserShortcut, isManagedBrowserPopoutAvailable } from '../managed-browser-platform.js'

describe('Managed Browser desktop platform behavior', () => {
  it.each(['darwin', 'win32', 'linux'] as const)('enables native pop-out on %s', (platform) => {
    expect(isManagedBrowserPopoutAvailable(platform)).toBe(true)
  })

  it('does not claim support for an unqualified Electron platform', () => {
    expect(isManagedBrowserPopoutAvailable('freebsd')).toBe(false)
  })

  it.each([
    ['darwin', { meta: true }],
    ['win32', { control: true }],
    ['linux', { control: true }],
  ] as const)('docks with the native close shortcut on %s', (platform, modifier) => {
    expect(isDockManagedBrowserShortcut({ type: 'keyDown', key: 'w', ...modifier }, platform)).toBe(true)
  })

  it.each([
    ['darwin', { control: true }],
    ['win32', { meta: true }],
    ['linux', { meta: true }],
  ] as const)('rejects the wrong close modifier on %s', (platform, modifier) => {
    expect(isDockManagedBrowserShortcut({ type: 'keyDown', key: 'w', ...modifier }, platform)).toBe(false)
  })

  it('does not consume modified or key-up variants', () => {
    expect(isDockManagedBrowserShortcut({ type: 'keyDown', key: 'w', control: true, shift: true }, 'win32')).toBe(false)
    expect(isDockManagedBrowserShortcut({ type: 'keyUp', key: 'w', control: true }, 'linux')).toBe(false)
  })
})
