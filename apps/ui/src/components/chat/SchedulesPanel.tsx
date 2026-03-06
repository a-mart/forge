import { useEffect, useMemo, useState } from 'react'
import { Clock3, Loader2 } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { cn } from '@/lib/utils'

// ── Types ──

export interface ScheduleRecord {
  id: string
  name: string
  cron: string
  message: string
  oneShot: boolean
  timezone: string
  createdAt: string
  nextFireAt: string
  lastFiredAt?: string
}

// ── Helpers ──

function normalizeRequiredString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeSchedule(value: unknown): ScheduleRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const entry = value as Partial<ScheduleRecord>
  const id = normalizeRequiredString(entry.id)
  const name = normalizeRequiredString(entry.name)
  const cron = normalizeRequiredString(entry.cron)
  const message = normalizeRequiredString(entry.message)
  const timezone = normalizeRequiredString(entry.timezone)
  const createdAt = normalizeRequiredString(entry.createdAt)
  const nextFireAt = normalizeRequiredString(entry.nextFireAt)

  if (!id || !name || !cron || !message || !timezone || !createdAt || !nextFireAt) return null

  const lastFiredAt = normalizeRequiredString(entry.lastFiredAt) ?? undefined

  return {
    id,
    name,
    cron,
    message,
    oneShot: typeof entry.oneShot === 'boolean' ? entry.oneShot : false,
    timezone,
    createdAt,
    nextFireAt,
    lastFiredAt,
  }
}

function resolveManagerSchedulesEndpoint(wsUrl: string, managerId: string): string {
  const normalizedManagerId = managerId.trim()
  if (!normalizedManagerId) throw new Error('managerId is required.')
  return resolveApiEndpoint(wsUrl, `/api/managers/${encodeURIComponent(normalizedManagerId)}/schedules`)
}

export async function fetchSchedules(
  wsUrl: string,
  managerId: string,
  signal: AbortSignal,
): Promise<ScheduleRecord[]> {
  const response = await fetch(resolveManagerSchedulesEndpoint(wsUrl, managerId), { signal })
  if (!response.ok) throw new Error(`Unable to load schedules (${response.status})`)

  const payload = (await response.json()) as { schedules?: unknown }
  if (!payload || !Array.isArray(payload.schedules)) return []

  return payload.schedules
    .map((entry) => normalizeSchedule(entry))
    .filter((entry): entry is ScheduleRecord => entry !== null)
}

function sortSchedules(left: ScheduleRecord, right: ScheduleRecord): number {
  const leftTs = Date.parse(left.nextFireAt)
  const rightTs = Date.parse(right.nextFireAt)

  if (!Number.isNaN(leftTs) && !Number.isNaN(rightTs)) return leftTs - rightTs
  if (!Number.isNaN(leftTs)) return -1
  if (!Number.isNaN(rightTs)) return 1

  return left.name.localeCompare(right.name)
}

function formatDateTime(value: string, timeZone?: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'

  try {
    return date.toLocaleString([], {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(timeZone ? { timeZone } : {}),
    })
  } catch {
    return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
  }
}

function format24HourTime(hour: string, minute: string): string | null {
  const numericHour = Number.parseInt(hour, 10)
  const numericMinute = Number.parseInt(minute, 10)

  if (
    Number.isNaN(numericHour) ||
    Number.isNaN(numericMinute) ||
    numericHour < 0 ||
    numericHour > 23 ||
    numericMinute < 0 ||
    numericMinute > 59
  ) {
    return null
  }

  return `${numericHour.toString().padStart(2, '0')}:${numericMinute.toString().padStart(2, '0')}`
}

function isWildcard(value: string): boolean {
  return value === '*'
}

function isStep(value: string): boolean {
  return /^\*\/\d+$/.test(value)
}

function isNumeric(value: string): boolean {
  return /^\d+$/.test(value)
}

function parseDayOfWeek(value: string): string | null {
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  if (!isNumeric(value)) return null
  const dayIndex = Number.parseInt(value, 10)
  if (dayIndex < 0 || dayIndex > 7) return null
  return weekdays[dayIndex % 7] ?? null
}

