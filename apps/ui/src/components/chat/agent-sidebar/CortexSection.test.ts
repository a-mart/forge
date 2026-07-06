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
  if (root) flushSync(() => root?.unmount())
  root = null
  container.remove()
})

describe('CortexSection', () => {
  it('renders Cortex sessions directly and omits the deleted review-run Running badge', () => {
    const reviewSession = makeAgent({
      agentId: 'cortex-review-1',
      managerId: 'cortex-review-1',
      displayName: 'Cortex Review Run',
      sessionLabel: 'Cortex Review Run',
      status: 'streaming',
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
      statuses: { 'cortex-review-1': { status: 'streaming', pendingCount: 0 } },
    })

    const text = container.textContent ?? ''
    expect(text).toContain('Cortex Review Run')
    expect(text).not.toContain('Running')
  })
})

function renderCortexSection(overrides: Partial<CortexSectionProps> = {}) {
  const defaultProps: CortexSectionProps = {
    cortexRow: {
      profile: makeCortexProfile(),
      sessions: [{ sessionAgent: makeAgent(), workers: [], isDefault: true }],
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
  flushSync(() => root?.render(createElement(CortexSection, defaultProps)))
}

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
    model: { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514', thinkingLevel: 'none' },
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
