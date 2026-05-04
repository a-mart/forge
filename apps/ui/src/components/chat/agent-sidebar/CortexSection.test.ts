/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import { CortexSection } from './CortexSection'
import type { CortexSectionProps } from './types'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }
  root = null
  container.remove()
})

function makeAgent(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: 'cortex-root',
    managerId: 'cortex-root',
    displayName: 'Cortex',
    role: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: {
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      thinkingLevel: 'none',
    },
    sessionFile: '/tmp/cortex-root.jsonl',
    sessionLabel: 'Cortex Root',
    profileId: 'cortex-profile',
    archetypeId: 'cortex',
    ...overrides,
  }
}

function makeCortexProfile(): ManagerProfile {
  return {
    profileId: 'cortex-profile',
    displayName: 'Cortex',
    defaultSessionAgentId: 'cortex-root',
    defaultModel: { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514', thinkingLevel: 'none' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function renderCortexSection(overrides: Partial<CortexSectionProps> = {}) {
  const defaultProps: CortexSectionProps = {
    cortexRow: {
      profile: makeCortexProfile(),
      sessions: [
        { sessionAgent: makeAgent(), workers: [], isDefault: true },
      ],
    },
    statuses: {},
    unreadCounts: {},
    selectedAgentId: null,
    isSettingsActive: false,
    isCollapsed: false,
    collapsedSessionIds: new Set(),
    visibleSessionLimit: 8,
    expandedWorkerListSessionIds: new Set(),
    onToggleCollapsed: vi.fn(),
    onToggleSessionCollapsed: vi.fn(),
    onShowMoreSessions: vi.fn(),
    onShowLessSessions: vi.fn(),
    onToggleWorkerListExpanded: vi.fn(),
    onSelect: vi.fn(),
    onDeleteAgent: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides,
  }

  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(CortexSection, defaultProps))
  })
}

describe('CortexSection activeWorkerCount fallback for review sessions', () => {
  it('shows Running indicator when a hidden review session has activeWorkerCount > 0 and no loaded workers', () => {
    // This is the key regression scenario:
    // Cortex review sessions are lazy-loaded (workers array is empty in the sidebar tree),
    // but the descriptor still reports activeWorkerCount from the backend.
    // The "Running" badge should still appear based on the fallback.
    const reviewSession: AgentDescriptor = makeAgent({
      agentId: 'cortex-review-1',
      managerId: 'cortex-review-1',
      displayName: 'Cortex Review Run',
      sessionLabel: 'Cortex Review Run',
      status: 'idle',
      sessionPurpose: 'cortex_review',
      activeWorkerCount: 1,
    })

    renderCortexSection({
      cortexRow: {
        profile: makeCortexProfile(),
        sessions: [
          { sessionAgent: makeAgent(), workers: [], isDefault: true },
          { sessionAgent: reviewSession, workers: [], isDefault: false },
        ],
      },
      statuses: {},
    })

    const text = container.textContent ?? ''
    expect(text).toContain('Running')
  })

  it('does not show Running indicator when review session has activeWorkerCount 0 and no loaded workers', () => {
    const reviewSession: AgentDescriptor = makeAgent({
      agentId: 'cortex-review-1',
      managerId: 'cortex-review-1',
      displayName: 'Cortex Review Run',
      sessionLabel: 'Cortex Review Run',
      status: 'idle',
      sessionPurpose: 'cortex_review',
      activeWorkerCount: 0,
    })

    renderCortexSection({
      cortexRow: {
        profile: makeCortexProfile(),
        sessions: [
          { sessionAgent: makeAgent(), workers: [], isDefault: true },
          { sessionAgent: reviewSession, workers: [], isDefault: false },
        ],
      },
      statuses: {},
    })

    const text = container.textContent ?? ''
    expect(text).not.toContain('Running')
  })

  it('shows Running indicator when review session has a streaming worker loaded', () => {
    const reviewSession: AgentDescriptor = makeAgent({
      agentId: 'cortex-review-1',
      managerId: 'cortex-review-1',
      displayName: 'Cortex Review Run',
      sessionLabel: 'Cortex Review Run',
      status: 'idle',
      sessionPurpose: 'cortex_review',
      activeWorkerCount: 0,
    })

    const worker: AgentDescriptor = {
      agentId: 'worker-1',
      managerId: 'cortex-review-1',
      displayName: 'Worker',
      role: 'worker',
      status: 'streaming',
      createdAt: '2026-01-01T00:00:01.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      cwd: '/tmp',
      model: { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514', thinkingLevel: 'none' },
      sessionFile: '/tmp/worker-1.jsonl',
    }

    renderCortexSection({
      cortexRow: {
        profile: makeCortexProfile(),
        sessions: [
          { sessionAgent: makeAgent(), workers: [], isDefault: true },
          { sessionAgent: reviewSession, workers: [worker], isDefault: false },
        ],
      },
      statuses: { 'worker-1': { status: 'streaming', pendingCount: 0 } },
    })

    const text = container.textContent ?? ''
    expect(text).toContain('Running')
  })

  it('shows Running indicator when review session itself is streaming', () => {
    const reviewSession: AgentDescriptor = makeAgent({
      agentId: 'cortex-review-1',
      managerId: 'cortex-review-1',
      displayName: 'Cortex Review Run',
      sessionLabel: 'Cortex Review Run',
      status: 'streaming',
      sessionPurpose: 'cortex_review',
      activeWorkerCount: 0,
    })

    renderCortexSection({
      cortexRow: {
        profile: makeCortexProfile(),
        sessions: [
          { sessionAgent: makeAgent(), workers: [], isDefault: true },
          { sessionAgent: reviewSession, workers: [], isDefault: false },
        ],
      },
      statuses: { 'cortex-review-1': { status: 'streaming', pendingCount: 0 } },
    })

    const text = container.textContent ?? ''
    expect(text).toContain('Running')
  })
})
