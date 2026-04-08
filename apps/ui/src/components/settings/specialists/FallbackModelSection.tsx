import { ChevronDown, ChevronUp } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import type { ModelPresetInfo } from '@forge/protocol'
import { MANAGER_REASONING_LEVELS } from '@forge/protocol'
import { getModelDisplayLabel, getSupportedReasoningLevelsForModelId } from '@/lib/model-preset'
import type { SelectableModel } from '@/lib/model-preset'
import type { CardEditState } from './types'
import { REASONING_LEVEL_LABELS } from './types'
import { ModelIdSelect } from './ModelIdSelect'

export function FallbackModelSection({
  isEditing,
  isExpanded,
  onToggle,
  fallbackModelId,
  fallbackProvider,
  fallbackReasoningLevel,
  onUpdateField,
  modelPresets,
  selectableModels,
}: {
  isEditing: boolean
  isExpanded: boolean
  onToggle: () => void
  fallbackModelId: string
  fallbackProvider: string
  fallbackReasoningLevel: string
  onUpdateField: (field: keyof CardEditState, value: string | boolean) => void
  modelPresets: ModelPresetInfo[]
  selectableModels: SelectableModel[]
}) {
  const hasFallback = !!fallbackModelId

  if (!isEditing) {
    // Read-only: show compact summary if configured
    if (!hasFallback) return null
    const label = getModelDisplayLabel(fallbackModelId, modelPresets, fallbackProvider)
    const reasoningLabel = fallbackReasoningLevel
      ? REASONING_LEVEL_LABELS[fallbackReasoningLevel] ?? fallbackReasoningLevel
      : null
    return (
      <p className="text-xs text-muted-foreground">
        Fallback: {label}
        {reasoningLabel && <span className="mx-1.5 text-muted-foreground/40">·</span>}
        {reasoningLabel}
      </p>
    )
  }

  // Editing mode
  const fallbackSupportedLevels = fallbackModelId
    ? getSupportedReasoningLevelsForModelId(fallbackModelId, modelPresets, fallbackProvider)
    : [...MANAGER_REASONING_LEVELS]

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={isExpanded}
      >
        {isExpanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
        {hasFallback
          ? `Fallback: ${getModelDisplayLabel(fallbackModelId, modelPresets, fallbackProvider)}${fallbackReasoningLevel ? ` · ${REASONING_LEVEL_LABELS[fallbackReasoningLevel] ?? fallbackReasoningLevel}` : ''}`
          : 'Configure fallback'}
      </button>

      {isExpanded && (
        <div className="flex flex-col gap-3 rounded-md border border-border/60 bg-muted/20 p-3 sm:flex-row sm:items-start">
          <div className="flex flex-col gap-1.5 sm:w-52">
            <Label className="text-xs font-medium text-muted-foreground">Fallback model</Label>
            <ModelIdSelect
              modelId={fallbackModelId}
              provider={fallbackProvider}
              onValueChange={(next) => {
                onUpdateField('fallbackProvider', next.provider)
                onUpdateField('fallbackModelId', next.modelId)
              }}
              models={selectableModels}
              presets={modelPresets}
              placeholder="None"
              allowNone
            />
          </div>
          <div className="flex flex-col gap-1.5 sm:w-40">
            <Label className="text-xs font-medium text-muted-foreground">Fallback reasoning</Label>
            <Select
              value={fallbackReasoningLevel || '__use_primary__'}
              onValueChange={(v) => onUpdateField('fallbackReasoningLevel', v === '__use_primary__' ? '' : v)}
            >
              <SelectTrigger className="w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__use_primary__" className="text-xs">
                  <span className="text-muted-foreground">Use primary</span>
                </SelectItem>
                {fallbackSupportedLevels.map((level) => (
                  <SelectItem key={level} value={level} className="text-xs">
                    {REASONING_LEVEL_LABELS[level] || level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </div>
  )
}
