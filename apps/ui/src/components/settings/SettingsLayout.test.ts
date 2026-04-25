/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Minimal mock for HelpTrigger
vi.mock('@/components/help/HelpTrigger', () => ({
  HelpTrigger: () => createElement('span', { 'data-testid': 'help-trigger' }),
}))

const { SettingsLayout } = await import('./SettingsLayout')
import type { SettingsTab } from './settings-target'

const COLLAB_TABS = await import('./settings-target').then(mod => {
  const target = mod.createCollabSettingsTarget('wss://collab.example.com')
  return target.availableTabs
})

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
})

function renderLayout(props: {
  activeTab?: SettingsTab
  onTabChange?: (tab: SettingsTab) => void
  availableTabs?: SettingsTab[]
  targetLabel?: string
}) {
  root = createRoot(container)
  flushSync(() => {
    root?.render(
      createElement(SettingsLayout, {
        activeTab: props.activeTab ?? 'general',
        onTabChange: props.onTabChange ?? vi.fn(),
        availableTabs: props.availableTabs,
        targetLabel: props.targetLabel,
        children: createElement('div', { 'data-testid': 'content' }, 'Content'),
      }),
    )
  })
}

describe('SettingsLayout', () => {
  it('shows all tabs when availableTabs is omitted', () => {
    renderLayout({})

    // Desktop nav should have 12 items (all tabs)
    const desktopNav = container.querySelector('nav.hidden')
    const buttons = desktopNav?.querySelectorAll('button') ?? []
    expect(buttons.length).toBe(12)
  })

  it('filters tabs to only availableTabs when provided', () => {
    renderLayout({ availableTabs: COLLAB_TABS })

    // Collab tabs exclude 'notifications' — should have 11 items
    const desktopNav = container.querySelector('nav.hidden')
    const buttons = desktopNav?.querySelectorAll('button') ?? []
    expect(buttons.length).toBe(11)

    // Notifications should not be present
    const labels = Array.from(buttons).map(btn => btn.textContent?.trim())
    expect(labels).not.toContain('Notifications')
    expect(labels).toContain('General')
    expect(labels).toContain('Authentication')
    expect(labels).toContain('About')
  })

  it('renders target badge when targetLabel is provided', () => {
    renderLayout({ targetLabel: 'Collab backend' })

    // The badge should be visible in the header
    const header = container.querySelector('header')
    expect(header?.textContent).toContain('Collab backend')
  })

  it('does not render target badge when targetLabel is omitted', () => {
    renderLayout({})

    const header = container.querySelector('header')
    // Should have "Settings" but no badge text
    expect(header?.textContent).toContain('Settings')
    expect(header?.textContent).not.toContain('Builder backend')
    expect(header?.textContent).not.toContain('Collab backend')
  })

  it('mobile nav also filters tabs', () => {
    renderLayout({ availableTabs: ['general', 'auth', 'about'] as SettingsTab[] })

    // Mobile nav is the first nav (without .hidden class)
    const mobileNav = container.querySelector('nav:not(.hidden)')
    const buttons = mobileNav?.querySelectorAll('button') ?? []
    expect(buttons.length).toBe(3)
  })
})
