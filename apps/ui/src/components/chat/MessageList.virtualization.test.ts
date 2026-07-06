/** @vitest-environment jsdom */

/**
 * Merge-blocking tests for WP-U2 — MessageList virtualization.
 *
 * Covers the hard parts called out in the spec:
 *  - only the ~viewport subset of rows is mounted (windowing)
 *  - scroll-to-message lands on an off-screen row (pins / reply / navigation)
 *  - stick-to-bottom during appended messages, and no yank when scrolled up
 *  - search-jump to an off-screen match mounts + flashes the target row
 *  - a 2,000-message fixture mounts only a small bounded number of rows (perf)
 *
 * jsdom has no layout engine, so a shared harness stubs the measurements the
 * virtualizer relies on (viewport height, per-row height, scrollTop). See
 * `message-list/test-virtualization-harness.ts`.
 */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationEntry } from '@forge/protocol'
import { MessageList, type MessageListHandle } from './MessageList'
import {
  installVirtualizationHarness,
  type VirtualizationHarness,
} from './message-list/test-virtualization-harness'

let root: Root
let container: HTMLDivElement
let virt: VirtualizationHarness | null
const now = '2026-05-30T00:00:00.000Z'
const originalResizeObserver = globalThis.ResizeObserver
const originalRequestAnimationFrame = globalThis.requestAnimationFrame
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame

const ROW_HEIGHT = 96

class ResizeObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  virt = null
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
  // Deferred (not synchronous) rAF: the virtualizer schedules scroll reconcile
  // via rAF, so a synchronous shim would recurse infinitely. setTimeout(0)
  // matches the existing MessageList test harness and stays flushable.
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    window.setTimeout(() => cb(Date.now()), 0)) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = ((id: number) =>
    window.clearTimeout(id)) as typeof cancelAnimationFrame
})

/** Flush pending macrotasks (setTimeout-based rAF settle callbacks). */
async function flushFrames(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  virt?.restore()
  globalThis.ResizeObserver = originalResizeObserver
  globalThis.requestAnimationFrame = originalRequestAnimationFrame
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame
  vi.restoreAllMocks()
})

/** Build N user messages with stable, addressable ids. */
function makeMessages(count: number): ConversationEntry[] {
  const messages: ConversationEntry[] = []
  for (let i = 0; i < count; i++) {
    messages.push({
      type: 'conversation_message',
      agentId: 'session-1',
      id: `msg-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `message ${i}`,
      timestamp: `2026-05-30T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      source: i % 2 === 0 ? 'user_input' : 'speak_to_user',
    } as Extract<ConversationEntry, { type: 'conversation_message' }>)
  }
  return messages
}

function render(
  messages: ConversationEntry[],
  extraProps: Record<string, unknown> = {},
  ref?: { current: MessageListHandle | null },
) {
  flushSync(() => {
    root.render(
      createElement(MessageList, {
        ref,
        messages,
        isLoading: false,
        activeAgentId: 'session-1',
        pendingChoiceIds: new Set<string>(),
        agents: [],
        statuses: {},
        ...extraProps,
      }),
    )
  })
}

function scrollContainer(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.overflow-y-auto')
  if (!el) throw new Error('scroll container not found')
  return el
}

/** Count mounted transcript rows (each conversation message wrapper). */
function mountedMessageRows(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'))
}

function mountedMessageIds(): string[] {
  return mountedMessageRows().map((el) => el.getAttribute('data-message-id') ?? '')
}

