import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Loader2, Plug, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { OpenRouterModelCard } from './OpenRouterModelCard'
import { OpenRouterBrowseDialog } from './OpenRouterBrowseDialog'
import { fetchOpenRouterModels, removeOpenRouterModel, type OpenRouterModelsResponse } from './openrouter-api'

interface SettingsOpenRouterProps {
  wsUrl: string | undefined
  modelConfigChangeKey: number
}

export function SettingsOpenRouter({ wsUrl, modelConfigChangeKey }: SettingsOpenRouterProps) {
  const [data, setData] = useState<OpenRouterModelsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [removingModelId, setRemovingModelId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const loadModels = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const response = await fetchOpenRouterModels(wsUrl)
      setData(response)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [wsUrl])

  useEffect(() => {
    if (!dialogOpen) {
      setActionError(null)
    }
  }, [dialogOpen])

  useEffect(() => {
    void loadModels()
  }, [loadModels, modelConfigChangeKey])

  const handleRemove = useCallback(async (modelId: string) => {
    if (!data) return

    setActionError(null)
    setRemovingModelId(modelId)
    setData((prev) => prev ? { ...prev, models: prev.models.filter((m) => m.modelId !== modelId) } : prev)

    try {
      await removeOpenRouterModel(wsUrl, modelId)
    } catch (removeError) {
      setActionError(removeError instanceof Error ? removeError.message : String(removeError))
      await loadModels()
    } finally {
      setRemovingModelId(null)
    }
  }, [data, loadModels, wsUrl])

  const models = data?.models ?? []
  const isConfigured = data?.isConfigured ?? false
  const addedModelIds = new Set(models.map((m) => m.modelId))
  const hasModels = models.length > 0

  const sortedModels = [...models].sort((a, b) => a.displayName.localeCompare(b.displayName))

  return (
    <div className="space-y-3 rounded-xl border border-border/70 p-4">
      {/* Section header */}
      <button
        type="button"
        onClick={() => setCollapsed((prev) => !prev)}
        className="flex w-full items-center justify-between gap-3 text-left"
        aria-expanded={!collapsed}
      >
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-foreground">OpenRouter</h3>
          <p className="text-xs text-muted-foreground">
            {loading ? 'Loading…' : `${models.length} ${models.length === 1 ? 'model' : 'models'}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {hasModels ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-xs"
              onClick={(e) => {
                e.stopPropagation()
                setDialogOpen(true)
              }}
            >
              <Search className="size-3" />
              Browse Models
            </Button>
          ) : null}
          {!loading ? (
            isConfigured ? (
              <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                Configured
              </Badge>
            ) : (
              <Badge variant="outline" className="border-border/60 bg-muted/40 text-muted-foreground">
                Not configured
              </Badge>
            )
          ) : null}
          {collapsed ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronUp className="size-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Content (collapsed hides) */}
      {!collapsed ? (
        <>
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-2 h-6 px-2 text-xs"
                onClick={() => void loadModels()}
              >
                Retry
              </Button>
            </div>
          ) : null}

          {actionError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {actionError}
            </div>
          ) : null}

          {loading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading OpenRouter models…
            </div>
          ) : hasModels ? (
            <div className="space-y-2 border-t border-border/60 pt-3">
              {sortedModels.map((model) => (
                <OpenRouterModelCard
                  key={model.modelId}
                  model={model}
                  onRemove={(id) => void handleRemove(id)}
                  isRemoving={removingModelId === model.modelId}
                />
              ))}
            </div>
          ) : (
            /* Empty state */
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border/70 py-8">
              <Plug className="size-6 text-muted-foreground/60" />
              <div className="space-y-1 text-center">
                <p className="text-sm font-medium text-foreground">No models added yet</p>
                <p className="max-w-xs text-xs text-muted-foreground">
                  Browse models from providers like DeepSeek, Mistral, Google, and more.
                </p>
                {!isConfigured ? (
                  <p className="text-xs text-muted-foreground/80">
                    Requires OPENROUTER_API_KEY in your environment.
                  </p>
                ) : null}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-1 gap-1.5"
                onClick={() => setDialogOpen(true)}
              >
                <Search className="size-3.5" />
                Browse Models
              </Button>
            </div>
          )}
        </>
      ) : null}

      <OpenRouterBrowseDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        wsUrl={wsUrl}
        addedModelIds={addedModelIds}
        onModelAdded={() => void loadModels()}
      />
    </div>
  )
}
