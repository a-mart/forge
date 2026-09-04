/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkGraphSnapshot } from '@forge/protocol'
import { workGraphColumnCount } from './plan-surface'
import { WorkGraphView } from './WorkGraphView'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

const graph: WorkGraphSnapshot = {
  maxConcurrency: 4,
  nodes: [
    {
      id: 'research',
      title: 'Research current behavior',
      task: 'Inspect the current behavior.',
      kind: 'research',
      status: 'awaiting_review',
      dependsOn: [],
      acceptanceCriteria: 'Evidence cites the inspected path.',
      route: 'auto',
      effort: 'auto',
      attempts: [{
        id: 'attempt-1',
        number: 1,
        status: 'succeeded',
        startedAt: '2026-07-18T12:00:00.000Z',
        completedAt: '2026-07-18T12:01:00.000Z',
        workerId: 'graph-research-1',
        behaviorMode: 'research',
        executionPolicy: 'support',
      }],
    },
    {
      id: 'synthesis',
      title: 'Synthesize recommendation',
      task: 'Synthesize accepted evidence.',
      kind: 'synthesis',
      status: 'pending',
      dependsOn: ['research'],
      route: 'auto',
      effort: 'auto',
      attempts: [],
    },
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

describe('WorkGraphView', () => {
  it('shows dependencies, acceptance, concurrency, and economical routing', () => {
    act(() => root.render(createElement(WorkGraphView, { graph })))

    expect(container.textContent).toContain('Dynamic work graph')
    expect(container.textContent).toContain('up to 4 parallel')
    expect(container.textContent).toContain('Review support')
    expect(container.textContent).toContain('Accept when: Evidence cites the inspected path.')
    expect(container.textContent).toContain('0 of 2 accepted')
    expect(container.querySelector('[data-work-graph-view="graph"]')).not.toBeNull()
    expect(buttonNamed('Graph').getAttribute('aria-pressed')).toBe('true')

    act(() => buttonNamed('Synthesize recommendation').click())
    expect(container.textContent).toContain('After: Research current behavior')
  })

  it('keeps graph node cards opaque so connector lines cannot show through', () => {
    const statuses = ['completed', 'running', 'awaiting_review', 'waiting', 'blocked', 'pending'] as const
    act(() => root.render(createElement(WorkGraphView, {
      graph: {
        ...graph,
        nodes: statuses.map((status, index) => ({
          ...graph.nodes[0],
          id: `node-${status}`,
          title: `Node ${status}`,
          status,
          dependsOn: index === 0 ? [] : ['node-completed'],
        })),
      },
    })))

    const cards = [...container.querySelectorAll('[data-work-graph-view="graph"] button[aria-label]')]
    expect(cards.length).toBe(statuses.length)
    for (const card of cards) {
      const classes = (card.getAttribute('class') ?? '').split(/\s+/)
      // Opaque base must survive on every card.
      expect(classes).toContain('bg-background')
      // No translucent bg-* status tint may replace the opaque base.
      expect(classes.filter((cls) => /^bg-(emerald|violet|sky|destructive)-/.test(cls))).toEqual([])
      // Status tint is an inset shadow wash painted over the opaque base.
      const status = statuses.find((s) => card.getAttribute('aria-label')?.startsWith(`Node ${s},`))
      if (status === 'pending') {
        expect(classes.filter((cls) => cls.startsWith('shadow-['))).toEqual([])
      } else {
        expect(classes.some((cls) => cls.startsWith('shadow-[inset_'))).toBe(true)
      }
    }
  })

  it('keeps compact rendering denser without long acceptance copy', () => {
    act(() => root.render(createElement(WorkGraphView, { graph, compact: true })))
    expect(container.textContent).toContain('Research current behavior')
    expect(container.textContent).not.toContain('Accept when:')
  })

  it('derives graph columns from stage width, not compact mode', () => {
    expect(workGraphColumnCount(320)).toBe(1)
    expect(workGraphColumnCount(430)).toBe(2)
    expect(workGraphColumnCount(620)).toBe(3)
    expect(workGraphColumnCount(720)).toBe(3)
  })

  it('keeps an explicit list choice across graph revisions while graph is active', () => {
    act(() => root.render(createElement(WorkGraphView, { graph })))
    act(() => buttonNamed('List').click())

    expect(container.querySelector('[data-work-graph-view="list"]')).not.toBeNull()
    expect(buttonNamed('List').getAttribute('aria-pressed')).toBe('true')
    expect(container.textContent).toContain('After Research current behavior')

    act(() => root.render(createElement(WorkGraphView, {
      graph: {
        ...graph,
        nodes: graph.nodes.map((node) => node.id === 'research'
          ? { ...node, status: 'completed' as const }
          : node),
      },
    })))

    expect(container.querySelector('[data-work-graph-view="list"]')).not.toBeNull()
    expect(buttonNamed('List').getAttribute('aria-pressed')).toBe('true')
  })
})

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')]
    .find((candidate) => (
      candidate.textContent?.trim() === name
      || candidate.getAttribute('aria-label')?.startsWith(`${name},`)
    ))
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`)
  return button
}
