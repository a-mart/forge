/** @vitest-environment jsdom */

import { fireEvent } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsAppearance } from './SettingsAppearance'
import { getContrastRatio, getDefaultAppearanceConfig, normalizeAppearanceConfig, resolveAppearanceCssVariables } from '@/lib/theme'

const STORAGE_KEY = 'swarm-theme'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
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

describe('SettingsAppearance', () => {
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

  it('reset defaults clears custom app variables, persisted custom state, and stale dark mode', () => {
    renderAppearance()
    clickButton('Terminal Lime')
    clickButton('Apply appearance')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--primary')).not.toBe('')

    clickButton('Reset defaults')

    const defaults = getDefaultAppearanceConfig()
    const stored = readStored()
    expect(stored.templateId).toBe(defaults.templateId)
    expect(stored.accentColor).toBe(defaults.accentColor)
    expect(stored.customApplied).toBe(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('')
  })
})
