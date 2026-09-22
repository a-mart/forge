import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import {
  BROWSER_AUTOMATION_MAX_SCREENSHOT_HEIGHT,
  BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH,
  BROWSER_PREVIEW_TOTAL_IMAGE_BYTES,
  type BrowserPreviewCardSnapshot,
  type BrowserPreviewDeckSnapshot,
  type BrowserPreviewFrameAvailable,
  type BrowserPreviewFramePayload,
} from '@forge/protocol'
import { cn } from '@/lib/utils'

interface RenderedFrame {
  sequence: number
  url: string
}

interface OverlayPosition {
  x: number
  y: number
}

interface DragState extends OverlayPosition {
  pointerId: number
  clientX: number
  clientY: number
  moved: boolean
}

interface ResizeState {
  pointerId: number
  clientX: number
  clientY: number
  width: number
  right: number
  top: number
  stackInset: number
}

interface BrowserPreviewSurfaceProps {
  hidden?: boolean
  onOpenManagedTab?: (tabId: string) => void | Promise<void>
}

const STACK_STEP_PX = 14
const MIN_CARD_WIDTH_PX = 240
const MAX_CARD_WIDTH_PX = 960
const EDGE_INSET_PX = 8

export function BrowserPreviewSurface({ hidden = false, onOpenManagedTab }: BrowserPreviewSurfaceProps) {
  const bridge = window.electronBridge?.browserPreview
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const overlayRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const resizeRef = useRef<ResizeState | null>(null)
  const suppressClickRef = useRef(false)
  const [position, setPosition] = useState<OverlayPosition | null>(null)
  const [cardWidth, setCardWidth] = useState<number | null>(null)
  const [frontTabId, setFrontTabId] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<BrowserPreviewDeckSnapshot | null>(null)
  const snapshotRef = useRef<BrowserPreviewDeckSnapshot | null>(null)
  const [frames, setFrames] = useState<Record<string, RenderedFrame>>({})
  const framesRef = useRef<Record<string, RenderedFrame>>({})
  const decodingUrls = useRef(new Set<string>())
  const pending = useRef(new Map<string, BrowserPreviewFrameAvailable>())
  const pulling = useRef<number | null>(null)
  const lifecycle = useRef(0)

  const replaceFrames = useCallback((next: Record<string, RenderedFrame>) => {
    framesRef.current = next
    setFrames(next)
  }, [])

  const applySnapshot = useCallback((next: BrowserPreviewDeckSnapshot | null) => {
    const previous = snapshotRef.current
    const generationChanged = previous?.previewGeneration !== next?.previewGeneration
    const cardsById = new Map(next?.cards.map((card) => [card.tabId, card]) ?? [])
    if (!next || generationChanged || next.hiddenContent) {
      pending.current.clear()
      for (const url of decodingUrls.current) URL.revokeObjectURL(url)
      decodingUrls.current.clear()
    } else {
      for (const [tabId, request] of pending.current) {
        if (request.previewGeneration !== next.previewGeneration || !cardsById.get(tabId)?.hasFrame) pending.current.delete(tabId)
      }
    }
    snapshotRef.current = next
    setSnapshot(next)
    if (!next || generationChanged) {
      setPosition(null)
      setFrontTabId(null)
    }
    const retained: Record<string, RenderedFrame> = {}
    for (const [tabId, frame] of Object.entries(framesRef.current)) {
      const card = cardsById.get(tabId)
      const sequenceIsCurrent = card?.targetAffinity === 'external-chrome'
        ? frame.sequence === card.frameSequence
        : Boolean(card && frame.sequence <= card.frameSequence)
      if (next && !generationChanged && !next.hiddenContent && card?.hasFrame && sequenceIsCurrent) retained[tabId] = frame
      else URL.revokeObjectURL(frame.url)
    }
    replaceFrames(retained)
    if (!next || next.hiddenContent) return
    for (const card of next.cards) {
      if (card.hasFrame && card.frameSequence > (retained[card.tabId]?.sequence ?? 0)) {
        pending.current.set(card.tabId, {
          previewGeneration: next.previewGeneration,
          tabId: card.tabId,
          sequence: card.frameSequence,
        })
      }
    }
  }, [replaceFrames])

  const pump = useCallback(async () => {
    const lifecycleId = lifecycle.current
    if (lifecycleId === 0 || pulling.current === lifecycleId || !bridge?.pullFrame) return
    const request = pending.current.values().next().value as BrowserPreviewFrameAvailable | undefined
    if (!request) return
    pending.current.delete(request.tabId)
    pulling.current = lifecycleId
    try {
      const payload = await bridge.pullFrame(request)
      if (payload && lifecycle.current === lifecycleId) {
        await decodeAndStore(
          payload,
          snapshotRef,
          framesRef,
          decodingUrls,
          replaceFrames,
          () => lifecycle.current === lifecycleId,
        )
      }
    } catch {
      // A later frame notification retries; the compact preview has no error chrome.
    } finally {
      if (pulling.current === lifecycleId) pulling.current = null
      if (lifecycle.current === lifecycleId && pending.current.size > 0) void pump()
    }
  }, [bridge, replaceFrames])

  useEffect(() => {
    if (!bridge?.getSnapshot || !bridge.onSnapshotChanged || !bridge.onFrameAvailable) return
    const lifecycleId = ++lifecycle.current
    const pendingFrames = pending.current
    const decodingFrameUrls = decodingUrls.current
    let receivedLiveSnapshot = false
    const removeSnapshot = bridge.onSnapshotChanged((next) => {
      receivedLiveSnapshot = true
      applySnapshot(next)
      void pump()
    })
    const removeAvailable = bridge.onFrameAvailable((available) => {
      const current = snapshotRef.current
      const card = current?.cards.find((candidate) => candidate.tabId === available.tabId)
      if (available.previewGeneration !== current?.previewGeneration || current.hiddenContent
        || !card?.hasFrame || card.frameSequence !== available.sequence) return
      pending.current.set(available.tabId, available)
      void pump()
    })
    void bridge.getSnapshot().then((next) => {
      if (lifecycle.current !== lifecycleId || receivedLiveSnapshot) return
      applySnapshot(next)
      void pump()
    }).catch(() => undefined)
    return () => {
      if (lifecycle.current === lifecycleId) lifecycle.current += 1
      if (pulling.current === lifecycleId) pulling.current = null
      snapshotRef.current = null
      removeSnapshot()
      removeAvailable()
      pendingFrames.clear()
      for (const frame of Object.values(framesRef.current)) URL.revokeObjectURL(frame.url)
      for (const url of decodingFrameUrls) URL.revokeObjectURL(url)
      decodingFrameUrls.clear()
      framesRef.current = {}
    }
  }, [applySnapshot, bridge, pump])

  const eligibleCards = snapshot?.cards.filter((card) => card.targetAffinity === 'managed-electron' || Boolean(frames[card.tabId])) ?? []
  const selectedFrontTabId = eligibleCards.some((card) => card.tabId === frontTabId) ? frontTabId : null
  const visibleCards = selectedFrontTabId
    ? [eligibleCards.find((card) => card.tabId === selectedFrontTabId)!, ...eligibleCards.filter((card) => card.tabId !== selectedFrontTabId)]
    : eligibleCards
  const hasCustomPosition = position !== null
  const cardCount = visibleCards.length
  const stackInset = Math.min(Math.max(cardCount - 1, 0), 3) * STACK_STEP_PX
  useEffect(() => {
    if (!hasCustomPosition || hidden) return
    const constrain = (): void => {
      const surface = surfaceRef.current
      if (!surface) return
      const bounds = surface.getBoundingClientRect()
      if (bounds.width < 1 || bounds.height < 1) return
      if (cardWidth !== null) {
        const maxWidth = Math.min(
          MAX_CARD_WIDTH_PX,
          bounds.width - 24 - stackInset,
          (bounds.height - 2 * EDGE_INSET_PX - stackInset) * 16 / 9,
        )
        setCardWidth((current) => current === null ? null : Math.min(current, Math.max(1, maxWidth)))
      }
      setPosition((current) => {
        if (!current) return null
        const next = clampPosition(current, surface, overlayRef.current)
        return next.x === current.x && next.y === current.y ? current : next
      })
    }
    constrain()
    window.addEventListener('resize', constrain)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(constrain)
    if (surfaceRef.current) observer?.observe(surfaceRef.current)
    if (overlayRef.current) observer?.observe(overlayRef.current)
    return () => {
      window.removeEventListener('resize', constrain)
      observer?.disconnect()
    }
  }, [cardCount, cardWidth, hasCustomPosition, hidden, stackInset])

  const applyResize = (resize: ResizeState, width: number): void => {
    const surface = surfaceRef.current
    if (!surface) return
    const surfaceRect = surface.getBoundingClientRect()
    if (surfaceRect.width < 1 || surfaceRect.height < 1) return
    const maxWidth = Math.min(
      MAX_CARD_WIDTH_PX,
      resize.right - EDGE_INSET_PX - resize.stackInset,
      surfaceRect.width - 24 - resize.stackInset,
      (surfaceRect.height - resize.top - EDGE_INSET_PX - resize.stackInset) * 16 / 9,
    )
    const nextWidth = Math.min(Math.max(width, Math.min(MIN_CARD_WIDTH_PX, maxWidth)), Math.max(1, maxWidth))
    setCardWidth(nextWidth)
    setPosition({ x: resize.right - nextWidth - resize.stackInset, y: resize.top })
  }

  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    const overlay = overlayRef.current
    if (!overlay) return
    const overlayRect = overlay.getBoundingClientRect()
    const start = currentPosition(surfaceRef.current, overlay)
    resizeRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      width: overlayRect.width - stackInset,
      right: start.x + overlayRect.width,
      top: start.y,
      stackInset,
    }
    setPosition(start)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const moveResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const resize = resizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    const horizontalChange = resize.clientX - event.clientX
    const verticalChange = (event.clientY - resize.clientY) * 16 / 9
    const change = Math.abs(horizontalChange) >= Math.abs(verticalChange) ? horizontalChange : verticalChange
    applyResize(resize, resize.width + change)
  }

  const endResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (resizeRef.current?.pointerId !== event.pointerId) return
    resizeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const direction = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? -1 : 0
    if (!direction) return
    const overlay = overlayRef.current
    if (!overlay) return
    event.preventDefault()
    const bounds = overlay.getBoundingClientRect()
    const start = currentPosition(surfaceRef.current, overlay)
    applyResize({
      pointerId: -1,
      clientX: 0,
      clientY: 0,
      width: bounds.width - stackInset,
      right: start.x + bounds.width,
      top: start.y,
      stackInset,
    }, bounds.width - stackInset + direction * (event.shiftKey ? 80 : 24))
  }

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return
    const start = currentPosition(surfaceRef.current, overlayRef.current)
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      moved: false,
      ...start,
    }
    setPosition(start)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const deltaX = event.clientX - drag.clientX
    const deltaY = event.clientY - drag.clientY
    if (!drag.moved && Math.hypot(deltaX, deltaY) >= 4) drag.moved = true
    setPosition(clampPosition({
      x: drag.x + deltaX,
      y: drag.y + deltaY,
    }, surfaceRef.current, overlayRef.current))
  }

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current
    if (drag?.pointerId !== event.pointerId) return
    dragRef.current = null
    if (drag.moved) {
      suppressClickRef.current = true
      window.setTimeout(() => { suppressClickRef.current = false }, 0)
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const selectCard = (tabId: string): void => {
    if (suppressClickRef.current) return
    setFrontTabId(tabId)
  }

  const openFrontCard = (card: BrowserPreviewCardSnapshot, index: number): void => {
    if (suppressClickRef.current || index !== 0 || card.targetAffinity !== 'managed-electron' || !onOpenManagedTab) return
    void Promise.resolve(onOpenManagedTab(card.tabId)).catch(() => undefined)
  }

  const nudge = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    const delta = event.shiftKey ? 40 : 12
    const movement = event.key === 'ArrowLeft' ? { x: -delta, y: 0 }
      : event.key === 'ArrowRight' ? { x: delta, y: 0 }
        : event.key === 'ArrowUp' ? { x: 0, y: -delta }
          : event.key === 'ArrowDown' ? { x: 0, y: delta }
            : null
    if (!movement) return
    event.preventDefault()
    const start = position ?? currentPosition(surfaceRef.current, overlayRef.current)
    setPosition(clampPosition({ x: start.x + movement.x, y: start.y + movement.y }, surfaceRef.current, overlayRef.current))
  }

  if (hidden || !snapshot || visibleCards.length === 0) return null

  const stackDepth = Math.min(visibleCards.length - 1, 3)
  return (
    <div ref={surfaceRef} className="pointer-events-none absolute inset-0 z-40 overflow-hidden" data-browser-preview-layer>
      <section
        ref={overlayRef}
        aria-label="Browser preview stack"
        className={cn(
          'pointer-events-auto absolute top-3 max-w-[calc(100%-1.5rem)] select-none',
          position ? 'left-0 top-0' : 'right-3',
        )}
        style={{
          width: cardWidth === null ? `calc(23rem + ${stackInset}px)` : `${cardWidth + stackInset}px`,
          ...(position ? { left: 0, transform: `translate3d(${position.x}px, ${position.y}px, 0)` } : {}),
        }}
        data-browser-preview-stack
        data-card-count={visibleCards.length}
        data-stack-depth={stackDepth}
      >
        <p className="sr-only" aria-live="polite">
          {visibleCards.map((card) => `${previewLabel(card)}: ${accessibilityState(card)}`).join('. ')}
        </p>
        <div
          className="relative aspect-video"
          style={{ marginLeft: stackInset, marginBottom: stackInset, width: `calc(100% - ${stackInset}px)` }}
        >
          {visibleCards.map((card, index) => {
            const depth = Math.min(index, 3)
            const frame = frames[card.tabId]
            const label = previewLabel(card)
            const isFront = index === 0
            const canOpen = isFront && card.targetAffinity === 'managed-electron' && Boolean(onOpenManagedTab)
            const instruction = canOpen ? 'Double-click to open in Browser' : isFront ? 'Front preview' : 'Click to bring forward'
            return (
              <button
                key={card.tabId}
                type="button"
                aria-label={`${label}: ${accessibilityState(card)}. ${instruction}`}
                title={instruction}
                className={cn(
                  'absolute inset-0 touch-none cursor-grab overflow-hidden rounded-[10px] border border-white/10 bg-zinc-950 p-0 text-left ring-1 ring-black/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing',
                  isFront
                    ? 'shadow-[0_16px_40px_rgba(0,0,0,0.34)]'
                    : 'shadow-[0_10px_26px_rgba(0,0,0,0.28)]',
                )}
                style={{
                  transform: `translate3d(${-depth * STACK_STEP_PX}px, ${depth * STACK_STEP_PX}px, 0)`,
                  zIndex: visibleCards.length - index,
                  opacity: Math.max(0.78, 1 - index * 0.06),
                }}
                onClick={() => selectCard(card.tabId)}
                onDoubleClick={() => openFrontCard(card, index)}
                onPointerDown={beginDrag}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={nudge}
                data-browser-preview-card
                data-browser-preview-front={isFront ? 'true' : undefined}
                data-stack-index={index}
                data-tab-id={card.tabId}
              >
                {!snapshot.hiddenContent && frame
                  ? <img src={frame.url} alt="" aria-hidden="true" className="h-full w-full object-contain" draggable={false} />
                  : (
                    <span className="flex h-full w-full items-center justify-center px-5 text-center text-[11px] text-zinc-300">
                      {snapshot.hiddenContent ? 'Preview hidden' : emptyMessage(card)}
                    </span>
                  )}
              </button>
            )
          })}
          <button
            type="button"
            aria-label="Resize browser previews"
            title="Drag or use arrow keys to resize previews"
            className="absolute bottom-0 left-0 z-10 flex h-7 w-7 touch-none cursor-nesw-resize items-end justify-start rounded-bl-[10px] bg-gradient-to-tr from-black/65 to-transparent p-1 text-white/80 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onPointerDown={beginResize}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onKeyDown={resizeWithKeyboard}
            data-browser-preview-resize
          >
            <span aria-hidden="true" className="block h-2.5 w-2.5 border-b-2 border-l-2 border-current" />
          </button>
        </div>
      </section>
    </div>
  )
}