describe('MessageList virtualization — windowing', () => {
  it('mounts only the viewport subset, not every message', async () => {
    // 500px viewport, 96px rows → ~5-6 visible + overscan; far fewer than 300.
    virt = installVirtualizationHarness({ viewportHeight: 500, rowHeight: ROW_HEIGHT })
    render(makeMessages(300))
    await flushFrames()

    const mounted = mountedMessageIds()
    expect(mounted.length).toBeGreaterThan(0)
    // Generous ceiling: visible (~6) + overscan (8 each side) + slack.
    expect(mounted.length).toBeLessThan(40)
    // The mounted set is a contiguous window of the full list.
    const indexes = mounted
      .map((id) => Number.parseInt(id.replace('msg-', ''), 10))
      .sort((a, b) => a - b)
    for (let i = 1; i < indexes.length; i++) {
      expect(indexes[i]).toBe(indexes[i - 1] + 1)
    }
    // Initial paint is pinned to the bottom → newest message mounted.
    expect(mounted).toContain('msg-299')
  })

  it('renders the correct visible subset near the top after scrolling up', async () => {
    virt = installVirtualizationHarness({ viewportHeight: 500, rowHeight: ROW_HEIGHT })
    const ref = { current: null as MessageListHandle | null }
    render(makeMessages(300), {}, ref)
    await flushFrames()

    // Scroll to the very top.
    await act(async () => {
      virt!.scrollTo(scrollContainer(), 0)
    })

    const indexes = mountedMessageIds()
      .map((id) => Number.parseInt(id.replace('msg-', ''), 10))
      .sort((a, b) => a - b)

    // Near the top, msg-0 must be in the window and late messages must not be.
    expect(indexes[0]).toBe(0)
    expect(indexes.at(-1)!).toBeLessThan(40)
    expect(mountedMessageIds()).not.toContain('msg-299')
  })
})

describe('MessageList virtualization — scroll-to-message', () => {
  it('scrolls an off-screen message into the mounted set and flashes it', async () => {
    virt = installVirtualizationHarness({ viewportHeight: 500, rowHeight: ROW_HEIGHT })
    const ref = { current: null as MessageListHandle | null }
    render(makeMessages(300), {}, ref)
    await flushFrames()

    // A middle message is initially off-screen (view starts pinned to bottom).
    expect(mountedMessageIds()).not.toContain('msg-40')

    await act(async () => {
      ref.current?.scrollToMessage('msg-40')
    })
    await flushFrames()

    const target = container.querySelector('[data-message-id="msg-40"]')
    expect(target).toBeTruthy()
    // Flash highlight applied to the landed row.
    expect(target?.classList.contains('pin-nav-highlight')).toBe(true)
  })

  it('keeps the target mounted across the settle window (transient pin)', async () => {
    virt = installVirtualizationHarness({ viewportHeight: 400, rowHeight: ROW_HEIGHT })
    const ref = { current: null as MessageListHandle | null }
    render(makeMessages(300), {}, ref)
    await flushFrames()

    await act(async () => {
      ref.current?.scrollToMessage('msg-150')
    })

    expect(container.querySelector('[data-message-id="msg-150"]')).toBeTruthy()
  })
})

