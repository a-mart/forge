import { useCallback, useEffect, useMemo, useState } from 'react'
import { useHelpContext } from '@/components/help/help-hooks'
import type { ManagerProfile } from '@forge/protocol'
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  KeyRound,
  Loader2,
  Save,
  Settings2,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingsSection } from './settings-row'
import type { SettingsEnvVariable, SkillInfo } from './settings-types'
import {
  fetchSettingsEnvVariables,
  fetchSkillsList,
  updateSettingsEnvVariables,
  deleteSettingsEnvVariable,
  toErrorMessage,
} from './settings-api'
import { SettingsChromeCdp } from './SettingsChromeCdp'

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const ALL_SKILLS_VALUE = '__all__'
const SCOPE_GLOBAL = '__global__'

/** Skills that have a dedicated rich configuration panel. */
const RICH_CONFIG_SKILLS: Record<string, React.ComponentType<{ wsUrl: string; onConfigChanged?: () => void }>> = {
  'chrome-cdp': SettingsChromeCdp,
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                    */
/* ------------------------------------------------------------------ */

function StatusBadge({ isSet }: { isSet: boolean }) {
  if (isSet) {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      >
        <Check className="size-3" />
        Set
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
    >
      <AlertTriangle className="size-3" />
      Missing
    </Badge>
  )
}

function EnvVariableRow({
  variable,
  draftValue,
  isRevealed,
  isSaving,
  isDeleting,
  onDraftChange,
  onToggleReveal,
  onSave,
  onDelete,
}: {
  variable: SettingsEnvVariable
  draftValue: string
  isRevealed: boolean
  isSaving: boolean
  isDeleting: boolean
  onDraftChange: (value: string) => void
  onToggleReveal: () => void
  onSave: () => void
  onDelete: () => void
}) {
  const busy = isSaving || isDeleting

  return (
    <div className="rounded-lg border border-border bg-card/50 p-4 transition-colors hover:bg-card/80">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <code className="text-[13px] font-semibold text-foreground">{variable.name}</code>
            <StatusBadge isSet={variable.isSet} />
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">Required by</span>
            <Badge variant="secondary" className="px-1.5 py-0 text-[11px] font-medium">
              {variable.skillName}
            </Badge>
            {!variable.required && (
              <span className="text-[11px] italic text-muted-foreground/70">· optional</span>
            )}
          </div>
        </div>

        {variable.helpUrl ? (
          <a
            href={variable.helpUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Get key
            <ExternalLink className="size-3" />
          </a>
        ) : null}
      </div>

      {variable.description ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{variable.description}</p>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            type={isRevealed ? 'text' : 'password'}
            placeholder={variable.isSet ? (variable.maskedValue ?? '••••••••') : 'Enter value…'}
            value={draftValue}
            onChange={(event) => onDraftChange(event.target.value)}
            className="pr-9 font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onToggleReveal}
            disabled={busy}
            className="absolute right-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground/70 hover:text-foreground"
            title={isRevealed ? 'Hide value' : 'Show value'}
          >
            {isRevealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </Button>
        </div>

        <Button
          type="button"
          size="sm"
          onClick={onSave}
          disabled={!draftValue.trim() || busy}
          className="gap-1.5"
        >
          {isSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
          {isSaving ? 'Saving' : 'Save'}
        </Button>

        {variable.isSet ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDelete}
            disabled={busy}
            className="gap-1.5 text-muted-foreground hover:text-destructive"
          >
            {isDeleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
            {isDeleting ? 'Removing' : 'Remove'}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Env variable list sub-component                                   */
/* ------------------------------------------------------------------ */

interface SkillEnvVariablesProps {
  variables: SettingsEnvVariable[]
  isLoading: boolean
  error: string | null
  success: string | null
  draftByName: Record<string, string>
  revealByName: Record<string, boolean>
  savingVar: string | null
  deletingVar: string | null
  onDraftChange: (name: string, value: string) => void
  onToggleReveal: (name: string) => void
  onSave: (name: string) => void
  onDelete: (name: string) => void
}

function SkillEnvVariables({
  variables,
  isLoading,
  error,
  success,
  draftByName,
  revealByName,
  savingVar,
  deletingVar,
  onDraftChange,
  onToggleReveal,
  onSave,
  onDelete,
}: SkillEnvVariablesProps) {
  const setCount = variables.filter((v) => v.isSet).length
  const totalCount = variables.length

  return (
    <SettingsSection
      label="Environment Variables"
      description={
        !isLoading && totalCount > 0
          ? `${setCount} of ${totalCount} configured`
          : 'API keys and secrets required by installed skills'
      }
    >
      {error ? (
        <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
          <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
          <p className="text-xs text-destructive">{error}</p>
        </div>
      ) : null}

      {success ? (
        <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
          <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <p className="text-xs text-emerald-600 dark:text-emerald-400">{success}</p>
        </div>
      ) : null}

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : variables.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
          <KeyRound className="mb-2 size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No environment variables found</p>
          <p className="mt-1 text-xs text-muted-foreground/60">
            Install skills that declare environment variables to configure them here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {variables.map((variable) => (
            <EnvVariableRow
              key={`${variable.skillName}:${variable.name}`}
              variable={variable}
              draftValue={draftByName[variable.name] ?? ''}
              isRevealed={revealByName[variable.name] === true}
              isSaving={savingVar === variable.name}
              isDeleting={deletingVar === variable.name}
              onDraftChange={(value) => onDraftChange(variable.name, value)}
              onToggleReveal={() => onToggleReveal(variable.name)}
              onSave={() => onSave(variable.name)}
              onDelete={() => onDelete(variable.name)}
            />
          ))}
        </div>
      )}
    </SettingsSection>
  )
}

/* ------------------------------------------------------------------ */
/*  Main skills settings tab                                          */
/* ------------------------------------------------------------------ */

interface SettingsSkillsProps {
  wsUrl: string
  profiles: ManagerProfile[]
}

export function SettingsSkills({ wsUrl, profiles }: SettingsSkillsProps) {
  useHelpContext('settings.skills')

  /* ---------- Scope state ---------- */
  const [selectedScope, setSelectedScope] = useState<string>(SCOPE_GLOBAL)

  /* ---------- Skill list state ---------- */
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [selectedSkill, setSelectedSkill] = useState<string>(ALL_SKILLS_VALUE)
  const [skillsLoading, setSkillsLoading] = useState(false)

  /* ---------- Env variable state ---------- */
  const [envVariables, setEnvVariables] = useState<SettingsEnvVariable[]>([])
  const [draftByName, setDraftByName] = useState<Record<string, string>>({})
  const [revealByName, setRevealByName] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [savingVar, setSavingVar] = useState<string | null>(null)
  const [deletingVar, setDeletingVar] = useState<string | null>(null)

  /* ---------- Data loading ---------- */

  const loadSkills = useCallback(async () => {
    setSkillsLoading(true)
    try {
      const profileId = selectedScope !== SCOPE_GLOBAL ? selectedScope : undefined
      const result = await fetchSkillsList(wsUrl, profileId)
      setSkills(result)
    } catch {
      // Non-fatal — skill list failure shouldn't block env var loading.
      // The dropdown just won't appear.
      setSkills([])
    } finally {
      setSkillsLoading(false)
    }
  }, [wsUrl, selectedScope])

  const loadVariables = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await fetchSettingsEnvVariables(wsUrl)
      setEnvVariables(result)
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setIsLoading(false)
    }
  }, [wsUrl])

  useEffect(() => {
    void loadSkills()
    void loadVariables()
  }, [loadSkills, loadVariables])

  /* Reset skill filter when scope changes */
  useEffect(() => {
    setSelectedSkill(ALL_SKILLS_VALUE)
  }, [selectedScope])

  /* Keep scope valid when profiles change */
  useEffect(() => {
    setSelectedScope((prev) => {
      if (prev === SCOPE_GLOBAL) return prev
      if (profiles.some((p) => p.profileId === prev)) return prev
      return SCOPE_GLOBAL
    })
  }, [profiles])

  /* ---------- Filtered variables ---------- */

  const filteredVariables = useMemo(() => {
    if (selectedSkill === ALL_SKILLS_VALUE) return envVariables
    return envVariables.filter((v) => v.skillName === selectedSkill)
  }, [envVariables, selectedSkill])

  /* ---------- Rich config panel ---------- */

  const RichConfigPanel = selectedSkill !== ALL_SKILLS_VALUE
    ? RICH_CONFIG_SKILLS[selectedSkill] ?? null
    : null

  /* ---------- Env variable handlers ---------- */

  const handleDraftChange = (name: string, value: string) => {
    setDraftByName((prev) => ({ ...prev, [name]: value }))
    setError(null)
    setSuccess(null)
  }

  const handleToggleReveal = (name: string) => {
    setRevealByName((prev) => ({ ...prev, [name]: !prev[name] }))
  }

  const handleSave = async (variableName: string) => {
    const value = draftByName[variableName]?.trim() ?? ''
    if (!value) {
      setError(`Enter a value for ${variableName} before saving.`)
      return
    }
    setError(null)
    setSuccess(null)
    setSavingVar(variableName)
    try {
      await updateSettingsEnvVariables(wsUrl, { [variableName]: value })
      setDraftByName((prev) => ({ ...prev, [variableName]: '' }))
      setSuccess(`${variableName} saved successfully.`)
      await loadVariables()
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setSavingVar(null)
    }
  }

  const handleDelete = async (variableName: string) => {
    setError(null)
    setSuccess(null)
    setDeletingVar(variableName)
    try {
      await deleteSettingsEnvVariable(wsUrl, variableName)
      setDraftByName((prev) => ({ ...prev, [variableName]: '' }))
      setSuccess(`${variableName} removed.`)
      await loadVariables()
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setDeletingVar(null)
    }
  }

  const handleConfigChanged = useCallback(() => {
    void loadVariables()
  }, [loadVariables])

  /* ---------- Render ---------- */

  const selectedProfileName = selectedScope !== SCOPE_GLOBAL
    ? profiles.find((p) => p.profileId === selectedScope)?.displayName || selectedScope
    : null

  return (
    <div className="flex flex-col gap-8">
      {/* Scope selector */}
      <SettingsSection
        label="Skills"
        description="Select a scope to view its skills and environment variables. Global skills are shared across all profiles."
      >
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted-foreground">Configuration scope</Label>
          <Select value={selectedScope} onValueChange={setSelectedScope}>
            <SelectTrigger className="w-full sm:w-64">
              <SelectValue placeholder="Select scope" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SCOPE_GLOBAL}>Global</SelectItem>
              {profiles.map((profile) => (
                <SelectItem key={profile.profileId} value={profile.profileId}>
                  {profile.displayName || profile.profileId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </SettingsSection>

      {/* Skill filter */}
      {skills.length > 0 && (
        <SettingsSection
          label="Skill Filter"
          description="Filter by skill to view its configuration and environment variables"
        >
          <div className="flex items-center gap-3">
            <Label className="text-sm font-medium text-muted-foreground">Skill</Label>
            <Select value={selectedSkill} onValueChange={setSelectedSkill}>
              <SelectTrigger className="w-full sm:w-64">
                <SelectValue placeholder="All Skills" />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value={ALL_SKILLS_VALUE}>All Skills</SelectItem>
                <SelectSeparator />
                {skills.map((skill) => (
                  <SelectItem key={skill.name} value={skill.name}>
                    <span className="flex items-center gap-2">
                      {skill.name}
                      {skill.hasRichConfig && (
                        <Settings2 className="size-3 text-muted-foreground" />
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingsSection>
      )}

      {/* Skill loading indicator (brief) */}
      {skillsLoading && skills.length === 0 && (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Empty state for profile scope with no skills */}
      {!skillsLoading && skills.length === 0 && selectedScope !== SCOPE_GLOBAL && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
          <FolderOpen className="mb-2 size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No skills found for {selectedProfileName}</p>
          <p className="mt-1 text-xs text-muted-foreground/60">
            Add skills to <code className="rounded bg-muted px-1 py-0.5">~/.forge/profiles/{selectedScope}/pi/skills/</code>
          </p>
        </div>
      )}

      {/* Rich config panel for selected skill */}
      {RichConfigPanel && (
        <div className="rounded-lg border border-border bg-card/30 p-5">
          <RichConfigPanel wsUrl={wsUrl} onConfigChanged={handleConfigChanged} />
        </div>
      )}

      {/* Env variables */}
      <SkillEnvVariables
        variables={filteredVariables}
        isLoading={isLoading}
        error={error}
        success={success}
        draftByName={draftByName}
        revealByName={revealByName}
        savingVar={savingVar}
        deletingVar={deletingVar}
        onDraftChange={handleDraftChange}
        onToggleReveal={handleToggleReveal}
        onSave={(name) => void handleSave(name)}
        onDelete={(name) => void handleDelete(name)}
      />
    </div>
  )
}
