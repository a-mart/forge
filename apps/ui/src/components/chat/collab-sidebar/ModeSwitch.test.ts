/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  reportBuilderConnected,
  reportCollabConnected,
  markCollabInactive,
  _resetForTesting,
} from '@/lib/connection-health-store'
import { ModeSwitch } from './ModeSwitch'
import type { ActiveSurface } from '@/hooks/index-page/use-route-state'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  _resetForTesting()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  root.unmount()
  document.body.removeChild(container)
})

function render(activeSurface: ActiveSurface = 'builder', onSelectSurface = vi.fn()) {
  flushSync(() => {
    root.render(
      createElement(ModeSwitch, {
        activeSurface,
        onSelectSurface,
      }),
    )
  })
}

function getDots(): HTMLElement[] {
  return Array.from(container.querySelectorAll('[role="status"]'))
}

function getButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'))
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('ModeSwitch', () => {
  it('renders builder and collab buttons', () => {
    render()
    const buttons = getButtons()
    expect(buttons).toHaveLength(2)
    expect(buttons[0].textContent).toContain('builder')
    expect(buttons[1].textContent).toContain('collab')
  })

  it('renders a health dot inside each button', () => {
    render()
    const dots = getDots()
    expect(dots).toHaveLength(2)
    const buttons = getButtons()
    expect(buttons[0].contains(dots[0])).toBe(true)
    expect(buttons[1].contains(dots[1])).toBe(true)
  })

  it('marks the active surface button as pressed', () => {
    render('collab')
    const buttons = getButtons()
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false')
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true')
  })

  // ---------------------------------------------------------------------------
  // Health dot colors
  // ---------------------------------------------------------------------------

  it('shows gray dots when both are disconnected (default)', () => {
    render()
    const dots = getDots()
    for (const dot of dots) {
      expect(dot.className).toContain('bg-muted-foreground/40')
    }
  })

  it('shows green dot for connected builder', () => {
    flushSync(() => reportBuilderConnected(true))
    render()
    const dots = getDots()
    expect(dots[0].className).toContain('bg-emerald-500')
    expect(dots[1].className).toContain('bg-muted-foreground/40')
  })

  it('shows green dot for connected collab', () => {
    flushSync(() => reportCollabConnected(true))
    render()
    const dots = getDots()
    expect(dots[0].className).toContain('bg-muted-foreground/40')
    expect(dots[1].className).toContain('bg-emerald-500')
  })

  it('shows amber dot for reconnecting (connect then disconnect)', () => {
    flushSync(() => {
      reportBuilderConnected(true)
      reportBuilderConnected(false)
    })
    render()
    const dots = getDots()
    expect(dots[0].className).toContain('bg-amber-500')
  })

  it('shows gray after markInactive, not stale green', () => {
    flushSync(() => {
      reportCollabConnected(true)
      markCollabInactive()
    })
    render()
    const dots = getDots()
    expect(dots[1].className).toContain('bg-muted-foreground/40')
  })

  it('shows correct dots when builder connected + collab connected', () => {
    flushSync(() => {
      reportBuilderConnected(true)
      reportCollabConnected(true)
    })
    render()
    const dots = getDots()
    expect(dots[0].className).toContain('bg-emerald-500')
    expect(dots[1].className).toContain('bg-emerald-500')
  })

  // ---------------------------------------------------------------------------
  // Active tab styling does not affect the other dot
  // ---------------------------------------------------------------------------

  it('preserves collab dot color when builder is the active tab', () => {
    flushSync(() => {
      reportBuilderConnected(true)
      reportCollabConnected(true)
    })
    render('builder')
    const dots = getDots()
    expect(dots[0].className).toContain('bg-emerald-500')
    expect(dots[1].className).toContain('bg-emerald-500')
  })

  it('preserves builder dot color when collab is the active tab', () => {
    flushSync(() => {
      reportBuilderConnected(true)
      reportBuilderConnected(false) // reconnecting
      reportCollabConnected(true)
    })
    render('collab')
    const dots = getDots()
    expect(dots[0].className).toContain('bg-amber-500')
    expect(dots[1].className).toContain('bg-emerald-500')
  })

  // ---------------------------------------------------------------------------
  // Accessibility
  // ---------------------------------------------------------------------------

  it('provides aria-label on health dots', () => {
    flushSync(() => {
      reportBuilderConnected(true)
      reportCollabConnected(true)
      reportCollabConnected(false) // reconnecting
    })
    render()
    const dots = getDots()
    expect(dots[0].getAttribute('aria-label')).toBe('builder Connected')
    expect(dots[1].getAttribute('aria-label')).toBe('collab Reconnecting')
  })

  // ---------------------------------------------------------------------------
  // Click behavior
  // ---------------------------------------------------------------------------

  it('calls onSelectSurface when a button is clicked', () => {
    const onSelect = vi.fn()
    render('builder', onSelect)
    const buttons = getButtons()
    buttons[1].click()
    expect(onSelect).toHaveBeenCalledWith('collab')
  })

  // ---------------------------------------------------------------------------
  // Live updates
  // ---------------------------------------------------------------------------

  it('updates dots in response to health changes after mount', () => {
    render()
    let dots = getDots()
    expect(dots[0].className).toContain('bg-muted-foreground/40')

    flushSync(() => reportBuilderConnected(true))
    dots = getDots()
    expect(dots[0].className).toContain('bg-emerald-500')
  })
})
