import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type {
  GenerationQualityFilter,
  GenerationRoleFilter,
  GenerationThroughputAvailableFilters,
  GenerationThroughputRangePreset,
  TokenAnalyticsAttributionFilter,
} from '@forge/protocol'
import { cn } from '@/lib/utils'

const RANGES: Array<{ value: GenerationThroughputRangePreset; label: string }> = [
  { value: '7d', label: '7 days' }, { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' }, { value: 'custom', label: 'Custom' },
]

export interface GenerationThroughputFilterState {
  rangePreset: GenerationThroughputRangePreset
  startDate?: string
  endDate?: string
  profileId?: string
  role?: GenerationRoleFilter
  provider?: string
  modelId?: string
  quality?: GenerationQualityFilter
  attribution?: TokenAnalyticsAttributionFilter
  specialistId?: string
}

export function GenerationThroughputFilters({
  filters,
  availableFilters,
  onFiltersChange,
}: {
  filters: GenerationThroughputFilterState
  availableFilters?: GenerationThroughputAvailableFilters
  onFiltersChange: (next: GenerationThroughputFilterState) => void
}) {
  const patch = (next: Partial<GenerationThroughputFilterState>) => onFiltersChange({ ...filters, ...next })
  const active = Boolean(filters.profileId || filters.role === 'manager' || filters.role === 'worker' || filters.provider || filters.modelId || (filters.quality && filters.quality !== 'all_measured') || (filters.attribution && filters.attribution !== 'all') || filters.specialistId)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        {RANGES.map((range) => (
          <button key={range.value} type="button" onClick={() => patch({ rangePreset: range.value, ...(range.value === 'custom' ? {} : { startDate: undefined, endDate: undefined }) })} className={cn('rounded-md px-2.5 py-1 text-xs font-medium transition-colors', filters.rangePreset === range.value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground')}>
            {range.label}
          </button>
        ))}
      </div>
      {filters.rangePreset === 'custom' ? (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <input aria-label="Throughput start date" type="date" value={filters.startDate ?? ''} onChange={(event) => patch({ startDate: event.target.value || undefined })} className="h-8 rounded-md border border-border/50 bg-card px-2 text-xs text-foreground" />
          <span>–</span>
          <input aria-label="Throughput end date" type="date" value={filters.endDate ?? ''} onChange={(event) => patch({ endDate: event.target.value || undefined })} className="h-8 rounded-md border border-border/50 bg-card px-2 text-xs text-foreground" />
        </div>
      ) : null}
      <Select value={filters.role ?? 'all'} onValueChange={(value) => patch({ role: value as GenerationRoleFilter })}>
        <SelectTrigger className="h-8 w-auto min-w-[105px] border-border/50 bg-card/80 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="all">All roles</SelectItem><SelectItem value="manager">Managers</SelectItem><SelectItem value="worker">Workers</SelectItem></SelectContent>
      </Select>
      <Select value={filters.quality ?? 'all_measured'} onValueChange={(value) => patch({ quality: value as GenerationQualityFilter })}>
        <SelectTrigger className="h-8 w-auto min-w-[128px] border-border/50 bg-card/80 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="all_measured">All measured</SelectItem><SelectItem value="strict">Strict boundaries</SelectItem><SelectItem value="all">All calls</SelectItem></SelectContent>
      </Select>
      {availableFilters?.profiles.length ? <Select value={filters.profileId ?? 'all'} onValueChange={(value) => patch({ profileId: value === 'all' ? undefined : value })}><SelectTrigger className="h-8 w-auto min-w-[115px] border-border/50 bg-card/80 text-xs"><SelectValue placeholder="All projects" /></SelectTrigger><SelectContent><SelectItem value="all">All projects</SelectItem>{availableFilters.profiles.map((profile) => <SelectItem key={profile.profileId} value={profile.profileId}>{profile.displayName}</SelectItem>)}</SelectContent></Select> : null}
      {availableFilters?.providers.length ? <Select value={filters.provider ?? 'all'} onValueChange={(value) => patch({ provider: value === 'all' ? undefined : value, ...(value === 'all' ? {} : { modelId: undefined }) })}><SelectTrigger className="h-8 w-auto min-w-[115px] border-border/50 bg-card/80 text-xs"><SelectValue placeholder="All providers" /></SelectTrigger><SelectContent><SelectItem value="all">All providers</SelectItem>{availableFilters.providers.map((provider) => <SelectItem key={provider.provider} value={provider.provider}>{provider.provider}</SelectItem>)}</SelectContent></Select> : null}
      {availableFilters?.models.length ? <Select value={filters.modelId ? `${filters.provider ?? ''}\u0000${filters.modelId}` : 'all'} onValueChange={(value) => { if (value === 'all') patch({ modelId: undefined }); else { const [provider, modelId] = value.split('\u0000'); patch({ provider, modelId }) } }}><SelectTrigger className="h-8 w-auto min-w-[125px] border-border/50 bg-card/80 text-xs"><SelectValue placeholder="All models" /></SelectTrigger><SelectContent><SelectItem value="all">All models</SelectItem>{availableFilters.models.map((model) => <SelectItem key={`${model.provider}\u0000${model.modelId}`} value={`${model.provider}\u0000${model.modelId}`}>{model.displayName}</SelectItem>)}</SelectContent></Select> : null}
      <Select value={filters.attribution ?? 'all'} onValueChange={(value) => patch({ attribution: value as TokenAnalyticsAttributionFilter, ...(value === 'specialist' || value === 'all' ? {} : { specialistId: undefined }) })}><SelectTrigger className="h-8 w-auto min-w-[120px] border-border/50 bg-card/80 text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All attribution</SelectItem><SelectItem value="specialist">Specialists</SelectItem><SelectItem value="ad_hoc">Ad hoc</SelectItem><SelectItem value="unknown">Unknown</SelectItem></SelectContent></Select>
      {availableFilters?.specialists.length && (!filters.attribution || filters.attribution === 'all' || filters.attribution === 'specialist') ? <Select value={filters.specialistId ?? 'all'} onValueChange={(value) => patch({ specialistId: value === 'all' ? undefined : value, ...(value === 'all' ? {} : { attribution: 'specialist' }) })}><SelectTrigger className="h-8 w-auto min-w-[125px] border-border/50 bg-card/80 text-xs"><SelectValue placeholder="All specialists" /></SelectTrigger><SelectContent><SelectItem value="all">All specialists</SelectItem>{availableFilters.specialists.map((specialist) => <SelectItem key={specialist.specialistId} value={specialist.specialistId}>{specialist.displayName}</SelectItem>)}</SelectContent></Select> : null}
      {active ? <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs text-muted-foreground" onClick={() => onFiltersChange({ rangePreset: filters.rangePreset, startDate: filters.startDate, endDate: filters.endDate })}><X className="size-3" />Clear</Button> : null}
    </div>
  )
}
