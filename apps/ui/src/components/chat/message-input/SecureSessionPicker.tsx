import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  KeyRound,
  Loader2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { SecureGrantDialog } from '../secure-session/SecureGrantDialog'
import { StopProcessesAndRevokeDialog } from '../secure-session/StopProcessesAndRevokeDialog'
import {
  formatSecureAvailability,
  formatSecureBinding,
  formatSecurePolicy,
} from '../secure-session/format'
import type {
  SecureLeaseView,
  SecureProjectDefaultStatusView,
  SecureSessionPickerConfig,
  SecureSessionSnapshotView,
} from '../secure-session/types'

function formatExpiry(expiresAt: string): string {
  const value = new Date(expiresAt)
  if (Number.isNaN(value.getTime())) return 'Expiry unavailable'
  return `Expires ${value.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

function leaseDescription(lease: SecureLeaseView): string {
  const parts = [
    lease.grantSource === 'project_default' ? 'Project default' : '',
    formatSecurePolicy(lease.policy),
    lease.bindings.map(formatSecureBinding).join(', '),
  ]
  if (lease.expiresAt) parts.push(formatExpiry(lease.expiresAt))
  if (typeof lease.remainingUses === 'number') {
    parts.push(`${lease.remainingUses} ${lease.remainingUses === 1 ? 'use' : 'uses'} left`)
  }
  return parts.filter(Boolean).join(' · ')
}

const PROJECT_DEFAULT_STATE_PRIORITY: Record<
  SecureProjectDefaultStatusView['state'],
  number
> = {
  active: 0,
  configured: 1,
  unavailable: 2,
  conflict: 3,
}

function aggregateProjectDefaults(
  config: SecureSessionPickerConfig,
): SecureProjectDefaultStatusView[] {
  const snapshots = [
    ...(config.snapshot ? [config.snapshot] : []),
    ...(config.teamMembers ?? []).map((member) => member.snapshot),
  ]
  const defaultsById = new Map<string, SecureProjectDefaultStatusView>()
  for (const snapshot of snapshots) {
    for (const projectDefault of snapshot.projectDefaults ?? []) {
      const current = defaultsById.get(projectDefault.secretId)
      if (
        !current
        || PROJECT_DEFAULT_STATE_PRIORITY[projectDefault.state]
          > PROJECT_DEFAULT_STATE_PRIORITY[current.state]
      ) {
        defaultsById.set(projectDefault.secretId, projectDefault)
      }
    }
  }
  return Array.from(defaultsById.values()).sort((left, right) =>
    left.displayAlias.localeCompare(right.displayAlias))
}

function projectDefaultStateLabel(
  state: SecureProjectDefaultStatusView['state'],
): string {
  if (state === 'active') return 'Active'
  if (state === 'configured') return 'Ready to apply'
  if (state === 'unavailable') return 'Unavailable'
  return 'Binding conflict'
}

function isSecureSessionSnapshotView(
  value: boolean | void | SecureSessionSnapshotView,
): value is SecureSessionSnapshotView {
  return typeof value === 'object'
    && value !== null
    && typeof value.sessionAgentId === 'string'
    && Array.isArray(value.leases)
}

function pickerState(config: SecureSessionPickerConfig, activeLeaseCount: number): {
  label: string
  ariaLabel: string
  tone: 'muted' | 'active' | 'warning'
  icon: 'shield' | 'check' | 'alert' | 'off' | 'loading'
} {
  if (config.outputState === 'quarantined') {
    return {
      label: 'Output redacted',
      ariaLabel: 'Secure session: protected output redacted. Review secure session.',
      tone: 'warning',
      icon: 'alert',
    }
  }

  if (config.availability.state !== 'available') {
    const label = config.availability.state === 'remote_origin'
      ? 'Remote'
      : config.availability.state === 'source_unavailable'
        ? 'Unavailable'
        : 'Unsupported'
    return {
      label,
      ariaLabel: `Secure session: ${formatSecureAvailability(config.availability.state)}`,
      tone: 'muted',
      icon: 'off',
    }
  }

  if (config.snapshot?.environmentStatus === 'starting') {
    return {
      label: 'Starting',
      ariaLabel: 'Secure session is starting.',
      tone: 'muted',
      icon: 'loading',
    }
  }

  if (
    config.snapshot?.environmentStatus === 'degraded'
    || config.snapshot?.environmentStatus === 'failed'
  ) {
    return {
      label: config.snapshot.environmentStatus === 'failed' ? 'Failed' : 'Degraded',
      ariaLabel: `Secure session environment ${config.snapshot.environmentStatus}.`,
      tone: 'warning',
      icon: 'alert',
    }
  }

  if (activeLeaseCount > 0) {
    return {
      label: `${activeLeaseCount} ${activeLeaseCount === 1 ? 'lease' : 'leases'}`,
      ariaLabel: `Secure session active with ${activeLeaseCount} active ${activeLeaseCount === 1 ? 'lease' : 'leases'}.`,
      tone: 'active',
      icon: 'check',
    }
  }

  const isReady =
    config.snapshot?.executionMode === 'secure'
    && config.snapshot.environmentStatus === 'ready'
  return {
    label: isReady ? 'Secure' : 'Start secure',
    ariaLabel: isReady
      ? 'Secure session ready. Manage secure session.'
      : 'Start a secure session.',
    tone: isReady ? 'active' : 'muted',
    icon: 'shield',
  }
}

function PickerIcon({
  icon,
}: {
  icon: ReturnType<typeof pickerState>['icon']
}) {
  if (icon === 'loading') {
    return <Loader2 className="size-3 animate-spin" aria-hidden="true" />
  }
  if (icon === 'check') {
    return <ShieldCheck className="size-3" aria-hidden="true" />
  }
  if (icon === 'alert') {
    return <ShieldAlert className="size-3" aria-hidden="true" />
  }
  if (icon === 'off') {
    return <ShieldOff className="size-3" aria-hidden="true" />
  }
  return <Shield className="size-3" aria-hidden="true" />
}

export function SecureSessionPicker({
  config,
}: {
  config: SecureSessionPickerConfig
}) {
  const [open, setOpen] = useState(false)
  const [grantOpen, setGrantOpen] = useState(false)
  const [stopOpen, setStopOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const [applyingProjectDefaults, setApplyingProjectDefaults] = useState(false)
  const sessionAgentId = config.snapshot?.sessionAgentId
  const configIdentity = `${config.originId ?? ''}\u0000${sessionAgentId ?? ''}`
  const configIdentityRef = useRef(configIdentity)
  configIdentityRef.current = configIdentity

  useEffect(() => {
    setOpen(false)
    setGrantOpen(false)
    setStopOpen(false)
    setStarting(false)
    setApplyingProjectDefaults(false)
  }, [config.originId, sessionAgentId])

  const activeLeases = useMemo(
    () => config.snapshot?.leases.filter((lease) => lease.status === 'active') ?? [],
    [config.snapshot?.leases],
  )
  const teamMembers = config.teamMembers ?? []
  const grantableSecrets = useMemo(
    () => config.secrets.filter((secret) =>
      !activeLeases.some((lease) => lease.secretId === secret.secretId)),
    [activeLeases, config.secrets],
  )
  const state = pickerState(config, activeLeases.length)
  const projectDefaults = useMemo(
    () => aggregateProjectDefaults(config),
    [config],
  )
  const hasNonActiveProjectDefaults = projectDefaults.some(
    (projectDefault) => projectDefault.state !== 'active',
  )
  const hasProjectDefaultsNeedingReview = projectDefaults.some(
    (projectDefault) =>
      projectDefault.state === 'unavailable'
      || projectDefault.state === 'conflict',
  )
  const canGrant =
    !config.readOnly
    && Boolean(config.onGrant)
    && config.availability.state === 'available'
    && config.snapshot?.executionMode === 'secure'
    && config.snapshot.environmentStatus === 'ready'
    && grantableSecrets.some((secret) => secret.available && secret.bindings.length > 0)
  const hasSavedSecrets = config.secrets.length > 0
  const hasUnleasedSecrets = grantableSecrets.length > 0
  const shouldOfferSecretReview =
    !canGrant
    && hasUnleasedSecrets
    && Boolean(config.onReviewProjectSecrets)
  const shouldOfferStart =
    !config.readOnly
    && config.availability.state === 'available'
    && (
      !config.snapshot
      || config.snapshot.executionMode === 'standard'
      || config.snapshot.environmentStatus === 'stopped'
    )
  const shouldOfferStop =
    !config.readOnly
    && Boolean(config.onRevoke)
    && (
      config.outputState === 'quarantined'
      || activeLeases.length > 0
      || (
        config.snapshot?.executionMode === 'secure'
        && config.snapshot.environmentStatus !== 'stopped'
      )
    )

  const startAndOpenGrant = async () => {
    if (!config.onStart || starting) return
    const startIdentity = configIdentity
    setOpen(false)
    setStarting(true)
    try {
      const result = await config.onStart()
      if (configIdentityRef.current !== startIdentity) return
      if (result === false) {
        setOpen(true)
        return
      }
      if (!isSecureSessionSnapshotView(result)) {
        setGrantOpen(true)
        return
      }

      const returnedDefaults = result.projectDefaults ?? []
      if (returnedDefaults.some((projectDefault) => projectDefault.state !== 'active')) {
        setOpen(true)
        return
      }
      if (result.leases.some((lease) => lease.status === 'active')) return
      if (grantableSecrets.some((secret) => secret.available && secret.bindings.length > 0)) {
        setGrantOpen(true)
        return
      }
      config.onReviewProjectSecrets?.()
    } finally {
      if (configIdentityRef.current === startIdentity) {
        setStarting(false)
      }
    }
  }

  const applyProjectDefaults = async () => {
    if (
      !sessionAgentId
      || !config.onApplyProjectDefaults
      || applyingProjectDefaults
    ) return
    setApplyingProjectDefaults(true)
    try {
      await config.onApplyProjectDefaults(sessionAgentId)
    } finally {
      setApplyingProjectDefaults(false)
    }
  }

  const unavailableDescription =
    config.availability.state === 'available'
      ? null
      : config.availability.reason
        ?? formatSecureAvailability(config.availability.state)

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={config.disabled}
            className={cn(
              'flex h-7 min-w-0 max-w-[42vw] items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors sm:max-w-40',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              'disabled:pointer-events-none disabled:opacity-50',
              state.tone === 'active'
                ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300'
                : state.tone === 'warning'
                  ? 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15'
                  : 'border-border/60 bg-muted/55 text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground',
            )}
            aria-label={state.ariaLabel}
            aria-haspopup="dialog"
            aria-expanded={open}
          >
            <PickerIcon icon={state.icon} />
            <span className="truncate">{state.label}</span>
            <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
          </button>
        </PopoverTrigger>

        <PopoverContent
          align="end"
          side="top"
          className="max-h-[min(32rem,calc(100vh-1rem))] w-[min(22rem,calc(100vw-1rem))] space-y-4 overflow-y-auto"
        >
          <PopoverHeader>
            <PopoverTitle className="flex items-center gap-2">
              <Shield className="size-4" aria-hidden="true" />
              {config.readOnly ? 'Worker Secure Status' : 'Team Secure Mode'}
            </PopoverTitle>
            <PopoverDescription>
              {config.readOnly
                ? 'This worker has an isolated Secure Bash container. Only its own approved grants are available here.'
                : 'Each agent runs Secure Bash in its own isolated container with independent grants.'}
            </PopoverDescription>
          </PopoverHeader>

          {unavailableDescription ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
              <p className="font-medium text-foreground">
                {config.availability.state === 'remote_origin'
                  ? 'Remote origin'
                  : config.availability.state === 'source_unavailable'
                    ? 'Secret source unavailable'
                    : 'Unsupported runtime'}
              </p>
              <p className="mt-1 text-muted-foreground">{unavailableDescription}</p>
            </div>
          ) : null}

          {config.outputState === 'quarantined' ? (
            <div className="rounded-md border border-destructive/35 bg-destructive/5 p-3 text-xs">
              <p className="font-medium text-destructive">Protected output redacted</p>
              <p className="mt-1 text-muted-foreground">
                {config.outputStateReason
                  ?? 'Forge removed protected material before it reached the agent. The Secure Session remains active.'}
              </p>
            </div>
          ) : null}

          {projectDefaults.length > 0 ? (
            <section
              className="space-y-2 rounded-md border border-border/70 bg-muted/35 p-2.5"
              aria-label="Project default status"
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Project defaults
                </h3>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {projectDefaults.length}
                </span>
              </div>
              <div className="space-y-1.5">
                {projectDefaults.map((projectDefault) => (
                  <div
                    key={projectDefault.secretId}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="min-w-0 truncate text-foreground">
                      {projectDefault.displayAlias}
                    </span>
                    <span className={cn(
                      'shrink-0 font-medium',
                      projectDefault.state === 'active'
                        ? 'text-emerald-700 dark:text-emerald-300'
                        : projectDefault.state === 'configured'
                          ? 'text-muted-foreground'
                          : 'text-amber-700 dark:text-amber-300',
                    )}>
                      {projectDefaultStateLabel(projectDefault.state)}
                    </span>
                  </div>
                ))}
              </div>
              {!config.readOnly
              && (hasNonActiveProjectDefaults || hasProjectDefaultsNeedingReview) ? (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {hasNonActiveProjectDefaults && config.onApplyProjectDefaults ? (
                    <Button
                      type="button"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={config.disabled || applyingProjectDefaults}
                      onClick={() => void applyProjectDefaults()}
                    >
                      {applyingProjectDefaults ? (
                        <>
                          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                          Applying…
                        </>
                      ) : 'Apply now'}
                    </Button>
                  ) : null}
                  {hasProjectDefaultsNeedingReview
                  && config.onReviewProjectSecrets ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      disabled={config.disabled || applyingProjectDefaults}
                      onClick={config.onReviewProjectSecrets}
                    >
                      Review project secrets
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {teamMembers.length > 0 ? (
            <section className="space-y-2" aria-label="Team secure status">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Team agents
              </h3>
              <div className="space-y-2">
                {teamMembers.map((member) => {
                  const memberLeases = member.snapshot.leases.filter(
                    (lease) => lease.status === 'active',
                  )
                  const ready =
                    member.snapshot.executionMode === 'secure'
                    && member.snapshot.environmentStatus === 'ready'
                  const quarantined = member.snapshot.outputState === 'quarantined'
                  return (
                    <div
                      key={member.sessionAgentId}
                      className="rounded-md border border-border/70 p-2.5"
                      data-secure-team-member={member.sessionAgentId}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="min-w-0 truncate text-sm font-medium">
                          {member.displayName}
                        </p>
                        <span className={cn(
                          'shrink-0 text-xs',
                          quarantined ? 'text-destructive' : 'text-muted-foreground',
                        )}>
                          {quarantined
                            ? 'Output redacted'
                            : ready
                              ? 'Secure'
                              : member.snapshot.environmentStatus}
                          {' · '}
                          {memberLeases.length} {memberLeases.length === 1 ? 'grant' : 'grants'}
                        </span>
                      </div>
                      {quarantined ? (
                        <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                          <span className="text-destructive">
                            Protected output was redacted for {member.displayName}.
                          </span>
                          {config.onRevoke ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              className="h-7 shrink-0 px-2 text-xs"
                              disabled={config.disabled}
                              onClick={() => void config.onRevoke?.(
                                member.sessionAgentId,
                                undefined,
                                { stopProcesses: true },
                              )}
                            >
                              Stop secure processes
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                      {memberLeases.length > 0 ? (
                        <div className="mt-2 space-y-1.5">
                          {memberLeases.map((lease) => (
                            <div
                              key={lease.leaseId}
                              className="flex items-center justify-between gap-2 text-xs"
                            >
                              <span className="min-w-0 truncate text-muted-foreground">
                                {lease.displayAlias}
                              </span>
                              {config.onRevoke ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 shrink-0 px-2 text-xs"
                                  disabled={config.disabled}
                                  onClick={() => void config.onRevoke?.(
                                    member.sessionAgentId,
                                    lease.leaseId,
                                  )}
                                >
                                  Revoke
                                </Button>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </section>
          ) : null}

          {activeLeases.length > 0 ? (
            <section className="space-y-2" aria-label="Active secure leases">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Active leases
                </h3>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {activeLeases.length}
                </span>
              </div>
              <div className="space-y-2">
                {activeLeases.map((lease) => (
                  <div
                    key={lease.leaseId}
                    className="flex items-start justify-between gap-3 rounded-md border border-border/70 p-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{lease.displayAlias}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {leaseDescription(lease)}
                      </p>
                    </div>
                    {!config.readOnly && config.onRevoke && sessionAgentId ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 shrink-0 px-2 text-xs"
                        disabled={config.disabled}
                        onClick={() => void config.onRevoke?.(
                          sessionAgentId,
                          lease.leaseId,
                        )}
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          ) : config.availability.state === 'available' ? (
            <div className="flex items-center gap-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              <KeyRound className="size-4 shrink-0" aria-hidden="true" />
              <span>No secrets are currently leased.</span>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {shouldOfferStart ? (
              <Button
                type="button"
                size="sm"
                disabled={config.disabled || !config.onStart || starting}
                onClick={() => void startAndOpenGrant()}
              >
                {starting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Starting…
                  </>
                ) : 'Start secure session'}
              </Button>
            ) : null}
            {!config.readOnly
            && config.availability.state === 'available'
            && !shouldOfferStart ? (
              canGrant ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={config.disabled}
                  onClick={() => {
                    setOpen(false)
                    setGrantOpen(true)
                  }}
                >
                  Grant secrets
                </Button>
              ) : !hasSavedSecrets && config.onReviewProjectSecrets ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={config.disabled}
                  onClick={() => {
                    setOpen(false)
                    config.onReviewProjectSecrets?.()
                  }}
                >
                  Add project secret
                </Button>
              ) : shouldOfferSecretReview && !hasProjectDefaultsNeedingReview ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={config.disabled}
                  onClick={() => {
                    setOpen(false)
                    config.onReviewProjectSecrets?.()
                  }}
                >
                  Review unavailable secrets
                </Button>
              ) : null
            ) : null}
            {shouldOfferStop ? (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={config.disabled}
                onClick={() => {
                  setOpen(false)
                  setStopOpen(true)
                }}
              >
                Stop processes and revoke
              </Button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>

      {grantOpen && config.onGrant && sessionAgentId ? (
        <SecureGrantDialog
          secrets={grantableSecrets}
          onGrant={(grants) => config.onGrant?.(sessionAgentId, grants)}
          onAddSecret={config.onReviewProjectSecrets}
          onClose={() => setGrantOpen(false)}
        />
      ) : null}

      <StopProcessesAndRevokeDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        onConfirm={() => {
          if (config.onRevoke && sessionAgentId) {
            return config.onRevoke(sessionAgentId, undefined, { stopProcesses: true })
          }
        }}
      />
    </>
  )
}