export function describeCronExpression(cron: string): string {
  const segments = cron.trim().split(/\s+/)
  if (segments.length < 5 || segments.length > 6) return 'Custom cron schedule'

  const startIndex = segments.length === 6 ? 1 : 0
  const minute = segments[startIndex] ?? '*'
  const hour = segments[startIndex + 1] ?? '*'
  const dayOfMonth = segments[startIndex + 2] ?? '*'
  const month = segments[startIndex + 3] ?? '*'
  const dayOfWeek = segments[startIndex + 4] ?? '*'

  if ([minute, hour, dayOfMonth, month, dayOfWeek].every(isWildcard)) return 'Every minute'

  if (isStep(minute) && isWildcard(hour) && isWildcard(dayOfMonth) && isWildcard(month) && isWildcard(dayOfWeek)) {
    return `Every ${minute.slice(2)} minutes`
  }

  if (isNumeric(minute) && isWildcard(hour) && isWildcard(dayOfMonth) && isWildcard(month) && isWildcard(dayOfWeek)) {
    return `At minute ${minute} past every hour`
  }

  if (isNumeric(minute) && isNumeric(hour) && isWildcard(dayOfMonth) && isWildcard(month) && isWildcard(dayOfWeek)) {
    const time = format24HourTime(hour, minute)
    return time ? `Every day at ${time}` : 'Custom cron schedule'
  }

  if (isNumeric(minute) && isNumeric(hour) && isWildcard(dayOfMonth) && isWildcard(month)) {
    const time = format24HourTime(hour, minute)
    const weekday = parseDayOfWeek(dayOfWeek)
    if (time && weekday) return `Every ${weekday} at ${time}`
  }

  if (isNumeric(minute) && isNumeric(hour) && isNumeric(dayOfMonth) && isWildcard(month) && isWildcard(dayOfWeek)) {
    const time = format24HourTime(hour, minute)
    return time ? `Day ${dayOfMonth} of each month at ${time}` : 'Custom cron schedule'
  }

  return 'Custom cron schedule'
}

// ── Component ──

interface SchedulesPanelProps {
  wsUrl: string
  managerId: string
  isActive: boolean
}

