import { describe, expect, it } from 'vitest'
import { resolveSessionSwitchSnapshotCacheEnabled } from './conversation-snapshot-cache-gate'

describe('session switch snapshot cache gate', () => {
  it('fails closed unless the build value is exactly true', () => {
    expect(resolveSessionSwitchSnapshotCacheEnabled('true')).toBe(true)
    expect(resolveSessionSwitchSnapshotCacheEnabled('TRUE')).toBe(false)
    expect(resolveSessionSwitchSnapshotCacheEnabled('1')).toBe(false)
    expect(resolveSessionSwitchSnapshotCacheEnabled(undefined)).toBe(false)
    expect(resolveSessionSwitchSnapshotCacheEnabled(true)).toBe(false)
  })
})
