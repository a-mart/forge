/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionPlanSnapshotEvent } from '@forge/protocol'
import { cn } from '@/lib/utils'
import { PlanDockIndicator } from './PlanDockIndicator'
import {
  CHAT_TRANSCRIPT_SURFACE_ATTR,
  CHAT_TRANSCRIPT_SURFACE_SELECTOR,
  PLAN_DOCK_POPOVER_HEIGHT_CLASS,
  PLAN_DOCK_POPOVER_SCROLL_CLASS,
  PLAN_DOCK_POPOVER_WIDTH_CLASS,
  POPOVER_CONTENT_BASE_WIDTH_CLASS,
  SCROLLBAR_HIDDEN_CLASS,
  planDockPopoverCollisionTopPx,
  planDockPopoverMaxHeightPx,
  workGraphColumnCount,
} from './plan-surface'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver

/** Mirrors `PopoverContent` base classes that compete with dock width overrides. */
const POPOVER_CONTENT_BASE_CLASSES =
  `z-50 ${POPOVER_CONTENT_BASE_WIDTH_CLASS} origin-(--radix-popover-content-transform-origin) rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden`

let root: Root
let container: HTMLDivElement

const snapshot: SessionPlanSnapshotEvent = {
  type: 'session_plan_snapshot',
  sessionAgentId: 'session-1',
  profileId: 'profile-1',
  revision: 2,
  updatedAt: '2026-07-13T00:00:00.000Z',
  plan: [
    { step: 'Inspect behavior', status: 'completed' },
    { step: 'Implement the dock', status: 'in_progress' },
    { step: 'Verify the result', status: 'pending' },
  ],
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('PlanDockIndicator', () => {
  it('shows completed progress rather than the active item ordinal', () => {
    act(() => root.render(createElement(PlanDockIndicator, {
      snapshot: {
        ...snapshot,
        plan: Array.from({ length: 13 }, (_, index) => ({
          step: `Step ${index + 1}`,
          status: index < 11
            ? 'completed' as const
            : index === 12
              ? 'in_progress' as const
              : 'pending' as const,
        })),
      },
    })))

    expect(container.textContent).toContain('11/13 done')
    expect(container.textContent).not.toContain('Step 13/13')
    expect(container.querySelector('button')?.getAttribute('aria-label'))
      .toBe('Open working plan, 11/13 done')
    expect(container.firstElementChild?.className).toBe('relative z-20 h-0 shrink-0')
    expect(container.firstElementChild?.firstElementChild?.className)
      .toBe('absolute inset-x-0 bottom-1 flex justify-center px-3')
  })

  it('shows zero completed progress when no items are done', () => {
    act(() => root.render(createElement(PlanDockIndicator, {
      snapshot: {
        ...snapshot,
        plan: snapshot.plan.map((step, index) => ({
          ...step,
          status: index === 0 ? 'in_progress' as const : 'pending' as const,
        })),
      },
    })))

    expect(container.textContent).toContain('0/3 done')
    expect(container.querySelector('button')?.getAttribute('aria-label'))
      .toBe('Open working plan, 0/3 done')
  })

  it('preserves completed plan labeling and hides when no plan exists', () => {
    act(() => root.render(createElement(PlanDockIndicator, {
      snapshot: {
        ...snapshot,
        plan: snapshot.plan.map((step) => ({ ...step, status: 'completed' as const })),
      },
    })))
    expect(container.textContent).toContain('Plan complete')
    expect(container.querySelector('button')?.getAttribute('aria-label'))
      .toBe('Open working plan, Plan complete')

    act(() => root.render(createElement(PlanDockIndicator, { snapshot: null })))
    expect(container.textContent).toBe('')
  })

  it('resolves the PopoverContent w-72 conflict to the 48rem dock surface width', () => {
    const merged = cn(POPOVER_CONTENT_BASE_CLASSES, PLAN_DOCK_POPOVER_WIDTH_CLASS, 'overflow-hidden p-0')
    expect(merged).toContain(PLAN_DOCK_POPOVER_WIDTH_CLASS)
    expect(merged).toContain('48rem')
    expect(merged).not.toContain(POPOVER_CONTENT_BASE_WIDTH_CLASS)
    expect(merged).not.toContain('24rem')
    expect(merged.split(/\s+/)).not.toContain('w-72')

    expect(workGraphColumnCount(384)).toBe(1)
    expect(workGraphColumnCount(768)).toBe(3)
  })

  it('bounds dock height to the chat transcript surface top, not the window top', () => {
    expect(planDockPopoverCollisionTopPx(128)).toBe(128)
    expect(planDockPopoverCollisionTopPx(-4)).toBe(0)
    expect(planDockPopoverCollisionTopPx(Number.NaN)).toBe(0)
    // Header (~56) + chrome above transcript: available height must exclude that inset.
    expect(planDockPopoverMaxHeightPx({ collisionTop: 96, availableBottom: 700 })).toBe(604)
    expect(planDockPopoverMaxHeightPx({ collisionTop: 96, availableBottom: 90 })).toBe(0)
    expect(planDockPopoverMaxHeightPx({ collisionTop: Number.NaN, availableBottom: 700 })).toBe(0)
    expect(CHAT_TRANSCRIPT_SURFACE_SELECTOR).toBe(`[${CHAT_TRANSCRIPT_SURFACE_ATTR}]`)
  })

  it('applies a measured transcript-top max-height when the landmark is present', async () => {
    const surface = document.createElement('div')
    surface.setAttribute(CHAT_TRANSCRIPT_SURFACE_ATTR, '')
    document.body.appendChild(surface)

    const rectFor = (el: Element, rect: Partial<DOMRect>) => {
      Object.defineProperty(el, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          x: 0,
          y: rect.top ?? 0,
          top: rect.top ?? 0,
          bottom: rect.bottom ?? 0,
          left: rect.left ?? 0,
          right: rect.right ?? 0,
          width: rect.width ?? 0,
          height: rect.height ?? 0,
          toJSON() { return this },
        }),
      })
    }
    rectFor(surface, { top: 120, bottom: 800, height: 680, width: 900 })

    try {
      act(() => root.render(createElement(PlanDockIndicator, {
        snapshot: graphSnapshot(),
      })))

      const trigger = container.querySelector('button')
      expect(trigger).toBeInstanceOf(HTMLButtonElement)
      if (!(trigger instanceof HTMLButtonElement)) return
      rectFor(trigger, { top: 720, bottom: 752, height: 32, width: 96 })

      act(() => trigger.click())
      await act(async () => {
        await Promise.resolve()
      })

      const scrollRegion = document.querySelector('[data-plan-dock-popover-scroll]')
      expect(scrollRegion).toBeInstanceOf(HTMLElement)
      if (!(scrollRegion instanceof HTMLElement)) return

      // availableBottom = trigger.top - sideOffset(8) = 712; collisionTop = 120 → 592
      expect(scrollRegion.style.maxHeight).toBe('592px')
      expect(document.querySelector(CHAT_TRANSCRIPT_SURFACE_SELECTOR)).toBe(surface)
    } finally {
      surface.remove()
    }
  })

  it('opens a full-width non-compact graph capped to Radix available height with hidden scrollbar chrome', () => {
    act(() => root.render(createElement(PlanDockIndicator, {
      snapshot: graphSnapshot(),
    })))

    const trigger = container.querySelector('button')
    act(() => trigger?.click())

    const popover = document.querySelector('[data-slot="popover-content"]')
    const scrollRegion = document.querySelector('[data-plan-dock-popover-scroll]')
    expect(popover).not.toBeNull()
    expect(scrollRegion).not.toBeNull()

    const popoverClass = popover?.className ?? ''
    const scrollClass = scrollRegion?.className ?? ''

    expect(popoverClass).toContain(PLAN_DOCK_POPOVER_WIDTH_CLASS)
    expect(popoverClass).toContain('48rem')
    expect(popoverClass).not.toContain('24rem')
    expect(popoverClass.split(/\s+/)).not.toContain('w-72')

    expect(scrollClass).toContain(PLAN_DOCK_POPOVER_HEIGHT_CLASS)
    expect(scrollClass).toContain('radix-popover-content-available-height')
    expect(scrollClass).toContain('overflow-y-auto')
    expect(scrollClass).toContain(SCROLLBAR_HIDDEN_CLASS)
    for (const token of PLAN_DOCK_POPOVER_SCROLL_CLASS.split(/\s+/)) {
      expect(scrollClass).toContain(token)
    }

    expect(popover?.textContent).toContain('Work graph')
    expect(popover?.textContent).toContain('Accept when: Device is listed as authorized.')
    expect(popover?.querySelector('[data-work-graph-view="graph"]')).not.toBeNull()
  })

  it('resets scroll position to the top every time the popover opens', async () => {
    const scrollTopByElement = new WeakMap<Element, number>()
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop')
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get(this: HTMLElement) {
        return scrollTopByElement.get(this) ?? 0
      },
      set(this: HTMLElement, value: number) {
        scrollTopByElement.set(this, value)
      },
    })

    try {
      act(() => root.render(createElement(PlanDockIndicator, {
        snapshot: graphSnapshot(),
      })))

      const trigger = container.querySelector('button')
      act(() => trigger?.click())
      await act(async () => {
        await Promise.resolve()
      })

      const firstScrollRegion = document.querySelector('[data-plan-dock-popover-scroll]')
      expect(firstScrollRegion).toBeInstanceOf(HTMLElement)
      if (!(firstScrollRegion instanceof HTMLElement)) return
      expect(firstScrollRegion.scrollTop).toBe(0)

      firstScrollRegion.scrollTop = 240
      expect(firstScrollRegion.scrollTop).toBe(240)

      act(() => trigger?.click()) // close
      act(() => trigger?.click()) // reopen
      await act(async () => {
        await Promise.resolve()
      })

      const reopenedScrollRegion = document.querySelector('[data-plan-dock-popover-scroll]')
      expect(reopenedScrollRegion).toBeInstanceOf(HTMLElement)
      if (!(reopenedScrollRegion instanceof HTMLElement)) return
      expect(reopenedScrollRegion.scrollTop).toBe(0)
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollTop', original)
    }
  })
})

function graphSnapshot(): SessionPlanSnapshotEvent {
  return {
    ...snapshot,
    coordinationMode: 'graph',
    explanation: 'Confirm the attached device before remediating.',
    plan: [
      { step: 'Confirm Android device is attached', status: 'in_progress' },
      { step: 'Remediate paging blockers', status: 'pending' },
    ],
    workGraph: {
      maxConcurrency: 2,
      nodes: [
        {
          id: 'confirm-device',
          title: 'Confirm Android device is attached and authorized',
          task: 'Verify adb sees an authorized device.',
          kind: 'decision',
          status: 'waiting',
          dependsOn: [],
          acceptanceCriteria: 'Device is listed as authorized.',
          effort: 'support',
          attempts: [],
        },
        {
          id: 'remediate',
          title: 'Remediate D3 projection blockers',
          task: 'Fix the accepted paging blockers.',
          kind: 'implementation',
          status: 'pending',
          dependsOn: ['confirm-device'],
          effort: 'deep',
          attempts: [],
        },
      ],
    },
  }
}
