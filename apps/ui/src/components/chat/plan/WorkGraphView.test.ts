/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkGraphSnapshot } from '@forge/protocol'
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
    expect(container.textContent).toContain('After Research current behavior')
    expect(container.textContent).toContain('Accept when: Evidence cites the inspected path.')
    expect(container.textContent).toContain('0 of 2 accepted')
  })

  it('keeps compact dock rendering useful without long acceptance copy', () => {
    act(() => root.render(createElement(WorkGraphView, { graph, compact: true })))
    expect(container.textContent).toContain('Research current behavior')
    expect(container.textContent).not.toContain('Accept when:')
  })
})
