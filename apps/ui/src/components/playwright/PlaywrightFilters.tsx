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

/** Stable worktree option with path-based key and user-facing label. */
export interface WorktreeOption {
  /** Unique key — worktree path, or `REPO_ROOT_WORKTREE_KEY` sentinel. */
  key: string
  /** User-facing label (worktree name or "Main repo"). */
  label: string
}

export interface PlaywrightDashboardFiltersState {
  search: string
  status: PlaywrightStatusFilter
  /** Worktree filter value — `'all'` or a `WorktreeOption.key`. */
  worktree: string
  onlyCorrelated: boolean
  onlyPreferred: boolean
  showInactive: boolean
  showStale: boolean
}

interface PlaywrightFiltersProps {
  filters: PlaywrightDashboardFiltersState
  worktreeOptions: WorktreeOption[]
  onFiltersChange: (filters: PlaywrightDashboardFiltersState) => void
  onRescan: () => void
  isRescanning: boolean
  /** Compact mode hides less-used toggles behind the search bar */
  compact?: boolean
}

export function PlaywrightFilters({
  filters,
  worktreeOptions,
  onFiltersChange,
  onRescan,
  isRescanning,
  compact = false,
}: PlaywrightFiltersProps) {
  const update = (patch: Partial<PlaywrightDashboardFiltersState>) => {
    onFiltersChange({ ...filters, ...patch })
  }

  // In compact mode, show only search + status + worktree inline.
  // The toggle switches are omitted (the parent handles sensible defaults).
  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {/* Search */}
        <div className="relative flex-1 min-w-[160px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            value={filters.search}
            onChange={(e) => update({ search: e.target.value })}
            placeholder="Search…"
            className="h-7 pl-8 pr-8 text-xs"
          />
          {filters.search.length > 0 ? (
            <button
              type="button"
              onClick={() => update({ search: '' })}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-muted-foreground"
              aria-label="Clear search"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>

        {/* Status filter */}
        <Select
          value={filters.status}
          onValueChange={(value) => update({ status: value as PlaywrightStatusFilter })}
        >
          <SelectTrigger className="h-7 w-[110px] text-xs">
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
            <SelectTrigger className="h-7 w-[140px] text-xs">
              <SelectValue placeholder="Workspace" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All workspaces</SelectItem>
              {worktreeOptions.map((wt) => (
                <SelectItem key={wt.key} value={wt.key}>
                  {wt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
    )
  }

  // Full filter bar (split/grid modes)
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
            <SelectValue placeholder="Workspace" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All workspaces</SelectItem>
            {worktreeOptions.map((wt) => (
              <SelectItem key={wt.key} value={wt.key}>
                {wt.label}
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

      {/* Toggle: show inactive */}
      <div className="flex items-center gap-1.5">
        <Switch
          id="show-inactive"
          checked={filters.showInactive}
          onCheckedChange={(checked) => update({ showInactive: checked === true })}
          className="scale-75"
        />
        <Label htmlFor="show-inactive" className="text-xs text-muted-foreground cursor-pointer">
          Show inactive
        </Label>
      </div>

      {/* Toggle: show stale */}
      <div className="flex items-center gap-1.5">
        <Switch
          id="show-stale"
          checked={filters.showStale}
          onCheckedChange={(checked) => update({ showStale: checked === true })}
          className="scale-75"
        />
        <Label htmlFor="show-stale" className="text-xs text-muted-foreground cursor-pointer">
          Show stale
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
