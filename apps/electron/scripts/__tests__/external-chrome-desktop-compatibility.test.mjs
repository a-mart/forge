import { describe, expect, it } from 'vitest'
import { unusedDesktopCompatibilityMetadata } from '../external-chrome-desktop-compatibility.mjs'

describe('External Chrome Desktop compatibility metadata', () => {
  it('persists unused unbounded Desktop-range metadata instead of app-semver gating', () => {
    expect(unusedDesktopCompatibilityMetadata()).toEqual({ min: '0.0.0', max: '999.999.999' })
  })
})
