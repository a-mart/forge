/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APPEARANCE_TEMPLATES,
  THEME_INIT_SCRIPT,
  applyAppearanceConfig,
  getContrastRatio,
  getDefaultAppearanceConfig,
  hasDefaultAppearanceValues,
  initializeThemePreference,
  normalizeAppearanceConfig,
  readStoredAppearanceConfig,
  resolveAppearanceCssVariables,
} from './theme'

const STORAGE_KEY = 'swarm-theme'

function installMockLocalStorage(): void {
  const store = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => store.set(key, value)),
      removeItem: vi.fn((key: string) => store.delete(key)),
      clear: vi.fn(() => store.clear()),
    },
  })
}

beforeEach(() => {
  installMockLocalStorage()
})

afterEach(() => {
  window.localStorage.clear()
  document.documentElement.className = ''
  document.documentElement.removeAttribute('style')
  vi.unstubAllGlobals()
})

describe('appearance theme storage', () => {
  it('exposes exactly the supported appearance templates', () => {
    expect(APPEARANCE_TEMPLATES.map((template) => template.name)).toEqual([
      'Original Forge',
      'Aurora Glass',
      'Midnight Forge',
      'Terminal Lime',
      'Sakura Dawn',
      'Desert Ember',
    ])
  })

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

  it('migrates stored default-valued applied config to true defaults', () => {
    const storedDefaults = { ...getDefaultAppearanceConfig(), customApplied: true }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(storedDefaults))

    expect(hasDefaultAppearanceValues(normalizeAppearanceConfig(storedDefaults))).toBe(true)
    expect(readStoredAppearanceConfig()).toEqual(getDefaultAppearanceConfig())
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(storedDefaults))
    Function(THEME_INIT_SCRIPT)()

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('')
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

  it('ignores stale pre-Apply JSON values and keeps true defaults', () => {
    const staleDraft = {
      version: 1,
      mode: 'dark',
      accentColor: '#14b8a6',
      backgroundColor: '#ecfeff',
      foregroundColor: '#083344',
      uiFont: 'geist',
      codeFont: 'geist-mono',
      templateId: 'aurora',
      customApplied: false,
    } as const

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(staleDraft))
    expect(readStoredAppearanceConfig()).toEqual(getDefaultAppearanceConfig())
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()

    applyAppearanceConfig(staleDraft)

    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--app-font-sans')).toBe('')
  })

  it('startup init ignores stale draft JSON but still applies default auto dark startup', () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      mode: 'dark',
      accentColor: '#14b8a6',
      backgroundColor: '#ecfeff',
      foregroundColor: '#083344',
      uiFont: 'geist',
      codeFont: 'geist-mono',
      templateId: 'aurora',
      customApplied: false,
    }))

    Function(THEME_INIT_SCRIPT)()

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--app-font-sans')).toBe('')

    document.documentElement.className = ''
    document.documentElement.removeAttribute('style')
    initializeThemePreference()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--app-font-sans')).toBe('')
  })

  it('restores true no-storage default startup behavior for Original Forge/defaults', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      mode: 'dark',
      accentColor: '#84cc16',
      backgroundColor: '#f7fee7',
      foregroundColor: '#1a2e05',
      uiFont: 'system',
      codeFont: 'system-mono',
      templateId: 'terminal',
      customApplied: true,
    }))
    applyAppearanceConfig(getDefaultAppearanceConfig(), { applyModeWhenCustomDisabled: true })
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()

    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))

    document.documentElement.className = ''
    document.documentElement.removeAttribute('style')
    Function(THEME_INIT_SCRIPT)()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('')

    document.documentElement.className = ''
    document.documentElement.removeAttribute('style')
    initializeThemePreference()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('')
  })

  it('keeps startup init and runtime init aligned for invalid applied fields', () => {
    const invalidAppliedConfig = {
      version: 1,
      mode: 'dark',
      accentColor: '#14b8a6',
      backgroundColor: '#ecfeff',
      foregroundColor: '#083344',
      uiFont: 'remote-font-url',
      codeFont: 'evil-mono',
      templateId: 'unknown-template',
      customApplied: true,
    }

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(invalidAppliedConfig))
    Function(THEME_INIT_SCRIPT)()
    const startupState = {
      isDark: document.documentElement.classList.contains('dark'),
      primary: document.documentElement.style.getPropertyValue('--primary'),
      fontSans: document.documentElement.style.getPropertyValue('--app-font-sans'),
      fontMono: document.documentElement.style.getPropertyValue('--app-font-mono'),
    }

    document.documentElement.className = ''
    document.documentElement.removeAttribute('style')
    initializeThemePreference()

    expect({
      isDark: document.documentElement.classList.contains('dark'),
      primary: document.documentElement.style.getPropertyValue('--primary'),
      fontSans: document.documentElement.style.getPropertyValue('--app-font-sans'),
      fontMono: document.documentElement.style.getPropertyValue('--app-font-mono'),
    }).toEqual(startupState)
    expect(startupState).toMatchObject({
      isDark: true,
      primary: '#3ec5b6',
      fontSans: expect.stringContaining('system-ui'),
      fontMono: expect.stringContaining('ui-monospace'),
    })
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

  it('derives readable template text contrast pairs for every template', () => {
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

      for (const vars of [lightVars, darkVars]) {
        expect(getContrastRatio(vars['--primary-foreground'], vars['--primary'])).toBeGreaterThanOrEqual(4.5)
        expect(getContrastRatio(vars['--secondary-foreground'], vars['--secondary'])).toBeGreaterThanOrEqual(4.5)
        expect(getContrastRatio(vars['--muted-foreground'], vars['--muted'])).toBeGreaterThanOrEqual(4.5)
        expect(getContrastRatio(vars['--accent-foreground'], vars['--accent'])).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
