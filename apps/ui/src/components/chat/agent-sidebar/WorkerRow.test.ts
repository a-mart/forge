/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor } from '@forge/protocol'
import { WorkerRow } from './WorkerRow'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
})

function buildWorker(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: 'manager-1--codex',
    managerId: 'manager-1',
    displayName: 'Codex',
    role: 'worker',
    status: 'idle',
    createdAt: '2026-05-30T10:00:00.000Z',
    updatedAt: '2026-05-30T10:00:00.000Z',
    cwd: '/tmp',
    model: {
      provider: 'codex-app-server',
      modelId: 'app-server',
      thinkingLevel: 'none',
    },
    sessionFile: '/tmp/manager-1--codex.jsonl',
    ...overrides,
  }
}

function renderWorker(agent: AgentDescriptor) {
  flushSync(() => {
    root.render(
      createElement(WorkerRow, {
        agent,
        liveStatus: { status: 'idle', pendingCount: 0 },
        isSelected: false,
        onSelect: vi.fn(),
        onDelete: vi.fn(),
      }),
    )
  })
}

describe('WorkerRow', () => {
  it('shows codex icon for codex external-thread workers', () => {
    renderWorker(
      buildWorker({
        externalThread: {
          type: 'codex_app_server',
          persisted: true,
          createdByMention: true,
          threadId: 'thread-1',
        },
      }),
    )

    const icon = container.querySelector('[data-external-thread-icon="codex_app_server"]')
    expect(icon).toBeTruthy()
    expect(icon?.getAttribute('src')).toBe('/agents/codex-logo.svg')
    expect(container.textContent).toContain('Codex')
  })

  it('does not create a context-menu trigger for read-only workers', () => {
    flushSync(() => {
      root.render(createElement(WorkerRow, {
        agent: buildWorker(),
        liveStatus: { status: 'idle', pendingCount: 0 },
        isSelected: false,
        onSelect: vi.fn(),
      }))
    })

    expect(container.querySelector('[data-worker-row]')?.getAttribute('data-state')).toBeNull()
  })

  it('does not show codex icon for regular forge workers', () => {
    renderWorker(
      buildWorker({
        agentId: 'worker-1',
        displayName: 'worker-1',
        model: {
          provider: 'openai-codex',
          modelId: 'gpt-5.4',
          thinkingLevel: 'high',
        },
        externalThread: undefined,
      }),
    )

    expect(container.querySelector('[data-external-thread-icon="codex_app_server"]')).toBeNull()
    expect(container.textContent).toContain('worker-1')
  })
})
