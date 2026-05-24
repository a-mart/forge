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

  it('shows archived project last-used metadata', () => {
    renderArchive({
      profiles: [profile('archived-project', '2026-05-20T00:00:00.000Z')],
      agents: [
        {
          ...manager('archived-project', 'archived-project'),
          lastUserMessageAt: '2026-05-21T12:30:00.000Z',
        },
      ],
    })

    const lastUsed = container.querySelector('[data-testid="archived-project-last-used"]')
    expect(lastUsed).toBeTruthy()
    expect(lastUsed!.textContent).toMatch(/^Last used /)
    expect(lastUsed!.textContent).not.toBe('Last used unknown')
  })

  it('shows directly archived session last-used metadata', () => {
    renderArchive({
      profiles: [profile('my-project')],
      agents: [
        manager('my-project', 'my-project'),
        {
          ...manager('archived-session', 'my-project', '2026-05-20T00:00:00.000Z'),
          lastUserMessageAt: '2026-05-22T09:15:00.000Z',
        },
      ],
    })

    const lastUsed = container.querySelector('[data-testid="archived-session-last-used"]')
    expect(lastUsed).toBeTruthy()
    expect(lastUsed!.textContent).toMatch(/^Last used /)
    expect(lastUsed!.textContent).not.toBe('Last used unknown')
  })

  it('shows parent project name for directly archived sessions', () => {
    const activeProfile = { ...profile('my-project'), displayName: 'My Cool Project' }
    renderArchive({
      profiles: [activeProfile],
      agents: [
        manager('my-project', 'my-project'),
        manager('archived-session', 'my-project', '2026-05-20T00:00:00.000Z'),
      ],
    })

    const sessionRow = container.querySelector('[data-testid="archived-session-row"]')
    expect(sessionRow).toBeTruthy()
    const projectIndicator = sessionRow!.querySelector('[data-testid="archived-session-project"]')
    expect(projectIndicator).toBeTruthy()
    expect(projectIndicator!.textContent).toBe('My Cool Project')
  })

  it('shows project name from profileId for multiple archived sessions from different projects', () => {
    const projectA = { ...profile('project-a'), displayName: 'Project Alpha' }
    const projectB = { ...profile('project-b'), displayName: 'Project Beta' }

    renderArchive({
      profiles: [projectA, projectB],
      agents: [
        manager('project-a', 'project-a'),
        manager('project-b', 'project-b'),
        manager('session-from-a', 'project-a', '2026-05-20T00:00:00.000Z'),
        manager('session-from-b', 'project-b', '2026-05-20T00:00:00.000Z'),
      ],
    })

    const sessionRows = container.querySelectorAll('[data-testid="archived-session-row"]')
    expect(sessionRows).toHaveLength(2)

    const projectIndicators = container.querySelectorAll('[data-testid="archived-session-project"]')
    expect(projectIndicators).toHaveLength(2)
    const labels = Array.from(projectIndicators).map((el) => el.textContent)
    expect(labels).toContain('Project Alpha')
    expect(labels).toContain('Project Beta')
  })

  it('renders directly archived sessions in last-used order', () => {
    renderArchive({
      profiles: [profile('my-project')],
      agents: [
        manager('my-project', 'my-project'),
        {
          ...manager('older-session', 'my-project', '2026-05-20T00:00:00.000Z'),
          lastUserMessageAt: '2026-05-21T00:00:00.000Z',
        },
        {
          ...manager('newer-session', 'my-project', '2026-05-20T00:00:00.000Z'),
          lastUserMessageAt: '2026-05-23T00:00:00.000Z',
        },
      ],
    })

    const sessionLabels = Array.from(container.querySelectorAll('[data-testid="archived-session-row"] h3'))
      .map((el) => el.textContent)
    expect(sessionLabels).toEqual(['newer-session', 'older-session'])
  })
})
