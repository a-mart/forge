import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TourStep } from './help-types'
import { GuidedTourStep } from './GuidedTourStep'
import { useHelp } from './help-hooks'

// ---------------------------------------------------------------------------
// Tour step definitions
// ---------------------------------------------------------------------------

const TOUR_STEPS: TourStep[] = [
  {
    id: 'tour-chat-input',
    target: '[data-tour="chat-input"], .chat-message-input, form.sticky',
    title: 'Start a conversation',
    description:
      'Type a message here to talk with your manager agent. You can ask questions, give instructions, or attach files.',
    placement: 'top',
  },
  {
    id: 'tour-sidebar',
    target: '[data-tour="sidebar"], aside.border-r',
    title: 'Your sessions live here',
    description:
      'The sidebar shows your manager sessions and workers. Switch between sessions or create new ones from here.',
    placement: 'right',
  },
  {
    id: 'tour-settings',
    target: '[data-tour="settings"], button[aria-label="Settings"]',
    title: 'Configure your setup',
    description:
      'Open settings to choose your model, set API keys, customize prompts, and configure skills.',
    placement: 'top',
  },
  {
    id: 'tour-workers',
    target: '[data-tour="workers"], .worker-pill-bar, [class*="WorkerPill"]',
    title: 'Watch your agents work',
    description:
      'When your manager spawns workers, they appear here as pills. Click one to see what it is doing in real time.',
    placement: 'top',
  },
  {
    id: 'tour-help',
    target: '[data-tour="help-button"], button[aria-label="Help"]',
    title: 'Help is always here',
    description:
      'Press Ctrl+/ (or ⌘/ on Mac) to open contextual help anytime. You can also relaunch this tour from the help panel.',
    placement: 'left',
  },
]

// ---------------------------------------------------------------------------
// Spotlight backdrop overlay
// ---------------------------------------------------------------------------

interface SpotlightOverlayProps {
  rect: DOMRect | null
  onClick: () => void
}

function SpotlightOverlay({ rect, onClick }: SpotlightOverlayProps) {
  const padding = 8
  const borderRadius = 12

  // Build a clip-path that cuts out the spotlight area from a full-screen rectangle.
  // outer = full viewport, inner = rounded rect around the target element.
  const clipPath = rect
    ? buildSpotlightClipPath(rect, padding, borderRadius)
    : undefined

  return (
    <div
      className="fixed inset-0 z-[10001] transition-all duration-300"
      style={{
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        clipPath,
      }}
      onClick={onClick}
      aria-hidden="true"
    />
  )
}

/**
 * Build an SVG clip-path that renders a full-screen overlay with a rounded-rect
 * cutout around the spotlight target.
 */
function buildSpotlightClipPath(
  rect: DOMRect,
  padding: number,
  borderRadius: number,
): string {
  const x = Math.max(0, rect.left - padding)
  const y = Math.max(0, rect.top - padding)
  const w = rect.width + padding * 2
  const h = rect.height + padding * 2
  const r = borderRadius

  // Use an SVG path with evenodd fill:
  // - Outer rect covers entire viewport
  // - Inner rounded rect is the cutout
  const vw = window.innerWidth
  const vh = window.innerHeight

  // Outer rect (clockwise)
  const outer = `M0,0 H${vw} V${vh} H0 Z`

  // Inner rounded rect (counter-clockwise for cutout with evenodd)
  const inner = [
    `M${x + r},${y}`,
    `H${x + w - r}`,
    `Q${x + w},${y} ${x + w},${y + r}`,
    `V${y + h - r}`,
    `Q${x + w},${y + h} ${x + w - r},${y + h}`,
    `H${x + r}`,
    `Q${x},${y + h} ${x},${y + h - r}`,
    `V${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    'Z',
  ].join(' ')

  return `path('${outer} ${inner}')`
}

// ---------------------------------------------------------------------------
// Spotlight glow ring
// ---------------------------------------------------------------------------

interface SpotlightGlowProps {
  rect: DOMRect | null
}

function SpotlightGlow({ rect }: SpotlightGlowProps) {
  if (!rect) return null

  const padding = 8
  return (
    <div
      className="pointer-events-none fixed z-[10001] rounded-xl ring-2 ring-primary/40 transition-all duration-300"
      style={{
        top: rect.top - padding,
        left: rect.left - padding,
        width: rect.width + padding * 2,
        height: rect.height + padding * 2,
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Position tracking interval (ms) — much cheaper than 60fps rAF loop
// ---------------------------------------------------------------------------

const POSITION_POLL_INTERVAL_MS = 100

// ---------------------------------------------------------------------------
// GuidedTour component
// ---------------------------------------------------------------------------

/**
 * Renders the guided tour when active. Reads state from HelpProvider context.
 * Mount this once inside <HelpProvider>.
 */
export function GuidedTour() {
  const { isTourActive, completeTour } = useHelp()
  const [stepIndex, setStepIndex] = useState(0)
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  // Resolve which steps actually have visible target elements right now
  const visibleSteps = useMemo(() => {
    if (!isTourActive) return TOUR_STEPS
    return TOUR_STEPS.filter((step) => {
      const el = document.querySelector(step.target)
      return el !== null
    })
  }, [isTourActive])

  const currentStep = visibleSteps[stepIndex] as TourStep | undefined

  // Reset step index when tour starts
  useEffect(() => {
    if (isTourActive) {
      setStepIndex(0)
    }
  }, [isTourActive])

  // Track the target element position with a throttled interval instead of rAF
  useEffect(() => {
    if (!isTourActive || !currentStep) {
      setTargetRect(null)
      return
    }

    function updateRect() {
      const el = document.querySelector(currentStep!.target)
      if (el) {
        setTargetRect(el.getBoundingClientRect())
      } else {
        setTargetRect(null)
      }
    }

    // Immediately measure once
    updateRect()

    // Then poll at a reasonable interval (handles scroll/resize)
    timerRef.current = setInterval(updateRect, POSITION_POLL_INTERVAL_MS)

    return () => {
      if (timerRef.current !== undefined) {
        clearInterval(timerRef.current)
      }
    }
  }, [isTourActive, currentStep])

  const handleComplete = useCallback(() => {
    setStepIndex(0)
    setTargetRect(null)
    completeTour()
  }, [completeTour])

  const handleNext = useCallback(() => {
    if (stepIndex >= visibleSteps.length - 1) {
      handleComplete()
    } else {
      setStepIndex((i) => i + 1)
    }
  }, [stepIndex, visibleSteps.length, handleComplete])

  const handleSkip = useCallback(() => {
    handleComplete()
  }, [handleComplete])

  if (!isTourActive || !currentStep) {
    return null
  }

  return createPortal(
    <>
      <SpotlightOverlay rect={targetRect} onClick={handleSkip} />
      <SpotlightGlow rect={targetRect} />
      <GuidedTourStep
        title={currentStep.title}
        description={currentStep.description}
        stepNumber={stepIndex + 1}
        totalSteps={visibleSteps.length}
        onNext={handleNext}
        onSkip={handleSkip}
        placement={currentStep.placement}
        targetRect={targetRect}
      />
    </>,
    document.body,
  )
}

/** The default tour steps, exported for testing or external consumption. */
export { TOUR_STEPS }
