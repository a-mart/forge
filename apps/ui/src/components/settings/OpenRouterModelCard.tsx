import { useCallback, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import {
  getDefaultOpenRouterManagerEnabled,
  getEffectiveOpenRouterManagerEnabled,
  getOpenRouterModelOverrideKey,
  isOpenRouterModelManagerSupported,
  type ModelOverrideEntry,
  type OpenRouterModelEntry,
} from '@forge/protocol'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { formatTokenCount } from '@/lib/format-utils'
import { updateModelOverride } from './models-api'
import type { SettingsApiClient } from './settings-api-client'

interface OpenRouterModelCardProps {
  clientOrWsUrl: SettingsApiClient | string | undefined
  model: OpenRouterModelEntry
  override?: ModelOverrideEntry
  onRemove: (modelId: string) => void
  isRemoving: boolean
  onRefresh: () => Promise<void>
  onCardSaveStart?: (modelKey: string) => void
  onCardSaveEnd?: (modelKey: string) => void
}

export function OpenRouterModelCard({
  clientOrWsUrl,
  model,
  override,
  onRemove,
  isRemoving,
  onRefresh,
  onCardSaveStart,
  onCardSaveEnd,
}: OpenRouterModelCardProps) {
  const [isSavingManagerEnabled, setIsSavingManagerEnabled] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasVision = model.inputModes.includes('image')
  const managerSupported = isOpenRouterModelManagerSupported(model)
  const defaultManagerEnabledValue = getDefaultOpenRouterManagerEnabled(model)
  const effectiveManagerEnabled = getEffectiveOpenRouterManagerEnabled(model, override)
  const hasManagerOverride = override?.managerEnabled !== undefined
  const overrideKey = getOpenRouterModelOverrideKey(model.modelId)

  const saveManagerEnabled = useCallback(
    async (checked: boolean) => {
      setError(null)
      setIsSavingManagerEnabled(true)
      onCardSaveStart?.(overrideKey)
      try {
        await updateModelOverride(clientOrWsUrl, overrideKey, {
          managerEnabled: checked === defaultManagerEnabledValue ? null : checked,
        })
        await onRefresh()
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : String(saveError))
      } finally {
        setIsSavingManagerEnabled(false)
        onCardSaveEnd?.(overrideKey)
      }
    },
    [clientOrWsUrl, defaultManagerEnabledValue, onCardSaveEnd, onCardSaveStart, onRefresh, overrideKey],
  )

  const resetManagerEnabled = useCallback(async () => {
    setError(null)
    setIsSavingManagerEnabled(true)
    onCardSaveStart?.(overrideKey)
    try {
      await updateModelOverride(clientOrWsUrl, overrideKey, { managerEnabled: null })
      await onRefresh()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setIsSavingManagerEnabled(false)
      onCardSaveEnd?.(overrideKey)
    }
  }, [clientOrWsUrl, onCardSaveEnd, onCardSaveStart, onRefresh, overrideKey])

  const managerEligibilityCopy = managerSupported
    ? 'Show this model in manager create/change selectors.'
    : model.supportsTools === false
      ? 'Not supported for manager agents. This model does not advertise tool calling.'
      : 'Tool support could not be verified from OpenRouter. Reload this section to retry.'

  return (
    <div className="group space-y-3 rounded-lg border border-border/70 bg-card/40 px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{model.displayName}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">{model.modelId}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>Context {formatTokenCount(model.contextWindow)}</span>
            <span>Output {formatTokenCount(model.maxOutputTokens)}</span>
            {model.supportsReasoning ? (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">Reasoning</Badge>
            ) : null}
            {hasVision ? (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">Vision</Badge>
            ) : null}
            {model.supportsTools === true ? (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">Tools</Badge>
            ) : model.supportsTools === false ? (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">No tools</Badge>
            ) : (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">Tools unverified</Badge>
            )}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 p-0 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
          onClick={() => onRemove(model.modelId)}
          disabled={isRemoving || isSavingManagerEnabled}
          aria-label={`Remove ${model.displayName}`}
        >
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="space-y-1.5 border-t border-border/50 pt-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span>Manager agents</span>
          {managerSupported && hasManagerOverride ? (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-medium">
              Override
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{managerEligibilityCopy}</p>
        {managerSupported ? (
          <div className="flex items-center gap-3 pt-1">
            <Switch
              checked={effectiveManagerEnabled}
              onCheckedChange={saveManagerEnabled}
              disabled={isSavingManagerEnabled || isRemoving}
              aria-label={`Enable ${model.displayName} for manager agents`}
            />
            <span className="text-sm text-muted-foreground">{effectiveManagerEnabled ? 'Enabled' : 'Disabled'}</span>
            {isSavingManagerEnabled ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2"
              onClick={() => void resetManagerEnabled()}
              disabled={!hasManagerOverride || isSavingManagerEnabled || isRemoving}
            >
              Reset
            </Button>
          </div>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </div>
  )
}
