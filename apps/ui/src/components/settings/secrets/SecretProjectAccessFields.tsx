import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  SECURE_SECRET_MAX_PROJECT_DEFAULTS,
  type ManagerProfile,
} from '@forge/protocol'
import { ChevronDown } from 'lucide-react'
import type { SecretScopeKind } from './secret-project-access-values'

export function SecretScopeFields({
  idPrefix,
  profiles,
  scopeKind,
  selectedProfileIds,
  disabled,
  onScopeKindChange,
  onProfileCheckedChange,
}: {
  idPrefix: string
  profiles: ManagerProfile[]
  scopeKind: SecretScopeKind
  selectedProfileIds: Set<string>
  disabled: boolean
  onScopeKindChange: (scopeKind: SecretScopeKind) => void
  onProfileCheckedChange: (profileId: string, checked: boolean) => void
}) {
  const selectedCount = selectedProfileIds.size
  const triggerLabel = scopeKind === 'instance'
    ? 'All projects'
    : selectedCount === 1
      ? profiles.find((profile) =>
          selectedProfileIds.has(profile.profileId)
        )?.displayName || '1 project'
      : `${selectedCount} projects`

  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${idPrefix}-scope`}>Available in</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            id={`${idPrefix}-scope`}
            type="button"
            variant="outline"
            role="combobox"
            disabled={disabled}
            className="w-full justify-between font-normal"
            aria-label="Available in projects"
          >
            <span className="truncate">{triggerLabel}</span>
            <ChevronDown className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[var(--radix-popover-trigger-width)] min-w-64 p-1.5"
        >
          <label className="flex cursor-pointer items-start gap-2 rounded px-2 py-2 text-sm hover:bg-accent/60">
            <Checkbox
              checked={scopeKind === 'instance'}
              onCheckedChange={(checked) => {
                if (checked === true) onScopeKindChange('instance')
              }}
              aria-label="Available in all projects"
            />
            <span>
              <span className="block font-medium">All projects</span>
              <span className="block text-xs text-muted-foreground">
                Includes projects created later.
              </span>
            </span>
          </label>
          <div className="my-1 border-t border-border/70" />
          <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
            Selected projects
          </p>
          <div className="max-h-56 overflow-y-auto">
            {profiles.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                No projects are available.
              </p>
            ) : profiles.map((profile) => {
              const checked =
                scopeKind === 'projects' && selectedProfileIds.has(profile.profileId)
              const lastSelected =
                checked && selectedProfileIds.size === 1
              const displayName = profile.displayName || profile.profileId
              return (
                <label
                  key={profile.profileId}
                  className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${
                    lastSelected
                      ? 'cursor-not-allowed opacity-60'
                      : 'cursor-pointer hover:bg-accent/60'
                  }`}
                >
                  <Checkbox
                    checked={checked}
                    disabled={lastSelected}
                    onCheckedChange={(nextChecked) => {
                      if (scopeKind !== 'projects') onScopeKindChange('projects')
                      onProfileCheckedChange(profile.profileId, nextChecked === true)
                    }}
                    aria-label={`Available in ${displayName}`}
                  />
                  <span className="min-w-0 flex-1 truncate">{displayName}</span>
                </label>
              )
            })}
          </div>
        </PopoverContent>
      </Popover>
      <p className="text-xs text-muted-foreground">
        {scopeKind === 'instance'
          ? 'The alias can be selected from any local project.'
          : 'The alias can be selected only from the checked projects.'}
      </p>
    </div>
  )
}

export function AutomaticGrantFields({
  idPrefix,
  profiles,
  scopeKind,
  scopeProfileIds,
  selectedProfileIds,
  everyProject,
  limitReachedProfileIds,
  everyProjectLimitReached,
  maxProjectDefaults = SECURE_SECRET_MAX_PROJECT_DEFAULTS,
  disabled,
  onProfileCheckedChange,
  onEveryProjectChange,
}: {
  idPrefix: string
  profiles: ManagerProfile[]
  scopeKind: SecretScopeKind
  scopeProfileIds: Set<string>
  selectedProfileIds: Set<string>
  everyProject: boolean
  limitReachedProfileIds: Set<string>
  everyProjectLimitReached: boolean
  maxProjectDefaults?: number
  disabled: boolean
  onProfileCheckedChange: (profileId: string, checked: boolean) => void
  onEveryProjectChange: (enabled: boolean) => void
}) {
  const selectableProfiles = scopeKind === 'projects'
    ? profiles.filter((profile) => scopeProfileIds.has(profile.profileId))
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
                  {maxProjectDefaults}/{maxProjectDefaults}
                </span>
              ) : null}
            </label>
          )
        })}
      </div>

      {everyProjectBlocked ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Every project is unavailable because one or more projects already have the maximum of{' '}
          {maxProjectDefaults} automatic grants. Remove one there first.
        </p>
      ) : null}
      {[...limitReachedProfileIds].some(
        (profileId) => !selectedProfileIds.has(profileId),
      ) && !everyProjectBlocked ? (
        <p className="text-xs text-muted-foreground">
          A project with {maxProjectDefaults} automatic grants cannot receive
          another until one is removed.
        </p>
      ) : null}
      {scopeKind === 'projects' ? (
        <p className="text-xs text-muted-foreground">
          This secret can be granted automatically only in projects where it is available.
        </p>
      ) : null}
    </fieldset>
  )
}
