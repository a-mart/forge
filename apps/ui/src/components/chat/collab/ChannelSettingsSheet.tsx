import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { CollaborationCategory, CollaborationChannel, ManagerReasoningLevel } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { getChannel, updateChannel } from '@/lib/collaboration-api'
import {
  getAvailableChangeManagerFamilies,
  getSupportedReasoningLevelsForModelId,
  useModelPresets,
} from '@/lib/model-preset'
import { REASONING_LEVEL_LABELS } from '@/components/settings/specialists/types'

const NO_CATEGORY_VALUE = '__none__'

interface ChannelSettingsBaseline {
  name: string
  description: string | null
  categoryId: string | null
  aiEnabled: boolean
  modelId: string | null
  reasoningLevel: string | null
  promptOverlay: string | null
}

interface ChannelSettingsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  channel: CollaborationChannel
  categories: CollaborationCategory[]
  isAdmin: boolean
  wsUrl?: string
}

export function ChannelSettingsSheet({
  open,
  onOpenChange,
  channel,
  categories,
  isAdmin,
  wsUrl,
}: ChannelSettingsSheetProps) {
  const sortedCategories = useMemo(
    () => [...categories].sort((left, right) => left.position - right.position || left.name.localeCompare(right.name)),
    [categories],
  )
  const modelPresets = useModelPresets(wsUrl, open ? 1 : 0)
  const modelFamilies = useMemo(() => getAvailableChangeManagerFamilies(modelPresets), [modelPresets])

  const channelName = channel.name
  const channelDescription = channel.description ?? ''
  const channelCategoryId = channel.categoryId ?? null
  const channelAiEnabled = channel.aiEnabled
  const channelPromptOverlay = channel.promptOverlay ?? ''
  const channelModelId = channel.modelId ?? null
  const channelReasoningLevel = channel.reasoningLevel ?? null

  const [baseline, setBaseline] = useState<ChannelSettingsBaseline>(() => buildBaseline({
    name: channelName,
    description: channelDescription,
    categoryId: channelCategoryId,
    aiEnabled: channelAiEnabled,
    modelId: channelModelId,
    reasoningLevel: channelReasoningLevel,
    promptOverlay: channelPromptOverlay,
  }))
  const [name, setName] = useState(channelName)
  const [description, setDescription] = useState(channelDescription)
  const [categoryValue, setCategoryValue] = useState(channelCategoryId ?? NO_CATEGORY_VALUE)
  const [aiEnabled, setAiEnabled] = useState(channelAiEnabled)
  const [modelId, setModelId] = useState(channelModelId ?? '')
  const [reasoningLevel, setReasoningLevel] = useState(channelReasoningLevel ?? '')
  const [promptOverlay, setPromptOverlay] = useState(channelPromptOverlay)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const supportedLevels = useMemo(
    () => modelId
      ? getSupportedReasoningLevelsForModelId(modelId, modelPresets)
      : [] as ManagerReasoningLevel[],
    [modelId, modelPresets],
  )

  // When model changes, auto-set reasoning level to default for that model
  const handleModelChange = (newModelId: string) => {
    setModelId(newModelId)
    if (!newModelId) {
      setReasoningLevel('')
      return
    }
    const preset = modelPresets.find((p) => p.presetId === newModelId || p.modelId === newModelId)
    if (preset) {
      setReasoningLevel(preset.defaultReasoningLevel)
    }
  }

  useEffect(() => {
    const nextBaseline = buildBaseline({
      name: channelName,
      description: channelDescription,
      categoryId: channelCategoryId,
      aiEnabled: channelAiEnabled,
      modelId: channelModelId,
      reasoningLevel: channelReasoningLevel,
      promptOverlay: channelPromptOverlay,
    })
    setBaseline(nextBaseline)
    setName(nextBaseline.name)
    setDescription(channelDescription)
    setCategoryValue(channelCategoryId ?? NO_CATEGORY_VALUE)
    setAiEnabled(nextBaseline.aiEnabled)
    setModelId(nextBaseline.modelId ?? '')
    setReasoningLevel(nextBaseline.reasoningLevel ?? '')
    setPromptOverlay(channelPromptOverlay)
    setError(null)
    setIsSaving(false)
  }, [
    channelAiEnabled,
    channelCategoryId,
    channel.channelId,
    channelDescription,
    channelName,
    channelPromptOverlay,
    channelModelId,
    channelReasoningLevel,
    open,
  ])

  useEffect(() => {
    if (!open) {
      return
    }

    let cancelled = false

    void getChannel(channel.channelId)
      .then((freshChannel) => {
        if (cancelled) {
          return
        }

        const nextBaseline = buildBaseline({
          name: freshChannel.name,
          description: freshChannel.description ?? '',
          categoryId: freshChannel.categoryId ?? null,
          aiEnabled: freshChannel.aiEnabled,
          modelId: freshChannel.modelId ?? null,
          reasoningLevel: freshChannel.reasoningLevel ?? null,
          promptOverlay: freshChannel.promptOverlay ?? '',
        })
        setBaseline(nextBaseline)
        setName(nextBaseline.name)
        setDescription(freshChannel.description ?? '')
        setCategoryValue(freshChannel.categoryId ?? NO_CATEGORY_VALUE)
        setAiEnabled(nextBaseline.aiEnabled)
        setModelId(nextBaseline.modelId ?? '')
        setReasoningLevel(nextBaseline.reasoningLevel ?? '')
        setPromptOverlay(freshChannel.promptOverlay ?? '')
      })
      .catch((loadError) => {
        if (cancelled) {
          return
        }

        setError(loadError instanceof Error ? loadError.message : 'Could not load channel settings.')
      })

    return () => {
      cancelled = true
    }
  }, [channel.channelId, open])

  const trimmedName = name.trim()
  const normalizedDescription = normalizeOptionalText(description)
  const normalizedPromptOverlay = normalizeOptionalText(promptOverlay)
  const normalizedCategoryId = categoryValue === NO_CATEGORY_VALUE ? null : categoryValue
  const normalizedModelId = modelId || null
  const normalizedReasoningLevel = reasoningLevel || null

  const hasChanges =
    trimmedName !== baseline.name ||
    normalizedDescription !== baseline.description ||
    normalizedCategoryId !== baseline.categoryId ||
    aiEnabled !== baseline.aiEnabled ||
    normalizedModelId !== baseline.modelId ||
    normalizedReasoningLevel !== baseline.reasoningLevel ||
    normalizedPromptOverlay !== baseline.promptOverlay

  const canSave = isAdmin && trimmedName.length > 0 && hasChanges && !isSaving

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSave) {
      return
    }

    setIsSaving(true)
    setError(null)

    try {
      await updateChannel(channel.channelId, {
        name: trimmedName,
        description: normalizedDescription,
        categoryId: normalizedCategoryId,
        aiEnabled,
        ...(normalizedModelId ? { modelId: normalizedModelId } : {}),
        ...(normalizedReasoningLevel ? { reasoningLevel: normalizedReasoningLevel } : {}),
        promptOverlay: normalizedPromptOverlay,
      })
      onOpenChange(false)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save channel settings.')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="overflow-hidden p-0"
        style={{ width: 'min(100vw, 440px)' }}
      >
        <SheetHeader className="gap-2 border-b border-border/70 pr-12">
          <SheetTitle>Channel settings</SheetTitle>
          <SheetDescription>
            {isAdmin
              ? 'Update the channel name, topic, category, and AI settings.'
              : 'Review the current channel configuration.'}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-5 overflow-y-auto p-4">
            <div className="space-y-2">
              <Label htmlFor="collab-channel-settings-name">Channel name</Label>
              <Input
                id="collab-channel-settings-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={!isAdmin || isSaving}
                autoFocus={isAdmin}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="collab-channel-settings-description">Topic / description</Label>
              <Textarea
                id="collab-channel-settings-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={!isAdmin || isSaving}
                className="min-h-24 resize-none"
                placeholder="What is this channel for?"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="collab-channel-settings-category">Category</Label>
              <Select
                value={categoryValue}
                onValueChange={setCategoryValue}
                disabled={!isAdmin || isSaving}
              >
                <SelectTrigger id="collab-channel-settings-category" className="w-full">
                  <SelectValue placeholder="No category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_CATEGORY_VALUE}>No category</SelectItem>
                  {sortedCategories.map((category) => (
                    <SelectItem key={category.categoryId} value={category.categoryId}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="collab-channel-settings-model">Model</Label>
              <div className="flex gap-2">
                <Select
                  value={modelId}
                  onValueChange={handleModelChange}
                  disabled={!isAdmin || isSaving || modelFamilies.length === 0}
                >
                  <SelectTrigger id="collab-channel-settings-model" className="flex-1">
                    <SelectValue placeholder="Select model" />
                  </SelectTrigger>
                  <SelectContent>
                    {modelFamilies.map((family) => (
                      <SelectItem key={family.familyId} value={family.familyId}>
                        {family.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {modelId && supportedLevels.length > 0 ? (
                  <Select
                    value={reasoningLevel}
                    onValueChange={setReasoningLevel}
                    disabled={!isAdmin || isSaving}
                  >
                    <SelectTrigger
                      id="collab-channel-settings-reasoning-level"
                      className="w-28 shrink-0"
                    >
                      <SelectValue placeholder="Reasoning" />
                    </SelectTrigger>
                    <SelectContent>
                      {supportedLevels.map((level) => (
                        <SelectItem key={level} value={level}>
                          {REASONING_LEVEL_LABELS[level] || level}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                Changes apply to this channel&apos;s AI configuration.
              </p>
            </div>

            <div className="rounded-xl border border-border/70 bg-card/60 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <Label htmlFor="collab-channel-settings-ai-enabled">Auto-reply</Label>
                  <p className="text-xs text-muted-foreground">
                    When enabled, Forge replies automatically without being @mentioned.
                  </p>
                </div>
                <Switch
                  id="collab-channel-settings-ai-enabled"
                  checked={aiEnabled}
                  onCheckedChange={setAiEnabled}
                  disabled={!isAdmin || isSaving}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="collab-channel-settings-prompt-overlay">Additional instructions</Label>
              <Textarea
                id="collab-channel-settings-prompt-overlay"
                value={promptOverlay}
                onChange={(event) => setPromptOverlay(event.target.value)}
                disabled={!isAdmin || isSaving}
                className="min-h-36 resize-y"
                placeholder="Optional channel-specific AI guidance"
              />
              <p className="text-xs text-muted-foreground">
                Extra context that applies only to this channel.
              </p>
            </div>

            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>

          <SheetFooter className="border-t border-border/70 bg-background/95 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              {isAdmin ? 'Cancel' : 'Close'}
            </Button>
            {isAdmin ? (
              <Button type="submit" disabled={!canSave}>
                {isSaving ? 'Saving…' : 'Save changes'}
              </Button>
            ) : null}
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

function buildBaseline(values: {
  name: string
  description: string
  categoryId: string | null
  aiEnabled: boolean
  modelId: string | null
  reasoningLevel: string | null
  promptOverlay: string
}): ChannelSettingsBaseline {
  return {
    name: values.name,
    description: normalizeOptionalText(values.description),
    categoryId: values.categoryId,
    aiEnabled: values.aiEnabled,
    modelId: values.modelId,
    reasoningLevel: values.reasoningLevel,
    promptOverlay: normalizeOptionalText(values.promptOverlay),
  }
}

function normalizeOptionalText(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
