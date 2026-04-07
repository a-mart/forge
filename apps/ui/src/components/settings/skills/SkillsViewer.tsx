import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHelpContext } from '@/components/help/help-hooks'
import { FolderOpen, Loader2 } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { SettingsSection } from '../settings-row'
import { SkillSourceBadge } from './SkillSourceBadge'
import { SkillListRail } from './SkillListRail'
import { SkillFileTree } from './SkillFileTree'
import { SkillFileViewer } from './SkillFileViewer'
import { fetchSkillInventory } from './skills-viewer-api'
import type { SkillInventoryEntry } from './skills-viewer-types'
import type { ManagerProfile } from '@forge/protocol'
import type { SettingsEnvVariable } from '../settings-types'
import {
  fetchSettingsEnvVariables,
  updateSettingsEnvVariables,
  deleteSettingsEnvVariable,
  toErrorMessage,
} from '../settings-api'
import { SettingsChromeCdp } from '../SettingsChromeCdp'
import { SkillEnvVariables } from './SkillEnvVariables'


/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const SCOPE_GLOBAL = '__global__'

/** Skills that have a dedicated rich configuration panel. */
const RICH_CONFIG_SKILLS: Record<
  string,
  React.ComponentType<{ wsUrl: string; onConfigChanged?: () => void }>
> = {
  'chrome-cdp': SettingsChromeCdp,
}

/* ------------------------------------------------------------------ */
/*  Main component                                                    */
/* ------------------------------------------------------------------ */

interface SkillsViewerProps {
  wsUrl: string
  profiles: ManagerProfile[]
}

export function SkillsViewer({ wsUrl, profiles }: SkillsViewerProps) {
  useHelpContext('settings.skills')

  /* ---------- Scope ---------- */
  const [selectedScope, setSelectedScope] = useState<string>(SCOPE_GLOBAL)

  /* ---------- Skills ---------- */
  const [skills, setSkills] = useState<SkillInventoryEntry[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const loadSkillsRequestIdRef = useRef(0)
  const hasInitializedScopeRef = useRef(false)
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

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

  const filteredEnvVariables = useMemo(() => {
    if (!selectedSkill) return []
    return envVariables.filter((v) => v.skillName === selectedSkill.name)
  }, [envVariables, selectedSkill])

  const RichConfigPanel =
    selectedSkill && RICH_CONFIG_SKILLS[selectedSkill.directoryName]
      ? RICH_CONFIG_SKILLS[selectedSkill.directoryName]
      : null

  /* ---------- Data loading ---------- */

  const loadSkills = useCallback(async () => {
    const requestId = ++loadSkillsRequestIdRef.current
    setSkillsLoading(true)
    try {
      const profileId =
        selectedScope !== SCOPE_GLOBAL ? selectedScope : undefined
      const result = await fetchSkillInventory(wsUrl, profileId)
      if (requestId !== loadSkillsRequestIdRef.current) {
        return
      }
      setSkills(result)
      // Auto-select first skill
      if (result.length > 0) {
        setSelectedSkillId((prev) => {
          // Keep selection if it still exists
          if (prev && result.some((s) => s.skillId === prev)) return prev
          return result[0].skillId
        })
      } else {
        setSelectedSkillId(null)
      }
    } catch {
      if (requestId !== loadSkillsRequestIdRef.current) {
        return
      }
      setSkills([])
      setSelectedSkillId(null)
    } finally {
      if (requestId === loadSkillsRequestIdRef.current) {
        setSkillsLoading(false)
      }
    }
  }, [wsUrl, selectedScope])

  const loadVariables = useCallback(async () => {
    setEnvLoading(true)
    setEnvError(null)
    try {
      const result = await fetchSettingsEnvVariables(wsUrl)
      setEnvVariables(result)
    } catch (err) {
      setEnvError(toErrorMessage(err))
    } finally {
      setEnvLoading(false)
    }
  }, [wsUrl])

  useEffect(() => {
    void loadSkills()
    void loadVariables()
  }, [loadSkills, loadVariables])

  /* Reset on scope change */
  useEffect(() => {
    if (!hasInitializedScopeRef.current) {
      hasInitializedScopeRef.current = true
    }
    setSearchQuery('')
    setSelectedFilePath(null)
  }, [selectedScope])

  /* Reset file selection when skill changes */
  useEffect(() => {
    // Auto-open SKILL.md if it exists
    setSelectedFilePath('SKILL.md')
  }, [selectedSkillId])

  /* Keep scope valid when profiles change */
  useEffect(() => {
    setSelectedScope((prev) => {
      if (prev === SCOPE_GLOBAL) return prev
      if (profiles.some((p) => p.profileId === prev)) return prev
      return SCOPE_GLOBAL
    })
  }, [profiles])

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
      await updateSettingsEnvVariables(wsUrl, { [variableName]: value })
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
      await deleteSettingsEnvVariable(wsUrl, variableName)
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
      {/* Scope selector */}
      <SettingsSection
        label="Skills"
        description="Browse, inspect, and configure installed skills."
      >
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted-foreground">
            Configuration scope
          </Label>
          <Select value={selectedScope} onValueChange={setSelectedScope}>
            <SelectTrigger className="w-full sm:w-64">
              <SelectValue placeholder="Select scope" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SCOPE_GLOBAL}>Global</SelectItem>
              {profiles.map((profile) => (
                <SelectItem
                  key={profile.profileId}
                  value={profile.profileId}
                >
                  {profile.displayName || profile.profileId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </SettingsSection>

      {/* Loading state */}
      {skillsLoading && skills.length === 0 && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Empty state for profile scope with no skills */}
      {!skillsLoading &&
        skills.length === 0 &&
        selectedScope !== SCOPE_GLOBAL && (
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
              wsUrl={wsUrl}
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
              wsUrl={wsUrl}
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
                    wsUrl={wsUrl}
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
  wsUrl,
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
  wsUrl: string
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
                  wsUrl={wsUrl}
                  skillId={selectedSkill.skillId}
                  selectedFilePath={selectedFilePath}
                  onSelectFile={onSelectFile}
                />
              </div>
            </div>

            {/* Right: File viewer */}
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <SkillFileViewer
                wsUrl={wsUrl}
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
  wsUrl,
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
  wsUrl: string
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
              wsUrl={wsUrl}
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
              wsUrl={wsUrl}
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
