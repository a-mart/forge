import { RefreshCw, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'

export type PlaywrightStatusFilter = 'all' | 'active' | 'inactive' | 'stale' | 'error'
export type PlaywrightSortKey = 'updatedAt' | 'worktree' | 'sessionName' | 'confidence'

export interface PlaywrightDashboardFiltersState {
  search: string
  status: PlaywrightStatusFilter
  worktree: string
  onlyCorrelated: boolean
  onlyPreferred: boolean
}

interface PlaywrightFiltersProps {
  filters: PlaywrightDashboardFiltersState
  worktreeOptions: string[]
  onFiltersChange: (filters: PlaywrightDashboardFiltersState) => void
  onRescan: () => void
  isRescanning: boolean
}

export function PlaywrightFilters({
  filters,
  worktreeOptions,
  onFiltersChange,
  onRescan,
  isRescanning,
}: PlaywrightFiltersProps) {
  const update = (patch: Partial<PlaywrightDashboardFiltersState>) => {
    onFiltersChange({ ...filters, ...patch })
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      {/* Search */}
      <div className="relative flex-1 min-w-[200px]">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
        <Input
          value={filters.search}
          onChange={(e) => update({ search: e.target.value })}
          placeholder="Search sessions…"
          className="h-8 pl-8 pr-8 text-sm"
        />
        {filters.search.length > 0 ? (
          <button
            type="button"
            onClick={() => update({ search: '' })}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-muted-foreground"
            aria-label="Clear search"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>

      {/* Status filter */}
      <Select
        value={filters.status}
        onValueChange={(value) => update({ status: value as PlaywrightStatusFilter })}
      >
        <SelectTrigger className="h-8 w-full text-sm sm:w-[130px]">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          <SelectItem value="active">Active</SelectItem>
          <SelectItem value="inactive">Inactive</SelectItem>
          <SelectItem value="stale">Stale</SelectItem>
          <SelectItem value="error">Error</SelectItem>
        </SelectContent>
      </Select>

      {/* Worktree filter */}
      {worktreeOptions.length > 0 ? (
        <Select
          value={filters.worktree}
          onValueChange={(value) => update({ worktree: value })}
        >
          <SelectTrigger className="h-8 w-full text-sm sm:w-[180px]">
            <SelectValue placeholder="Worktree" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All worktrees</SelectItem>
            {worktreeOptions.map((wt) => (
              <SelectItem key={wt} value={wt}>
                {wt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {/* Toggle: correlated only */}
      <div className="flex items-center gap-1.5">
        <Switch
          id="only-correlated"
          checked={filters.onlyCorrelated}
          onCheckedChange={(checked) => update({ onlyCorrelated: checked === true })}
          className="scale-75"
        />
        <Label htmlFor="only-correlated" className="text-xs text-muted-foreground cursor-pointer">
          Correlated only
        </Label>
      </div>

      {/* Toggle: preferred only */}
      <div className="flex items-center gap-1.5">
        <Switch
          id="only-preferred"
          checked={filters.onlyPreferred}
          onCheckedChange={(checked) => update({ onlyPreferred: checked === true })}
          className="scale-75"
        />
        <Label htmlFor="only-preferred" className="text-xs text-muted-foreground cursor-pointer">
          Preferred only
        </Label>
      </div>

      {/* Rescan button */}
      <Button
        variant="outline"
        size="sm"
        onClick={onRescan}
        disabled={isRescanning}
        className="h-8 shrink-0"
      >
        <RefreshCw className={`size-3.5 mr-1.5 ${isRescanning ? 'animate-spin' : ''}`} />
        Rescan
      </Button>
    </div>
  )
}
