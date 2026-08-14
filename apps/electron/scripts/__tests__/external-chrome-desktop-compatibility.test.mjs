import { describe, expect, it } from 'vitest'
import { desktopCompatibilityFromVersion } from '../external-chrome-desktop-compatibility.mjs'

describe('External Chrome Desktop compatibility policy', () => {
  it('derives the current Desktop major/minor range instead of a stale fixed cap', () => {
    expect(desktopCompatibilityFromVersion('0.23.0')).toEqual({ min: '0.23.0', max: '0.23.999' })
    expect(desktopCompatibilityFromVersion('0.23.0-beta.1')).toEqual({ min: '0.23.0', max: '0.23.999' })
    expect(desktopCompatibilityFromVersion('0.22.0-beta.6')).toEqual({ min: '0.22.0', max: '0.22.999' })
    expect(desktopCompatibilityFromVersion('1.0.4')).toEqual({ min: '1.0.0', max: '1.0.999' })
  })

  it('rejects versions that cannot identify an intended Desktop major/minor', () => {
    expect(() => desktopCompatibilityFromVersion('')).toThrow('requires a Desktop version')
    expect(() => desktopCompatibilityFromVersion('not-a-version')).toThrow('cannot parse Desktop version')
    expect(() => desktopCompatibilityFromVersion('v0.23.0')).toThrow('cannot parse Desktop version')
  })
})
