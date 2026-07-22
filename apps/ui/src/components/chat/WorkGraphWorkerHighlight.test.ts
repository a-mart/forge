/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor, WorkGraphSnapshot } from '@forge/protocol'
import { WorkerPillBar } from './WorkerPillBar'
import { WorkGraphWorkerHighlightProvider } from './WorkGraphWorkerHighlight'
import { getWorkGraphNodeWorkerId } from './work-graph-node-worker'
import { useWorkGraphWorkerHighlight } from './work-graph-worker-highlight-context'
import { WorkerRow } from './agent-sidebar/WorkerRow'
import { SessionRowItem } from './agent-sidebar/SessionRowItem'
import { WorkGraphDiagram } from './plan/WorkGraphDiagram'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

const graph: WorkGraphSnapshot = {
  maxConcurrency: 1,
  nodes: [{
    id: 'implementation',
    title: 'Implement highlight',
    task: 'Add the highlight.',
    kind: 'implementation',
    status: 'running',
    dependsOn: [],
    effort: 'routine',
    attempts: [
      {
        id: 'first-attempt',
        number: 1,
        status: 'succeeded',
        startedAt: '2026-07-20T10:00:00.000Z',
        completedAt: '2026-07-20T10:01:00.000Z',
        workerId: 'old-worker',
        behaviorMode: 'general',
        executionPolicy: 'routine',
      },
      {
        id: 'current-attempt',
        number: 2,
        status: 'running',
        startedAt: '2026-07-20T10:02:00.000Z',
        workerId: 'worker-1',
        behaviorMode: 'general',
        executionPolicy: 'routine',
      },
    ],
  }],
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

function worker(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: 'worker-1',
    managerId: 'session-1',
    displayName: 'Highlight worker',
    role: 'worker',
    status: 'streaming',
    createdAt: '2026-07-20T10:00:00.000Z',
    updatedAt: '2026-07-20T10:00:00.000Z',
    cwd: '/tmp',
    model: { provider: 'anthropic', modelId: 'claude-sonnet', thinkingLevel: 'none' },
    sessionFile: '/tmp/worker-1.jsonl',
    ...overrides,
  }
}

function HighlightTrigger() {
  const { highlightWorker } = useWorkGraphWorkerHighlight()
  return createElement('button', {
    type: 'button',
    onClick: () => highlightWorker('worker-1'),
  }, 'Highlight worker')
}

function HighlightProbe() {
  const { signal } = useWorkGraphWorkerHighlight()
  return createElement('output', null, signal ? `${signal.workerId}:${signal.nonce}` : 'none')
}

describe('work graph worker highlights', () => {
  it('maps graph clicks to the current attempt and replays the signal on repeated clicks', () => {
    act(() => {
      root.render(createElement(
        WorkGraphWorkerHighlightProvider,
        null,
        createElement(HighlightProbe),
        createElement(WorkGraphDiagram, { graph, compact: false }),
      ))
    })

    expect(getWorkGraphNodeWorkerId(graph.nodes[0]!)).toBe('worker-1')
    const node = [...container.querySelectorAll('button')].find((button) => (
      button.getAttribute('aria-label')?.startsWith('Implement highlight,')
    ))
    expect(node).toBeInstanceOf(HTMLButtonElement)

    act(() => node?.click())
    expect(container.querySelector('output')?.textContent).toBe('worker-1:1')

    act(() => node?.click())
    expect(container.querySelector('output')?.textContent).toBe('worker-1:2')
  })

  it('outlines only visible targets without selecting a worker or navigating', () => {
    const onSelect = vi.fn()
    const onNavigateToWorker = vi.fn()
    act(() => {
      root.render(createElement(
        WorkGraphWorkerHighlightProvider,
        null,
        createElement(HighlightTrigger),
        createElement(WorkerRow, {
          agent: worker(),
          liveStatus: { status: 'streaming', pendingCount: 0 },
          isSelected: false,
          onSelect,
        }),
        createElement(WorkerPillBar, {
          workers: [worker()],
          statuses: { 'worker-1': { status: 'streaming' } },
          activityMessages: [],
          onNavigateToWorker,
        }),
      ))
    })

    const pill = container.querySelector('[data-worker-pill="worker-1"]')
    expect(pill).not.toBeNull()
    expect(container.querySelectorAll('[data-work-graph-worker-highlight]')).toHaveLength(0)

    act(() => {
      const trigger = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Highlight worker')
      trigger?.click()
    })

    expect(container.querySelector('[data-worker-row] [data-work-graph-worker-highlight]')).not.toBeNull()
    expect(pill?.querySelector('[data-work-graph-worker-highlight]')).not.toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
    expect(onNavigateToWorker).not.toHaveBeenCalled()
  })

  it('does not expand a collapsed session to reveal a hidden worker row', () => {
    const onToggleCollapse = vi.fn()
    act(() => {
      root.render(createElement(
        WorkGraphWorkerHighlightProvider,
        null,
        createElement(HighlightTrigger),
        createElement(SessionRowItem, {
          session: {
            sessionAgent: worker({ agentId: 'session-1', managerId: 'session-1', role: 'manager', displayName: 'Session' }),
            workers: [worker()],
            isDefault: false,
          },
          statuses: { 'worker-1': { status: 'streaming', pendingCount: 0 } },
          unreadCount: 0,
          selectedAgentId: null,
          isSettingsActive: false,
          isCollapsed: true,
          isWorkerListExpanded: false,
          onToggleCollapse,
          onToggleWorkerListExpanded: vi.fn(),
          onSelect: vi.fn(),
          onDeleteAgent: vi.fn(),
        }),
      ))
    })

    act(() => {
      const trigger = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Highlight worker')
      trigger?.click()
    })

    expect(container.querySelector('[data-worker-row]')).toBeNull()
    expect(onToggleCollapse).not.toHaveBeenCalled()
  })
})