describe('MessageList virtualization — stick-to-bottom', () => {
  it('pins to the newest message when a message is appended at the bottom', async () => {
    virt = installVirtualizationHarness({ viewportHeight: 500, rowHeight: ROW_HEIGHT })
    const messages = makeMessages(50)
    const ref = { current: null as MessageListHandle | null }
    render(messages, {}, ref)
    await flushFrames()

    // Initial force-scroll lands at the bottom → last message mounted.
    expect(mountedMessageIds()).toContain('msg-49')

    // Append one more message while the user is at the bottom.
    const grown = [
      ...messages,
      {
        type: 'conversation_message',
        agentId: 'session-1',
        id: 'msg-50',
        role: 'assistant',
        text: 'freshly appended',
        timestamp: now,
        source: 'speak_to_user',
      } as Extract<ConversationEntry, { type: 'conversation_message' }>,
    ]
    render(grown, {}, ref)
    await flushFrames()

    // View stays pinned to the newest message.
    expect(mountedMessageIds()).toContain('msg-50')
    const c = scrollContainer()
    expect(c.scrollTop + c.clientHeight).toBeGreaterThanOrEqual(c.scrollHeight - 100)
  })

  it('does not yank a scrolled-up user to the bottom on append', async () => {
    virt = installVirtualizationHarness({ viewportHeight: 500, rowHeight: ROW_HEIGHT })
    const messages = makeMessages(50)
    const ref = { current: null as MessageListHandle | null }
    render(messages, {}, ref)
    await flushFrames()

    // User scrolls up to the middle.
    await act(async () => {
      virt!.scrollTo(scrollContainer(), 20 * ROW_HEIGHT)
    })
    const scrollBefore = scrollContainer().scrollTop
    expect(mountedMessageIds()).not.toContain('msg-49')

    // Append a message.
    const grown = [
      ...messages,
      {
        type: 'conversation_message',
        agentId: 'session-1',
        id: 'msg-50',
        role: 'assistant',
        text: 'appended while scrolled up',
        timestamp: now,
        source: 'speak_to_user',
      } as Extract<ConversationEntry, { type: 'conversation_message' }>,
    ]
    render(grown, {}, ref)
    await flushFrames()

    // The view was NOT yanked to the bottom.
    expect(scrollContainer().scrollTop).toBe(scrollBefore)
    expect(mountedMessageIds()).not.toContain('msg-50')
  })
})

describe('MessageList virtualization — search jump', () => {
  it('scroll-to-message mounts an off-screen search match for DOM highlighting', async () => {
    virt = installVirtualizationHarness({ viewportHeight: 500, rowHeight: ROW_HEIGHT })
    const ref = { current: null as MessageListHandle | null }
    // The consumer (BuilderSurface) computes matches from data, then calls
    // scrollToMessage(match.messageId); useSearchHighlight then walks the DOM.
    // Here we assert the row for an off-screen match becomes a real DOM node.
    render(makeMessages(300), {}, ref)
    await flushFrames()

    const offScreenMatchId = 'msg-12'
    expect(mountedMessageIds()).not.toContain(offScreenMatchId)

    await act(async () => {
      ref.current?.scrollToMessage(offScreenMatchId)
    })
    await flushFrames()

    const matchRow = container.querySelector(`[data-message-id="${offScreenMatchId}"]`)
    expect(matchRow).toBeTruthy()
    // The rendered text is present for the highlight DOM-walk to find.
    expect(matchRow?.textContent).toContain('message 12')
  })
})

describe('MessageList virtualization — large transcript perf', () => {
  it('mounts only a small bounded number of rows for a 2,000-message fixture', async () => {
    virt = installVirtualizationHarness({ viewportHeight: 800, rowHeight: ROW_HEIGHT })
    render(makeMessages(2000))
    await flushFrames()

    const mounted = mountedMessageRows().length
    // 800px / 96px ≈ 9 visible; + overscan 8 each side ≈ ~25. Assert a hard
    // ceiling well below the full 2,000 to prove only ~viewport rows mount.
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(60)
    // And categorically far fewer than the full fixture.
    expect(mounted).toBeLessThan(2000 / 10)
  })

  it('mounts a bounded window after scrolling into the middle of 2,000 messages', async () => {
    virt = installVirtualizationHarness({ viewportHeight: 800, rowHeight: ROW_HEIGHT })
    render(makeMessages(2000))
    await flushFrames()

    await act(async () => {
      virt!.scrollTo(scrollContainer(), 1000 * ROW_HEIGHT)
    })

    const rows = mountedMessageRows().length
    expect(rows).toBeGreaterThan(0)
    expect(rows).toBeLessThan(60)

    // The window is centered around index ~1000, not around 0 or the end.
    const indexes = mountedMessageIds()
      .map((id) => Number.parseInt(id.replace('msg-', ''), 10))
      .sort((a, b) => a - b)
    expect(indexes[0]).toBeGreaterThan(900)
    expect(indexes.at(-1)!).toBeLessThan(1100)
  })
})
