import { useState } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SecureSshTrustRequestSummary } from '@forge/protocol'

interface SecureSshTrustRequestCardProps {
  request: SecureSshTrustRequestSummary
  disabled?: boolean
  canApprove?: boolean
  onTrust: (requestId: string) => boolean | void | Promise<boolean | void>
  onDismiss: (
    requestId: string,
  ) => boolean | void | Promise<boolean | void>
}

export function SecureSshTrustRequestCard({
  request,
  disabled = false,
  canApprove = true,
  onTrust,
  onDismiss,
}: SecureSshTrustRequestCardProps) {
  const [resolving, setResolving] = useState<'trust' | 'dismiss' | null>(null)

  const trust = async () => {
    if (resolving || !canApprove) return
    setResolving('trust')
    try {
      await onTrust(request.requestId)
    } finally {
      setResolving(null)
    }
  }

  const dismiss = async () => {
    if (resolving) return
    setResolving('dismiss')
    try {
      await onDismiss(request.requestId)
    } finally {
      setResolving(null)
    }
  }

  return (
    <div
      className="max-w-2xl space-y-3 rounded-lg border border-amber-500/40 bg-card p-4"
      role="alert"
      data-secure-ssh-trust-request={request.requestId}
    >
      <div className="flex items-start gap-2">
        <ShieldCheck
          className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">Trust SSH host?</p>
          <p className="text-xs text-muted-foreground">
            {request.requestedByDisplayName || request.requestedByAgentId}
            {' requested '}
            <span className="font-mono">{request.alias}</span>
          </p>
        </div>
      </div>

      <div className="space-y-2 rounded-md bg-muted/45 p-3 text-xs">
        <div>
          <span className="font-medium text-foreground">Purpose</span>
          <p className="mt-0.5 text-muted-foreground">{request.purposeSummary}</p>
        </div>
        <dl className="grid gap-1 text-muted-foreground sm:grid-cols-2">
          <div>
            <dt className="inline font-medium text-foreground">Connection: </dt>
            <dd className="inline">
              {request.username}@{request.hostName}:{request.port}
            </dd>
          </div>
          <div>
            <dt className="inline font-medium text-foreground">Alias: </dt>
            <dd className="inline font-mono">{request.alias}</dd>
          </div>
        </dl>
        <p className="break-all font-mono text-muted-foreground">
          {request.hostKeyAlgorithm} {request.hostKeyFingerprint}
        </p>
      </div>

      <p className="text-xs text-muted-foreground">
        The connection reported this public host key. Verify the fingerprint for sensitive hosts.
        Trusting it saves this alias for the project; no private credential enters chat.
      </p>

      {!canApprove ? (
        <p className="text-xs text-muted-foreground">
          Pair this browser with Forge Desktop to trust the host here.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {canApprove ? (
          <Button
            type="button"
            size="sm"
            disabled={disabled || Boolean(resolving)}
            onClick={() => void trust()}
          >
            {resolving === 'trust' ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Trusting…
              </>
            ) : 'Trust host'}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || Boolean(resolving)}
          onClick={() => void dismiss()}
        >
          Dismiss request
        </Button>
      </div>
    </div>
  )
}
