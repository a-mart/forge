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
    statuses: {},
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

describe('SessionRowItem repo-sourced project agent badge', () => {
  it('shows repo source indicator for repo-sourced project agents', () => {
    renderRow({
      session: {
        sessionAgent: makeAgent({
          projectAgent: {
            handle: 'docs',
            whenToUse: 'Documentation',
            source: {
              type: 'repo',
              workspaceKey: 'ws-key',
              forgeDirRealpath: '/test/.forge',
              definitionId: 'def-docs',
              activatedAt: '2026-01-01T00:00:00Z',
            },
          },
        }),
        workers: [],
        isDefault: false,
      },
    })

    // Should have the repo project agent aria-label
    const repoLabel = container.querySelector('[aria-label="Repository Project Agent"]')
    expect(repoLabel).not.toBeNull()
  })

  it('shows repo source indicator for reload-style public project agent source marker', () => {
    renderRow({
      session: {
        sessionAgent: makeAgent({
          projectAgent: {
            handle: 'docs',
            whenToUse: 'Documentation',
            sourceKind: 'repo',
          },
        }),
        workers: [],
        isDefault: false,
      },
    })

    const repoLabel = container.querySelector('[aria-label="Repository Project Agent"]')
    expect(repoLabel).not.toBeNull()
  })

  it('shows plain project agent icon for local project agents', () => {
    renderRow({
      session: {
        sessionAgent: makeAgent({
          projectAgent: {
            handle: 'local-agent',
            whenToUse: 'Local tasks',
          },
        }),
        workers: [],
        isDefault: false,
      },
    })

    // Should have the plain project agent aria-label, not repo
    const projectAgentLabel = container.querySelector('[aria-label="Project Agent"]')
    expect(projectAgentLabel).not.toBeNull()
    const repoLabel = container.querySelector('[aria-label="Repository Project Agent"]')
    expect(repoLabel).toBeNull()
  })

  it('labels the copied path as the session data path', () => {
    renderRow()

    const trigger = container.querySelector('[data-slot="context-menu-trigger"]') ?? container.firstElementChild
    expect(trigger).not.toBeNull()
    flushSync(() => {
      trigger!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))
    })

    const text = document.body.textContent ?? ''
    expect(text).toContain('Copy session data path')
    expect(text).not.toContain('Copy path')
  })

  it('shows direct sharing action for promoted project agents only', () => {
    const onOpenProjectAgentSharing = vi.fn()
    renderRow({
      session: {
        sessionAgent: makeAgent({
          projectAgent: {
            handle: 'local-agent',
            whenToUse: 'Local tasks',
          },
        }),
        workers: [],
        isDefault: false,
      },
      onOpenProjectAgentSharing,
      onOpenProjectAgentSettings: vi.fn(),
      onDemoteProjectAgent: vi.fn(),
    })

    const trigger = container.querySelector('[data-slot="context-menu-trigger"]') ?? container.firstElementChild
    expect(trigger).not.toBeNull()
    flushSync(() => {
      trigger!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))
    })

    const text = document.body.textContent ?? ''
    expect(text).toContain('Share Project Agent…')
    expect(text).toContain('Project Agent Settings')
    expect(text).toContain('Demote to Session')

    const shareItem = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent?.includes('Share Project Agent'),
    ) as HTMLElement | undefined
    expect(shareItem).toBeDefined()
    flushSync(() => {
      shareItem!.click()
    })
    expect(onOpenProjectAgentSharing).toHaveBeenCalledTimes(1)
  })

  it('does not show direct sharing action for regular sessions', () => {
    renderRow({
      onOpenProjectAgentSharing: vi.fn(),
      onOpenProjectAgentSettings: vi.fn(),
      onDemoteProjectAgent: vi.fn(),
    })

    const trigger = container.querySelector('[data-slot="context-menu-trigger"]') ?? container.firstElementChild
    expect(trigger).not.toBeNull()
    flushSync(() => {
      trigger!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))
    })

    const text = document.body.textContent ?? ''
    expect(text).not.toContain('Share Project Agent')
    expect(text).not.toContain('Project Agent Settings')
    expect(text).not.toContain('Demote to Session')
  })

  it('shows distinct unlink context menu item for reload-style public project agent source marker', () => {
    renderRow({
      session: {
        sessionAgent: makeAgent({
          projectAgent: {
            handle: 'repo-agent',
            whenToUse: 'Repo tasks',
            sourceKind: 'repo',
          },
        }),
        workers: [],
        isDefault: false,
      },
      onDemoteProjectAgent: vi.fn(),
      onOpenProjectAgentSettings: vi.fn(),
    })

    const trigger = container.querySelector('[data-slot="context-menu-trigger"]') ?? container.firstElementChild
    expect(trigger).not.toBeNull()
    flushSync(() => {
      trigger!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))
    })

    const text = document.body.textContent ?? ''
    expect(text).toContain('Unlink from Repository Definition')
    expect(text).not.toContain('Demote to Session')
  })
})
