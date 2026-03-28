import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface GuidedTourStepProps {
  title: string
  description: string
  stepNumber: number
  totalSteps: number
  onNext: () => void
  onSkip: () => void
  placement: 'top' | 'bottom' | 'left' | 'right'
  targetRect: DOMRect | null
}

interface Position {
  top: number
  left: number
}

const CARD_GAP = 16

function computePosition(
  placement: GuidedTourStepProps['placement'],
  targetRect: DOMRect | null,
  cardRect: { width: number; height: number },
): Position {
  if (!targetRect) {
    // Center on screen when no target
    return {
      top: Math.max(16, (window.innerHeight - cardRect.height) / 2),
      left: Math.max(16, (window.innerWidth - cardRect.width) / 2),
    }
  }

  let top: number
  let left: number

  switch (placement) {
    case 'bottom':
      top = targetRect.bottom + CARD_GAP
      left = targetRect.left + targetRect.width / 2 - cardRect.width / 2
      break
    case 'top':
      top = targetRect.top - cardRect.height - CARD_GAP
      left = targetRect.left + targetRect.width / 2 - cardRect.width / 2
      break
    case 'right':
      top = targetRect.top + targetRect.height / 2 - cardRect.height / 2
      left = targetRect.right + CARD_GAP
      break
    case 'left':
      top = targetRect.top + targetRect.height / 2 - cardRect.height / 2
      left = targetRect.left - cardRect.width - CARD_GAP
      break
  }

  // Clamp to viewport with padding
  const pad = 12
  top = Math.max(pad, Math.min(top, window.innerHeight - cardRect.height - pad))
  left = Math.max(pad, Math.min(left, window.innerWidth - cardRect.width - pad))

  return { top, left }
}

export function GuidedTourStep({
  title,
  description,
  stepNumber,
  totalSteps,
  onNext,
  onSkip,
  placement,
  targetRect,
}: GuidedTourStepProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<Position | null>(null)

  useEffect(() => {
    const card = cardRef.current
    if (!card) return

    // Measure the card, then position it
    const rect = card.getBoundingClientRect()
    setPosition(computePosition(placement, targetRect, { width: rect.width, height: rect.height }))
  }, [placement, targetRect])

  const isLastStep = stepNumber === totalSteps

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={`Tour step ${stepNumber} of ${totalSteps}: ${title}`}
      className={cn(
        'fixed z-[10002] w-80 rounded-lg border border-border bg-card p-4 shadow-lg',
        'transition-all duration-300 ease-out',
        position ? 'opacity-100 scale-100' : 'opacity-0 scale-95',
      )}
      style={
        position
          ? { top: position.top, left: position.left }
          : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
      }
    >
      {/* Step counter */}
      <p className="mb-1 text-xs font-medium text-muted-foreground">
        Step {stepNumber} of {totalSteps}
      </p>

      {/* Title */}
      <h3 className="mb-1.5 text-sm font-semibold text-card-foreground">{title}</h3>

      {/* Description */}
      <p className="mb-4 text-sm leading-relaxed text-muted-foreground">{description}</p>

      {/* Actions */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onSkip} className="text-muted-foreground">
          Skip tour
        </Button>
        <Button size="sm" onClick={onNext}>
          {isLastStep ? 'Done' : 'Next'}
        </Button>
      </div>
    </div>
  )
}
