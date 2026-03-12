import { useCallback, useEffect, useMemo, useState } from 'react'
import { Eye, Loader2 } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

import { SettingsSection } from './settings-row'
import { PromptEditor } from './prompts/PromptEditor'
import {
  fetchPromptList,
  fetchPromptPreview,
  type PromptPreviewSection,
} from './prompts/prompt-api'
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

  // ---- Preview state ----
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewSections, setPreviewSections] = useState<PromptPreviewSection[]>([])
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const handlePreview = useCallback(async () => {
    if (!selectedProfileId) return
    setPreviewOpen(true)
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const result = await fetchPromptPreview(wsUrl, selectedProfileId)
      setPreviewSections(result.sections)
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to load preview')
    } finally {
      setPreviewLoading(false)
    }
  }, [wsUrl, selectedProfileId])

  return (
    <div className="flex flex-col gap-6">
      {/* Profile scope selector */}
      {profiles.length > 1 && (
        <SettingsSection
          label="Profile"
          description="Select which profile's prompt overrides to manage."
        >
          <div className="flex items-end gap-2">
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
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={handlePreview}
                    disabled={!selectedProfileId}
                  >
                    <Eye className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Preview full runtime context</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </SettingsSection>
      )}

      {/* Category + prompt selectors */}
      <SettingsSection
        label="Prompt Templates"
        description="Browse and edit system prompts. Overrides are scoped to the selected profile."
        cta={
          profiles.length <= 1 ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePreview}
                    disabled={!selectedProfileId}
                    className="gap-1.5"
                  >
                    <Eye className="size-3.5" />
                    Preview
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Preview the full runtime context</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : undefined
        }
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

      {/* Preview dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="!max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Runtime Context Preview</DialogTitle>
            <DialogDescription>
              This is the complete context a new session would receive for this profile.
            </DialogDescription>
          </DialogHeader>
          {previewLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : previewError ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
              <p className="text-xs text-destructive">{previewError}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3 min-h-0 flex-1 overflow-hidden">
              <div className="shrink-0 text-xs text-muted-foreground">
                {previewSections.length} {previewSections.length === 1 ? 'section' : 'sections'}
              </div>
              <div className="flex-1 min-h-0 overflow-auto rounded-md border bg-muted/50 p-3">
                {previewSections.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No preview sections were returned.</p>
                ) : (
                  <div className="space-y-2">
                    {previewSections.map((section, index) => (
                      <details
                        key={`${section.label}:${section.source}:${index}`}
                        open={index === 0}
                        className="overflow-hidden rounded-md border bg-background"
                      >
                        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                          {section.label}
                        </summary>
                        <div className="border-t px-3 py-2">
                          <p className="mb-2 text-[11px] text-muted-foreground break-all">
                            {section.source}
                          </p>
                          <pre className="text-xs leading-relaxed whitespace-pre-wrap break-words font-mono">
                            {section.content}
                          </pre>
                        </div>
                      </details>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
