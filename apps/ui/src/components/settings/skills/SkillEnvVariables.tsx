import {
  AlertTriangle,
  Check,
  Eye,
  EyeOff,
  ExternalLink,
  KeyRound,
  Loader2,
  Save,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsSection } from '../settings-row'
import type { SettingsEnvVariable } from '../settings-types'

/* ------------------------------------------------------------------ */
/*  Status badge                                                      */
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

/* ------------------------------------------------------------------ */
/*  Env variable row                                                  */
/* ------------------------------------------------------------------ */

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
            <code className="text-[13px] font-semibold text-foreground">
              {variable.name}
            </code>
            <StatusBadge isSet={variable.isSet} />
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">
              Required by
            </span>
            <Badge
              variant="secondary"
              className="px-1.5 py-0 text-[11px] font-medium"
            >
              {variable.skillName}
            </Badge>
            {!variable.required && (
              <span className="text-[11px] italic text-muted-foreground/70">
                · optional
              </span>
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
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {variable.description}
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            type={isRevealed ? 'text' : 'password'}
            placeholder={
              variable.isSet
                ? (variable.maskedValue ?? '••••••••')
                : 'Enter value…'
            }
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
            {isRevealed ? (
              <EyeOff className="size-3.5" />
            ) : (
              <Eye className="size-3.5" />
            )}
          </Button>
        </div>

        <Button
          type="button"
          size="sm"
          onClick={onSave}
          disabled={!draftValue.trim() || busy}
          className="gap-1.5"
        >
          {isSaving ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Save className="size-3.5" />
          )}
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
            {isDeleting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
            {isDeleting ? 'Removing' : 'Remove'}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main env variables list component                                 */
/* ------------------------------------------------------------------ */

export interface SkillEnvVariablesProps {
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

export function SkillEnvVariables({
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
          : 'API keys and secrets required by this skill'
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
          <p className="text-xs text-emerald-600 dark:text-emerald-400">
            {success}
          </p>
        </div>
      ) : null}

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : variables.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
          <KeyRound className="mb-2 size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            No environment variables found
          </p>
          <p className="mt-1 text-xs text-muted-foreground/60">
            This skill does not require any environment variables.
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
