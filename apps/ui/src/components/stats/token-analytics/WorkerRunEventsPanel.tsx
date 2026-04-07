import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { abbreviateNumber } from '../charts/chart-utils'
import { fetchTokenWorkerEvents } from './token-analytics-api'
import type {
  TokenAnalyticsWorkerEvent,
  TokenAnalyticsWorkerRunSummary,
} from '@forge/protocol'

function formatCost(value: number): string {
  if (value >= 100) return `$${value.toFixed(0)}`
  if (value >= 1) return `$${value.toFixed(2)}`
  if (value >= 0.01) return `$${value.toFixed(3)}`
  if (value > 0) return `$${value.toFixed(4)}`
  return '—'
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return iso
  }
}

interface WorkerRunEventsPanelProps {
  wsUrl: string
  profileId: string
  sessionId: string
  workerId: string
  worker: TokenAnalyticsWorkerRunSummary
}

export function WorkerRunEventsPanel({
  wsUrl,
  profileId,
  sessionId,
  workerId,
  worker,
}: WorkerRunEventsPanelProps) {
  const [events, setEvents] = useState<TokenAnalyticsWorkerEvent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setError(null)

    fetchTokenWorkerEvents(wsUrl, { profileId, sessionId, workerId })
      .then((response) => {
        if (!cancelled) {
          setEvents(response.events)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load events')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [wsUrl, profileId, sessionId, workerId])

  return (
    <div className="px-4 py-3">
      {/* Worker summary header */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          <span className="font-medium text-foreground">{worker.workerId}</span>
        </span>
        <span>Session: {worker.sessionLabel}</span>
        <span>Events: {worker.eventCount}</span>
        {worker.reasoningLevels.length > 0 ? (
          <span>Reasoning: {worker.reasoningLevels.join(', ')}</span>
        ) : null}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="py-4 text-xs text-destructive">{error}</div>
      ) : events.length === 0 ? (
        <div className="py-4 text-center text-xs text-muted-foreground">
          No events found
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-border/30 hover:bg-transparent">
                <TableHead>Time</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Reasoning</TableHead>
                <TableHead className="text-right">Input</TableHead>
                <TableHead className="text-right">Output</TableHead>
                <TableHead className="text-right">Cache</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event, idx) => (
                <TableRow key={idx} className="border-border/20">
                  <TableCell className="text-xs text-muted-foreground">
                    {formatTimestamp(event.timestamp)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {event.modelId}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {event.provider}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {event.reasoningLevel ?? '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {abbreviateNumber(event.usage.input)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {abbreviateNumber(event.usage.output)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {abbreviateNumber(event.usage.cacheRead)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {abbreviateNumber(event.usage.total)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {event.cost ? formatCost(event.cost.total) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
