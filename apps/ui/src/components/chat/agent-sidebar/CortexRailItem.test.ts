/** @vitest-environment jsdom */

import { fireEvent, getByRole, getByText, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import { CortexRailItem } from './CortexRailItem'
import { TooltipProvider } from '@/components/ui/tooltip'

// Radix Popover observes its portal content in browser environments.
globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver

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

describe('CortexRailItem', () => {
  it('opens the reusable navigator, selects non-root sessions, exposes actions, and restores focus', async () => {
    const onSelect = vi.fn()
    const onStopSession = vi.fn()
    const onMarkAllRead = vi.fn()
    const rootSession = makeAgent({ status: 'streaming', sessionLabel: 'Main' })
    const reviewSession = makeAgent({
      agentId: 'cortex-review',
      managerId: 'cortex-review',
      sessionLabel: 'Review Run',
      status: 'idle',
    })

    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(TooltipProvider, null, createElement(CortexRailItem, {
        cortexRow: {
          profile: makeProfile(),
          sessions: [
            { sessionAgent: rootSession, workers: [], isDefault: true },
            { sessionAgent: reviewSession, workers: [], isDefault: false },
          ],
        },
        statuses: { 'cortex-root': { status: 'streaming', pendingCount: 0 } },
        unreadCounts: { 'cortex-root': 2 },
        selectedAgentId: null,
        isSettingsActive: false,
        onSelect,
        onDeleteAgent: vi.fn(),
        onOpenSettings: vi.fn(),
        onStopSession,
        onMarkAllRead,
      })))
    })

    const trigger = getByRole(container, 'button', { name: 'Cortex' })
    trigger.focus()
    fireEvent.click(trigger)

    const popover = await waitFor(() => {
      const content = document.body.querySelector('[data-slot="popover-content"]') as HTMLElement | null
      expect(content).not.toBeNull()
      return content as HTMLElement
    })
    expect(popover.getAttribute('aria-label')).toBe('Cortex navigator')
    fireEvent.click(getByText(popover, 'Review Run').closest('button') as HTMLButtonElement)
    expect(onSelect).toHaveBeenCalledWith('cortex-review')

    fireEvent.contextMenu(getByText(popover, 'Cortex'))
    const stop = await waitFor(() => getByRole(document.body, 'menuitem', { name: 'Stop Root Session' }))
    fireEvent.click(stop)
    expect(onStopSession).toHaveBeenCalledWith('cortex-root')

    fireEvent.contextMenu(getByText(popover, 'Cortex'))
    const markRead = await waitFor(() => getByRole(document.body, 'menuitem', { name: 'Mark All as Read' }))
    fireEvent.click(markRead)
    expect(onMarkAllRead).toHaveBeenCalledWith('cortex-profile')

    fireEvent.contextMenu(getByText(popover, 'Cortex'))
    const mute = await waitFor(() => getByRole(document.body, 'menuitem', { name: 'Mute All Sessions' }))
    fireEvent.click(mute)

    fireEvent.contextMenu(getByText(popover, 'Cortex'))
    await waitFor(() => expect(getByRole(document.body, 'menuitem', { name: 'Unmute All Sessions' })).toBeTruthy())

    fireEvent.keyDown(popover, { key: 'Escape', code: 'Escape' })
    await waitFor(() => expect(document.body.querySelector('[data-slot="popover-content"]')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })
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
    model: { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514', thinkingLevel: 'none' },
    sessionFile: '/tmp/cortex-root.jsonl',
    sessionLabel: 'Main',
    profileId: 'cortex-profile',
    archetypeId: 'cortex',
    ...overrides,
  }
}

function makeProfile(): ManagerProfile {
  return {
    profileId: 'cortex-profile',
    displayName: 'Cortex',
    defaultSessionAgentId: 'cortex-root',
    defaultModel: { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514', thinkingLevel: 'none' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}
