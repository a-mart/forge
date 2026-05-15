import { describe, expect, it } from 'vitest'
import { buildSkillImportRouteUrl, findSkillImportUrlInArgs, parseSkillImportDeepLink } from '../deep-link.js'

describe('skill import deep links', () => {
  it('extracts an HTTPS share URL from forge://skill-import links', () => {
    const result = parseSkillImportDeepLink('forge://skill-import?url=https%3A%2F%2Fforgeskills.radops.ai%2Fs%2Ftoken%23ignored')

    expect(result).toBe('https://forgeskills.radops.ai/s/token')
  })

  it('allows IPv6 localhost share URLs for development deep links', () => {
    const result = parseSkillImportDeepLink('forge://skill-import?url=http%3A%2F%2F%5B%3A%3A1%5D%3A8787%2Fs%2Ftoken')

    expect(result).toBe('http://[::1]:8787/s/token')
  })

  it('rejects unsupported actions and unsafe embedded URLs', () => {
    expect(parseSkillImportDeepLink('forge://settings?url=https%3A%2F%2Fforgeskills.radops.ai%2Fs%2Ftoken')).toBeNull()
    expect(parseSkillImportDeepLink('forge://skill-import?url=file%3A%2F%2F%2Ftmp%2Fskill.json')).toBeNull()
    expect(parseSkillImportDeepLink('not a url')).toBeNull()
  })

  it('finds deep links in platform argv arrays', () => {
    expect(findSkillImportUrlInArgs([
      '/Applications/Forge.app/Contents/MacOS/Forge',
      'forge://skill-import?url=https%3A%2F%2Fforgeskills.radops.ai%2Fs%2Ftoken',
    ])).toBe('https://forgeskills.radops.ai/s/token')
  })

  it('builds a safe renderer settings route instead of navigating to the share URL', () => {
    const result = buildSkillImportRouteUrl('app://forge/index.html', 'https://forgeskills.radops.ai/s/token')

    expect(result).toBe('app://forge/index.html?view=settings&settingsTab=skills&skillImportUrl=https%3A%2F%2Fforgeskills.radops.ai%2Fs%2Ftoken')
  })
})
