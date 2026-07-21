/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor, ConversationEntry } from '@forge/protocol'
import type { AgentActivityEntry } from '@/lib/ws-state'
import { WorkerPillBar } from './WorkerPillBar'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const onNavigateToWorker = vi.fn()

const worker: AgentDescriptor = {
  agentId: 'worker-1',
  managerId: 'manager-1',
  displayName: 'Streaming worker',
  role: 'worker',
  status: 'streaming',
  createdAt: '2026-07-21T10:00:00.000Z',
  updatedAt: '2026-07-21T10:00:00.000Z',
  cwd: '/tmp',
  model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' },
  sessionFile: '/tmp/worker-1.jsonl',
}

function summary(index: number, prefix = 'Activity'): Extract<ConversationEntry, { type: 'activity_summary' }> {
  const correlationId = `${prefix.toLowerCase()}-${index}`
  return {
    type: 'activity_summary',
    schemaVersion: 1,
    itemId: `tool:manager-1:${correlationId}`,
    agentId: 'manager-1',
    actorAgentId: worker.agentId,
    timestamp: new Date(Date.UTC(2026, 6, 21, 10, 0, index)).toISOString(),
    kind: 'tool_activity',
    status: 'completed',
    toolName: 'read',
    correlationId,
    displaySummary: `${prefix} ${index}`,
  }
}

const replayedSummary = summary(1, 'Read file')

beforeEach(() => {
  onNavigateToWorker.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(activityMessages: AgentActivityEntry[]) {
  act(() => {
    root.render(createElement(WorkerPillBar, {
      workers: [worker],
      statuses: {
        [worker.agentId]: {
          status: 'streaming',
          streamingStartedAt: Date.now() - 5_000,
        },
      },
      activityMessages,
      onNavigateToWorker,
    }))
  })
}

function getPill(): HTMLButtonElement {
  const pill = container.querySelector(`[data-worker-pill="${worker.agentId}"]`)
  expect(pill).toBeInstanceOf(HTMLButtonElement)
  return pill as HTMLButtonElement
}

function getEntryCount(): number {
  return document.body.querySelector('[data-worker-quick-look-entries]')?.children.length ?? 0
}

describe('WorkerPillBar quick look', () => {
  it('renders replayed worker summaries and updates immediately for live tool activity', () => {
    render([replayedSummary])

    act(() => getPill().click())

    expect(document.body.textContent).toContain('Read file 1')
    expect(document.body.textContent).not.toContain('No recent activity')

    const liveStart: Extract<ConversationEntry, { type: 'agent_tool_call' }> = {
      type: 'agent_tool_call',
      agentId: 'manager-1',
      actorAgentId: worker.agentId,
      timestamp: '2026-07-21T10:00:02.000Z',
      kind: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'bash-1',
      text: JSON.stringify({ command: 'pnpm test' }),
    }
    render([replayedSummary, liveStart])

    expect(document.body.textContent).toContain('Running command')
    expect(document.body.textContent).toContain('pnpm test')
  })

  it('retains the initial open snapshot while rolling live updates append beyond 30 entries', () => {
    const initial = Array.from({ length: 30 }, (_, index) => summary(index, 'Initial'))
    render(initial)
    act(() => getPill().click())

    expect(getEntryCount()).toBe(30)
    expect(document.body.textContent).toContain('Initial 0')

    let rollingActivity: AgentActivityEntry[] = initial
    let previousCount = getEntryCount()
    for (let index = 0; index < 35; index += 1) {
      rollingActivity = [...rollingActivity, summary(index, 'Live')].slice(-30)
      render(rollingActivity)
      const nextCount = getEntryCount()
      expect(nextCount).toBeGreaterThanOrEqual(previousCount)
      previousCount = nextCount
    }

    expect(getEntryCount()).toBe(65)
    expect(document.body.textContent).toContain('Initial 0')
    expect(document.body.textContent).toContain('Live 34')
  })

  it('uses a fixed responsive frame with an internal flex scroll region', () => {
    render([replayedSummary])
    act(() => getPill().click())

    const popover = document.body.querySelector('[data-worker-quick-look-popover]')
    const scrollRegion = document.body.querySelector('[data-worker-quick-look-scroll]')
    expect(popover?.className).toContain('h-[min(42rem,_calc(100vh-6rem))]')
    expect(popover?.className).toContain('overflow-hidden')
    expect(scrollRegion?.className).toContain('min-h-0')
    expect(scrollRegion?.className).toContain('flex-1')
    expect(scrollRegion?.className).toContain('overflow-y-auto')
  })

  it('resets the accumulated snapshot after close and reopen', () => {
    render([summary(0, 'Initial')])
    const pill = getPill()
    act(() => pill.click())
    render([summary(0, 'Live')])

    expect(document.body.textContent).toContain('Initial 0')
    expect(document.body.textContent).toContain('Live 0')

    act(() => pill.click())
    render([summary(0, 'Live')])
    act(() => pill.click())

    expect(document.body.textContent).not.toContain('Initial 0')
    expect(document.body.textContent).toContain('Live 0')
  })
})
