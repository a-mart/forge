/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest'
import {
  APPEARANCE_TEMPLATES,
  THEME_INIT_SCRIPT,
  applyAppearanceConfig,
  getContrastRatio,
  getDefaultAppearanceConfig,
  normalizeAppearanceConfig,
  readStoredAppearanceConfig,
  resolveAppearanceCssVariables,
} from './theme'

const STORAGE_KEY = 'swarm-theme'

afterEach(() => {
  window.localStorage.clear()
  document.documentElement.className = ''
  document.documentElement.removeAttribute('style')
})

describe('appearance theme storage', () => {
  it('reads legacy swarm-theme string preferences without custom appearance', () => {
    window.localStorage.setItem(STORAGE_KEY, 'dark')

    expect(readStoredAppearanceConfig()).toEqual({
      ...getDefaultAppearanceConfig(),
      mode: 'dark',
      customApplied: false,
    })
  })

  it('falls back to defaults for invalid JSON', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not-json')

    expect(readStoredAppearanceConfig()).toEqual(getDefaultAppearanceConfig())
  })

  it('sanitizes invalid colors and non-whitelisted fonts', () => {
    const normalized = normalizeAppearanceConfig({
      version: 1,
      mode: 'dark',
      accentColor: 'red',
      backgroundColor: '#12345',
      foregroundColor: '#abcdef',
      uiFont: 'https://fonts.example/remote',
      codeFont: 'evil-mono',
      templateId: 'unknown-template',
      customApplied: true,
    })

    expect(normalized).toEqual({
      ...getDefaultAppearanceConfig(),
      mode: 'dark',
      foregroundColor: '#abcdef',
      customApplied: true,
    })
  })

  it('does not apply theme mode or custom CSS variables for pre-Apply migrated JSON', () => {
    applyAppearanceConfig({
      version: 1,
      mode: 'dark',
      accentColor: '#14b8a6',
      backgroundColor: '#ecfeff',
      foregroundColor: '#083344',
      uiFont: 'system',
      codeFont: 'system-mono',
      templateId: 'aurora',
      customApplied: false,
    })

    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--app-font-sans')).toBe('')
  })

  it('startup init ignores pre-Apply migrated JSON mode and variables', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      mode: 'dark',
      accentColor: '#14b8a6',
      backgroundColor: '#ecfeff',
      foregroundColor: '#083344',
      uiFont: 'system',
      codeFont: 'system-mono',
      templateId: 'aurora',
    }))

    Function(THEME_INIT_SCRIPT)()

    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--app-font-sans')).toBe('')
  })

  it('persists versioned applied config and applies only safe CSS variables', () => {
    applyAppearanceConfig({
      version: 1,
      mode: 'light',
      accentColor: '#14b8a6',
      backgroundColor: '#ecfeff',
      foregroundColor: '#083344',
      uiFont: 'system',
      codeFont: 'system-mono',
      templateId: 'aurora',
      customApplied: true,
    })

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(stored).toMatchObject({
      version: 1,
      mode: 'light',
      accentColor: '#14b8a6',
      uiFont: 'system',
      codeFont: 'system-mono',
      templateId: 'aurora',
      customApplied: true,
    })
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#14b8a6')
    expect(document.documentElement.style.getPropertyValue('--app-font-sans')).toContain('system-ui')
    expect(document.documentElement.style.getPropertyValue('--app-font-mono')).toContain('ui-monospace')
  })

  it('derives readable primary foreground contrast for every template', () => {
    for (const template of APPEARANCE_TEMPLATES) {
      const config = normalizeAppearanceConfig({
        ...getDefaultAppearanceConfig(),
        ...template,
        templateId: template.id,
        mode: template.preferredMode ?? 'light',
        customApplied: true,
      })
      const lightVars = resolveAppearanceCssVariables(config, false)
      const darkVars = resolveAppearanceCssVariables(config, true)

      expect(getContrastRatio(lightVars['--primary-foreground'], lightVars['--primary'])).toBeGreaterThanOrEqual(4.5)
      expect(getContrastRatio(darkVars['--primary-foreground'], darkVars['--primary'])).toBeGreaterThanOrEqual(4.5)
    }
  })
})
