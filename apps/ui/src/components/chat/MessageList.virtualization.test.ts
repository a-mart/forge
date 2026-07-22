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
const originalIntersectionObserver = globalThis.IntersectionObserver
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
  globalThis.IntersectionObserver = originalIntersectionObserver
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
  it('defers ResizeObserver row measurements to a frame to avoid dropped layout updates', async () => {
    virt = installVirtualizationHarness({ viewportHeight: 500, rowHeight: ROW_HEIGHT })

    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    if (!offsetHeight?.get) throw new Error('virtualization harness did not install offsetHeight')

    let insideObserverCallback = false
    let measuredSynchronously = false
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (insideObserverCallback) measuredSynchronously = true
        return offsetHeight.get?.call(this) as number
      },
    })

    class ImmediateRowResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (!target.hasAttribute('data-index')) return
        insideObserverCallback = true
        this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver)
        insideObserverCallback = false
      }
      disconnect() {}
      unobserve() {}
    }
    globalThis.ResizeObserver = ImmediateRowResizeObserver as unknown as typeof ResizeObserver

    render(makeMessages(30))

    // react-virtual must schedule the measurement rather than reading layout
    // inside ResizeObserver delivery, where synchronous repositioning can make
    // Chromium drop later notifications and leave rows at estimated heights.
    expect(measuredSynchronously).toBe(false)
    await flushFrames()
  })

  it('keeps mounted row positions non-overlapping when a row reflows during smooth scroll', async () => {
    virt = installVirtualizationHarness({ viewportHeight: 500, rowHeight: ROW_HEIGHT })

    const baseOffsetHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'offsetHeight',
    )
    if (!baseOffsetHeight?.get) {
      throw new Error('virtualization harness did not install offsetHeight')
    }

    const rowHeights = new Map<number, number>()
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        const index = Number.parseInt(this.dataset.index ?? '', 10)
        return rowHeights.get(index) ?? (baseOffsetHeight.get?.call(this) as number)
      },
    })

    const observers = new Set<{
      instance: ResizeObserver
      callback: ResizeObserverCallback
      targets: Set<Element>
    }>()
    class ManualResizeObserver {
      readonly registration: {
        instance: ResizeObserver
        callback: ResizeObserverCallback
        targets: Set<Element>
      }

      constructor(callback: ResizeObserverCallback) {
        this.registration = {
          instance: this as unknown as ResizeObserver,
          callback,
          targets: new Set(),
        }
        observers.add(this.registration)
      }

      observe(target: Element) {
        this.registration.targets.add(target)
      }

      unobserve(target: Element) {
        this.registration.targets.delete(target)
      }

      disconnect() {
        this.registration.targets.clear()
        observers.delete(this.registration)
      }
    }
    globalThis.ResizeObserver = ManualResizeObserver as unknown as typeof ResizeObserver

    const notifyRowResize = (target: Element) => {
      for (const observer of observers) {
        if (observer.targets.has(target)) {
          observer.callback(
            [{ target } as ResizeObserverEntry],
            observer.instance,
          )
        }
      }
    }
    const rowPosition = (index: number) => {
      const node = container.querySelector<HTMLElement>(`[data-index="${index}"]`)
      if (!node) throw new Error(`virtual row ${index} is not mounted`)
      const match = /translateY\((-?[\d.]+)px\)/.exec(node.style.transform)
      if (!match) throw new Error(`virtual row ${index} has no translateY position`)
      return {
        node,
        start: Number.parseFloat(match[1]),
        end: Number.parseFloat(match[1]) + node.offsetHeight,
      }
    }

    const ref = { current: null as MessageListHandle | null }
    render(makeMessages(30), {}, ref)
    await flushFrames()

    const scroller = scrollContainer()
    await act(async () => {
      virt!.scrollTo(scroller, scroller.scrollHeight - scroller.clientHeight - 240)
    })

    // Keep the virtualizer's smooth-scroll state active. Real browsers advance
    // toward the target over multiple frames; the harness normally applies the
    // final scroll offset immediately, which would hide this race.
    const immediateScrollTo = scroller.scrollTo.bind(scroller)
    scroller.scrollTo = ((options?: ScrollToOptions | number, y?: number) => {
      if (typeof options === 'object' && options?.behavior === 'smooth') return
      if (typeof options === 'number') {
        immediateScrollTo(options, y ?? 0)
      } else {
        immediateScrollTo(options)
      }
    }) as typeof scroller.scrollTo

    await act(async () => {
      ref.current?.scrollToBottom('smooth')
    })

    const mountedIndexes = Array.from(
      container.querySelectorAll<HTMLElement>('[data-index]'),
      (node) => Number.parseInt(node.dataset.index ?? '', 10),
    ).filter(Number.isFinite).sort((a, b) => a - b)
    // Nine rows before the last/target row is still mounted by overscan, but it
    // sits just outside the virtualizer's eight-row smooth-scroll buffer.
    const resizedIndex = mountedIndexes.at(-10)
    if (resizedIndex === undefined) throw new Error('too few virtual rows mounted')
    const nextIndex = resizedIndex + 1
    expect(mountedIndexes).toContain(nextIndex)

    const before = rowPosition(resizedIndex)
    const nextBefore = rowPosition(nextIndex)
    expect(nextBefore.start).toBeGreaterThanOrEqual(before.end)

    // This mounted overscan row is outside TanStack Virtual's buffer around the
    // smooth-scroll target. Its ResizeObserver notification must still update
    // downstream transforms when its real DOM height changes.
    rowHeights.set(resizedIndex, ROW_HEIGHT + 240)
    notifyRowResize(before.node)
    await flushFrames()

    const after = rowPosition(resizedIndex)
    const nextAfter = rowPosition(nextIndex)
    expect(nextAfter.start).toBeGreaterThanOrEqual(after.end)
  })

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

  it('preserves the visible anchor when an automatic older page is prepended', async () => {
    virt = installVirtualizationHarness({ viewportHeight: 500, rowHeight: ROW_HEIGHT })
    let intersectionCallback: IntersectionObserverCallback | null = null
    class IntersectionObserverStub {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    globalThis.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver

    const messages = makeMessages(50)
    const onLoadOlder = vi.fn()
    render(messages, { hasOlder: true, olderCursor: 'cursor-1', onLoadOlder })
    await flushFrames()

    await act(async () => {
      virt!.scrollTo(scrollContainer(), 0)
    })
    const before = scrollContainer().scrollTop
    const beforeIds = mountedMessageIds()
    const sentinel = container.querySelector('[data-testid="older-history-sentinel"]')
    if (!sentinel || !intersectionCallback) throw new Error('older history sentinel was not observed')

    await act(async () => {
      const notify: IntersectionObserverCallback = intersectionCallback!
      notify(
        [{ isIntersecting: true, target: sentinel } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      )
    })
    expect(onLoadOlder).toHaveBeenCalledOnce()

    const older: ConversationEntry[] = Array.from({ length: 10 }, (_, index) => ({
      type: 'conversation_message',
      agentId: 'session-1',
      id: `older-${index}`,
      role: 'assistant',
      text: `older message ${index}`,
      timestamp: now,
      source: 'speak_to_user',
    }))
    render([...older, ...messages], {
      hasOlder: true,
      olderCursor: 'cursor-2',
      onLoadOlder,
      historyMutation: { revision: 1, kind: 'prepend' },
    })
    await flushFrames()

    expect(scrollContainer().scrollTop).toBe(before + older.length * ROW_HEIGHT)
    expect(mountedMessageIds().some((id) => beforeIds.includes(id))).toBe(true)
  })

  it('resets to the newest content when a larger history replacement changes identity', async () => {
    virt = installVirtualizationHarness({ viewportHeight: 500, rowHeight: ROW_HEIGHT })
    render(makeMessages(20), {
      historyMutation: { revision: 1, kind: 'replace' },
    })
    await flushFrames()

    await act(async () => {
      virt!.scrollTo(scrollContainer(), 5 * ROW_HEIGHT)
    })

    const replacement = makeMessages(30).map((message, index) => ({
      ...message,
      id: `replacement-${index}`,
      text: `replacement ${index}`,
    }))
    render(replacement, {
      historyMutation: { revision: 2, kind: 'replace' },
    })
    await flushFrames()

    expect(mountedMessageIds()).toContain('replacement-29')
    const scroll = scrollContainer()
    expect(scroll.scrollTop + scroll.clientHeight).toBeGreaterThanOrEqual(scroll.scrollHeight - 100)
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

/**
 * Regression guard for the React #185 ("Maximum update depth exceeded") render
 * cascade root-caused in UI-RELOAD-LOOP-INVESTIGATION.md §2(d): the scroll
 * effects used to depend on `scrollToBottom`, whose identity changed every
 * render in a real browser (it closes over the virtualizer, whose returned
 * object identity churns as `measureElement` resolves real row heights across
 * frames). That made the ResizeObserver effect tear down and re-install a NEW
 * observer on every render, and the observer's callback drives setState →
 * re-render → new observer → …, a self-feeding loop on large transcripts.
 *
 * HARNESS LIMITATION (deliberate + documented): jsdom has no layout engine, so
 * `measureElement` never shifts and the virtualizer's identity stays stable —
 * meaning the `[scrollEl, scrollToBottom]` effect does NOT re-fire per render in
 * this harness even with the pre-fix deps. These tests therefore CANNOT
 * reproduce the live cascade and are not red-on-pre-fix. What they DO lock in is
 * the stabilized-callback contract the fix establishes and which the harness can
 * observe: (1) the observer is installed via a ref-read + element-keyed effect,
 * so it is created once at mount and NEVER grows across re-renders; (2) firing
 * that observer repeatedly under `isLoading` + a 1000-row list settles without
 * throwing or spawning observers. The invariant that the observer is created
 * exactly once per element (not per render) is verified live in the fix's ref
 * indirection; the true per-render-churn behavior must be re-checked in a real
 * large session (see report).
 */
describe('MessageList virtualization — scroll-effect stability (React #185 guard)', () => {
  it('installs zero additional ResizeObservers across a growing, streaming re-render sequence', async () => {
    virt = installVirtualizationHarness({ viewportHeight: 800, rowHeight: ROW_HEIGHT })

    let constructed = 0
    class CountingResizeObserver {
      constructor(_cb: ResizeObserverCallback) {
        constructed += 1
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    globalThis.ResizeObserver = CountingResizeObserver as unknown as typeof ResizeObserver

    const messages = makeMessages(1000)
    const ref = { current: null as MessageListHandle | null }
    render(messages, { isLoading: true }, ref)
    await flushFrames()

    // Baseline: however many the mount-time scrollEl settling produced (bounded).
    const afterMount = constructed
    expect(afterMount).toBeGreaterThan(0)

    // Re-render repeatedly with a growing, still-streaming transcript. The effect
    // is keyed only on the scroll element and reads scrollToBottom from a ref, so
    // no new observer is created while the element is stable — the delta stays 0.
    for (let i = 0; i < 25; i++) {
      messages.push({
        type: 'conversation_message',
        agentId: 'session-1',
        id: `stream-${i}`,
        role: 'assistant',
        text: `streaming chunk ${i}`,
        timestamp: now,
        source: 'speak_to_user',
      } as Extract<ConversationEntry, { type: 'conversation_message' }>)
      render([...messages], { isLoading: true }, ref)
    }
    await flushFrames()

    // No per-render churn: the observer set did not grow with re-renders.
    expect(constructed - afterMount).toBe(0)
  })

  it('settles when the ResizeObserver fires under isLoading (no render loop, no observer growth)', async () => {
    virt = installVirtualizationHarness({ viewportHeight: 800, rowHeight: ROW_HEIGHT })

    // An observer that invokes its callback immediately on observe() AND retains
    // the callbacks so we can fire them on demand — reproducing the measured-size
    // oscillation that drove the cascade.
    let constructed = 0
    const callbacks: ResizeObserverCallback[] = []
    class FiringResizeObserver {
      cb: ResizeObserverCallback
      constructor(cb: ResizeObserverCallback) {
        constructed += 1
        this.cb = cb
        callbacks.push(cb)
      }
      observe() {
        // Fire synchronously on observe, as a real RO does after the first layout.
        this.cb([], this as unknown as ResizeObserver)
      }
      disconnect() {}
      unobserve() {}
    }
    globalThis.ResizeObserver = FiringResizeObserver as unknown as typeof ResizeObserver

    const messages = makeMessages(1000)
    const ref = { current: null as MessageListHandle | null }

    // Mounting a 1000-row streaming list while the observer fires on install must
    // converge, not recurse into #185.
    expect(() => {
      render(messages, { isLoading: true }, ref)
    }).not.toThrow()
    await flushFrames()

    const afterMount = constructed
    expect(afterMount).toBeGreaterThan(0)

    // Fire the (stable) observer callbacks repeatedly by hand — simulating
    // continued size oscillation. Each fire calls scrollToBottom via the ref;
    // none of them may install a new observer or throw.
    await act(async () => {
      for (let i = 0; i < 30; i++) {
        for (const cb of callbacks) {
          cb([], null as unknown as ResizeObserver)
        }
      }
    })
    await flushFrames()

    // No new observers were created by the firing cascade.
    expect(constructed - afterMount).toBe(0)
    // The list is still mounted and pinned to the newest row — behavior intact.
    expect(mountedMessageIds()).toContain('msg-999')
  })
})
