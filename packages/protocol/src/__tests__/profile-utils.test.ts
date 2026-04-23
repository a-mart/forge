import { describe, expect, it } from 'vitest'
import { isSystemProfile, type ManagerProfile } from '../index.js'

function createProfile(overrides: Partial<ManagerProfile> = {}): ManagerProfile {
  return {
    profileId: overrides.profileId ?? 'alpha',
    displayName: overrides.displayName ?? 'Alpha',
    defaultSessionAgentId: overrides.defaultSessionAgentId ?? 'alpha',
    createdAt: overrides.createdAt ?? '2026-04-14T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-14T00:00:00.000Z',
    ...(overrides.profileType ? { profileType: overrides.profileType } : {}),
    ...(overrides.sortOrder !== undefined ? { sortOrder: overrides.sortOrder } : {}),
  }
}

describe('profile-utils', () => {
  it('treats profiles without profileType as user profiles', () => {
    expect(isSystemProfile(createProfile())).toBe(false)
    expect(isSystemProfile(createProfile({ profileType: 'user' }))).toBe(false)
  })

  it('identifies system profiles', () => {
    expect(isSystemProfile(createProfile({ profileId: 'cortex', profileType: 'system' }))).toBe(true)
  })
})
