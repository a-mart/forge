import { useCallback, useEffect, useMemo, useState } from 'react'
import { useHelpContext } from '@/components/help/help-hooks'
import { Eye, Loader2 } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
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
import { PromptSurfaceEditor } from './prompts/PromptSurfaceEditor'
import {
  fetchCortexPromptSurfaceList,
  fetchPromptList,
  fetchPromptPreview,
  type PromptPreviewSection,
} from './prompts/prompt-api'
import type { SettingsApiClient } from './settings-api-client'
import type {
  CortexPromptSurfaceGroup,
  CortexPromptSurfaceListEntry,
  PromptCategory,
  PromptListEntry,
  ManagerProfile,
} from '@forge/protocol'

const CORTEX_PROFILE_ID = 'cortex'

const CATEGORY_OPTIONS: Array<{ value: PromptCategory | 'cortex'; label: string }> = [
  { value: 'archetype', label: 'Archetypes' },
  { value: 'operational', label: 'Operational' },
]

const CORTEX_GROUP_LABELS: Record<CortexPromptSurfaceGroup, string> = {
  system: 'System Templates',
  seed: 'Seed Templates',
  live: 'Live Cortex Files',
  scratch: 'Scratch / Supplemental',
}

type SurfaceCategory = PromptCategory | 'cortex'

interface SettingsPromptsProps {
  wsUrl: string
  apiClient?: SettingsApiClient
  profiles: ManagerProfile[]
  /** Bumped when a prompt_changed or cortex_prompt_surface_changed WS event fires */
  promptChangeKey: number
  /** Optional active session context for per-session runtime prompt preview. */
  previewSession?: {
    agentId: string
    profileId: string
  } | null
}

