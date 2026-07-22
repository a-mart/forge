import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ session: { fromPartition: vi.fn() } }))

let subject: typeof import('../browser-session.js')
beforeAll(async () => { subject = await import('../browser-session.js') })

describe('browser profile sessions', () => {
  it('derives stable isolated persistent partitions', () => {
    const one = subject.browserPartitionForProfile('profile-one')
    expect(one).toMatch(/^persist:forge-browser-[a-f0-9]{20}$/)
    expect(subject.browserPartitionForProfile('profile-one')).toBe(one)
    expect(subject.browserPartitionForProfile('profile-two')).not.toBe(one)
    expect(subject.isBrowserPartition(one)).toBe(true)
    expect(subject.isBrowserPartition('persist:other')).toBe(false)
  })

  it('removes Electron and Forge product tokens from user agents', () => {
    expect(subject.sanitizeBrowserUserAgent('Mozilla/5.0 Electron/37.10.3 Chrome/138 Forge/0.22.0 Safari/537.36'))
      .toBe('Mozilla/5.0 Chrome/138 Safari/537.36')
  })

  it('allows exactly the T3 parity permission set', () => {
    expect([...subject.ALLOWED_BROWSER_PERMISSIONS].sort()).toEqual([
      'clipboard-read', 'clipboard-sanitized-write', 'geolocation', 'notifications',
    ])
    expect(subject.ALLOWED_BROWSER_PERMISSIONS.has('media')).toBe(false)
  })
})
