import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Card } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { abbreviateNumber } from '../charts/chart-utils'
import { cn } from '@/lib/utils'
import type { TokenAnalyticsSpecialistSummary } from '@forge/protocol'

type SortField = 'runCount' | 'averageTokensPerRun' | 'totalTokens' | 'percentOfScopedTokens'
type SortDir = 'asc' | 'desc'

function getDisplayNameForAttribution(summary: TokenAnalyticsSpecialistSummary): string {
  if (summary.attributionKind === 'ad_hoc') return 'Ad-hoc Workers'
  if (summary.attributionKind === 'unknown') return 'Legacy'
  return summary.displayName
}

function getColorForAttribution(summary: TokenAnalyticsSpecialistSummary): string | null {
  if (summary.attributionKind === 'ad_hoc') return '#3b82f6'
  if (summary.attributionKind === 'unknown') return '#6b7280'
  return summary.color ?? '#8b5cf6'
}

interface SortableHeaderProps {
  label: string
  field: SortField
  currentSort: SortField
  currentDir: SortDir
  onSort: (field: SortField) => void
  className?: string
}

function SortableHeader({ label, field, currentSort, currentDir, onSort, className }: SortableHeaderProps) {
  const isActive = currentSort === field
  return (
    <TableHead className={cn('cursor-pointer select-none', className)} onClick={() => onSort(field)}>
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive ? (
          currentDir === 'desc' ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronUp className="size-3" />
          )
        ) : null}
      </span>
    </TableHead>
  )
}

interface SpecialistBreakdownTableProps {
  breakdown: TokenAnalyticsSpecialistSummary[]
  onSpecialistClick?: (specialistId: string | null) => void
}

export function SpecialistBreakdownTable({
  breakdown,
  onSpecialistClick,
}: SpecialistBreakdownTableProps) {
  const [sortField, setSortField] = useState<SortField>('totalTokens')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortField(field)
      setSortDir('desc')
    }
  }

  const sorted = useMemo(() => {
    return [...breakdown].sort((a, b) => {
      let aVal: number
      let bVal: number
      switch (sortField) {
        case 'runCount':
          aVal = a.runCount
          bVal = b.runCount
          break
        case 'averageTokensPerRun':
          aVal = a.averageTokensPerRun
          bVal = b.averageTokensPerRun
          break
        case 'totalTokens':
          aVal = a.usage.total
          bVal = b.usage.total
          break
        case 'percentOfScopedTokens':
          aVal = a.percentOfScopedTokens
          bVal = b.percentOfScopedTokens
          break
        default:
          aVal = a.usage.total
          bVal = b.usage.total
      }
      return sortDir === 'desc' ? bVal - aVal : aVal - bVal
    })
  }, [breakdown, sortField, sortDir])

  if (breakdown.length === 0) {
    return null
  }

  return (
    <Card className="border-border/50 bg-card/80 backdrop-blur-sm">
      <div className="p-3 pb-0">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Specialist Breakdown
        </div>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="border-border/30 hover:bg-transparent">
              <TableHead className="min-w-[140px]">Specialist</TableHead>
              <SortableHeader label="Runs" field="runCount" currentSort={sortField} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortableHeader label="Avg/Run" field="averageTokensPerRun" currentSort={sortField} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortableHeader label="Total Tokens" field="totalTokens" currentSort={sortField} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortableHeader label="% of Total" field="percentOfScopedTokens" currentSort={sortField} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <TableHead>Top Model</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => {
              const key = row.specialistId ?? row.attributionKind
              const color = getColorForAttribution(row)
              const name = getDisplayNameForAttribution(row)
              const isClickable = row.attributionKind === 'specialist' && row.specialistId
              return (
                <TableRow
                  key={key}
                  className={cn(
                    'border-border/20',
                    isClickable && 'cursor-pointer hover:bg-muted/30',
                  )}
                  onClick={isClickable ? () => onSpecialistClick?.(row.specialistId) : undefined}
                >
                  <TableCell className="font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      {color ? (
                        <span
                          className="inline-block size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: color }}
                        />
                      ) : null}
                      <span className="text-xs">{name}</span>
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {row.runCount.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {abbreviateNumber(row.averageTokensPerRun)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {abbreviateNumber(row.usage.total)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {row.percentOfScopedTokens.toFixed(1)}%
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {row.topModelId ?? '—'}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}
