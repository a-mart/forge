/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import { ArchiveView } from './ArchiveView'

let container: HTMLDivElement
let root: Root | null = null

function profile(profileId: string, archivedAt?: string): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: profileId,
    defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'medium' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archivedAt,
  }
}

function manager(agentId: string, profileId: string, archivedAt?: string): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    role: 'manager',
    status: 'idle',
    displayName: agentId,
    sessionLabel: agentId,
    profileId,
    cwd: '/tmp',
    model: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'medium' },
    sessionFile: `/tmp/${agentId}.jsonl`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archivedAt,
  }
}

function renderArchive(props: Partial<Parameters<typeof ArchiveView>[0]> = {}) {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(ArchiveView, {
      agents: [],
      profiles: [],
      onBack: vi.fn(),
      onRestoreProfile: vi.fn(),
      onRestoreSession: vi.fn(),
      ...props,
    }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) flushSync(() => root?.unmount())
  root = null
  container.remove()
})

describe('ArchiveView', () => {
  it('renders restore-only archived projects and sessions without delete actions', () => {
    const restoreProfile = vi.fn()
    const restoreSession = vi.fn()
    renderArchive({
      profiles: [profile('active'), profile('archived-project', '2026-05-20T00:00:00.000Z')],
      agents: [
        manager('active', 'active'),
        manager('archived-project', 'archived-project'),
        manager('archived-session', 'active', '2026-05-20T00:00:00.000Z'),
      ],
      onRestoreProfile: restoreProfile,
      onRestoreSession: restoreSession,
    })

    expect(container.textContent).toContain('Archived projects')
    expect(container.textContent).toContain('archived-project')
    expect(container.textContent).toContain('Archived sessions')
    expect(container.textContent).toContain('archived-session')
    expect(container.textContent).not.toContain('Delete')

    const buttons = Array.from(container.querySelectorAll('button'))
    const restoreButtons = buttons.filter((button) => button.textContent === 'Restore')
    expect(restoreButtons).toHaveLength(2)

    restoreButtons[0]?.click()
    expect(restoreProfile).toHaveBeenCalledWith('archived-project', true)

    restoreButtons[1]?.click()
    expect(restoreSession).toHaveBeenCalledWith('archived-session', true)
  })
})
