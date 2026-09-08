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
    expect(inspector().textContent).toContain('Evidence cites the inspected path.')
    expect(container.textContent).toContain('0 of 2 accepted')
    expect(container.querySelector('[data-work-graph-view="graph"]')).not.toBeNull()
    expect(buttonNamed('Graph').getAttribute('aria-pressed')).toBe('true')

    act(() => buttonNamed('Synthesize recommendation').click())
    expect(inspector().textContent).toContain('Research current behavior · Awaiting review · Unresolved')
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

  it('keeps the complete inspector available in compact rendering', () => {
    act(() => root.render(createElement(WorkGraphView, { graph, compact: true })))
    expect(container.textContent).toContain('Research current behavior')
    expect(inspector().textContent).toContain('Evidence cites the inspected path.')
  })

  it('preserves selection between views and updates the selected snapshot live', () => {
    act(() => root.render(createElement(WorkGraphView, { graph })))
    act(() => buttonNamed('Synthesize recommendation').click())
    act(() => buttonNamed('List').click())
    expect(inspector().getAttribute('aria-label')).toBe('Step inspector: Synthesize recommendation')
    expect(buttonNamed('Synthesize recommendation').getAttribute('aria-pressed')).toBe('true')
    act(() => buttonNamed('Graph').click())
    expect(buttonNamed('Synthesize recommendation').getAttribute('aria-pressed')).toBe('true')
    act(() => root.render(createElement(WorkGraphView, { graph: {
      ...graph, nodes: graph.nodes.map(node => ({ ...node, status: 'completed' as const })),
    } })))
    expect(inspector().textContent).toContain('Manager accepted this step.')
    expect(inspector().textContent).toContain('Unresolved dependencies · 0')
  })

  it('shows every attempt newest first, expandable complete literal results and legacy attribution', () => {
    const text = '<script>doNotRun()</script>\n' + 'evidence '.repeat(200) + 'END OF STORED TEXT'
    act(() => root.render(createElement(WorkGraphView, { graph: {
      ...graph, nodes: [{ ...graph.nodes[0], attempts: [graph.nodes[0].attempts[0], {
        ...graph.nodes[0].attempts[0], id: 'attempt-2', number: 2, summary: text,
        model: { provider: 'provider', modelId: 'model', thinkingLevel: 'high' },
      }] }],
    } })))
    const attempts = [...inspector().querySelectorAll('section[aria-label="Execution attempts"] > details')]
    expect(attempts.map(el => el.querySelector('summary')?.textContent)).toEqual([
      'Attempt 2 · Succeeded (worker result)', 'Attempt 1 · Succeeded (worker result)',
    ])
    expect(attempts[0].hasAttribute('open')).toBe(true)
    expect(attempts[1].hasAttribute('open')).toBe(false)
    expect(inspector().textContent).toContain('Worker succeeded. Manager acceptance is still required.')
    expect(inspector().textContent).toContain('provider / model')
    const result = attempts[0].querySelector('details')!
    act(() => result.querySelector('summary')!.click())
    expect(result.open).toBe(true)
    expect(result.querySelector('p')?.textContent).toBe(text)
    expect(container.querySelector('script')).toBeNull()
    act(() => attempts[1].querySelector('summary')!.click())
    expect((attempts[1] as HTMLDetailsElement).open).toBe(true)
    expect(attempts[1].textContent).toContain('Not recorded')
    expect(attempts[1].textContent).toContain('support')
  })

  it('keeps cancelled steps inspectable and missing dependencies unresolved', () => {
    act(() => root.render(createElement(WorkGraphView, { graph: {
      ...graph, nodes: [{ ...graph.nodes[1], status: 'cancelled', dependsOn: ['missing'] }],
    } })))
    expect(inspector().textContent).toContain('missing · Missing from snapshot · Unresolved')
    expect(inspector().textContent).toContain('No execution attempts recorded.')
    expect(inspector().textContent).toContain('No acceptance criteria recorded.')
    act(() => buttonNamed('List').click())
    const button = buttonNamed('Synthesize recommendation')
    expect(button.disabled).toBe(false)
    expect(button.getAttribute('aria-controls')).toBe(inspector().id)
    button.focus()
    expect(document.activeElement).toBe(button)
    expect(inspector().textContent).toContain('Cancelled')
  })

  it('preserves the selected step and expanded older result through live status and result updates', () => {
    const olderText = '<b>literal</b>' + 'x'.repeat(600)
    const attempts = [
      { ...graph.nodes[0].attempts[0], summary: olderText },
      { ...graph.nodes[0].attempts[0], id: 'attempt-2', number: 2, status: 'running' as const },
    ]
    const renderStatus = (status: 'running' | 'awaiting_review' | 'completed') => act(() => root.render(createElement(WorkGraphView, { graph: {
      ...graph, nodes: [graph.nodes[1], { ...graph.nodes[0], status, attempts: attempts.map((attempt, index) => index === 1
        ? { ...attempt, status: status === 'running' ? 'running' as const : 'succeeded' as const, summary: `Live result: ${status}` }
        : attempt) }],
    } })))
    renderStatus('running')
    act(() => buttonNamed('Research current behavior').click())
    const older = inspector().querySelectorAll<HTMLDetailsElement>('section[aria-label="Execution attempts"] > details')[1]
    act(() => older.querySelector('summary')!.click())
    const text = older.querySelector('details')!
    act(() => text.querySelector('summary')!.click())
    for (const status of ['awaiting_review', 'completed'] as const) {
      renderStatus(status)
      act(() => buttonNamed(status === 'awaiting_review' ? 'List' : 'Graph').click())
      expect(inspector().getAttribute('aria-label')).toBe('Step inspector: Research current behavior')
      expect(older.isConnected && older.open && text.open).toBe(true)
      expect(text.querySelector('p')?.textContent).toBe(olderText)
      expect(inspector().textContent).toContain(`Live result: ${status}`)
      expect(inspector().textContent).toContain(status === 'completed' ? 'Manager accepted this step.' : 'Manager acceptance is still required.')
    }
  })

  it('does not satisfy dependencies with a cancelled predecessor', () => {
    act(() => root.render(createElement(WorkGraphView, { graph: {
      ...graph, nodes: [{ ...graph.nodes[0], status: 'cancelled' }, { ...graph.nodes[1], dependsOn: ['research', 'missing'] }],
    } })))
    act(() => buttonNamed('Synthesize recommendation').click())
    expect(inspector().textContent).toContain('Unresolved dependencies · 2')
    expect(inspector().textContent).toContain('Research current behavior · Cancelled · Unresolved')
    expect(inspector().textContent).toContain('missing · Missing from snapshot · Unresolved')
  })

  it.each([new Date().toISOString(), '2026-07-18T12:00:00.000Z'])('formats calendar date and time retaining exact %s and tolerates invalid legacy timestamps', (timestamp) => {
    act(() => root.render(createElement(WorkGraphView, { graph: {
      ...graph, nodes: [{ ...graph.nodes[0], statusUpdatedAt: timestamp, attempts: [{ ...graph.nodes[0].attempts[0], completedAt: 'invalid legacy date' }] }],
    } })))
    const time = inspector().querySelector('time')!
    expect(time.dateTime).toBe(timestamp)
    expect(time.title).toBe(timestamp)
    expect(time.textContent).toBe(new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))
    expect(inspector().textContent).toContain('invalid legacy date')
  })

  it('falls back after selected-node removal and handles empty snapshots', () => {
    act(() => root.render(createElement(WorkGraphView, { graph })))
    act(() => buttonNamed('Synthesize recommendation').click())
    act(() => root.render(createElement(WorkGraphView, { graph: { ...graph, nodes: [graph.nodes[0]] } })))
    expect(inspector().getAttribute('aria-label')).toBe('Step inspector: Research current behavior')
    act(() => root.render(createElement(WorkGraphView, { graph: { ...graph, nodes: [] } })))
    expect(container.textContent).toContain('No steps in this graph.')
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

function inspector(): HTMLElement {
  return container.querySelector('section[aria-label^="Step inspector:"]')!
}
