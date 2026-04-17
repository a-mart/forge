/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor } from '@forge/protocol'
import { SessionRowItem } from './SessionRowItem'
import type { SessionRowItemProps } from './types'

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
    agentId: 'session-1',
    managerId: 'session-1',
    displayName: 'Test Session',
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
    sessionFile: '/tmp/session-1.jsonl',
    sessionLabel: 'Test Session',
    ...overrides,
  }
}

function renderRow(overrides: Partial<SessionRowItemProps> = {}) {
  const defaultProps: SessionRowItemProps = {
    session: {
      sessionAgent: makeAgent(),
      workers: [],
      isDefault: false,
    },
    managerStreaming: false,
    streamingWorkerCount: 0,
    unreadCount: 0,
    selectedAgentId: null,
    isSettingsActive: false,
    isCollapsed: true,
    isWorkerListExpanded: false,
    onToggleCollapse: vi.fn(),
    onToggleWorkerListExpanded: vi.fn(),
    onSelect: vi.fn(),
    onDeleteAgent: vi.fn(),
    ...overrides,
  }

  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(SessionRowItem, defaultProps))
  })
}

describe('SessionRowItem creator attribution', () => {
  it('shows creator attribution when creatorAgentId is set and getCreatorAttribution returns a label', () => {
    renderRow({
      session: {
        sessionAgent: makeAgent({ creatorAgentId: 'creator-agent-1' }),
        workers: [],
        isDefault: false,
      },
      getCreatorAttribution: (id) => id === 'creator-agent-1' ? 'orchestrator' : null,
    })

    const text = container.textContent ?? ''
    expect(text).toContain('@orchestrator')
  })

  it('does not show creator attribution when creatorAgentId is not set', () => {
    renderRow({
      session: {
        sessionAgent: makeAgent(),
        workers: [],
        isDefault: false,
      },
      getCreatorAttribution: () => 'orchestrator',
    })

    const text = container.textContent ?? ''
    expect(text).not.toContain('@orchestrator')
  })

  it('does not show creator attribution when getCreatorAttribution returns null (deleted creator)', () => {
    renderRow({
      session: {
        sessionAgent: makeAgent({ creatorAgentId: 'deleted-agent' }),
        workers: [],
        isDefault: false,
      },
      getCreatorAttribution: () => null,
    })

    const text = container.textContent ?? ''
    expect(text).not.toContain('@')
  })
})
