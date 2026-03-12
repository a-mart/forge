import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Label } from '@/components/ui/label'
import { SettingsSection } from './settings-row'
import { PromptEditor } from './prompts/PromptEditor'
import { fetchPromptList } from './prompts/prompt-api'
import type { PromptCategory, PromptListEntry, ManagerProfile } from '@middleman/protocol'

/* ------------------------------------------------------------------ */
/*  Category display names                                            */
/* ------------------------------------------------------------------ */

const CATEGORY_OPTIONS: { value: PromptCategory; label: string }[] = [
  { value: 'archetype', label: 'Archetypes' },
  { value: 'operational', label: 'Operational' },
]

/* ------------------------------------------------------------------ */
/*  Main component                                                    */
/* ------------------------------------------------------------------ */

interface SettingsPromptsProps {
  wsUrl: string
  profiles: ManagerProfile[]
  /** Bumped when a prompt_changed WS event fires */
  promptChangeKey: number
}

export function SettingsPrompts({ wsUrl, profiles, promptChangeKey }: SettingsPromptsProps) {
  // ---- Profile selection ----
  const defaultProfileId = profiles.length > 0 ? profiles[0].profileId : ''
  const [selectedProfileId, setSelectedProfileId] = useState(defaultProfileId)

  // Keep selection in sync when profiles list changes
  useEffect(() => {
    setSelectedProfileId((prev) => {
      if (prev && profiles.some((p) => p.profileId === prev)) return prev
      return profiles.length > 0 ? profiles[0].profileId : ''
    })
  }, [profiles])

  // ---- Category & prompt selection ----
  const [selectedCategory, setSelectedCategory] = useState<PromptCategory>('archetype')
  const [selectedPromptId, setSelectedPromptId] = useState<string>('')
  const [promptList, setPromptList] = useState<PromptListEntry[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  // Prompts filtered to current category
  const categoryPrompts = useMemo(
    () => promptList.filter((p) => p.category === selectedCategory),
    [promptList, selectedCategory],
  )

  // Load prompt list when profile or promptChangeKey changes
  const loadPromptList = useCallback(async () => {
    if (!selectedProfileId) return
    setListLoading(true)
    setListError(null)
    try {
      const list = await fetchPromptList(wsUrl, selectedProfileId)
      setPromptList(list)
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Failed to load prompts')
    } finally {
      setListLoading(false)
    }
  }, [wsUrl, selectedProfileId])

  useEffect(() => {
    void loadPromptList()
  }, [loadPromptList, promptChangeKey])

  // Auto-select first prompt in category when category or list changes
  useEffect(() => {
    if (categoryPrompts.length > 0) {
      const currentStillValid = categoryPrompts.some((p) => p.promptId === selectedPromptId)
      if (!currentStillValid) {
        setSelectedPromptId(categoryPrompts[0].promptId)
      }
    } else {
      setSelectedPromptId('')
    }
  }, [categoryPrompts, selectedPromptId])

  // Currently selected prompt metadata
  const selectedPrompt = useMemo(
    () => promptList.find((p) => p.category === selectedCategory && p.promptId === selectedPromptId),
    [promptList, selectedCategory, selectedPromptId],
  )

  return (
    <div className="flex flex-col gap-6">
      {/* Profile scope selector */}
      {profiles.length > 1 && (
        <SettingsSection
          label="Profile"
          description="Select which profile's prompt overrides to manage."
        >
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Configuration scope</Label>
            <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
              <SelectTrigger className="w-full sm:w-64">
                <SelectValue placeholder="Select profile" />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((p) => (
                  <SelectItem key={p.profileId} value={p.profileId}>
                    {p.displayName || p.profileId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingsSection>
      )}

      {/* Category + prompt selectors */}
      <SettingsSection
        label="Prompt Templates"
        description="Browse and edit system prompts. Overrides are scoped to the selected profile."
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          {/* Category */}
          <div className="flex flex-col gap-1.5 sm:w-48">
            <Label className="text-xs font-medium text-muted-foreground">Category</Label>
            <Select
              value={selectedCategory}
              onValueChange={(value) => setSelectedCategory(value as PromptCategory)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Prompt */}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Prompt</Label>
            <Select
              value={selectedPromptId}
              onValueChange={setSelectedPromptId}
              disabled={categoryPrompts.length === 0}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={listLoading ? 'Loading…' : 'Select prompt'} />
              </SelectTrigger>
              <SelectContent>
                {categoryPrompts.map((p) => (
                  <SelectItem key={p.promptId} value={p.promptId}>
                    {p.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </SettingsSection>

      {/* Loading / error / empty states */}
      {listLoading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {listError && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
          <p className="text-xs text-destructive">{listError}</p>
        </div>
      )}

      {/* Editor */}
      {!listLoading && selectedPrompt && selectedProfileId && (
        <>
          <Separator />
          <PromptEditor
            key={`${selectedCategory}:${selectedPromptId}:${selectedProfileId}`}
            wsUrl={wsUrl}
            category={selectedCategory}
            promptId={selectedPromptId}
            profileId={selectedProfileId}
            displayName={selectedPrompt.displayName}
            description={selectedPrompt.description}
            refreshKey={promptChangeKey}
          />
        </>
      )}
    </div>
  )
}
