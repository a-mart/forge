/** @vitest-environment jsdom */

import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentDisplayMeta } from './agent-display-utils'
import { ToolLogRow } from './ToolLogRow'
import type { ToolExecutionDisplayEntry } from './types'

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

function makeToolEntry(
  overrides: Partial<ToolExecutionDisplayEntry> = {},
): ToolExecutionDisplayEntry {
  return {
    id: 'tool-1',
    toolName: 'bash',
    toolCallId: 'tc-1',
    inputPayload: '{"command":"echo hello"}',
    latestPayload: '{"command":"echo hello"}',
    timestamp: '2026-01-15T10:00:00.000Z',
    startTimestamp: '2026-01-15T09:59:59.000Z',
    latestKind: 'tool_execution_end',
    isError: false,
    ...overrides,
  }
}

function makeActorDisplay(overrides: Partial<AgentDisplayMeta> = {}): AgentDisplayMeta {
  return {
    agentId: 'worker-1',
    primaryLabel: 'Backend specialist',
    secondaryLabel: 'anthropic/claude-opus-4-6 · high',
    specialistColor: '#3b82f6',
    title: 'worker-1 — Backend specialist — anthropic/claude-opus-4-6 · high',
    ...overrides,
  }
}

describe('ToolLogRow actor metadata rendering', () => {
  it('renders actor label chip when actorDisplay is provided', () => {
    const entry = makeToolEntry({ actorAgentId: 'worker-1' })
    const actorDisplay = makeActorDisplay()

    act(() => {
      root.render(
        createElement(ToolLogRow, {
          type: 'tool_execution',
          entry,
          actorDisplay,
        }),
      )
    })

    expect(container.textContent).toContain('Backend specialist')
  })

  it('renders specialist color dot when specialistColor is provided', () => {
    const entry = makeToolEntry({ actorAgentId: 'worker-1' })
    const actorDisplay = makeActorDisplay({ specialistColor: '#ff0000' })

    act(() => {
      root.render(
        createElement(ToolLogRow, {
          type: 'tool_execution',
          entry,
          actorDisplay,
        }),
      )
    })

    const dot = container.querySelector('span[style*="background-color"]')
    expect(dot).not.toBeNull()
    expect((dot as HTMLElement).style.backgroundColor).toBe('rgb(255, 0, 0)')
  })

  it('does not render specialist color dot when specialistColor is null', () => {
    const entry = makeToolEntry({ actorAgentId: 'worker-1' })
    const actorDisplay = makeActorDisplay({ specialistColor: null })

    act(() => {
      root.render(
        createElement(ToolLogRow, {
          type: 'tool_execution',
          entry,
          actorDisplay,
        }),
      )
    })

    const dot = container.querySelector('span[style*="background-color"]')
    expect(dot).toBeNull()
  })

  it('falls back to raw actorAgentId when actorDisplay is absent', () => {
    const entry = makeToolEntry({ actorAgentId: 'worker-raw-id' })

    act(() => {
      root.render(
        createElement(ToolLogRow, {
          type: 'tool_execution',
          entry,
        }),
      )
    })

    expect(container.textContent).toContain('worker-raw-id')
    expect(container.textContent).not.toContain('Backend specialist')
  })

  it('does not render actor chip when both actorDisplay and actorAgentId are absent', () => {
    const entry = makeToolEntry({ actorAgentId: undefined })

    act(() => {
      root.render(
        createElement(ToolLogRow, {
          type: 'tool_execution',
          entry,
        }),
      )
    })

    // Should still render the tool message but no actor chip
    expect(container.textContent).toContain('Ran command')
    // No chip with border class should be present for actor
    const chips = container.querySelectorAll('span.mr-1\\.5')
    expect(chips.length).toBe(0)
  })

  it('distinguishes explicit secure container commands from legacy-compatible commands', () => {
    const entry = makeToolEntry({
      toolName: 'secure_bash',
      inputPayload: '{"command":"ssh deployment true"}',
    })

    act(() => {
      root.render(
        createElement(ToolLogRow, {
          type: 'tool_execution',
          entry,
        }),
      )
    })

    expect(container.textContent).toContain('Ran secure command')
    expect(container.textContent).toContain('ssh deployment true')
  })

  it('shows secondaryLabel in expanded footer', () => {
    const entry = makeToolEntry({ actorAgentId: 'worker-1' })
    const actorDisplay = makeActorDisplay({
      secondaryLabel: 'Docs worker · anthropic/claude-opus-4-6 · high',
    })

    act(() => {
      root.render(
        createElement(ToolLogRow, {
          type: 'tool_execution',
          entry,
          actorDisplay,
        }),
      )
    })

    // Click to expand
    const expandButton = container.querySelector<HTMLButtonElement>('button[aria-expanded]')
    expect(expandButton).not.toBeNull()

    act(() => {
      expandButton?.click()
    })

    expect(container.textContent).toContain(
      'Docs worker · anthropic/claude-opus-4-6 · high',
    )
  })

  it('uses actorDisplay.title as tooltip on the actor chip', () => {
    const entry = makeToolEntry({ actorAgentId: 'worker-1' })
    const actorDisplay = makeActorDisplay({
      title: 'worker-1 — Backend specialist — anthropic/claude-opus-4-6',
    })

    act(() => {
      root.render(
        createElement(ToolLogRow, {
          type: 'tool_execution',
          entry,
          actorDisplay,
        }),
      )
    })

    const chip = container.querySelector(
      'span[title="worker-1 — Backend specialist — anthropic/claude-opus-4-6"]',
    )
    expect(chip).not.toBeNull()
  })
})

describe('ToolLogRow Codex detail labels', () => {
  it('renders codex command labels and command detail', () => {
    const entry = makeToolEntry({
      toolName: 'codex_command',
      inputPayload: '{"command":"pnpm test"}',
      latestPayload: '{"command":"pnpm test","status":"completed"}',
      latestKind: 'tool_execution_end',
    })

    act(() => {
      root.render(createElement(ToolLogRow, { type: 'tool_execution', entry }))
    })

    expect(container.textContent).toContain('Codex ran command')
    expect(container.textContent).toContain('pnpm test')
  })

  it('renders cancelled Codex detail rows from payload status', () => {
    const entry = makeToolEntry({
      toolName: 'codex_command',
      latestKind: 'tool_execution_end',
      isError: false,
      latestPayload: JSON.stringify({
        status: 'cancelled',
        note: 'Codex item closed on turn cancelled.',
      }),
    })

    act(() => {
      root.render(createElement(ToolLogRow, { type: 'tool_execution', entry }))
    })

    expect(container.textContent).toContain('Codex command cancelled')
  })

  it('renders codex MCP labels with server/tool detail', () => {
    const entry = makeToolEntry({
      toolName: 'codex_mcp_tool',
      inputPayload: '{"server":"forge","tool":"search"}',
      latestPayload: '{"server":"forge","tool":"search","status":"inProgress"}',
      latestKind: 'tool_execution_start',
    })

    act(() => {
      root.render(createElement(ToolLogRow, { type: 'tool_execution', entry }))
    })

    expect(container.textContent).toContain('Codex MCP tool running')
    expect(container.textContent).toContain('forge/search')
  })
})
