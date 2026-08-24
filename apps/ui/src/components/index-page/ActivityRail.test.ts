/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Clock3, FolderOpen, GitBranch, Globe2, MessageSquare, Package, SquareTerminal } from 'lucide-react'
import { ActivityRail } from './ActivityRail'
import { ChatHeader } from '@/components/chat/ChatHeader'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
})

describe('ActivityRail', () => {
  it('renders rail buttons with active and badge states', () => {
    act(() => {
      root = createRoot(container)
      root.render(
        createElement(ActivityRail, {
          items: [
            {
              id: 'files',
              label: 'Browse Files',
              icon: FolderOpen,
              active: true,
              onClick: vi.fn(),
            },
            {
              id: 'schedules',
              label: 'Cron / Schedules',
              icon: Clock3,
              badge: 2,
              onClick: vi.fn(),
            },
          ],
        }),
      )
    })

    const nav = container.querySelector('nav[aria-label="Activity rail"]')
    expect(nav).not.toBeNull()

    const activeButton = container.querySelector('button[aria-pressed="true"]')
    expect(activeButton).not.toBeNull()
    expect(activeButton?.getAttribute('aria-label')).toBe('Browse Files')

    const badgeButton = container.querySelector('button[aria-label="Cron / Schedules (2)"]')
    expect(badgeButton).not.toBeNull()
    expect(badgeButton?.className).not.toContain('border')
    expect(badgeButton?.className).not.toContain('shadow')
    const badge = badgeButton?.querySelector('span[aria-hidden="true"]')
    expect(badge?.textContent).toBe('2')
    expect(badge?.className).toContain('bg-blue-600')
    expect(badge?.className).toContain('text-white')
    expect(badge?.className).toContain('ring-sidebar')
  })

  it('uses the Rooms inboard treatment and reserves the bottom slot for Cortex', () => {
    act(() => {
      root = createRoot(container)
      root.render(
        createElement(ActivityRail, {
          roomsV2: true,
          cortex: createElement('button', { type: 'button', 'aria-label': 'Cortex' }),
          items: [{ id: 'chat', label: 'Chat', icon: MessageSquare, active: true, onClick: vi.fn() }],
        }),
      )
    })

    const nav = container.querySelector('nav[aria-label="Activity rail"]')
    expect(nav?.className).toContain('border-x')
    expect(nav?.querySelector('button[aria-label="Chat"]')?.className).toContain('size-[34px]')
    expect(nav?.querySelector('[data-testid="cortex-rail-slot"] button[aria-label="Cortex"]')).not.toBeNull()
  })

  it('does not render a visible separator between rail groups', () => {
    act(() => {
      root = createRoot(container)
      root.render(
        createElement(ActivityRail, {
          items: [
            {
              id: 'artifacts',
              label: 'Artifacts',
              icon: FolderOpen,
              onClick: vi.fn(),
            },
            {
              id: 'files',
              label: 'Browse Files',
              icon: FolderOpen,
              onClick: vi.fn(),
            },
          ],
        }),
      )
    })

    expect(container.querySelector('[data-slot="separator"]')).toBeNull()
    expect(container.querySelectorAll('button')).toHaveLength(2)
  })

  it('preserves the workspace rail order from top to bottom with Chat first', () => {
    act(() => {
      root = createRoot(container)
      root.render(
        createElement(ActivityRail, {
          items: [
            { id: 'chat', label: 'Chat', icon: MessageSquare, onClick: vi.fn() },
            { id: 'browser', label: 'Browser', icon: Globe2, onClick: vi.fn() },
            { id: 'files', label: 'Browse Files', icon: FolderOpen, onClick: vi.fn() },
            { id: 'changes', label: 'View Changes', icon: GitBranch, onClick: vi.fn() },
            { id: 'terminal', label: 'Terminal', icon: SquareTerminal, onClick: vi.fn() },
            { id: 'schedules', label: 'Cron / Schedules', icon: Clock3, onClick: vi.fn() },
            { id: 'artifacts', label: 'Artifacts', icon: Package, onClick: vi.fn() },
          ],
        }),
      )
    })

    expect(Array.from(container.querySelectorAll('button')).map((button) => button.getAttribute('aria-label'))).toEqual([
      'Chat',
      'Browser',
      'Browse Files',
      'View Changes',
      'Terminal',
      'Cron / Schedules',
      'Artifacts',
    ])
  })

  it('shows shortcut labels in tooltips and aria labels', () => {
    act(() => {
      root = createRoot(container)
      root.render(
        createElement(ActivityRail, {
          items: [
            {
              id: 'changes',
              label: 'View Changes',
              icon: GitBranch,
              shortcutLabel: '⌘⇧D',
              onClick: vi.fn(),
            },
          ],
        }),
      )
    })

    const changesButton = container.querySelector('button[aria-label="View Changes (⌘⇧D)"]')
    expect(changesButton).not.toBeNull()
  })
})

describe('ChatHeader desktop workspace gating', () => {
  const baseProps = {
    connected: true,
    activeAgentId: 'agent-1',
    activeAgentLabel: 'Forge › test',
    activeAgentStatus: 'idle' as const,
    channelView: 'web' as const,
    onChannelViewChange: vi.fn(),
    contextWindowUsage: null,
    showCompact: false,
    compactInProgress: false,
    onCompact: vi.fn(),
    showSmartCompact: false,
    smartCompactInProgress: false,
    onSmartCompact: vi.fn(),
    showStopAll: false,
    stopAllInProgress: false,
    stopAllDisabled: false,
    onStopAll: vi.fn(),
    showNewChat: false,
    onNewChat: vi.fn(),
    isArtifactsPanelOpen: false,
    onToggleArtifactsPanel: vi.fn(),
    onToggleFileBrowser: vi.fn(),
    onOpenDiffViewer: vi.fn(),
  }

  it('hides desktop workspace actions when showDesktopWorkspaceActions is false', () => {
    act(() => {
      root = createRoot(container)
      root.render(createElement(ChatHeader, { ...baseProps, showDesktopWorkspaceActions: false }))
    })

    const workspaceGroup = container.querySelector('.md\\:hidden')
    expect(workspaceGroup).not.toBeNull()
    expect(workspaceGroup?.querySelector('button[aria-label="Browse Files"]')).not.toBeNull()
  })

  it('keeps desktop workspace actions visible by default', () => {
    act(() => {
      root = createRoot(container)
      root.render(createElement(ChatHeader, baseProps))
    })

    const workspaceGroup = container.querySelector('.md\\:hidden')
    expect(workspaceGroup).toBeNull()
    expect(container.querySelector('button[aria-label="Browse Files"]')).not.toBeNull()
  })

  it('invokes header artifacts toggle handler when panel is open', () => {
    const onToggleArtifactsPanel = vi.fn()

    act(() => {
      root = createRoot(container)
      root.render(
        createElement(ChatHeader, {
          ...baseProps,
          isArtifactsPanelOpen: true,
          onToggleArtifactsPanel,
        }),
      )
    })

    const artifactsButton = container.querySelector('button[aria-label="Close artifacts"]')
    expect(artifactsButton).not.toBeNull()

    act(() => {
      artifactsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onToggleArtifactsPanel).toHaveBeenCalledTimes(1)
  })
})