export function SettingsPrompts({ wsUrl, apiClient, profiles, promptChangeKey, previewSession }: SettingsPromptsProps) {
  useHelpContext('settings.prompts')
  const clientOrWsUrl: SettingsApiClient | string = apiClient ?? wsUrl

  const defaultProfileId = profiles.length > 0 ? profiles[0].profileId : ''
  const [selectedProfileId, setSelectedProfileId] = useState(defaultProfileId)
  const [selectedCategory, setSelectedCategory] = useState<SurfaceCategory>('archetype')
  const [selectedItemId, setSelectedItemId] = useState<string>('')
  const [promptList, setPromptList] = useState<PromptListEntry[]>([])
  const [cortexSurfaces, setCortexSurfaces] = useState<CortexPromptSurfaceListEntry[]>([])
  const [cortexEnabled, setCortexEnabled] = useState(false)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  useEffect(() => {
    setSelectedProfileId((prev) => {
      if (prev && profiles.some((profile) => profile.profileId === prev)) return prev
      return profiles.length > 0 ? profiles[0].profileId : ''
    })
  }, [profiles])

  const loadPromptData = useCallback(async () => {
    if (!selectedProfileId) return
    setListLoading(true)
    setListError(null)
    try {
      const [list, cortexResponse] = await Promise.all([
        fetchPromptList(clientOrWsUrl, selectedProfileId),
        fetchCortexPromptSurfaceList(clientOrWsUrl, selectedProfileId),
      ])
      setPromptList(list)
      setCortexEnabled(cortexResponse.enabled)
      setCortexSurfaces(cortexResponse.surfaces)
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Failed to load prompts')
    } finally {
      setListLoading(false)
    }
  }, [clientOrWsUrl, selectedProfileId])

  useEffect(() => {
    void loadPromptData()
  }, [loadPromptData, promptChangeKey])

  const isCortexProfileSelected = selectedProfileId === CORTEX_PROFILE_ID
  const useCollapsedCortexPicker = isCortexProfileSelected

  useEffect(() => {
    if (useCollapsedCortexPicker) {
      if (selectedCategory !== 'cortex') {
        setSelectedCategory('cortex')
        setSelectedItemId('')
      }
      return
    }

    if (!cortexEnabled && selectedCategory === 'cortex') {
      setSelectedCategory('archetype')
      setSelectedItemId('')
    }
  }, [cortexEnabled, selectedCategory, useCollapsedCortexPicker])

  const hiddenGenericPromptKeys = useMemo(() => {
    if (!cortexEnabled) return new Set<string>()
    return new Set(
      cortexSurfaces
        .filter((surface) => surface.kind === 'registry' && surface.category && surface.promptId)
        .map((surface) => `${surface.category}:${surface.promptId}`),
    )
  }, [cortexEnabled, cortexSurfaces])

  const categoryPrompts = useMemo(
    () => promptList.filter((prompt) => {
      if (prompt.category !== selectedCategory) return false
      return !hiddenGenericPromptKeys.has(`${prompt.category}:${prompt.promptId}`)
    }),
    [hiddenGenericPromptKeys, promptList, selectedCategory],
  )

  const groupedCortexSurfaces = useMemo(() => {
    const groups: Record<CortexPromptSurfaceGroup, CortexPromptSurfaceListEntry[]> = {
      system: [],
      seed: [],
      live: [],
      scratch: [],
    }

    for (const surface of cortexSurfaces) {
      groups[surface.group].push(surface)
    }

    return groups
  }, [cortexSurfaces])

  useEffect(() => {
    if (selectedCategory === 'cortex') {
      if (cortexSurfaces.length === 0) {
        setSelectedItemId('')
        return
      }
      const currentStillValid = cortexSurfaces.some((surface) => surface.surfaceId === selectedItemId)
      if (!currentStillValid) {
        setSelectedItemId(cortexSurfaces[0].surfaceId)
      }
      return
    }

    if (categoryPrompts.length === 0) {
      setSelectedItemId('')
      return
    }
    const currentStillValid = categoryPrompts.some((prompt) => prompt.promptId === selectedItemId)
    if (!currentStillValid) {
      setSelectedItemId(categoryPrompts[0].promptId)
    }
  }, [categoryPrompts, cortexSurfaces, selectedCategory, selectedItemId])

  const selectedPrompt = useMemo(
    () => promptList.find((prompt) => prompt.category === selectedCategory && prompt.promptId === selectedItemId),
    [promptList, selectedCategory, selectedItemId],
  )

  const selectedCortexSurface = useMemo(
    () => cortexSurfaces.find((surface) => surface.surfaceId === selectedItemId),
    [cortexSurfaces, selectedItemId],
  )

  const availableCategories = useMemo(
    () => (cortexEnabled ? [...CATEGORY_OPTIONS, { value: 'cortex', label: 'Cortex Surfaces' }] : CATEGORY_OPTIONS),
    [cortexEnabled],
  )

  const selectedProfileLabel = useMemo(
    () => profiles.find((profile) => profile.profileId === selectedProfileId)?.displayName ?? selectedProfileId,
    [profiles, selectedProfileId],
  )

  const sectionDescription = useMemo(() => {
    if (useCollapsedCortexPicker) {
      return `Browse Cortex prompts, seed templates, live files, and scratch surfaces for ${selectedProfileLabel}.`
    }

    if (cortexEnabled && selectedCategory === 'cortex') {
      return `Browse Cortex seed templates, live files, and scratch surfaces for ${selectedProfileLabel}.`
    }

    return 'Browse and edit system prompts. Overrides are scoped to the selected profile.'
  }, [cortexEnabled, selectedCategory, selectedProfileLabel, useCollapsedCortexPicker])

  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewSections, setPreviewSections] = useState<PromptPreviewSection[]>([])
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewMode, setPreviewMode] = useState<'sections' | 'combined'>('sections')

  const combinedPreviewContent = useMemo(() => {
    if (previewSections.length === 0) return ''
    return previewSections
      .map((section) => `# ${section.label}\n\n${section.content}`)
      .join('\n\n---\n\n')
  }, [previewSections])

  const handlePreview = useCallback(async () => {
    if (!selectedProfileId) return
    setPreviewOpen(true)
    setPreviewLoading(true)
    setPreviewError(null)
    const previewAgentId = previewSession?.profileId === selectedProfileId ? previewSession.agentId : undefined
    try {
      const result = await fetchPromptPreview(clientOrWsUrl, selectedProfileId, previewAgentId)
      setPreviewSections(result.sections)
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to load preview')
    } finally {
      setPreviewLoading(false)
    }
  }, [clientOrWsUrl, previewSession, selectedProfileId])

  return (
    <div className="flex flex-col gap-6">
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
                  {profiles.map((profile) => (
                    <SelectItem key={profile.profileId} value={profile.profileId}>
                      {profile.displayName || profile.profileId}
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

      <SettingsSection
        label="Prompt Templates"
        description={sectionDescription}
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
          {!useCollapsedCortexPicker ? (
            <div className="flex flex-col gap-1.5 sm:w-48">
              <Label className="text-xs font-medium text-muted-foreground">Category</Label>
              <Select
                value={selectedCategory}
                onValueChange={(value) => setSelectedCategory(value as SurfaceCategory)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableCategories.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label className="text-xs font-medium text-muted-foreground">
              {useCollapsedCortexPicker
                ? 'Cortex item'
                : selectedCategory === 'cortex'
                  ? 'Cortex surface'
                  : 'Prompt'}
            </Label>
            <Select
              value={selectedItemId}
              onValueChange={setSelectedItemId}
              disabled={(useCollapsedCortexPicker || selectedCategory === 'cortex') ? cortexSurfaces.length === 0 : categoryPrompts.length === 0}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={listLoading ? 'Loading…' : useCollapsedCortexPicker ? 'Select Cortex item' : 'Select prompt'} />
              </SelectTrigger>
              <SelectContent>
                {useCollapsedCortexPicker || selectedCategory === 'cortex' ? (
                  (Object.entries(groupedCortexSurfaces) as Array<[CortexPromptSurfaceGroup, CortexPromptSurfaceListEntry[]]>).map(
                    ([group, surfaces]) => {
                      if (surfaces.length === 0) return null
                      return (
                        <SelectGroup key={group}>
                          <SelectLabel>{CORTEX_GROUP_LABELS[group]}</SelectLabel>
                          {surfaces.map((surface) => (
                            <SelectItem key={surface.surfaceId} value={surface.surfaceId}>
                              {surface.title}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )
                    },
                  )
                ) : (
                  categoryPrompts.map((prompt) => (
                    <SelectItem key={prompt.promptId} value={prompt.promptId}>
                      {prompt.displayName}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
        </div>
      </SettingsSection>

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

      {!listLoading && (useCollapsedCortexPicker || selectedCategory === 'cortex') && selectedCortexSurface && selectedProfileId ? (
        <>
          <Separator />
          <PromptSurfaceEditor
            key={`cortex:${selectedCortexSurface.surfaceId}:${selectedProfileId}:${promptChangeKey}`}
            clientOrWsUrl={clientOrWsUrl}
            profileId={selectedProfileId}
            surface={selectedCortexSurface}
            refreshKey={promptChangeKey}
          />
        </>
      ) : null}

      {!listLoading && !useCollapsedCortexPicker && selectedCategory !== 'cortex' && selectedPrompt && selectedProfileId ? (
        <>
          <Separator />
          <PromptEditor
            key={`${selectedCategory}:${selectedItemId}:${selectedProfileId}`}
            clientOrWsUrl={clientOrWsUrl}
            category={selectedCategory}
            promptId={selectedItemId}
            profileId={selectedProfileId}
            displayName={selectedPrompt.displayName}
            description={selectedPrompt.description}
            refreshKey={promptChangeKey}
          />
        </>
      ) : null}

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
              <div className="shrink-0 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {previewSections.length} {previewSections.length === 1 ? 'section' : 'sections'}
                </span>
                <div className="inline-flex items-center rounded-md border bg-muted p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setPreviewMode('sections')}
                    className={`rounded-sm px-2.5 py-1 font-medium transition-colors ${
                      previewMode === 'sections'
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    Sections
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewMode('combined')}
                    className={`rounded-sm px-2.5 py-1 font-medium transition-colors ${
                      previewMode === 'combined'
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    Combined
                  </button>
                </div>
              </div>
              <div className="flex-1 min-h-0 overflow-auto rounded-md border bg-muted/50 p-3">
                {previewSections.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No preview sections were returned.</p>
                ) : previewMode === 'combined' ? (
                  <pre className="text-xs leading-relaxed whitespace-pre-wrap break-words font-mono">
                    {combinedPreviewContent}
                  </pre>
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
