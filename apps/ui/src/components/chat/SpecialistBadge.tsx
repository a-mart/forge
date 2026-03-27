import { cn } from '@/lib/utils'

function contrastTextColor(hex: string): string {
  const raw = hex.replace('#', '')
  if (raw.length < 6) return '#fff'
  const r = parseInt(raw.slice(0, 2), 16)
  const g = parseInt(raw.slice(2, 4), 16)
  const b = parseInt(raw.slice(4, 6), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.55 ? '#000' : '#fff'
}

interface SpecialistBadgeProps {
  displayName: string
  color: string
  className?: string
}

export function SpecialistBadge({ displayName, color, className }: SpecialistBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap',
        className,
      )}
      style={{
        backgroundColor: color,
        color: contrastTextColor(color),
      }}
    >
      {displayName}
    </span>
  )
}
