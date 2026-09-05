import { describe, expect, expectTypeOf, it } from 'vitest'
import type { AgentDescriptor, ManagerProfile } from '../agents.js'
import { isContextMode, resolveContextMode, type ContextMode } from '../context-mode.js'

describe('context mode policy', () => {
  it('preserves summary as the default and supports both override directions', () => {
    expect(resolveContextMode(undefined, undefined)).toBe('summary')
    expect(resolveContextMode('fresh', undefined)).toBe('fresh')
    expect(resolveContextMode('fresh', 'summary')).toBe('summary')
    expect(resolveContextMode('summary', 'fresh')).toBe('fresh')
  })
  it('recognizes only explicitly supported modes', () => {
    expect(isContextMode('summary')).toBe(true)
    expect(isContextMode('fresh')).toBe(true)
    for (const value of [undefined, null, '', 'auto', {}, 1]) expect(isContextMode(value)).toBe(false)
  })
  it('keeps project default and manager-session override optional on descriptors', () => {
    expectTypeOf<ManagerProfile['defaultContextMode']>().toEqualTypeOf<ContextMode | undefined>()
    expectTypeOf<AgentDescriptor['contextModeOverride']>().toEqualTypeOf<ContextMode | undefined>()
  })
})
