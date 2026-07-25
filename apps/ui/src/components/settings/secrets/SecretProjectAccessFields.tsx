import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  SECURE_SECRET_MAX_PROJECT_DEFAULTS,
  type ManagerProfile,
} from '@forge/protocol'
import type { SecretScopeKind } from './secret-project-access-values'

export function SecretScopeFields({
  idPrefix,
  profiles,
  scopeKind,
  profileId,
  disabled,
  onScopeKindChange,
  onProfileIdChange,
}: {
  idPrefix: string
  profiles: ManagerProfile[]
  scopeKind: SecretScopeKind
  profileId: string
  disabled: boolean
  onScopeKindChange: (scopeKind: SecretScopeKind) => void
  onProfileIdChange: (profileId: string) => void
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Available in" htmlFor={`${idPrefix}-scope`}>
        <Select
          value={scopeKind}
          onValueChange={(value) => onScopeKindChange(value as SecretScopeKind)}
          disabled={disabled}
        >
          <SelectTrigger id={`${idPrefix}-scope`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="profile" disabled={profiles.length === 0}>
              Only this project
            </SelectItem>
            <SelectItem value="instance">All projects</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {scopeKind === 'profile' ? (
        <ProjectSelect
          id={`${idPrefix}-scope-project`}
          label="Project"
          profiles={profiles}
          value={profileId}
          disabled={disabled}
          onValueChange={onProfileIdChange}
        />
      ) : (
        <p className="self-end pb-2 text-xs text-muted-foreground">
          The alias can be selected from any local project.
        </p>
      )}
    </div>
  )
}

export function AutomaticGrantFields({
  idPrefix,
  profiles,
  scopeKind,
  scopeProfileId,
  selectedProfileIds,
  everyProject,
  limitReachedProfileIds,
  everyProjectLimitReached,
  disabled,
  onProfileCheckedChange,
  onEveryProjectChange,
}: {
  idPrefix: string
  profiles: ManagerProfile[]
  scopeKind: SecretScopeKind
  scopeProfileId: string
  selectedProfileIds: Set<string>
  everyProject: boolean
  limitReachedProfileIds: Set<string>
  everyProjectLimitReached: boolean
  disabled: boolean
  onProfileCheckedChange: (profileId: string, checked: boolean) => void
  onEveryProjectChange: (enabled: boolean) => void
}) {
  const selectableProfiles = scopeKind === 'profile'
    ? profiles.filter((profile) => profile.profileId === scopeProfileId)
    : profiles
  const everyProjectBlocked = scopeKind === 'instance'
    && !everyProject
    && (
      everyProjectLimitReached
      || selectableProfiles.some(
        (profile) => limitReachedProfileIds.has(profile.profileId),
      )
    )

  return (
    <fieldset
      className="space-y-3 rounded-md border border-border/70 bg-card/30 p-3"
      disabled={disabled}
    >
      <legend className="px-1 text-sm font-medium">Automatically grant in</legend>
      <p className="text-xs text-muted-foreground">
        Team Secure Mode grants this secret to eligible agents in the selected projects until
        it stops. Being available in a project's catalog does not grant access.
      </p>

      <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border/70 bg-background/50 p-1.5">
        {scopeKind === 'instance' ? (
          <label
            className={`flex items-start gap-2 rounded px-2 py-2 text-sm ${
              everyProjectBlocked
                ? 'cursor-not-allowed opacity-60'
                : 'cursor-pointer hover:bg-accent/60'
            }`}
          >
            <Checkbox
              id={`${idPrefix}-automatic-every-project`}
              checked={everyProject}
              disabled={disabled || everyProjectBlocked}
              onCheckedChange={(checked) => onEveryProjectChange(checked === true)}
              aria-label="Every project, including future projects"
            />
            <span className="min-w-0">
              <span className="block font-medium">Every project</span>
              <span className="block text-xs text-muted-foreground">
                Includes current projects and projects created later.
              </span>
            </span>
          </label>
        ) : null}

        {selectableProfiles.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">
            No projects are available.
          </p>
        ) : selectableProfiles.map((profile) => {
          const checked = selectedProfileIds.has(profile.profileId)
          const limitReached = limitReachedProfileIds.has(profile.profileId) && !checked
          const projectDisabled = disabled || everyProject || limitReached
          const displayName = profile.displayName || profile.profileId
          return (
            <label
              key={profile.profileId}
              className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${
                projectDisabled
                  ? 'cursor-not-allowed opacity-60'
                  : 'cursor-pointer hover:bg-accent/60'
              }`}
            >
              <Checkbox
                id={`${idPrefix}-automatic-${profile.profileId}`}
                checked={everyProject || checked}
                disabled={projectDisabled}
                onCheckedChange={(nextChecked) => {
                  onProfileCheckedChange(profile.profileId, nextChecked === true)
                }}
                aria-label={`Automatically grant in ${displayName}`}
              />
              <span className="min-w-0 flex-1 truncate">{displayName}</span>
              {limitReached ? (
                <span className="text-xs text-muted-foreground">
                  {SECURE_SECRET_MAX_PROJECT_DEFAULTS}/{SECURE_SECRET_MAX_PROJECT_DEFAULTS}
                </span>
              ) : null}
            </label>
          )
        })}
      </div>

      {everyProjectBlocked ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Every project is unavailable because one or more projects already have the maximum of{' '}
          {SECURE_SECRET_MAX_PROJECT_DEFAULTS} automatic grants. Remove one there first.
        </p>
      ) : null}
      {[...limitReachedProfileIds].some(
        (profileId) => !selectedProfileIds.has(profileId),
      ) && !everyProjectBlocked ? (
        <p className="text-xs text-muted-foreground">
          A project with {SECURE_SECRET_MAX_PROJECT_DEFAULTS} automatic grants cannot receive
          another until one is removed.
        </p>
      ) : null}
      {scopeKind === 'profile' ? (
        <p className="text-xs text-muted-foreground">
          A project-only secret can be granted automatically only in its own project.
        </p>
      ) : null}
    </fieldset>
  )
}

function ProjectSelect({
  id,
  label,
  profiles,
  value,
  disabled,
  onValueChange,
}: {
  id: string
  label: string
  profiles: ManagerProfile[]
  value: string
  disabled: boolean
  onValueChange: (profileId: string) => void
}) {
  return (
    <Field label={label} htmlFor={id}>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Choose a project" />
        </SelectTrigger>
        <SelectContent>
          {profiles.map((profile) => (
            <SelectItem key={profile.profileId} value={profile.profileId}>
              {profile.displayName || profile.profileId}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  )
}
