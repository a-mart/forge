import { useEffect, useMemo, useState } from 'react'
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
  SecureSessionPickerConfig,
} from '../secure-session/types'

function formatExpiry(expiresAt: string): string {
  const value = new Date(expiresAt)
  if (Number.isNaN(value.getTime())) return 'Expiry unavailable'
  return `Expires ${value.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

function leaseDescription(lease: SecureLeaseView): string {
  const parts = [
    formatSecurePolicy(lease.policy),
    lease.bindings.map(formatSecureBinding).join(', '),
  ]
  if (lease.expiresAt) parts.push(formatExpiry(lease.expiresAt))
  if (typeof lease.remainingUses === 'number') {
    parts.push(`${lease.remainingUses} ${lease.remainingUses === 1 ? 'use' : 'uses'} left`)
  }
  return parts.filter(Boolean).join(' · ')
}

function pickerState(config: SecureSessionPickerConfig, activeLeaseCount: number): {
  label: string
  ariaLabel: string
  tone: 'muted' | 'active' | 'warning'
  icon: 'shield' | 'check' | 'alert' | 'off' | 'loading'
} {
  if (config.outputState === 'quarantined') {
    return {
      label: 'Output held',
      ariaLabel: 'Secure session: output quarantined. Review secure session.',
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
  const sessionAgentId = config.snapshot?.sessionAgentId

  useEffect(() => {
    setOpen(false)
    setGrantOpen(false)
    setStopOpen(false)
  }, [config.originId, sessionAgentId])

  const activeLeases = useMemo(
    () => config.snapshot?.leases.filter((lease) => lease.status === 'active') ?? [],
    [config.snapshot?.leases],
  )
  const state = pickerState(config, activeLeases.length)
  const canGrant =
    config.availability.state === 'available'
    && config.snapshot?.executionMode === 'secure'
    && config.snapshot.environmentStatus === 'ready'
    && config.secrets.some((secret) => secret.available && secret.bindings.length > 0)
  const shouldOfferStart =
    config.availability.state === 'available'
    && (
      !config.snapshot
      || config.snapshot.executionMode === 'standard'
      || config.snapshot.environmentStatus === 'stopped'
    )
  const shouldOfferStop =
    config.outputState === 'quarantined'
    || activeLeases.length > 0
    || (
      config.snapshot?.executionMode === 'secure'
      && config.snapshot.environmentStatus !== 'stopped'
    )

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
              Secure Session
            </PopoverTitle>
            <PopoverDescription>
              Secure Bash runs in a task-owned Linux container. Active grants are
              injected into every command process while their scope remains valid.
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
              <p className="font-medium text-destructive">Secure output quarantined</p>
              <p className="mt-1 text-muted-foreground">
                {config.outputStateReason
                  ?? 'Output was withheld because it may contain protected secret material.'}
              </p>
            </div>
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
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 shrink-0 px-2 text-xs"
                      disabled={config.disabled}
                      onClick={() => void config.onRevoke(lease.leaseId)}
                    >
                      Revoke
                    </Button>
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
                disabled={config.disabled || !config.onStart}
                onClick={() => {
                  setOpen(false)
                  void config.onStart?.()
                }}
              >
                Start secure session
              </Button>
            ) : null}
            {config.availability.state === 'available' && !shouldOfferStart ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={config.disabled || !canGrant}
                onClick={() => {
                  setOpen(false)
                  setGrantOpen(true)
                }}
              >
                Grant a secret
              </Button>
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

      {grantOpen ? (
        <SecureGrantDialog
          secrets={config.secrets}
          onGrant={config.onGrant}
          onClose={() => setGrantOpen(false)}
        />
      ) : null}

      <StopProcessesAndRevokeDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        onConfirm={() => config.onRevoke(undefined, { stopProcesses: true })}
      />
    </>
  )
}
