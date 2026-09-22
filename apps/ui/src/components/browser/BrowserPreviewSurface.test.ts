/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPreviewDeckSnapshot, BrowserPreviewFrameAvailable } from '@forge/protocol'
import { BrowserPreviewSurface } from './BrowserPreviewSurface'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root | null = null
let snapshotListener: ((snapshot: BrowserPreviewDeckSnapshot | null) => void) | null
let frameListener: ((frame: BrowserPreviewFrameAvailable) => void) | null
let getSnapshot: ReturnType<typeof vi.fn>
let pullFrame: ReturnType<typeof vi.fn>
let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>
const OriginalImage = globalThis.Image
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

function snapshot(overrides: Partial<BrowserPreviewDeckSnapshot> = {}): BrowserPreviewDeckSnapshot {
  return {
    previewGeneration: 1,
    workspaceEpoch: 7,
    sessionAgentId: 'session-1',
    profileId: 'profile-1',
    hiddenContent: false,
    cards: [{
      tabId: 'chrome.profile.7',
      targetAffinity: 'managed-electron',
      label: 'Managed tab',
      lifecycle: 'ready',
      presented: false,
      state: 'waiting',
      frameSequence: 0,
      hasFrame: false,
      width: null,
      height: null,
      ageMsAtDelivery: null,
    }],
    ...overrides,
  }
}

function card(tabId: string, index: number) {
  return {
    ...snapshot().cards[0]!,
    tabId,
    targetAffinity: 'managed-electron' as const,
    label: `Managed tab ${index + 1}`,
  }
}

