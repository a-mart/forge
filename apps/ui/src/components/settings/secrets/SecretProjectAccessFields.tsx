import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
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

export function ProjectDefaultFields({
  idPrefix,
  profiles,
  scopeKind,
  scopeProfileId,
  profileId,
  enabled,
  projectDefaultLimitReached,
  disabled,
  onProfileIdChange,
  onEnabledChange,
}: {
  idPrefix: string
  profiles: ManagerProfile[]
  scopeKind: SecretScopeKind
  scopeProfileId: string
  profileId: string
  enabled: boolean
  projectDefaultLimitReached: boolean
  disabled: boolean
  onProfileIdChange: (profileId: string) => void
  onEnabledChange: (enabled: boolean) => void
}) {
  const effectiveProfileId = scopeKind === 'profile' ? scopeProfileId : profileId
  return (
    <div className="rounded-md border border-border/70 bg-card/30 p-3">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-project-default`} className="text-sm font-medium">
            Automatically available in this project
          </Label>
          <p className="text-xs text-muted-foreground">
            {projectDefaultLimitReached
              ? `This project already has ${SECURE_SECRET_MAX_PROJECT_DEFAULTS} automatic secrets. Disable one before enabling another.`
              : 'New Secure Mode sessions receive a task-lifetime grant. Standard Bash remains unchanged.'}
          </p>
        </div>
        <Switch
          id={`${idPrefix}-project-default`}
          checked={enabled}
          disabled={disabled || !effectiveProfileId || projectDefaultLimitReached}
          onCheckedChange={onEnabledChange}
          aria-label="Automatically available in this project"
        />
      </div>
      {scopeKind === 'instance' ? (
        <div className="mt-3 max-w-sm">
          <ProjectSelect
            id={`${idPrefix}-default-project`}
            label="Default project"
            profiles={profiles}
            value={profileId}
            disabled={disabled}
            onValueChange={onProfileIdChange}
          />
        </div>
      ) : null}
    </div>
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