export function SchedulesPanel({ wsUrl, managerId, isActive }: SchedulesPanelProps) {
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null)

  const sortedSchedules = useMemo(() => [...schedules].sort(sortSchedules), [schedules])

  const selectedSchedule = useMemo(() => {
    if (sortedSchedules.length === 0) return null
    if (!selectedScheduleId) return sortedSchedules[0]
    return sortedSchedules.find((s) => s.id === selectedScheduleId) ?? sortedSchedules[0]
  }, [selectedScheduleId, sortedSchedules])

  useEffect(() => {
    if (!isActive) return

    if (!managerId.trim()) {
      setSchedules([])
      setSelectedScheduleId(null)
      setError('Select a manager to load schedules.')
      setIsLoading(false)
      return
    }

    const abortController = new AbortController()
    setIsLoading(true)
    setError(null)

    void fetchSchedules(wsUrl, managerId, abortController.signal)
      .then((nextSchedules) => {
        if (abortController.signal.aborted) return
        setSchedules(nextSchedules)
        setSelectedScheduleId((current) => {
          if (current && nextSchedules.some((s) => s.id === current)) return current
          return nextSchedules[0]?.id ?? null
        })
      })
      .catch((err: unknown) => {
        if (abortController.signal.aborted) return
        const message = err instanceof Error ? err.message : 'Unable to load schedules'
        setSchedules([])
        setError(message)
        setSelectedScheduleId(null)
      })
      .finally(() => {
        if (abortController.signal.aborted) return
        setIsLoading(false)
      })

    return () => {
      abortController.abort()
    }
  }, [isActive, managerId, wsUrl])

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center px-4 py-12 text-center">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          Loading schedules...
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4 py-12 text-center">
        <Clock3 className="mb-2 size-8 text-muted-foreground/40" aria-hidden="true" />
        <p className="text-xs text-muted-foreground">Unable to load schedules</p>
        <p className="mt-1 text-[11px] text-muted-foreground/70">{error}</p>
      </div>
    )
  }

  if (sortedSchedules.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4 py-12 text-center">
        <Clock3 className="mb-2 size-8 text-muted-foreground/40" aria-hidden="true" />
        <p className="text-xs text-muted-foreground">No schedules yet</p>
        <p className="mt-1 text-[11px] text-muted-foreground/70">
          Cron jobs will appear here once scheduled.
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea
        className={cn(
          'min-h-0 flex-1',
          '[&>[data-slot=scroll-area-scrollbar]]:w-1.5',
          '[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-transparent',
          'hover:[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-border',
        )}
      >
        <div className="space-y-0.5 p-2">
          {sortedSchedules.map((schedule) => (
            <button
              key={schedule.id}
              type="button"
              className={cn(
                'group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
                'transition-colors duration-100',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60',
                selectedSchedule?.id === schedule.id
                  ? 'bg-accent/50 text-foreground'
                  : 'text-foreground hover:bg-accent/70',
              )}
              onClick={() => setSelectedScheduleId(schedule.id)}
              title={schedule.name}
            >
              <span
                className={cn(
                  'inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors',
                  selectedSchedule?.id === schedule.id
                    ? 'bg-primary/15 text-primary'
                    : 'bg-muted/60 text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary',
                )}
              >
                <Clock3 className="size-3.5" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{schedule.name}</span>
                <span className="block truncate text-[10px] text-muted-foreground/70">
                  {describeCronExpression(schedule.cron)}
                </span>
              </span>
            </button>
          ))}
        </div>
      </ScrollArea>

      {selectedSchedule ? (
        <div className="shrink-0 border-t border-border/80 p-3">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Clock3 className="size-3" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-xs font-semibold leading-snug text-foreground">
                {selectedSchedule.name}
              </h3>
              <span className="mt-0.5 inline-block rounded-full bg-muted/80 px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                {selectedSchedule.oneShot ? 'One-time' : 'Recurring'}
              </span>
            </div>
          </div>

          <div className="mt-3 space-y-2 text-[11px]">
            <div className="flex items-baseline justify-between gap-2">
              <span className="shrink-0 text-muted-foreground">Schedule</span>
              <span className="truncate text-right font-medium text-foreground">
                {describeCronExpression(selectedSchedule.cron)}
              </span>
            </div>

            <div className="flex items-baseline justify-between gap-2">
              <span className="shrink-0 text-muted-foreground">Expression</span>
              <code className="truncate rounded bg-muted/60 px-1 py-0.5 font-mono text-[10px] text-foreground">
                {selectedSchedule.cron}
              </code>
            </div>

            <div className="flex items-baseline justify-between gap-2">
              <span className="shrink-0 text-muted-foreground">Next fire</span>
              <span className="truncate text-right text-foreground">
                {formatDateTime(selectedSchedule.nextFireAt, selectedSchedule.timezone)}
              </span>
            </div>

            {selectedSchedule.lastFiredAt ? (
              <div className="flex items-baseline justify-between gap-2">
                <span className="shrink-0 text-muted-foreground">Last fired</span>
                <span className="truncate text-right text-foreground">
                  {formatDateTime(selectedSchedule.lastFiredAt)}
                </span>
              </div>
            ) : null}

            <div className="flex items-baseline justify-between gap-2">
              <span className="shrink-0 text-muted-foreground">Timezone</span>
              <span className="truncate text-right text-foreground">
                {selectedSchedule.timezone}
              </span>
            </div>
          </div>

          <div className="mt-3">
            <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">Message</p>
            <div className="rounded-lg bg-muted/30 p-2.5 ring-1 ring-border/40">
              <ScrollArea className="max-h-24">
                <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">
                  {selectedSchedule.message}
                </p>
              </ScrollArea>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
