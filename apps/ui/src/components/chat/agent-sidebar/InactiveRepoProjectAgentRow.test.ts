/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InactiveRepoProjectAgentRow } from './InactiveRepoProjectAgentRow'
import type { RepoProjectAgentSidebarEntry } from '@/hooks/use-inactive-repo-project-agents'

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

function makeEntry(overrides: Partial<RepoProjectAgentSidebarEntry['item']> = {}, activatable = true): RepoProjectAgentSidebarEntry {
  return {
    profileId: 'profile-a',
    sessionAgentId: 'session-a',
    activatable,
    item: {
      definitionId: 'def-docs',
      handle: 'docs',
      path: '/repo/.forge/project-agents/def-docs',
      status: activatable ? 'valid' : 'invalid',
      problems: [],
      displayName: 'Docs Agent',
      whenToUse: 'Use for documentation tasks',
      ...overrides,
    },
  }
}

describe('InactiveRepoProjectAgentRow', () => {
  it('renders inactive repository project agent label and calls onSelect when clicked', () => {
    const onSelect = vi.fn()
    const entry = makeEntry()

    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(InactiveRepoProjectAgentRow, {
        entry,
        isSelected: false,
        onSelect,
      }))
    })

    expect(container.textContent).toContain('Docs Agent')
    const button = container.querySelector('button')
    expect(button).toBeTruthy()
    button?.click()
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('shows selected styling when isSelected is true', () => {
    const entry = makeEntry()

    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(InactiveRepoProjectAgentRow, {
        entry,
        isSelected: true,
        onSelect: vi.fn(),
      }))
    })

    const button = container.querySelector('button')
    expect(button?.className).toContain('ring-1')
  })

  it('uses muted styling for unavailable definitions', () => {
    const entry = makeEntry({ status: 'wrong_workspace' }, false)

    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(InactiveRepoProjectAgentRow, {
        entry,
        isSelected: false,
        onSelect: vi.fn(),
      }))
    })

    const button = container.querySelector('button')
    expect(button?.className).toContain('text-sidebar-foreground/40')
    expect(button?.getAttribute('aria-label')).toContain('unavailable')
  })
})
