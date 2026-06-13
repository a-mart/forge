/** @vitest-environment jsdom */

import { fireEvent } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsAppearance } from './SettingsAppearance'
import { getContrastRatio, normalizeAppearanceConfig, resolveAppearanceCssVariables } from '@/lib/theme'

const STORAGE_KEY = 'swarm-theme'

let container: HTMLDivElement
let root: Root | null = null

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
  window.localStorage.clear()
  document.documentElement.className = ''
  document.documentElement.removeAttribute('style')
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
  window.localStorage.clear()
  document.documentElement.className = ''
  document.documentElement.removeAttribute('style')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderAppearance(): void {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(SettingsAppearance))
  })
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label),
  )
  expect(button).toBeTruthy()
  return button as HTMLButtonElement
}

function clickButton(label: string): void {
  fireEvent.click(findButton(label))
  flushSync(() => {})
}

function readStored(): Record<string, string | boolean | number> {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
}

function stubPrefersDark(matches: boolean): void {
  vi.stubGlobal('matchMedia', () => ({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
}

function rgbString(hex: string): string {
  const value = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16))
  return `rgb(${r}, ${g}, ${b})`
}

function findPreviewShell(): HTMLElement {
  const title = Array.from(container.querySelectorAll('div')).find((element) =>
    element.textContent === 'Forge workspace',
  )
  expect(title).toBeTruthy()
  const shell = title?.parentElement?.parentElement?.parentElement
  expect(shell).toBeTruthy()
  return shell as HTMLElement
}

describe('SettingsAppearance', () => {
  it('keeps legacy mode-only preferences as mode-only and not applyable custom appearance', () => {
    window.localStorage.setItem(STORAGE_KEY, 'dark')

    renderAppearance()

    const applyButton = findButton('Apply appearance')
    expect(applyButton.disabled).toBe(true)
    expect(container.textContent).toContain('Forge default colors; dark mode is active.')
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('')
  })

  it('applies mode-only changes without generating a custom palette', () => {
    renderAppearance()

    clickButton('Dark')
    expect(container.textContent).toContain('You have unapplied draft changes.')

    clickButton('Apply appearance')

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--app-font-sans')).toBe('')
    expect(container.textContent).toContain('Forge default colors; dark mode is active.')
    expect(container.textContent).not.toContain('Custom appearance is applied.')
    expect(findButton('Apply appearance').disabled).toBe(true)
  })

  it('keeps template selections as draft until Apply is clicked', () => {
    renderAppearance()

    clickButton('Aurora Glass')

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('')
    expect(container.textContent).toContain('You have unapplied draft changes.')
    expect(container.textContent).toContain('--accent: #14b8a6')

    clickButton('Apply appearance')

    const stored = readStored()
    expect(stored.templateId).toBe('aurora')
    expect(stored.customApplied).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#14b8a6')
  })

  it('edits hex color values with validation before applying', () => {
    renderAppearance()

    const accentInput = container.querySelector('input[aria-label="Accent hex value"]') as HTMLInputElement | null
    expect(accentInput).toBeTruthy()

    fireEvent.change(accentInput!, { target: { value: '14B8A6' } })
    flushSync(() => {})

    expect(container.textContent).toContain('--accent: #14b8a6')
    expect(container.textContent).toContain('You have unapplied draft changes.')

    fireEvent.change(accentInput!, { target: { value: '#12zzzz' } })
    flushSync(() => {})

    expect(accentInput?.getAttribute('aria-invalid')).toBe('true')
    expect(container.textContent).toContain('Enter a 6-digit hex color.')
    expect(container.textContent).toContain('--accent: #14b8a6')

    clickButton('Apply appearance')
    const stored = readStored()
    expect(stored.accentColor).toBe('#14b8a6')
    expect(stored.customApplied).toBe(true)
  })

  it('randomizes the draft without applying globally and keeps readable contrast', () => {
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.8)
      .mockReturnValueOnce(0.2)
      .mockReturnValueOnce(0.4)
      .mockReturnValueOnce(0.6)
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.7)
      .mockReturnValueOnce(0.3)
      .mockReturnValueOnce(0.9)
      .mockReturnValueOnce(0.5)
      .mockReturnValue(0.42)

    renderAppearance()
    clickButton('Randomize draft')

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('')
    expect(container.textContent).toContain('You have unapplied draft changes.')

    clickButton('Apply appearance')
    const stored = readStored()
    expect(stored.customApplied).toBe(true)
    expect(typeof stored.accentColor).toBe('string')
    expect(getContrastRatio(stored.foregroundColor as string, stored.backgroundColor as string)).toBeGreaterThanOrEqual(7)

    const appliedVars = resolveAppearanceCssVariables(normalizeAppearanceConfig(stored), stored.mode === 'dark')
    expect(getContrastRatio(appliedVars['--primary-foreground'], appliedVars['--primary'])).toBeGreaterThanOrEqual(4.5)
  })

  it('previews Original Forge system mode with matchMedia instead of stale applied DOM dark class', () => {
    stubPrefersDark(false)
    renderAppearance()
    clickButton('Terminal Lime')
    clickButton('Apply appearance')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    clickButton('Original Forge')

    const lightDefaultBackground = resolveAppearanceCssVariables(
      { ...normalizeAppearanceConfig({}), customApplied: true },
      false,
    )['--background']
    expect(findPreviewShell().style.backgroundColor).toBe(rgbString(lightDefaultBackground))
  })

  it('applying Original Forge after a custom dark template restores true defaults', () => {
    renderAppearance()
    clickButton('Terminal Lime')
    clickButton('Apply appearance')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--primary')).not.toBe('')

    clickButton('Original Forge')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--primary')).not.toBe('')

    clickButton('Apply appearance')

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('')
  })

  it('reset defaults clears custom app variables, persisted custom state, and stale dark mode', () => {
    renderAppearance()
    clickButton('Terminal Lime')
    clickButton('Apply appearance')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--primary')).not.toBe('')

    clickButton('Reset defaults')

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('')
  })
})
