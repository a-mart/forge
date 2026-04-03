import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Loader2, RotateCcw, Search } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { OpenRouterBrowseRow } from './OpenRouterBrowseRow'
import { addOpenRouterModel, fetchAvailableOpenRouterModels, type AvailableOpenRouterModel } from './openrouter-api'


type CapabilityFilter = 'reasoning' | 'vision' | 'tools'

interface ProviderGroupData {
  provider: string
  models: AvailableOpenRouterModel[]
}

interface OpenRouterBrowseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  wsUrl: string | undefined
  addedModelIds: Set<string>
  onModelAdded: () => void
}

export function OpenRouterBrowseDialog({
  open,
  onOpenChange,
  wsUrl,
  addedModelIds,
  onModelAdded,
}: OpenRouterBrowseDialogProps) {
  const [allModels, setAllModels] = useState<AvailableOpenRouterModel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [activeFilters, setActiveFilters] = useState<Set<CapabilityFilter>>(new Set())
  const [addingModelId, setAddingModelId] = useState<string | null>(null)
  const [localAddedIds, setLocalAddedIds] = useState<Set<string>>(new Set())
  const [actionError, setActionError] = useState<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 150)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Sync parent addedModelIds into local state when dialog opens
  useEffect(() => {
    if (open) {
      setLocalAddedIds(new Set(addedModelIds))
      setActionError(null)
    }
  }, [open, addedModelIds])

  // Load available models on dialog open
  useEffect(() => {
    if (!open) return

    let cancelled = false

    const load = async () => {
      setLoading(true)
      setError(null)
      setActionError(null)
      try {
        const models = await fetchAvailableOpenRouterModels(wsUrl)
        if (!cancelled) {
          setAllModels(models)
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [open, wsUrl])

  // Autofocus search on open
  useEffect(() => {
    if (open) {
      // Small delay to let the dialog render
      const timer = setTimeout(() => searchInputRef.current?.focus(), 100)
      return () => clearTimeout(timer)
    }
  }, [open])

  // Filter and group
  const { groups, filteredCount, totalCount } = useMemo(() => {
    const query = debouncedQuery.trim().toLowerCase()
    const total = allModels.length

    const filtered = allModels.filter((model) => {
      // Text search
      if (query) {
        const matchesSearch =
          model.modelId.toLowerCase().includes(query) ||
          model.displayName.toLowerCase().includes(query) ||
          model.upstreamProvider.toLowerCase().includes(query)
        if (!matchesSearch) return false
      }

      // Capability filters (AND logic)
      if (activeFilters.has('reasoning') && !model.supportsReasoning) return false
      if (activeFilters.has('vision') && !model.inputModes.includes('image')) return false
      if (activeFilters.has('tools') && !model.supportsTools) return false

      return true
    })

    // Group by upstream provider
    const byProvider = new Map<string, AvailableOpenRouterModel[]>()
    for (const model of filtered) {
      const provider = model.upstreamProvider || 'other'
      const existing = byProvider.get(provider)
      if (existing) {
        existing.push(model)
      } else {
        byProvider.set(provider, [model])
      }
    }

    // Sort providers alphabetically, models within each group alphabetically by display name
    const sortedGroups: ProviderGroupData[] = Array.from(byProvider.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, models]) => ({
        provider,
        models: models.sort((a, b) => a.displayName.localeCompare(b.displayName)),
      }))

    return { groups: sortedGroups, filteredCount: filtered.length, totalCount: total }
  }, [allModels, debouncedQuery, activeFilters])

  const handleAdd = useCallback(async (modelId: string) => {
    setActionError(null)
    setAddingModelId(modelId)
    try {
      await addOpenRouterModel(wsUrl, modelId)
      setLocalAddedIds((prev) => new Set(prev).add(modelId))
      onModelAdded()
    } catch (addError) {
      setActionError(addError instanceof Error ? addError.message : String(addError))
    } finally {
      setAddingModelId(null)
    }
  }, [wsUrl, onModelAdded])

  const toggleFilter = useCallback((filter: CapabilityFilter) => {
    setActiveFilters((prev) => {
      const next = new Set(prev)
      if (next.has(filter)) {
        next.delete(filter)
      } else {
        next.add(filter)
      }
      return next
    })
  }, [])

  const clearFilters = useCallback(() => {
    setActiveFilters(new Set())
  }, [])

  const handleRetry = useCallback(async () => {
    setLoading(true)
    setError(null)
    setActionError(null)
    try {
      const models = await fetchAvailableOpenRouterModels(wsUrl)
      setAllModels(models)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [wsUrl])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border/60 px-6 py-4">
          <DialogTitle>Browse OpenRouter Models</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 border-b border-border/60 px-6 py-4">
          {/* Search input */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              type="text"
              placeholder="Search models..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Filter chips */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant={activeFilters.size === 0 ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={clearFilters}
            >
              All
            </Button>
            {(['reasoning', 'vision', 'tools'] as const).map((filter) => (
              <Button
                key={filter}
                type="button"
                variant={activeFilters.has(filter) ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 px-2.5 text-xs capitalize"
                onClick={() => toggleFilter(filter)}
              >
                {filter}
              </Button>
            ))}
          </div>

          {actionError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {actionError}
            </div>
          ) : null}
        </div>

        {/* Results area */}
        <div className="flex-1 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading models…
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-3 py-16 text-sm">
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="size-4" />
                Failed to load available models.
              </div>
              <p className="max-w-md text-center text-xs text-muted-foreground">{error}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => void handleRetry()}>
                <RotateCcw className="size-3.5" />
                Retry
              </Button>
            </div>
          ) : (
            <>
              {/* Model count */}
              <div className="px-6 py-2 text-xs text-muted-foreground">
                {debouncedQuery || activeFilters.size > 0
                  ? `${filteredCount} of ${totalCount} models`
                  : `${totalCount} models available`}
              </div>

              <ScrollArea className="h-[calc(60vh-4rem)]">
                <div className="space-y-5 px-6 pb-4">
                  {groups.length === 0 ? (
                    <div className="py-12 text-center text-sm text-muted-foreground">
                      {debouncedQuery ? (
                        <>No models match &ldquo;{debouncedQuery}&rdquo;. Try a different search term.</>
                      ) : activeFilters.size > 0 ? (
                        'No models match the current filters.'
                      ) : (
                        'No models available.'
                      )}
                    </div>
                  ) : (
                    groups.map((group) => (
                      <div key={group.provider} className="space-y-2">
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          {group.provider}
                        </h4>
                        <div className="space-y-1.5">
                          {group.models.map((model) => (
                            <OpenRouterBrowseRow
                              key={model.modelId}
                              model={model}
                              isAdded={localAddedIds.has(model.modelId)}
                              isAdding={addingModelId === model.modelId}
                              onAdd={(id) => void handleAdd(id)}
                            />
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
