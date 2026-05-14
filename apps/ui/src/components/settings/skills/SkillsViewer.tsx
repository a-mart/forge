import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHelpContext } from '@/components/help/help-hooks'
import { Download, FolderOpen, Loader2, Share2 } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { SettingsSection } from '../settings-row'
import { SkillSourceBadge } from './SkillSourceBadge'
import { SkillListRail } from './SkillListRail'
import { SkillFileTree } from './SkillFileTree'
import { SkillFileViewer } from './SkillFileViewer'
import { fetchSkillInventory } from './skills-viewer-api'
import { SkillImportDialog, SKILL_IMPORT_GLOBAL_SCOPE_VALUE } from './SkillImportDialog'
import { SkillShareDialog } from './SkillShareDialog'
import type { SkillInventoryEntry } from './skills-viewer-types'
import type { ManagerProfile, CollaborationCategory, CollaborationChannel, SkillImportResultResponse } from '@forge/protocol'
import type { SettingsEnvVariable } from '../settings-types'
import {
  fetchSettingsEnvVariables,
  updateSettingsEnvVariables,
  deleteSettingsEnvVariable,
  toErrorMessage,
} from '../settings-api'
import type { SettingsApiClient } from '../settings-api-client'
import { SettingsChromeCdp } from '../SettingsChromeCdp'
import { SkillEnvVariables } from './SkillEnvVariables'
import { fetchCollabCategories, fetchCollabChannels } from '../specialists-api'
import { CategorySkillDefaultsView } from '../specialists/CategorySkillDefaultsView'
import { ChannelSkillSelection } from '../specialists/ChannelSkillSelection'
import { CollabSettingsBanner } from '../specialists/CollabSettingsBanner'


/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const SCOPE_GLOBAL = '__global__'
const COLLAB_CATEGORY_PREFIX = 'category:'
const COLLAB_CHANNEL_PREFIX = 'channel:'

/** Skills that have a dedicated rich configuration panel. */
const RICH_CONFIG_SKILLS: Record<
  string,
  React.ComponentType<{ clientOrWsUrl: SettingsApiClient | string; onConfigChanged?: () => void }>
> = {
  'chrome-cdp': SettingsChromeCdp,
}

/* ------------------------------------------------------------------ */
/*  Main component                                                    */
/* ------------------------------------------------------------------ */

interface SkillsViewerProps {
  wsUrl: string
  apiClient?: SettingsApiClient
  profiles: ManagerProfile[]
  changeKey?: number
  /** Optional initial scope value (e.g. 'channel:ch-1') for testing */
  initialScope?: string
  /** Optional Forge share URL handed in from route/deep-link state. */
  initialImportUrl?: string
}

