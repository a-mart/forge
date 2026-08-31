import { useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type {
  SecureSecretProviderSummary,
  SecureSecretSourceStatus,
} from '@forge/protocol'
import type {
  SecureSessionReadiness,
  SecureSessionReadinessCode,
} from '@/lib/secure-secrets-api'
import { serializeSafeSecureSessionsDiagnostics } from './secure-readiness-diagnostics'

const EXECUTION_LABELS: Record<SecureSessionReadinessCode, string> = {
  available: 'Ready',
  backend_unavailable: 'Docker unavailable',
  image_unavailable: 'Secure image unavailable',
  unsupported_platform: 'Unsupported platform',
}

const SOURCE_LABELS: Record<SecureSecretProviderSummary['kind'], string> = {
  local_keychain: 'Local vault',
  bitwarden_secrets_manager: 'Bitwarden Secrets Manager',
  bitwarden_password_manager: 'Bitwarden Password Manager',
}

const SOURCE_STATUS_LABELS: Record<SecureSecretSourceStatus, string> = {
  available: 'Ready',
  locked: 'Locked',
  auth_required: 'Reconnect required',
  unreachable: 'Unreachable',
  missing: 'Missing',
  disabled: 'Disabled',
}

function readinessActions(
  readiness: SecureSessionReadiness | null,
  privateEntrySupported: boolean,
  privateEntryAvailable: boolean,
  providers: SecureSecretProviderSummary[],
): string[] {
  const actions: string[] = []
  if (readiness?.code === 'backend_unavailable') {
    actions.push('Start or repair Docker Desktop, then check again.')
  } else if (readiness?.code === 'image_unavailable') {
    actions.push('Install the Forge secure runner in this local Docker engine.')
  } else if (readiness?.code === 'unsupported_platform') {
    actions.push('Use a supported local Builder platform for Secure Bash.')
  }
  if (!privateEntrySupported) {
    actions.push('Open Forge Desktop with operating-system secure storage available.')
  } else if (!privateEntryAvailable) {
    actions.push('Unlock operating-system private storage here, then continue without restarting Forge.')
  }
  if (providers.some((provider) => provider.status === 'locked')) {
    actions.push('Unlock the affected secret source, then test it again.')
  }
  if (providers.some((provider) => provider.status === 'auth_required')) {
    actions.push('Reconnect the affected source below.')
  }
  if (providers.some((provider) => provider.status === 'unreachable')) {
    actions.push('Check source connectivity, then test the connection again.')
  }
  if (providers.some((provider) =>
    provider.status === 'missing' || provider.status === 'disabled')) {
    actions.push('Review the affected source and reconnect or remove it.')
  }
  return Array.from(new Set(actions)).slice(0, 4)
}

function StatusBadge({
  ready,
  children,
}: {
  ready: boolean
  children: React.ReactNode
}) {
  return (
    <Badge
      variant="outline"
      className={ready
        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
        : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'}
    >
      {children}
    </Badge>
  )
}

export function SecureSessionsReadinessPanel({
  readiness,
  loading,
  privateEntrySupported,
  privateEntryAvailable,
  unlockingPrivateEntry,
  privateEntryUnlockMessage,
  installingRunner,
  runnerInstallMessage,
  providers,
  configuredProjectDefaultCount,
  maxProjectDefaults,
  onRefresh,
  onUnlockPrivateEntry,
  onInstallRunner,
}: {
  readiness: SecureSessionReadiness | null
  loading: boolean
  privateEntrySupported: boolean
  privateEntryAvailable: boolean
  unlockingPrivateEntry: boolean
  privateEntryUnlockMessage: string | null
  installingRunner: boolean
  runnerInstallMessage: string | null
  providers: SecureSecretProviderSummary[]
  configuredProjectDefaultCount?: number
  maxProjectDefaults?: number
  onRefresh: () => void | Promise<void>
  onUnlockPrivateEntry: () => void | Promise<void>
  onInstallRunner: () => void | Promise<void>
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const actions = loading
    ? []
    : readinessActions(
        readiness,
        privateEntrySupported,
        privateEntryAvailable,
        providers,
      )

  const copyDiagnostics = async () => {
    setCopyState('idle')
    try {
      await navigator.clipboard.writeText(serializeSafeSecureSessionsDiagnostics({
        readiness,
        privateEntryAvailable,
        providers,
        configuredProjectDefaultCount,
        maxProjectDefaults,
      }))
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <section
      className="space-y-3 rounded-md border border-border/70 bg-card/40 p-4"
      aria-label="Secure Sessions readiness"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <div className="rounded-md border border-border bg-background p-2">
            <ShieldCheck className="size-4 text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">Secure Sessions readiness</h3>
            <p className="text-xs text-muted-foreground">
              Fixed local checks only. No secret values or provider details are included.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {privateEntrySupported && !privateEntryAvailable ? (
            <Button
              type="button"
              variant="default"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={loading || unlockingPrivateEntry}
              onClick={() => void onUnlockPrivateEntry()}
            >
              {unlockingPrivateEntry
                ? <Loader2 className="size-3.5 animate-spin" />
                : <ShieldCheck className="size-3.5" />}
              Unlock private storage
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            disabled={loading || installingRunner}
            onClick={() => void onRefresh()}
          >
            {loading
              ? <Loader2 className="size-3.5 animate-spin" />
              : <RefreshCw className="size-3.5" />}
            Check again
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => void copyDiagnostics()}
          >
            <Clipboard className="size-3.5" />
            Copy safe diagnostics
          </Button>
        </div>
      </div>

      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 p-2.5">
          <span className="text-muted-foreground">Secure Bash</span>
          <StatusBadge ready={readiness?.available === true}>
            {readiness ? EXECUTION_LABELS[readiness.code] : 'Checking'}
          </StatusBadge>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 p-2.5">
          <span className="text-muted-foreground">Private entry</span>
          <StatusBadge ready={!loading && privateEntryAvailable}>
            {loading
              ? 'Checking'
              : privateEntryAvailable
                ? 'Available'
                : privateEntrySupported
                  ? 'Locked'
                  : 'Unavailable'}
          </StatusBadge>
        </div>
        {providers.map((provider) => (
          <div
            key={provider.providerId}
            className="flex items-center justify-between gap-3 rounded-md border border-border/60 p-2.5"
          >
            <span className="truncate text-muted-foreground">
              {SOURCE_LABELS[provider.kind]}
            </span>
            <StatusBadge ready={provider.status === 'available'}>
              {SOURCE_STATUS_LABELS[provider.status]}
            </StatusBadge>
          </div>
        ))}
        {configuredProjectDefaultCount !== undefined ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 p-2.5">
            <span className="text-muted-foreground">Configured automatic grants</span>
            <Badge variant="outline">{configuredProjectDefaultCount}</Badge>
          </div>
        ) : null}
      </div>

      {actions.length > 0 ? (
        <div className="space-y-1.5 rounded-md border border-amber-500/25 bg-amber-500/5 p-2.5 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            <AlertTriangle className="size-3.5 text-amber-500" />
            Next actions
          </p>
          <ul className="space-y-1 text-muted-foreground">
            {actions.map((action) => <li key={action}>• {action}</li>)}
          </ul>
          {readiness?.code === 'image_unavailable' ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                type="button"
                variant="default"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                disabled={installingRunner}
                onClick={() => void onInstallRunner()}
              >
                {installingRunner
                  ? <Loader2 className="size-3.5 animate-spin" />
                  : <ShieldCheck className="size-3.5" />}
                {installingRunner ? 'Installing secure runner…' : 'Install secure runner'}
              </Button>
            </div>
          ) : null}
        </div>
      ) : !loading && readiness?.available && privateEntryAvailable ? (
        <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="size-3.5" />
          Secure Sessions are ready for configured local sources.
        </p>
      ) : null}

      {runnerInstallMessage ? (
        <p
          role="status"
          className={readiness?.available
            ? 'text-xs text-emerald-700 dark:text-emerald-300'
            : 'text-xs text-destructive'}
        >
          {runnerInstallMessage}
        </p>
      ) : null}

      {copyState !== 'idle' ? (
        <p
          role="status"
          className={copyState === 'copied'
            ? 'text-xs text-emerald-700 dark:text-emerald-300'
            : 'text-xs text-destructive'}
        >
          {copyState === 'copied'
            ? 'Safe diagnostics copied.'
            : 'Safe diagnostics could not be copied.'}
        </p>
      ) : null}
      {privateEntryUnlockMessage ? (
        <p
          role="status"
          className={privateEntryAvailable
            ? 'text-xs text-emerald-700 dark:text-emerald-300'
            : 'text-xs text-amber-700 dark:text-amber-300'}
        >
          {privateEntryUnlockMessage}
        </p>
      ) : null}
    </section>
  )
}
