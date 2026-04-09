import { useMemo } from 'react'
import { Square } from 'lucide-react'
import { ACTIVE_WAVEFORM_BAR_COUNT } from './types'

interface VoiceRecordingBarProps {
  durationMs: number
  waveformBars: number[]
  onStop: () => void
  disabled: boolean
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function stretchWaveformBars(source: number[], targetCount: number): number[] {
  if (targetCount <= 0) return []
  if (source.length === 0) return Array.from({ length: targetCount }, () => 0)
  if (source.length === 1) return Array.from({ length: targetCount }, () => source[0] ?? 0)

  return Array.from({ length: targetCount }, (_, index) => {
    const position = (index / (targetCount - 1)) * (source.length - 1)
    const lower = Math.floor(position)
    const upper = Math.min(source.length - 1, Math.ceil(position))
    const ratio = position - lower
    const lowerValue = source[lower] ?? 0
    const upperValue = source[upper] ?? lowerValue
    return lowerValue + (upperValue - lowerValue) * ratio
  })
}

export function VoiceRecordingBar({ durationMs, waveformBars, onStop, disabled }: VoiceRecordingBarProps) {
  const activeWaveformBars = useMemo(
    () => stretchWaveformBars(waveformBars, ACTIVE_WAVEFORM_BAR_COUNT),
    [waveformBars],
  )

  return (
    <div className="flex min-h-[48px] items-center gap-2 border-b border-border/60 bg-red-500/[0.05] px-3 py-2">
      <div className="flex h-7 flex-1 items-center gap-px py-1" aria-hidden>
        {activeWaveformBars.map((bar, index) => {
          const barHeight = Math.max(2, Math.round(bar * 18))
          return (
            <span
              key={index}
              className="flex-1 rounded-[1px] bg-red-500/60 transition-[height] duration-150 ease-out"
              style={{ height: `${barHeight}px` }}
            />
          )
        })}
      </div>

      <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
        {formatDuration(durationMs)}
      </span>

      <button
        type="button"
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-red-500 text-white transition-colors hover:bg-red-600 disabled:opacity-50"
        onClick={onStop}
        disabled={disabled}
        aria-label="Stop recording"
      >
        <Square className="size-2 fill-current" />
      </button>
    </div>
  )
}
