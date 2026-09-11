import { useEffect, useState } from 'react'
import { getOpenRouterModelOverrideKey, type ModelOverrideEntry, type OpenRouterModelEntry } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatTokenCount } from '@/lib/format-utils'
import { updateModelOverride } from './models-api'
import type { SettingsApiClient } from './settings-api-client'

export function OpenRouterContextWindow({
  model, override, clientOrWsUrl, disabled, onRefresh, onSaveStart, onSaveEnd,
}: {
  model: OpenRouterModelEntry
  override?: ModelOverrideEntry
  clientOrWsUrl: SettingsApiClient | string | undefined
  disabled: boolean
  onRefresh: () => Promise<void>
  onSaveStart: () => void
  onSaveEnd: () => void
}) {
  const cap = override?.contextWindowCap
  const [draft, setDraft] = useState(cap?.toString() ?? '')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setDraft(cap?.toString() ?? '')
    setError(null)
  }, [model.modelId, cap])
  const parsed = Number(draft)
  const valid = draft.trim() === '' || (Number.isSafeInteger(parsed) && parsed > 0)
  const effective = Math.min(model.contextWindow, cap ?? model.contextWindow)

  async function save(value: number | null) {
    setError(null)
    onSaveStart()
    try {
      await updateModelOverride(clientOrWsUrl, getOpenRouterModelOverrideKey(model.modelId), { contextWindowCap: value })
      await onRefresh()
      setDraft(value?.toString() ?? '')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      onSaveEnd()
    }
  }

  return <div className="space-y-1.5 border-t border-border/50 pt-3">
    <div className="flex flex-wrap items-center gap-2">
      <span className="mr-auto text-sm font-medium">Context window</span>
      <Input
        type="number" min={1} step={1} className="h-8 w-36 text-xs"
        aria-label={`Context window cap for ${model.displayName}`}
        aria-invalid={!valid}
        placeholder={model.contextWindow.toLocaleString()}
        value={draft} disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button type="button" size="sm" variant="outline" className="h-8"
        disabled={disabled || !valid || draft === (cap?.toString() ?? '')}
        onClick={() => void save(draft.trim() === '' ? null : parsed)}>Apply</Button>
      <Button type="button" size="sm" variant="ghost" className="h-8 px-2" aria-label="Reset context window"
        disabled={disabled || cap === undefined} onClick={() => void save(null)}>Reset</Button>
    </div>
    <p className="text-xs text-muted-foreground">
      {formatTokenCount(effective)} effective · {formatTokenCount(model.contextWindow)} default maximum · tokens
    </p>
    <p className="text-xs text-muted-foreground">Applies when an agent next starts; running agents keep their current limit.</p>
    {!valid ? <p className="text-xs text-destructive">Enter a positive whole number of tokens, or leave blank for the default.</p> : null}
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
  </div>
}
