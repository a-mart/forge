import { AlertTriangle, ChevronDown, ChevronUp, Copy, Loader2, Pencil, Pin, RotateCcw, Trash2 } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { SpecialistBadge } from '@/components/chat/SpecialistBadge'
import { getModelDisplayLabel, getSupportedReasoningLevelsForModelId } from '@/lib/model-preset'
import type { SpecialistCardProps } from './types'
import { REASONING_LEVEL_LABELS } from './types'
import { normalizeHandle, specialistToEditState, modelSupportsWebSearch } from './utils'
import { ColorSwatchPicker } from './ColorSwatchPicker'
import { ModelIdSelect } from './ModelIdSelect'
import { FallbackModelSection } from './FallbackModelSection'
import { HandleField } from './HandleField'

export function SpecialistCard({
  mode,
  specialist,
  isEditing,
  editState,
  isSaving,
  isCloning,
  cardError,
  isPromptExpanded,
  isFallbackExpanded,
  onExpand,
  onCancelEditing,
  onUpdateField,
  onSave,
  onDelete,
  onRevert,
  onClone,
  onToggleEnabled,
  onTogglePrompt,
  onToggleFallback,
  modelPresets,
  selectableModels,
  allSpecialists,
}: SpecialistCardProps) {
  const currentValues = isEditing && editState ? editState : specialistToEditState(specialist)

  // Compact summary values (used in collapsed state)
  const modelDisplay = getModelDisplayLabel(specialist.modelId, modelPresets, specialist.provider)
  const reasoningLabel = REASONING_LEVEL_LABELS[specialist.reasoningLevel ?? 'high'] ?? specialist.reasoningLevel ?? 'High'
  const hasFallback = !!specialist.fallbackModelId
  const fallbackLabel = hasFallback
    ? getModelDisplayLabel(specialist.fallbackModelId!, modelPresets, specialist.fallbackProvider)
    : null
  const fallbackReasoningLabel = specialist.fallbackReasoningLevel
    ? REASONING_LEVEL_LABELS[specialist.fallbackReasoningLevel] ?? specialist.fallbackReasoningLevel
    : null

  const stopPropagation = (e: React.MouseEvent) => e.stopPropagation()

  /* ---- Collapsed state ---- */
  if (!isEditing) {
    return (
      <div
        className="rounded-lg border border-border/60 bg-muted/30 px-4 py-3 transition-colors hover:bg-muted/50 cursor-pointer"
        onClick={onExpand}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onExpand() } }}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {/* Left: badge, handle, model summary */}
          <div className="flex flex-col gap-1.5 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <SpecialistBadge displayName={specialist.displayName} color={specialist.color} />
              <span className="font-mono text-xs text-muted-foreground/70">{specialist.specialistId}.md</span>
              {specialist.builtin && (
                <span className="inline-flex items-center rounded-full border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  Builtin
                </span>
              )}
              {specialist.builtin && specialist.pinned && (
                <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  <Pin className="size-2.5" />
                  Pinned
                </span>
              )}
              {!specialist.available && (
                <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="size-3" />
                  {specialist.availabilityMessage || 'Unavailable'}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              <span>{modelDisplay}</span>
              <span className="mx-1.5 text-muted-foreground/40">·</span>
              <span>{reasoningLabel}</span>
            </p>
            {hasFallback && (
              <p className="text-xs text-muted-foreground/70">
                Fallback: {fallbackLabel}
                {fallbackReasoningLabel && (
                  <>
                    <span className="mx-1.5 text-muted-foreground/40">·</span>
                    {fallbackReasoningLabel}
                  </>
                )}
              </p>
            )}
          </div>

          {/* Right: toggle + optional action button */}
          <div className="flex items-center gap-3 self-start shrink-0" onClick={stopPropagation}>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs text-muted-foreground/70" htmlFor={`enabled-${specialist.specialistId}`}>
                Enabled
              </Label>
              <Switch
                id={`enabled-${specialist.specialistId}`}
                size="sm"
                checked={specialist.enabled}
                disabled={isSaving}
                onCheckedChange={onToggleEnabled}
                aria-label={`Toggle ${specialist.specialistId} specialist`}
              />
            </div>
            {onClone && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onClone}
                disabled={isSaving || isCloning}
                className="gap-1 text-xs text-muted-foreground hover:text-foreground h-7 px-2"
                aria-label={`Clone ${specialist.specialistId} specialist`}
              >
                {isCloning ? <Loader2 className="size-3 animate-spin" /> : <Copy className="size-3" />}
                Clone
              </Button>
            )}
            {mode === 'inherited' && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onExpand}
                disabled={isSaving}
                className="gap-1 text-xs text-muted-foreground hover:text-foreground h-7 px-2"
              >
                {isSaving ? <Loader2 className="size-3 animate-spin" /> : <Pencil className="size-3" />}
                Customize
              </Button>
            )}
          </div>
        </div>

        {/* When to use — compact with truncation */}
        {specialist.whenToUse && (
          <p className="mt-1.5 text-xs text-muted-foreground/70 line-clamp-2">
            {specialist.whenToUse}
          </p>
        )}

        {cardError && (
          <div className="mt-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-1.5">
            <p className="text-xs text-destructive">{cardError}</p>
          </div>
        )}
      </div>
    )
  }

  /* ---- Expanded state (editing) ---- */
  const promptLineCount = currentValues.promptBody.split('\n').length
  const supportedLevels = getSupportedReasoningLevelsForModelId(
    currentValues.modelId,
    modelPresets,
    currentValues.provider,
  )
  const supportsWebSearch = modelSupportsWebSearch(currentValues.modelId, modelPresets, currentValues.provider)

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <SpecialistBadge displayName={currentValues.displayName} color={currentValues.color} />
          <span className="font-mono text-xs text-muted-foreground">{normalizeHandle(currentValues.handle) || specialist.specialistId}.md</span>
          {specialist.builtin && (
            <span className="inline-flex items-center rounded-full border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              Builtin
            </span>
          )}
          {specialist.builtin && currentValues.pinned && (
            <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              <Pin className="size-2.5" />
              Pinned
            </span>
          )}
          {!specialist.available && (
            <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
              <AlertTriangle className="size-3" />
              {specialist.availabilityMessage || 'Unavailable'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 self-start">
          <Label className="text-xs font-medium text-muted-foreground" htmlFor={`enabled-edit-${specialist.specialistId}`}>
            Enabled
          </Label>
          <Switch
            id={`enabled-edit-${specialist.specialistId}`}
            size="sm"
            checked={currentValues.enabled}
            disabled={isSaving}
            onCheckedChange={(checked) => onUpdateField('enabled', checked)}
            aria-label={`Toggle ${specialist.specialistId} specialist`}
          />
        </div>
      </div>

      {/* Handle (filename) */}
      <HandleField
        value={currentValues.handle}
        originalHandle={specialist.specialistId}
        isBuiltin={specialist.builtin}
        isSaving={isSaving}
        allSpecialists={allSpecialists}
        onChange={(v) => onUpdateField('handle', v)}
      />

      {/* Display name + badge color */}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Display name</Label>
          <Input
            value={currentValues.displayName}
            onChange={(e) => onUpdateField('displayName', e.target.value)}
            className="h-9 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Badge color</Label>
          <div className="flex items-center gap-2">
            <Input
              value={currentValues.color}
              onChange={(e) => onUpdateField('color', e.target.value)}
              className="h-9 font-mono text-sm"
              placeholder="#2563eb"
            />
            <ColorSwatchPicker
              value={currentValues.color}
              onChange={(color) => onUpdateField('color', color)}
            />
          </div>
        </div>
      </div>

      {/* When to use */}
      <div className="space-y-1">
        <Label className="text-xs font-medium text-muted-foreground">When to use</Label>
        <Textarea
          value={currentValues.whenToUse}
          onChange={(e) => onUpdateField('whenToUse', e.target.value)}
          rows={2}
          className="resize-none text-xs"
        />
      </div>

      {/* Model + reasoning */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex flex-col gap-1.5 sm:w-52">
          <Label className="text-xs font-medium text-muted-foreground">Model</Label>
          <ModelIdSelect
            modelId={currentValues.modelId}
            provider={currentValues.provider}
            onValueChange={(next) => {
              onUpdateField('provider', next.provider)
              onUpdateField('modelId', next.modelId)
            }}
            models={selectableModels}
            presets={modelPresets}
            placeholder="Select model"
          />
        </div>
        <div className="flex flex-col gap-1.5 sm:w-40">
          <Label className="text-xs font-medium text-muted-foreground">Reasoning level</Label>
          <Select
            value={currentValues.reasoningLevel}
            onValueChange={(value) => onUpdateField('reasoningLevel', value)}
          >
            <SelectTrigger className="w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {supportedLevels.map((level) => (
                <SelectItem key={level} value={level} className="text-xs">
                  {REASONING_LEVEL_LABELS[level] || level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Fallback */}
      <FallbackModelSection
        isEditing={true}
        isExpanded={isFallbackExpanded}
        onToggle={onToggleFallback}
        fallbackModelId={currentValues.fallbackModelId}
        fallbackProvider={currentValues.fallbackProvider}
        fallbackReasoningLevel={currentValues.fallbackReasoningLevel}
        onUpdateField={onUpdateField}
        modelPresets={modelPresets}
        selectableModels={selectableModels}
      />

      {supportsWebSearch && (
        <div className="flex items-center gap-2">
          <Switch
            checked={currentValues.webSearch}
            onCheckedChange={(checked) => onUpdateField('webSearch', checked)}
          />
          <Label>Native Search</Label>
          <span className="text-xs text-muted-foreground">
            Enable xAI native search (web + X) for this specialist
          </span>
        </div>
      )}

      {/* System prompt */}
      <div className="space-y-1">
        <button
          type="button"
          onClick={onTogglePrompt}
          className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={isPromptExpanded}
        >
          {isPromptExpanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          System prompt
          <span className="text-[10px] text-muted-foreground/60">({promptLineCount} lines)</span>
        </button>
        {isPromptExpanded && (
          <Textarea
            value={currentValues.promptBody}
            onChange={(e) => onUpdateField('promptBody', e.target.value)}
            rows={12}
            className="resize-y font-mono text-xs"
          />
        )}
      </div>

      {specialist.builtin && (
        <div className="rounded-md border border-border/60 bg-muted/20 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="text-xs font-medium text-foreground">Pin customizations</p>
              <p className="text-[11px] text-muted-foreground">
                Pinned specialists won&apos;t be updated by Forge. Unpin to restore automatic updates.
              </p>
            </div>
            <Switch
              size="sm"
              checked={currentValues.pinned}
              disabled={isSaving}
              onCheckedChange={(checked) => onUpdateField('pinned', checked)}
              aria-label={`Toggle pinned state for ${specialist.specialistId}`}
            />
          </div>
        </div>
      )}

      {/* Error */}
      {cardError && (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-1.5">
          <p className="text-xs text-destructive">{cardError}</p>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" onClick={onSave} disabled={isSaving} className="gap-1">
          {isSaving && <Loader2 className="size-3 animate-spin" />}
          Save
        </Button>
        <Button size="sm" variant="outline" onClick={onCancelEditing} disabled={isSaving}>
          Cancel
        </Button>
        <div className="flex-1" />
        {mode === 'global' && !specialist.builtin && onDelete && (
          <Button
            size="sm"
            variant="outline"
            onClick={onDelete}
            disabled={isSaving}
            className="gap-1 text-destructive hover:text-destructive"
          >
            <Trash2 className="size-3" />
            Delete
          </Button>
        )}
        {mode === 'profileOverride' && specialist.shadowsGlobal && onRevert && (
          <Button
            size="sm"
            variant="outline"
            onClick={onRevert}
            disabled={isSaving}
            className="gap-1 text-muted-foreground"
          >
            <RotateCcw className="size-3" />
            Revert to default
          </Button>
        )}
        {mode === 'profileOverride' && !specialist.shadowsGlobal && onDelete && (
          <Button
            size="sm"
            variant="outline"
            onClick={onDelete}
            disabled={isSaving}
            className="gap-1 text-destructive hover:text-destructive"
          >
            <Trash2 className="size-3" />
            Delete
          </Button>
        )}
      </div>
    </div>
  )
}
