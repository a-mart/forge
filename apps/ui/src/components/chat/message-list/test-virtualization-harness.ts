/**
 * jsdom layout stubs for testing @tanstack/react-virtual-backed components.
 *
 * jsdom reports 0 for every layout measurement (`getBoundingClientRect`,
 * `offsetHeight`, `scrollHeight`, `clientHeight`). The virtualizer only emits a
 * render range when the scroll element reports a non-zero height, and it sizes
 * each row from `offsetHeight`. Without stubs the virtualized list mounts zero
 * rows, so every content assertion fails for reasons unrelated to behavior.
 *
 * These stubs give the scroll container a fixed viewport and give each row a
 * fixed measured height, so the virtualizer produces a deterministic, testable
 * window. Callers pick the viewport height; a tall default makes small fixtures
 * render in full (matching pre-virtualization behavior), while an explicit small
 * viewport exercises the windowing/perf path.
 */

export interface VirtualizationHarnessOptions {
  /** Height (px) reported for the scroll container's client/bounding rect. */
  viewportHeight?: number
  /** Height (px) reported for each rendered row via offsetHeight/rect. */
  rowHeight?: number
}

export interface VirtualizationHarness {
  /** Simulate scrolling the container to a given offset and fire `scroll`. */
  scrollTo: (el: HTMLElement, top: number) => void
  restore: () => void
}

const DEFAULT_VIEWPORT_HEIGHT = 10_000
const DEFAULT_ROW_HEIGHT = 96

/**
 * Identify the scroll container: the element the virtualizer observes. In
 * MessageList it is the `overflow-y-auto` div. We treat any element carrying
 * that class as the viewport and everything else as a row.
 */
function isScrollContainer(el: HTMLElement): boolean {
  return el.className.includes('overflow-y-auto')
}

export function installVirtualizationHarness(
  options: VirtualizationHarnessOptions = {},
): VirtualizationHarness {
  const viewportHeight = options.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT
  const rowHeight = options.rowHeight ?? DEFAULT_ROW_HEIGHT

  // Per-element scroll offset store (jsdom's scrollTop is a no-op writable 0).
  const scrollTops = new WeakMap<HTMLElement, number>()

  const rectDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'getBoundingClientRect',
  )
  const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetHeight',
  )
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'scrollHeight',
  )
  const clientHeightDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'clientHeight',
  )
  const scrollTopDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'scrollTop',
  )

  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      const height = isScrollContainer(this) ? viewportHeight : rowHeight
      const scrollContainer = isScrollContainer(this)
        ? this
        : this.closest<HTMLElement>('.overflow-y-auto')
      const translateY = /translateY\((-?[\d.]+)px\)/.exec(this.style.transform)?.[1]
      const top = isScrollContainer(this)
        ? 0
        : Number.parseFloat(translateY ?? '0') - (scrollContainer ? (scrollTops.get(scrollContainer) ?? 0) : 0)
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        right: 0,
        bottom: top + height,
        width: 0,
        height,
        toJSON: () => ({}),
      } as DOMRect
    },
  })

  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      return isScrollContainer(this) ? viewportHeight : rowHeight
    },
  })

  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      return isScrollContainer(this) ? viewportHeight : rowHeight
    },
  })

  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      // Total content height = the virtualizer's spacer height, which is the
      // scroll container's first child height. Fall back to viewport height.
      if (isScrollContainer(this)) {
        const spacer = this.firstElementChild as HTMLElement | null
        const declared = spacer?.style?.height
        const parsed = declared ? Number.parseFloat(declared) : NaN
        return Number.isFinite(parsed) ? parsed : viewportHeight
      }
      return rowHeight
    },
  })

  // A real browser fires `scroll` whenever the offset changes — via user
  // scroll, `scrollTop = x`, or `scrollTo({top})`. The virtualizer's offset
  // observer only learns the new position from that event, so faithfully
  // emulate it here for every write path.
  const applyScroll = (el: HTMLElement, top: number) => {
    const clamped = Math.max(0, top)
    if ((scrollTops.get(el) ?? 0) === clamped) return
    scrollTops.set(el, clamped)
    el.dispatchEvent(new Event('scroll'))
  }

  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement): number {
      return scrollTops.get(this) ?? 0
    },
    set(this: HTMLElement, value: number) {
      applyScroll(this, value)
    },
  })

  const scrollToDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'scrollTo',
  )
  Object.defineProperty(Element.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value(this: HTMLElement, options?: ScrollToOptions | number, y?: number) {
      const top =
        typeof options === 'object' && options !== null
          ? (options.top ?? scrollTops.get(this) ?? 0)
          : (y ?? scrollTops.get(this) ?? 0)
      applyScroll(this, top)
    },
  })

  const scrollTo = (el: HTMLElement, top: number) => {
    applyScroll(el, top)
  }

  const restore = () => {
    if (rectDescriptor) {
      Object.defineProperty(Element.prototype, 'getBoundingClientRect', rectDescriptor)
    }
    if (offsetHeightDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeightDescriptor)
    }
    if (scrollHeightDescriptor) {
      Object.defineProperty(Element.prototype, 'scrollHeight', scrollHeightDescriptor)
    }
    if (clientHeightDescriptor) {
      Object.defineProperty(Element.prototype, 'clientHeight', clientHeightDescriptor)
    }
    if (scrollTopDescriptor) {
      Object.defineProperty(Element.prototype, 'scrollTop', scrollTopDescriptor)
    }
    if (scrollToDescriptor) {
      Object.defineProperty(Element.prototype, 'scrollTo', scrollToDescriptor)
    } else {
      Reflect.deleteProperty(Element.prototype, 'scrollTo')
    }
  }

  return { scrollTo, restore }
}
