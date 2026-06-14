/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactsSidebar } from './ArtifactsSidebar'

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
  vi.unstubAllGlobals()
})

describe('ArtifactsSidebar controlled tab', () => {
  it('reflects parent-provided activeTab for schedules', () => {
    act(() => {
      root = createRoot(container)
      root.render(
        createElement(ArtifactsSidebar, {
          wsUrl: 'ws://127.0.0.1:47187',
          managerId: 'manager-1',
          artifacts: [],
          isOpen: true,
          onClose: () => {},
          onArtifactClick: () => {},
          activeTab: 'schedules',
          onActiveTabChange: () => {},
        }),
      )
    })

    const activeTrigger = container.querySelector(
      '[data-slot="tabs-trigger"][data-state="active"]',
    )
    expect(activeTrigger?.textContent).toBe('Schedules')
  })

  it('uses a single selected-surface title in desktop rail mode', () => {
    act(() => {
      root = createRoot(container)
      root.render(
        createElement(ArtifactsSidebar, {
          wsUrl: 'ws://127.0.0.1:47187',
          managerId: 'manager-1',
          artifacts: [],
          isOpen: true,
          onClose: () => {},
          onArtifactClick: () => {},
          activeTab: 'schedules',
          onActiveTabChange: () => {},
          panelMode: 'rail-selected',
        }),
      )
    })

    expect(container.querySelector('[data-slot="tabs-list"]')).toBeNull()
    expect(container.querySelector('h2')?.textContent).toBe('Cron / Schedules')
    expect(container.textContent).not.toContain('ArtifactsSchedules')
  })

  it('places the resize handle after the pane for left rail layout', () => {
    act(() => {
      root = createRoot(container)
      root.render(
        createElement(ArtifactsSidebar, {
          wsUrl: 'ws://127.0.0.1:47187',
          managerId: 'manager-1',
          artifacts: [],
          isOpen: true,
          onClose: () => {},
          onArtifactClick: () => {},
          activeTab: 'artifacts',
          onActiveTabChange: () => {},
          panelMode: 'rail-selected',
          desktopPlacement: 'left',
          desktopOnly: true,
        }),
      )
    })

    const pane = container.querySelector('[aria-label="Artifacts panel"]')
    const resizeHandle = pane?.nextElementSibling
    expect(pane?.className).toContain('md:border-r')
    expect(pane?.className).toContain('max-md:hidden')
    expect(resizeHandle?.className).toContain('cursor-col-resize')
  })

  it('keeps tabs available in rail mode on mobile where the rail is hidden', () => {
    const mediaQuery = {
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    vi.stubGlobal('matchMedia', vi.fn(() => mediaQuery))

    act(() => {
      root = createRoot(container)
      root.render(
        createElement(ArtifactsSidebar, {
          wsUrl: 'ws://127.0.0.1:47187',
          managerId: 'manager-1',
          artifacts: [],
          isOpen: true,
          onClose: () => {},
          onArtifactClick: () => {},
          activeTab: 'schedules',
          onActiveTabChange: () => {},
          panelMode: 'rail-selected',
        }),
      )
    })

    expect(container.querySelector('[data-slot="tabs-list"]')).not.toBeNull()
    expect(container.textContent).toContain('Artifacts')
    expect(container.textContent).toContain('Schedules')
  })
})
