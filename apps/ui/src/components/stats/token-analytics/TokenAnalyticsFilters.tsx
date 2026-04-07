import { useMemo, useState, useCallback } from 'react'
import { X, Calendar, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger, PopoverClose } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type {
  TokenAnalyticsRangePreset,
  TokenAnalyticsAttributionFilter,
  TokenAnalyticsAvailableFilters,
} from '@forge/protocol'

const RANGE_PRESETS: { value: TokenAnalyticsRangePreset; label: string }[] = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom' },
]

export interface TokenAnalyticsFilterState {
  rangePreset: TokenAnalyticsRangePreset
  startDate?: string
  endDate?: string
  profileId?: string
  provider?: string
  modelId?: string
  attribution?: TokenAnalyticsAttributionFilter
  specialistId?: string
}

interface TokenAnalyticsFiltersProps {
  filters: TokenAnalyticsFilterState
  availableFilters?: TokenAnalyticsAvailableFilters
  onFiltersChange: (filters: TokenAnalyticsFilterState) => void
}

export function TokenAnalyticsFilters({
  filters,
  availableFilters,
  onFiltersChange,
}: TokenAnalyticsFiltersProps) {
  // Draft state for custom date range — only committed on Apply
  const [draftStart, setDraftStart] = useState(filters.startDate ?? '')
  const [draftEnd, setDraftEnd] = useState(filters.endDate ?? '')

  const hasActiveFilters = useMemo(() => {
    return Boolean(
      filters.profileId ||
        filters.provider ||
        filters.modelId ||
        (filters.attribution && filters.attribution !== 'all') ||
        filters.specialistId,
    )
  }, [filters])

  const handleClearFilters = () => {
    onFiltersChange({
      rangePreset: filters.rangePreset,
      startDate: filters.startDate,
      endDate: filters.endDate,
    })
  }

  const updateFilter = (patch: Partial<TokenAnalyticsFilterState>) => {
    onFiltersChange({ ...filters, ...patch })
  }

  // Validation for custom date range draft
  const draftValid = Boolean(draftStart && draftEnd && draftEnd >= draftStart)
  const showInvertedError = Boolean(draftStart && draftEnd && draftEnd < draftStart)

  const handleApplyCustomRange = useCallback(() => {
    if (!draftValid) return
    onFiltersChange({
      ...filters,
      rangePreset: 'custom',
      startDate: draftStart,
      endDate: draftEnd,
    })
  }, [filters, draftStart, draftEnd, draftValid, onFiltersChange])

  // When opening the popover, sync draft from committed filters
  const handlePopoverOpen = useCallback(
    (open: boolean) => {
      if (open) {
        setDraftStart(filters.startDate ?? '')
        setDraftEnd(filters.endDate ?? '')
      }
    },
    [filters.startDate, filters.endDate],
  )

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Profile */}
      {availableFilters && availableFilters.profiles.length > 0 ? (
        <Select
          value={filters.profileId ?? '__all__'}
          onValueChange={(v) => updateFilter({ profileId: v === '__all__' ? undefined : v })}
        >
          <SelectTrigger className="h-8 w-auto min-w-[120px] border-border/50 bg-card/80 text-xs">
            <SelectValue placeholder="All projects" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All projects</SelectItem>
            {availableFilters.profiles.map((p) => (
              <SelectItem key={p.profileId} value={p.profileId}>
                {p.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {/* Range preset */}
      <div className="flex items-center gap-1">
        {RANGE_PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => {
              if (preset.value === 'custom') {
                // Just switch the visual preset — don't commit dates yet.
                // The popover will handle date entry and Apply.
                if (filters.rangePreset !== 'custom') {
                  // Switch to custom preset but keep the last non-custom query active
                  // until user applies valid dates. We set rangePreset locally but
                  // don't fire onFiltersChange with custom + no dates.
                  // Instead, we still need the preset button to appear selected,
                  // so we set custom but keep the old dates if present.
                  if (filters.startDate && filters.endDate) {
                    updateFilter({ rangePreset: 'custom' })
                  } else {
                    // No dates yet — switch preset visually but suppress the fetch
                    // by keeping rangePreset as custom with existing (undefined) dates.
                    // The panel will suppress fetches for incomplete custom ranges.
                    updateFilter({ rangePreset: 'custom', startDate: undefined, endDate: undefined })
                  }
                }
              } else {
                const patch: Partial<TokenAnalyticsFilterState> = { rangePreset: preset.value }
                patch.startDate = undefined
                patch.endDate = undefined
                updateFilter(patch)
              }
            }}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              filters.rangePreset === preset.value
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
            )}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* Custom date range */}
      {filters.rangePreset === 'custom' ? (
        <Popover onOpenChange={handlePopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 border-border/50 bg-card/80 text-xs"
            >
              <Calendar className="size-3" />
              {filters.startDate && filters.endDate
                ? `${filters.startDate} – ${filters.endDate}`
                : 'Pick dates'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-3" align="start">
            <div className="flex items-center gap-2">
              <div>
                <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                  Start
                </label>
                <input
                  type="date"
                  value={draftStart}
                  onChange={(e) => setDraftStart(e.target.value)}
                  className="h-8 rounded-md border border-border/50 bg-card px-2 text-xs text-foreground"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                  End
                </label>
                <input
                  type="date"
                  value={draftEnd}
                  onChange={(e) => setDraftEnd(e.target.value)}
                  className="h-8 rounded-md border border-border/50 bg-card px-2 text-xs text-foreground"
                />
              </div>
            </div>
            {showInvertedError ? (
              <p className="mt-1.5 text-[11px] text-destructive">End date must be on or after start date</p>
            ) : null}
            <div className="mt-2 flex justify-end">
              <PopoverClose asChild>
                <Button
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  disabled={!draftValid}
                  onClick={handleApplyCustomRange}
                >
                  <Check className="size-3" />
                  Apply
                </Button>
              </PopoverClose>
            </div>
          </PopoverContent>
        </Popover>
      ) : null}

      {/* Provider */}
      {availableFilters && availableFilters.providers.length > 0 ? (
        <Select
          value={filters.provider ?? '__all__'}
          onValueChange={(v) => updateFilter({ provider: v === '__all__' ? undefined : v })}
        >
          <SelectTrigger className="h-8 w-auto min-w-[110px] border-border/50 bg-card/80 text-xs">
            <SelectValue placeholder="All providers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All providers</SelectItem>
            {availableFilters.providers.map((p) => (
              <SelectItem key={p.provider} value={p.provider}>
                {p.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {/* Model */}
      {availableFilters && availableFilters.models.length > 0 ? (
        <Select
          value={filters.modelId ?? '__all__'}
          onValueChange={(v) => updateFilter({ modelId: v === '__all__' ? undefined : v })}
        >
          <SelectTrigger className="h-8 w-auto min-w-[120px] border-border/50 bg-card/80 text-xs">
            <SelectValue placeholder="All models" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All models</SelectItem>
            {availableFilters.models.map((m) => (
              <SelectItem key={m.modelId} value={m.modelId}>
                {m.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {/* Attribution */}
      {availableFilters && availableFilters.attributions.length > 0 ? (
        <Select
          value={filters.attribution ?? 'all'}
          onValueChange={(v) => {
            const attribution = v as TokenAnalyticsAttributionFilter
            const patch: Partial<TokenAnalyticsFilterState> = { attribution }
            // Clear specialist when switching away from specialist attribution
            if (attribution !== 'specialist') {
              patch.specialistId = undefined
            }
            updateFilter(patch)
          }}
        >
          <SelectTrigger className="h-8 w-auto min-w-[120px] border-border/50 bg-card/80 text-xs">
            <SelectValue placeholder="All origins" />
          </SelectTrigger>
          <SelectContent>
            {availableFilters.attributions.map((a) => (
              <SelectItem key={a.value} value={a.value}>
                {a.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {/* Specialist (only when attribution is specialist or all) */}
      {availableFilters &&
      availableFilters.specialists.length > 0 &&
      (!filters.attribution || filters.attribution === 'all' || filters.attribution === 'specialist') ? (
        <Select
          value={filters.specialistId ?? '__all__'}
          onValueChange={(v) => updateFilter({ specialistId: v === '__all__' ? undefined : v })}
        >
          <SelectTrigger className="h-8 w-auto min-w-[120px] border-border/50 bg-card/80 text-xs">
            <SelectValue placeholder="All specialists" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All specialists</SelectItem>
            {availableFilters.specialists.map((s) => (
              <SelectItem key={s.specialistId} value={s.specialistId}>
                <span className="flex items-center gap-1.5">
                  {s.color ? (
                    <span
                      className="inline-block size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: s.color }}
                    />
                  ) : null}
                  {s.displayName}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {/* Clear filters */}
      {hasActiveFilters ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={handleClearFilters}
        >
          <X className="size-3" />
          Clear
        </Button>
      ) : null}
    </div>
  )
}