beforeEach(() => {
  snapshotListener = null
  frameListener = null
  getSnapshot = vi.fn(async () => snapshot())
  pullFrame = vi.fn(async (request: BrowserPreviewFrameAvailable) => ({
    ...request,
    mimeType: 'image/png' as const,
    data: 'eA==',
    width: 1,
    height: 1,
    ageMsAtDelivery: 4_000,
  }))
  createObjectURL = vi.fn(() => `blob:preview-${createObjectURL.mock.calls.length}`)
  revokeObjectURL = vi.fn()
  Object.assign(URL, { createObjectURL, revokeObjectURL })
  globalThis.Image = class {
    src = ''
    naturalWidth = 1
    naturalHeight = 1
    decode = vi.fn(async () => undefined)
  } as never
  window.electronBridge = {
    windowRole: 'main',
    platform: 'darwin',
    browserPreview: {
      getSnapshot,
      pullFrame,
      onSnapshotChanged: (listener) => { snapshotListener = listener; return vi.fn() },
      onFrameAvailable: (listener) => { frameListener = listener; return vi.fn() },
    },
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = null
  container.remove()
  delete window.electronBridge
  globalThis.Image = OriginalImage
  Object.assign(URL, { createObjectURL: originalCreateObjectURL, revokeObjectURL: originalRevokeObjectURL })
  vi.clearAllMocks()
})

async function render(hidden = false, onOpenManagedTab?: (tabId: string) => void | Promise<void>): Promise<void> {
  await act(async () => {
    root?.render(createElement(BrowserPreviewSurface, { hidden, onOpenManagedTab }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function publish(next: BrowserPreviewDeckSnapshot | null): Promise<void> {
  await act(async () => {
    snapshotListener?.(next)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('BrowserPreviewSurface', () => {
  it('stays subscribed while the Browser workspace hides it and reveals the current automatic preview in Chat', async () => {
    getSnapshot.mockResolvedValueOnce(null)
    await render(true)
    expect(container.querySelector('[data-browser-preview-layer]')).toBeNull()

    const withFrame = snapshot({
      cards: [{ ...snapshot().cards[0]!, state: 'updating', frameSequence: 1, hasFrame: true, width: 1, height: 1, ageMsAtDelivery: 0 }],
    })
    await publish(withFrame)
    expect(container.querySelector('[data-browser-preview-layer]')).toBeNull()
    expect(pullFrame).toHaveBeenCalledOnce()

    await render(false)
    expect(container.querySelector('[data-browser-preview-layer]')).not.toBeNull()
    expect(container.querySelector('[data-browser-preview-stack]')).not.toBeNull()
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:preview-1')
  })

  it('never renders a frame-less External Chrome placeholder', async () => {
    getSnapshot.mockResolvedValueOnce(snapshot({
      cards: [{ ...snapshot().cards[0]!, targetAffinity: 'external-chrome', label: null }],
    }))
    await render()
    expect(container.querySelector('[data-browser-preview-layer]')).toBeNull()
    expect(container.textContent).not.toContain('Waiting for agent snapshot')
  })

  it('does not overwrite a newer live preview with a delayed bootstrap snapshot', async () => {
    let resolveBootstrap!: (value: BrowserPreviewDeckSnapshot | null) => void
    getSnapshot.mockImplementationOnce(() => new Promise((resolve) => { resolveBootstrap = resolve }))
    await render()
    await publish(snapshot())
    await act(async () => {
      resolveBootstrap(null)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('[data-browser-preview-stack]')).not.toBeNull()
  })

  it('does not restore a stale bootstrap deck after a newer live close event', async () => {
    let resolveBootstrap!: (value: BrowserPreviewDeckSnapshot | null) => void
    getSnapshot.mockImplementationOnce(() => new Promise((resolve) => { resolveBootstrap = resolve }))
    await render()
    await publish(null)
    await act(async () => {
      resolveBootstrap(snapshot())
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('[data-browser-preview-layer]')).toBeNull()
  })

  it('renders a compact frameless cascade instead of a dashboard shell', async () => {
    await render()
    await publish(snapshot({ cards: [card('managed-1', 0), card('chrome-1', 1), card('chrome-2', 2)] }))

    const stack = container.querySelector('section[aria-label="Browser preview stack"]') as HTMLElement
    const cards = [...container.querySelectorAll<HTMLElement>('[data-browser-preview-card]')]
    expect(stack.dataset.cardCount).toBe('3')
    expect(stack.dataset.stackDepth).toBe('2')
    expect(stack.style.width).toContain('23rem')
    expect(stack.style.width).toContain('28px')
    expect(stack.querySelector('header')).toBeNull()
    expect(stack.querySelector('footer')).toBeNull()
    expect(container.querySelector('button[aria-label="Pause previews"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Close browser previews"]')).toBeNull()
    expect(cards).toHaveLength(3)
    expect(cards[0]?.dataset.browserPreviewFront).toBe('true')
    expect(cards.map((element) => element.style.transform)).toEqual([
      'translate3d(0px, 0px, 0)',
      'translate3d(-14px, 14px, 0)',
      'translate3d(-28px, 28px, 0)',
    ])
  })

  it('brings a clicked card forward and opens that exact managed tab when the front card is double-clicked', async () => {
    const onOpenManagedTab = vi.fn()
    getSnapshot.mockResolvedValueOnce(snapshot({
      cards: [card('managed-1', 0), card('managed-2', 1), card('managed-3', 2)],
    }))
    await render(false, onOpenManagedTab)

    const thirdCard = container.querySelector('[data-tab-id="managed-3"]') as HTMLButtonElement
    await act(async () => {
      thirdCard.click()
      await Promise.resolve()
    })

    const frontCard = container.querySelector('[data-browser-preview-front="true"]') as HTMLButtonElement
    expect(frontCard.dataset.tabId).toBe('managed-3')
    expect(onOpenManagedTab).not.toHaveBeenCalled()

    await act(async () => {
      frontCard.click()
      frontCard.click()
      frontCard.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }))
      await Promise.resolve()
    })
    expect(onOpenManagedTab).toHaveBeenCalledOnce()
    expect(onOpenManagedTab).toHaveBeenCalledWith('managed-3')
  })

  it('does not bring a back card forward when its drag ends with a click', async () => {
    getSnapshot.mockResolvedValueOnce(snapshot({
      cards: [card('managed-1', 0), card('managed-2', 1), card('managed-3', 2)],
    }))
    await render()
    const draggedCard = container.querySelector('[data-tab-id="managed-3"]') as HTMLButtonElement & {
      setPointerCapture(pointerId: number): void
      releasePointerCapture(pointerId: number): void
      hasPointerCapture(pointerId: number): boolean
    }
    draggedCard.setPointerCapture = vi.fn()
    draggedCard.releasePointerCapture = vi.fn()
    draggedCard.hasPointerCapture = vi.fn(() => true)

    await act(async () => {
      draggedCard.dispatchEvent(pointerEvent('pointerdown', { pointerId: 4, clientX: 50, clientY: 50, button: 0 }))
      draggedCard.dispatchEvent(pointerEvent('pointermove', { pointerId: 4, clientX: 70, clientY: 70, button: 0 }))
      draggedCard.dispatchEvent(pointerEvent('pointerup', { pointerId: 4, clientX: 70, clientY: 70, button: 0 }))
      draggedCard.click()
      await Promise.resolve()
    })

    const frontCard = container.querySelector('[data-browser-preview-front="true"]') as HTMLButtonElement
    expect(frontCard.dataset.tabId).toBe('managed-1')
  })

  it('drags the entire compact stack and constrains it to the Chat layer', async () => {
    await render()
    const surface = container.querySelector('[data-browser-preview-layer]') as HTMLDivElement
    const overlay = container.querySelector('section[aria-label="Browser preview stack"]') as HTMLElement
    const handle = container.querySelector('[data-browser-preview-card]') as HTMLButtonElement & {
      setPointerCapture(pointerId: number): void
      releasePointerCapture(pointerId: number): void
      hasPointerCapture(pointerId: number): boolean
    }
    surface.getBoundingClientRect = () => rect(0, 0, 1_000, 800)
    overlay.getBoundingClientRect = () => {
      const match = overlay.style.transform.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px/)
      return match ? rect(Number(match[1]), Number(match[2]), 368, 220) : rect(620, 12, 368, 220)
    }
    handle.setPointerCapture = vi.fn()
    handle.releasePointerCapture = vi.fn()
    handle.hasPointerCapture = vi.fn(() => true)

    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 9, clientX: 900, clientY: 40, button: 0 }))
      handle.dispatchEvent(pointerEvent('pointermove', { pointerId: 9, clientX: 700, clientY: 140, button: 0 }))
      handle.dispatchEvent(pointerEvent('pointerup', { pointerId: 9, clientX: 700, clientY: 140, button: 0 }))
      await Promise.resolve()
    })

    expect(handle.setPointerCapture).toHaveBeenCalledWith(9)
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(9)
    expect(overlay.style.transform).toBe('translate3d(420px, 112px, 0)')
    expect(overlay.classList).toContain('top-0')

    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 10, clientX: 700, clientY: 140, button: 0 }))
      handle.dispatchEvent(pointerEvent('pointermove', { pointerId: 10, clientX: 750, clientY: 1_000, button: 0 }))
      handle.dispatchEvent(pointerEvent('pointerup', { pointerId: 10, clientX: 750, clientY: 1_000, button: 0 }))
      await Promise.resolve()
    })
    expect(overlay.style.transform).toBe('translate3d(470px, 572px, 0)')
  })

  it('resizes every preview from the corner while keeping the stack in Chat and preserving card clicks', async () => {
    getSnapshot.mockResolvedValueOnce(snapshot({
      cards: [card('managed-1', 0), card('managed-2', 1), card('managed-3', 2)],
    }))
    await render()
    const surface = container.querySelector('[data-browser-preview-layer]') as HTMLDivElement
    const overlay = container.querySelector('[data-browser-preview-stack]') as HTMLElement
    const handle = container.querySelector('[data-browser-preview-resize]') as HTMLButtonElement & {
      setPointerCapture(pointerId: number): void
      releasePointerCapture(pointerId: number): void
      hasPointerCapture(pointerId: number): boolean
    }
    let surfaceWidth = 1_000
    let surfaceHeight = 800
    surface.getBoundingClientRect = () => rect(0, 0, surfaceWidth, surfaceHeight)
    overlay.getBoundingClientRect = () => {
      const width = overlay.style.width.endsWith('px') ? Number.parseFloat(overlay.style.width) : 396
      const match = overlay.style.transform.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px/)
      return match ? rect(Number(match[1]), Number(match[2]), width, (width - 28) * 9 / 16 + 28)
        : rect(592, 12, width, (width - 28) * 9 / 16 + 28)
    }
    handle.setPointerCapture = vi.fn()
    handle.releasePointerCapture = vi.fn()
    handle.hasPointerCapture = vi.fn(() => true)

    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 12, clientX: 620, clientY: 220, button: 0 }))
      handle.dispatchEvent(pointerEvent('pointermove', { pointerId: 12, clientX: 420, clientY: 332, button: 0 }))
      handle.dispatchEvent(pointerEvent('pointerup', { pointerId: 12, clientX: 420, clientY: 332, button: 0 }))
      await Promise.resolve()
    })

    expect(handle.setPointerCapture).toHaveBeenCalledWith(12)
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(12)
    expect(overlay.style.width).toBe('596px') // 568px card plus two 14px stack offsets
    expect(overlay.style.transform).toBe('translate3d(392px, 12px, 0)')
    expect(container.querySelector('[data-browser-preview-front="true"]')?.getAttribute('data-tab-id')).toBe('managed-1')

    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 13, clientX: 420, clientY: 332, button: 0 }))
      handle.dispatchEvent(pointerEvent('pointermove', { pointerId: 13, clientX: -2_000, clientY: 2_000, button: 0 }))
      handle.dispatchEvent(pointerEvent('pointerup', { pointerId: 13, clientX: -2_000, clientY: 2_000, button: 0 }))
      await Promise.resolve()
    })
    expect(overlay.style.width).toBe('976px') // bounded by the Chat edge
    expect(overlay.style.transform).toBe('translate3d(12px, 12px, 0)')

    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 14, clientX: 0, clientY: 500, button: 0 }))
      handle.dispatchEvent(pointerEvent('pointermove', { pointerId: 14, clientX: 2_000, clientY: -2_000, button: 0 }))
      handle.dispatchEvent(pointerEvent('pointerup', { pointerId: 14, clientX: 2_000, clientY: -2_000, button: 0 }))
      await Promise.resolve()
    })
    expect(overlay.style.width).toBe('268px') // 240px minimum card width
    expect(overlay.style.transform).toBe('translate3d(720px, 12px, 0)')

    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }))
      await Promise.resolve()
    })
    expect(overlay.style.width).toBe('292px')
    expect(overlay.style.transform).toBe('translate3d(696px, 12px, 0)')

    const thirdCard = container.querySelector('[data-tab-id="managed-3"]') as HTMLButtonElement
    await act(async () => { thirdCard.click(); await Promise.resolve() })
    expect(container.querySelector('[data-browser-preview-front="true"]')?.getAttribute('data-tab-id')).toBe('managed-3')

    surfaceWidth = 500
    surfaceHeight = 400
    await act(async () => { window.dispatchEvent(new Event('resize')); await Promise.resolve() })
    expect(overlay.style.transform).toBe('translate3d(200px, 12px, 0)')

    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 15, clientX: 200, clientY: 200, button: 0 }))
      handle.dispatchEvent(pointerEvent('pointermove', { pointerId: 15, clientX: -2_000, clientY: 2_000, button: 0 }))
      handle.dispatchEvent(pointerEvent('pointerup', { pointerId: 15, clientX: -2_000, clientY: 2_000, button: 0 }))
      await Promise.resolve()
    })
    expect(overlay.style.width).toBe('476px')
    expect(overlay.style.transform).toBe('translate3d(16px, 12px, 0)')

    await render(true)
    expect(container.querySelector('[data-browser-preview-stack]')).toBeNull()
    await render(false)
    const restored = container.querySelector('[data-browser-preview-stack]') as HTMLElement
    expect(restored.style.width).toBe('476px')
    expect(restored.style.transform).toBe('translate3d(16px, 12px, 0)')
  })

  it('pulls and decodes current-generation frames, then revokes them on privacy clear', async () => {
    await render()
    const withFrame = snapshot({
      cards: [{ ...snapshot().cards[0]!, state: 'updating', frameSequence: 1, hasFrame: true, width: 1, height: 1, ageMsAtDelivery: 4_000 }],
    })
    await publish(withFrame)

    expect(pullFrame).toHaveBeenCalledWith({ previewGeneration: 1, tabId: 'chrome.profile.7', sequence: 1 })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:preview-1')

    await publish({ ...withFrame, hiddenContent: true, cards: [{ ...withFrame.cards[0]!, hasFrame: false, frameSequence: 0, width: null, height: null, ageMsAtDelivery: null, state: 'paused' }] })
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('Preview hidden')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')

    frameListener?.({ previewGeneration: 1, tabId: 'chrome.profile.7', sequence: 2 })
    await act(async () => { await Promise.resolve() })
    expect(pullFrame).toHaveBeenCalledOnce()
  })

  it('drops an older Chrome image while a replacement frame fails to decode', async () => {
    await render()
    const first = snapshot({
      cards: [{
        ...snapshot().cards[0]!,
        targetAffinity: 'external-chrome',
        label: null,
        state: 'updating',
        frameSequence: 1,
        hasFrame: true,
        width: 1,
        height: 1,
        ageMsAtDelivery: 0,
      }],
    })
    await publish(first)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:preview-1')

    globalThis.Image = class {
      src = ''
      naturalWidth = 1
      naturalHeight = 1
      decode = vi.fn(async () => { throw new Error('decode failed') })
    } as never
    await publish({ ...first, cards: [{ ...first.cards[0]!, frameSequence: 2 }] })

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
    expect(container.querySelector('[data-browser-preview-layer]')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })

  it('does not create or retain a frame blob when an in-flight pull resolves after unmount', async () => {
    type Frame = {
      previewGeneration: number
      tabId: string
      sequence: number
      mimeType: 'image/png'
      data: string
      width: number
      height: number
      ageMsAtDelivery: number
    }
    let resolvePull!: (frame: Frame) => void
    const pull = new Promise<Frame>((resolve) => { resolvePull = resolve })
    pullFrame.mockImplementationOnce(() => pull)
    await render()
    await publish(snapshot({
      cards: [{ ...snapshot().cards[0]!, state: 'updating', frameSequence: 1, hasFrame: true, width: 1, height: 1, ageMsAtDelivery: 0 }],
    }))
    expect(pullFrame).toHaveBeenCalledOnce()

    act(() => root?.unmount())
    root = null
    resolvePull({ previewGeneration: 1, tabId: 'chrome.profile.7', sequence: 1, mimeType: 'image/png', data: 'eA==', width: 1, height: 1, ageMsAtDelivery: 0 })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('revokes a decoding frame immediately when the embedded surface unmounts', async () => {
    let resolveDecode!: () => void
    const decode = new Promise<void>((resolve) => { resolveDecode = resolve })
    globalThis.Image = class {
      src = ''
      naturalWidth = 1
      naturalHeight = 1
      decode = vi.fn(() => decode)
    } as never
    await render()
    const withFrame = snapshot({
      cards: [{ ...snapshot().cards[0]!, state: 'updating', frameSequence: 1, hasFrame: true, width: 1, height: 1, ageMsAtDelivery: 0 }],
    })
    act(() => snapshotListener?.(withFrame))
    await act(async () => { await Promise.resolve() })
    expect(createObjectURL).toHaveBeenCalledOnce()

    act(() => root?.unmount())
    root = null
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
    resolveDecode()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
  })

  it('never retains a same-tab image across preview generations', async () => {
    await render()
    const withFrame = snapshot({
      cards: [{ ...snapshot().cards[0]!, state: 'updating', frameSequence: 1, hasFrame: true, width: 1, height: 1, ageMsAtDelivery: 0 }],
    })
    await publish(withFrame)
    expect(container.querySelector('img')).not.toBeNull()

    await publish(snapshot({
      previewGeneration: 2,
      cards: [{ ...snapshot().cards[0]!, targetAffinity: 'external-chrome', label: null, state: 'expired', frameSequence: 0, hasFrame: false }],
    }))
    expect(container.querySelector('[data-browser-preview-layer]')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
    expect(container.textContent).not.toContain('Snapshot expired')
  })

  it('discards decoded pixels whose current metadata changed while decode was pending', async () => {
    let resolveDecode!: () => void
    const decode = new Promise<void>((resolve) => { resolveDecode = resolve })
    globalThis.Image = class {
      src = ''
      naturalWidth = 1
      naturalHeight = 1
      decode = vi.fn(() => decode)
    } as never
    await render()
    const withFrame = snapshot({
      cards: [{ ...snapshot().cards[0]!, state: 'updating', frameSequence: 1, hasFrame: true, width: 1, height: 1, ageMsAtDelivery: 0 }],
    })
    act(() => snapshotListener?.(withFrame))
    await act(async () => { await Promise.resolve() })
    act(() => snapshotListener?.({ ...withFrame, hiddenContent: true, cards: [{ ...withFrame.cards[0]!, hasFrame: false, frameSequence: 0, state: 'paused' }] }))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
    resolveDecode()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(container.querySelector('img')).toBeNull()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
  })
})

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect
}

function pointerEvent(type: string, init: { pointerId: number; clientX: number; clientY: number; button: number }): Event {
  const event = new MouseEvent(type, { bubbles: true, clientX: init.clientX, clientY: init.clientY, button: init.button })
  Object.defineProperty(event, 'pointerId', { value: init.pointerId })
  return event
}