async function decodeAndStore(
  payload: BrowserPreviewFramePayload,
  snapshotRef: RefObject<BrowserPreviewDeckSnapshot | null>,
  framesRef: RefObject<Record<string, RenderedFrame>>,
  decodingUrls: RefObject<Set<string>>,
  replaceFrames: (frames: Record<string, RenderedFrame>) => void,
  isCurrent: () => boolean,
): Promise<void> {
  const snapshot = snapshotRef.current
  const expectedCard = snapshot?.cards.find((card) => card.tabId === payload.tabId)
  if (payload.previewGeneration !== snapshot?.previewGeneration || snapshot.hiddenContent || !expectedCard?.hasFrame
    || expectedCard.frameSequence !== payload.sequence || payload.data.length === 0
    || payload.data.length > BROWSER_PREVIEW_TOTAL_IMAGE_BYTES
    || !Number.isSafeInteger(payload.width) || !Number.isSafeInteger(payload.height)
    || payload.width < 1 || payload.height < 1
    || payload.width > BROWSER_AUTOMATION_MAX_SCREENSHOT_WIDTH
    || payload.height > BROWSER_AUTOMATION_MAX_SCREENSHOT_HEIGHT) return
  const binary = atob(payload.data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  if (!isCurrent()) return
  const url = URL.createObjectURL(new Blob([bytes], { type: payload.mimeType }))
  decodingUrls.current.add(url)
  const image = new Image()
  image.src = url
  try {
    await image.decode()
  } catch {
    decodingUrls.current.delete(url)
    URL.revokeObjectURL(url)
    return
  }
  decodingUrls.current.delete(url)
  const currentSnapshot = snapshotRef.current
  const currentCard = currentSnapshot?.cards.find((card) => card.tabId === payload.tabId)
  if (!isCurrent() || payload.previewGeneration !== currentSnapshot?.previewGeneration || currentSnapshot.hiddenContent
    || !currentCard?.hasFrame || currentCard.frameSequence !== payload.sequence
    || image.naturalWidth !== payload.width || image.naturalHeight !== payload.height) {
    URL.revokeObjectURL(url)
    return
  }
  const previous = framesRef.current[payload.tabId]
  if (previous && previous.sequence >= payload.sequence) {
    URL.revokeObjectURL(url)
    return
  }
  if (previous) URL.revokeObjectURL(previous.url)
  replaceFrames({
    ...framesRef.current,
    [payload.tabId]: {
      sequence: payload.sequence,
      url,
    },
  })
}

function previewLabel(card: BrowserPreviewCardSnapshot): string {
  return card.label ?? 'Chrome tab'
}

function emptyMessage(card: BrowserPreviewCardSnapshot): string {
  return card.state === 'unavailable' ? 'Preview unavailable' : 'Waiting for preview'
}

function accessibilityState(card: BrowserPreviewCardSnapshot): string {
  if (card.state === 'expired') return 'snapshot expired'
  if (card.state === 'paused') return 'preview hidden'
  if (card.state === 'unavailable') return 'preview unavailable'
  if (card.state === 'waiting') return 'waiting for preview image'
  return 'read-only preview available'
}

function currentPosition(surface: HTMLElement | null, overlay: HTMLElement | null): OverlayPosition {
  if (!surface || !overlay) return { x: 12, y: 12 }
  const surfaceRect = surface.getBoundingClientRect()
  const overlayRect = overlay.getBoundingClientRect()
  return clampPosition({ x: overlayRect.left - surfaceRect.left, y: overlayRect.top - surfaceRect.top }, surface, overlay)
}

function clampPosition(position: OverlayPosition, surface: HTMLElement | null, overlay: HTMLElement | null): OverlayPosition {
  if (!surface || !overlay) return position
  const surfaceRect = surface.getBoundingClientRect()
  const overlayRect = overlay.getBoundingClientRect()
  const inset = EDGE_INSET_PX
  return {
    x: Math.min(Math.max(inset, position.x), Math.max(inset, surfaceRect.width - overlayRect.width - inset)),
    y: Math.min(Math.max(inset, position.y), Math.max(inset, surfaceRect.height - overlayRect.height - inset)),
  }
}