export function SkillsViewer({ wsUrl, apiClient, profiles, changeKey, initialScope, initialImportUrl }: SkillsViewerProps) {
  useHelpContext('settings.skills')
  const clientOrWsUrl: SettingsApiClient | string = apiClient ?? wsUrl
  const isCollab = apiClient?.target.kind === 'collab'

  /* ---------- Scope ---------- */
  const [selectedScope, setSelectedScope] = useState<string>(initialScope ?? SCOPE_GLOBAL)

  /* ---------- Collab scope detection ---------- */
  const isCollabCategory = selectedScope.startsWith(COLLAB_CATEGORY_PREFIX)
  const isCollabChannel = selectedScope.startsWith(COLLAB_CHANNEL_PREFIX)
  const collabCategoryId = isCollabCategory ? selectedScope.slice(COLLAB_CATEGORY_PREFIX.length) : undefined
  const collabChannelId = isCollabChannel ? selectedScope.slice(COLLAB_CHANNEL_PREFIX.length) : undefined
  const skillLoadScope = (isCollabCategory || isCollabChannel) ? SCOPE_GLOBAL : selectedScope

  /* ---------- Collab data ---------- */
  const [collabCategories, setCollabCategories] = useState<CollaborationCategory[]>([])
  const [collabChannels, setCollabChannels] = useState<CollaborationChannel[]>([])

  useEffect(() => {
    if (!isCollab) return
    let cancelled = false
    Promise.all([
      fetchCollabCategories(clientOrWsUrl),
      fetchCollabChannels(clientOrWsUrl),
    ])
      .then(([categories, channels]) => {
        if (!cancelled) {
          setCollabCategories(categories)
          setCollabChannels(channels.filter((ch) => !ch.archived))
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [isCollab, clientOrWsUrl, changeKey])

  /* ---------- Channel skill selection state ---------- */
  const selectedChannelDto = isCollabChannel
    ? collabChannels.find((ch) => ch.channelId === collabChannelId)
    : undefined
  const [channelSkillSelection, setChannelSkillSelection] = useState(selectedChannelDto?.activeSkillSelection)

  useEffect(() => {
    setChannelSkillSelection(selectedChannelDto?.activeSkillSelection)
  }, [selectedChannelDto])

  const handleChannelSkillSelectionSaved = useCallback(
    (updated: { activeSkillSelection?: import('@forge/protocol').CollaborationSkillSelectionState }) => {
      setChannelSkillSelection(updated.activeSkillSelection)
      if (collabChannelId && updated.activeSkillSelection) {
        setCollabChannels((prev) =>
          prev.map((ch) =>
            ch.channelId === collabChannelId
              ? { ...ch, activeSkillSelection: updated.activeSkillSelection }
              : ch,
          ),
        )
      }
    },
    [collabChannelId],
  )

  const handleCategoryUpdated = useCallback((updated: CollaborationCategory) => {
    setCollabCategories((prev) =>
      prev.map((c) => (c.categoryId === updated.categoryId ? updated : c)),
    )
  }, [])

  const selectedCategory = isCollabCategory
    ? collabCategories.find((c) => c.categoryId === collabCategoryId)
    : undefined

  const selectedChannelLabel = isCollabChannel
    ? collabChannels.find((ch) => ch.channelId === collabChannelId)?.name ?? collabChannelId ?? ''
    : ''

  /* ---------- Skills ---------- */
  const [skills, setSkills] = useState<SkillInventoryEntry[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const loadSkillsRequestIdRef = useRef(0)
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  /* ---------- Share/import dialogs ---------- */
  const [shareDialogOpen, setShareDialogOpen] = useState(false)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importDialogInitialUrl, setImportDialogInitialUrl] = useState<string | undefined>(undefined)
  const lastInitialImportUrlRef = useRef<string | undefined>(undefined)

  /* ---------- File viewer ---------- */
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)

  /* ---------- Env variables ---------- */
  const [envVariables, setEnvVariables] = useState<SettingsEnvVariable[]>([])
  const [draftByName, setDraftByName] = useState<Record<string, string>>({})
  const [revealByName, setRevealByName] = useState<Record<string, boolean>>({})
  const [envError, setEnvError] = useState<string | null>(null)
  const [envSuccess, setEnvSuccess] = useState<string | null>(null)
  const [envLoading, setEnvLoading] = useState(false)
  const [savingVar, setSavingVar] = useState<string | null>(null)
  const [deletingVar, setDeletingVar] = useState<string | null>(null)

  /* ---------- Derived ---------- */
  const selectedSkill = useMemo(
    () => skills.find((s) => s.skillId === selectedSkillId) ?? null,
    [skills, selectedSkillId],
  )

  const selectedSkillShareable = Boolean(
    selectedSkill && (selectedSkill.sourceKind === 'machine-local' || selectedSkill.sourceKind === 'profile'),
  )
  const canUseLocalSkillSharing = !isCollab && !isCollabCategory && !isCollabChannel

  const filteredEnvVariables = useMemo(() => {
    if (!selectedSkill) return []
    return envVariables.filter((v) => v.skillName === selectedSkill.name)
  }, [envVariables, selectedSkill])

  const RichConfigPanel =
    selectedSkill && RICH_CONFIG_SKILLS[selectedSkill.directoryName]
      ? RICH_CONFIG_SKILLS[selectedSkill.directoryName]
      : null

  /* ---------- Data loading ---------- */

  const loadSkills = useCallback(async (scope: string) => {
    const requestId = ++loadSkillsRequestIdRef.current
    setSkillsLoading(true)
    try {
      const profileId = scope !== SCOPE_GLOBAL ? scope : undefined
      const result = await fetchSkillInventory(clientOrWsUrl, profileId)
      if (requestId !== loadSkillsRequestIdRef.current) {
        return
      }
      setSkills(result)
      if (result.length > 0) {
        setSelectedSkillId((prev) => {
          if (prev && result.some((s) => s.skillId === prev)) return prev
          return result[0].skillId
        })
        setSelectedFilePath('SKILL.md')
      } else {
        setSelectedSkillId(null)
        setSelectedFilePath(null)
      }
    } catch {
      if (requestId !== loadSkillsRequestIdRef.current) {
        return
      }
      setSkills([])
      setSelectedSkillId(null)
      setSelectedFilePath(null)
    } finally {
      if (requestId === loadSkillsRequestIdRef.current) {
        setSkillsLoading(false)
      }
    }
  }, [clientOrWsUrl])

  const handleImportedSkill = useCallback(async (result: SkillImportResultResponse) => {
    const nextScope = result.target.scope === 'profile' && result.target.profileId
      ? result.target.profileId
      : SCOPE_GLOBAL
    setSelectedScope(nextScope)
    await loadSkills(nextScope)
    if (result.skillId) {
      setSelectedSkillId(result.skillId)
      setSelectedFilePath('SKILL.md')
    }
  }, [loadSkills])

  const loadVariables = useCallback(async () => {
    setEnvLoading(true)
    setEnvError(null)
    try {
      const result = await fetchSettingsEnvVariables(clientOrWsUrl)
      setEnvVariables(result)
    } catch (err) {
      setEnvError(toErrorMessage(err))
    } finally {
      setEnvLoading(false)
    }
  }, [clientOrWsUrl])

  useEffect(() => {
    void loadSkills(skillLoadScope)
  }, [loadSkills, skillLoadScope])

  useEffect(() => {
    void loadVariables()
  }, [loadVariables])

  useEffect(() => {
    const trimmed = initialImportUrl?.trim()
    if (!trimmed || trimmed === lastInitialImportUrlRef.current || isCollab) {
      return
    }
    lastInitialImportUrlRef.current = trimmed
    setImportDialogInitialUrl(trimmed)
    setImportDialogOpen(true)
  }, [initialImportUrl, isCollab])

  /* Reset on scope change */
  useEffect(() => {
    setSearchQuery('')
    setSelectedFilePath(null)
  }, [selectedScope])

  /* Keep scope valid when profiles change */
  useEffect(() => {
    if (isCollab) return
    setSelectedScope((prev) => {
      if (prev === SCOPE_GLOBAL) return prev
      if (profiles.some((p) => p.profileId === prev)) return prev
      return SCOPE_GLOBAL
    })
  }, [profiles, isCollab])

  /* ---------- Skill selection ---------- */

  const handleSelectSkill = useCallback((skillId: string) => {
    setSelectedSkillId(skillId)
    setSelectedFilePath('SKILL.md')
  }, [])

  /* ---------- Env variable handlers ---------- */

  const handleDraftChange = (name: string, value: string) => {
    setDraftByName((prev) => ({ ...prev, [name]: value }))
    setEnvError(null)
    setEnvSuccess(null)
  }

  const handleToggleReveal = (name: string) => {
    setRevealByName((prev) => ({ ...prev, [name]: !prev[name] }))
  }

  const handleSave = async (variableName: string) => {
    const value = draftByName[variableName]?.trim() ?? ''
    if (!value) {
      setEnvError(`Enter a value for ${variableName} before saving.`)
      return
    }
    setEnvError(null)
    setEnvSuccess(null)
    setSavingVar(variableName)
    try {
      await updateSettingsEnvVariables(clientOrWsUrl, { [variableName]: value })
      setDraftByName((prev) => ({ ...prev, [variableName]: '' }))
      setEnvSuccess(`${variableName} saved successfully.`)
      await loadVariables()
    } catch (err) {
      setEnvError(toErrorMessage(err))
    } finally {
      setSavingVar(null)
    }
  }

  const handleDelete = async (variableName: string) => {
    setEnvError(null)
    setEnvSuccess(null)
    setDeletingVar(variableName)
    try {
      await deleteSettingsEnvVariable(clientOrWsUrl, variableName)
      setDraftByName((prev) => ({ ...prev, [variableName]: '' }))
      setEnvSuccess(`${variableName} removed.`)
      await loadVariables()
    } catch (err) {
      setEnvError(toErrorMessage(err))
    } finally {
      setDeletingVar(null)
    }
  }

  const handleConfigChanged = useCallback(() => {
    void loadVariables()
  }, [loadVariables])

  const selectedProfileName =
    selectedScope !== SCOPE_GLOBAL
      ? profiles.find((p) => p.profileId === selectedScope)?.displayName ||
        selectedScope
      : null

  /* ---------- Render ---------- */

  return (
    <div className="flex flex-col gap-6">
      <SkillShareDialog
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
        clientOrWsUrl={clientOrWsUrl}
        skill={selectedSkill}
      />
      <SkillImportDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        clientOrWsUrl={clientOrWsUrl}
        profiles={profiles}
        initialUrl={importDialogInitialUrl}
        initialScope={selectedScope === SCOPE_GLOBAL ? SKILL_IMPORT_GLOBAL_SCOPE_VALUE : selectedScope}
        onImported={handleImportedSkill}
      />

      {/* Collab settings banner */}
      {isCollab && apiClient && (
        <CollabSettingsBanner apiClient={apiClient} />
      )}

      {/* Scope selector */}
      <SettingsSection
        label="Skills"
        description={isCollab
          ? 'Browse, inspect, and configure installed skills. Select a category or channel to manage skill selection.'
          : 'Browse, inspect, and configure installed skills.'}
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-medium text-muted-foreground">
              Configuration scope
            </Label>
            <Select value={selectedScope} onValueChange={setSelectedScope}>
              <SelectTrigger className="w-full sm:w-72">
                <SelectValue placeholder="Select scope" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SCOPE_GLOBAL}>
                  {isCollab ? 'Global Collaboration' : 'Global'}
                </SelectItem>
                {/* Builder: show profiles */}
                {!isCollab && profiles.map((profile) => (
                  <SelectItem
                    key={profile.profileId}
                    value={profile.profileId}
                  >
                    {profile.displayName || profile.profileId}
                  </SelectItem>
                ))}
                {/* Collab: show categories */}
                {isCollab && collabCategories.length > 0 && (
                  <SelectGroup>
                    <SelectLabel className="text-xs">Categories</SelectLabel>
                    {collabCategories.map((cat) => (
                      <SelectItem
                        key={`category:${cat.categoryId}`}
                        value={`${COLLAB_CATEGORY_PREFIX}${cat.categoryId}`}
                      >
                        Category: {cat.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {/* Collab: show channels */}
                {isCollab && collabChannels.length > 0 && (
                  <SelectGroup>
                    <SelectLabel className="text-xs">Channels</SelectLabel>
                    {collabChannels.map((ch) => (
                      <SelectItem
                        key={`channel:${ch.channelId}`}
                        value={`${COLLAB_CHANNEL_PREFIX}${ch.channelId}`}
                      >
                        #{ch.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          </div>

          {canUseLocalSkillSharing && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!selectedSkill || !selectedSkillShareable}
                title={!selectedSkillShareable ? 'Only user-created global and project skills can be shared.' : undefined}
                onClick={() => setShareDialogOpen(true)}
              >
                <Share2 className="mr-1.5 size-3.5" />
                Share selected skill
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setImportDialogInitialUrl(undefined)
                  setImportDialogOpen(true)
                }}
              >
                <Download className="mr-1.5 size-3.5" />
                Import from URL
              </Button>
            </div>
          )}
        </div>
      </SettingsSection>

      {/* Collab: Category skill defaults */}
      {isCollabCategory && selectedCategory && (
        <CategorySkillDefaultsView
          clientOrWsUrl={clientOrWsUrl}
          category={selectedCategory}
          changeKey={changeKey ?? 0}
          onCategoryUpdated={handleCategoryUpdated}
        />
      )}
      {isCollabCategory && !selectedCategory && !skillsLoading && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
          <p className="text-xs text-destructive">Category not found.</p>
        </div>
      )}

      {/* Collab: Channel skill selection */}
      {isCollabChannel && (
        <ChannelSkillSelection
          clientOrWsUrl={clientOrWsUrl}
          channelId={collabChannelId!}
          channelLabel={selectedChannelLabel}
          activeSkillSelection={channelSkillSelection}
          changeKey={changeKey ?? 0}
          onSelectionSaved={handleChannelSkillSelectionSaved}
        />
      )}

      {/* Loading state */}
      {skillsLoading && skills.length === 0 && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Empty state for profile scope with no skills (builder only — collab category/channel scopes load global skills) */}
      {!skillsLoading &&
        skills.length === 0 &&
        selectedScope !== SCOPE_GLOBAL &&
        !isCollabCategory &&
        !isCollabChannel && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
            <FolderOpen className="mb-2 size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              No skills found for {selectedProfileName}
            </p>
            <p className="mt-1 text-xs text-muted-foreground/60">
              Add skills to{' '}
              <code className="rounded bg-muted px-1 py-0.5">
                ~/.forge/profiles/{selectedScope}/pi/skills/
              </code>
            </p>
          </div>
        )}

      {/* Main skill explorer — master-detail layout */}
      {!skillsLoading && skills.length > 0 && (
        <>
          {/* Desktop: side-by-side layout */}
          <div className="hidden md:block">
            <SkillExplorerDesktop
              clientOrWsUrl={clientOrWsUrl}
              skills={skills}
              selectedSkillId={selectedSkillId}
              selectedSkill={selectedSkill}
              selectedFilePath={selectedFilePath}
              searchQuery={searchQuery}
              skillsLoading={skillsLoading}
              onSearchChange={setSearchQuery}
              onSelectSkill={handleSelectSkill}
              onSelectFile={setSelectedFilePath}
            />
          </div>

          {/* Mobile: stacked layout */}
          <div className="md:hidden">
            <SkillExplorerMobile
              clientOrWsUrl={clientOrWsUrl}
              skills={skills}
              selectedSkillId={selectedSkillId}
              selectedSkill={selectedSkill}
              selectedFilePath={selectedFilePath}
              searchQuery={searchQuery}
              skillsLoading={skillsLoading}
              onSearchChange={setSearchQuery}
              onSelectSkill={handleSelectSkill}
              onSelectFile={setSelectedFilePath}
            />
          </div>

          {/* Configuration section */}
          {selectedSkill && (
            <div className="flex flex-col gap-6">
              {/* Rich config panel */}
              {RichConfigPanel && (
                <div className="rounded-lg border border-border bg-card/30 p-5">
                  <RichConfigPanel
                    clientOrWsUrl={clientOrWsUrl}
                    onConfigChanged={handleConfigChanged}
                  />
                </div>
              )}

              {/* Environment Variables */}
              {filteredEnvVariables.length > 0 && (
                <SkillEnvVariables
                  variables={filteredEnvVariables}
                  isLoading={envLoading}
                  error={envError}
                  success={envSuccess}
                  draftByName={draftByName}
                  revealByName={revealByName}
                  savingVar={savingVar}
                  deletingVar={deletingVar}
                  onDraftChange={handleDraftChange}
                  onToggleReveal={handleToggleReveal}
                  onSave={(name) => void handleSave(name)}
                  onDelete={(name) => void handleDelete(name)}
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Desktop layout: side-by-side master-detail                        */
/* ------------------------------------------------------------------ */

function SkillExplorerDesktop({
  clientOrWsUrl,
  skills,
  selectedSkillId,
  selectedSkill,
  selectedFilePath,
  searchQuery,
  skillsLoading,
  onSearchChange,
  onSelectSkill,
  onSelectFile,
}: {
  clientOrWsUrl: SettingsApiClient | string
  skills: SkillInventoryEntry[]
  selectedSkillId: string | null
  selectedSkill: SkillInventoryEntry | null
  selectedFilePath: string | null
  searchQuery: string
  skillsLoading: boolean
  onSearchChange: (q: string) => void
  onSelectSkill: (id: string) => void
  onSelectFile: (path: string) => void
}) {
  return (
    <div
      className="overflow-hidden rounded-lg border border-border bg-card/30"
      style={{ height: 'calc(100vh - 280px)' }}
    >
      <div className="flex h-full">
        {/* Left: Skill list */}
        <div
          className="shrink-0 border-r border-border/60 bg-card/20"
          style={{ width: '220px' }}
        >
          <SkillListRail
            skills={skills}
            isLoading={skillsLoading}
            searchQuery={searchQuery}
            onSearchChange={onSearchChange}
            selectedSkillId={selectedSkillId}
            onSelectSkill={onSelectSkill}
          />
        </div>

        {/* Center: Detail */}
        {selectedSkill ? (
          <>
            {/* Skill header + file tree */}
            <div
              className="flex shrink-0 flex-col border-r border-border/60 bg-card/10"
              style={{ width: '180px' }}
            >
              {/* Skill info header */}
              <div className="shrink-0 border-b border-border/40 px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-foreground">
                    {selectedSkill.name}
                  </span>
                  <SkillSourceBadge sourceKind={selectedSkill.sourceKind} />
                </div>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {selectedSkill.rootPath}
                </p>
              </div>

              {/* File tree */}
              <div className="flex-1 overflow-hidden">
                <SkillFileTree
                  clientOrWsUrl={clientOrWsUrl}
                  skillId={selectedSkill.skillId}
                  selectedFilePath={selectedFilePath}
                  onSelectFile={onSelectFile}
                />
              </div>
            </div>

            {/* Right: File viewer */}
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <SkillFileViewer
                clientOrWsUrl={clientOrWsUrl}
                skillId={selectedSkill.skillId}
                filePath={selectedFilePath}
                rootPath={selectedSkill.rootPath}
              />
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <p className="text-sm">Select a skill to browse its files</p>
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Mobile layout: stacked                                            */
/* ------------------------------------------------------------------ */

function SkillExplorerMobile({
  clientOrWsUrl,
  skills,
  selectedSkillId,
  selectedSkill,
  selectedFilePath,
  searchQuery,
  skillsLoading,
  onSearchChange,
  onSelectSkill,
  onSelectFile,
}: {
  clientOrWsUrl: SettingsApiClient | string
  skills: SkillInventoryEntry[]
  selectedSkillId: string | null
  selectedSkill: SkillInventoryEntry | null
  selectedFilePath: string | null
  searchQuery: string
  skillsLoading: boolean
  onSearchChange: (q: string) => void
  onSelectSkill: (id: string) => void
  onSelectFile: (path: string) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* Skill selector (horizontal scroll) */}
      <div className="overflow-hidden rounded-lg border border-border bg-card/30">
        <div style={{ maxHeight: '200px' }}>
          <SkillListRail
            skills={skills}
            isLoading={skillsLoading}
            searchQuery={searchQuery}
            onSearchChange={onSearchChange}
            selectedSkillId={selectedSkillId}
            onSelectSkill={onSelectSkill}
          />
        </div>
      </div>

      {selectedSkill && (
        <>
          {/* Skill info */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{selectedSkill.name}</span>
            <SkillSourceBadge sourceKind={selectedSkill.sourceKind} />
          </div>

          {/* File tree */}
          <div
            className="overflow-hidden rounded-lg border border-border bg-card/30"
            style={{ maxHeight: '200px' }}
          >
            <SkillFileTree
              clientOrWsUrl={clientOrWsUrl}
              skillId={selectedSkill.skillId}
              selectedFilePath={selectedFilePath}
              onSelectFile={onSelectFile}
            />
          </div>

          {/* File viewer */}
          <div
            className="overflow-hidden rounded-lg border border-border bg-card/30"
            style={{ minHeight: '300px' }}
          >
            <SkillFileViewer
              clientOrWsUrl={clientOrWsUrl}
              skillId={selectedSkill.skillId}
              filePath={selectedFilePath}
              rootPath={selectedSkill.rootPath}
            />
          </div>
        </>
      )}
    </div>
  )
}
