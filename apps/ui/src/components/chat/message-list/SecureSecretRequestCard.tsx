import { useMemo, useState } from 'react'
import { KeyRound, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PrivateSecretValueDialog } from '../secure-session/PrivateSecretValueDialog'
import {
  formatSecureAvailability,
  formatSecureBinding,
  formatSecurePolicy,
  secureBindingKey,
} from '../secure-session/format'
import type {
  SecureAccessRequestView,
  SecureGrantInput,
  SecureSessionAvailability,
  SecureSecretOption,
} from '../secure-session/types'

interface SecureSecretRequestCardProps {
  request: SecureAccessRequestView
  availability: SecureSessionAvailability
  secrets: SecureSecretOption[]
  disabled?: boolean
  onGrant: (grant: SecureGrantInput) => void | Promise<void>
  onDeny: (requestId: string) => void | Promise<void>
  onPrivateFulfill?: (
    requestId: string,
    value: string | Uint8Array,
  ) => void | Promise<void>
}

function matchesRequest(
  secret: SecureSecretOption,
  request: SecureAccessRequestView,
): boolean {
  if (!secret.available || !request.secretId || secret.secretId !== request.secretId) return false
  return request.requestedBindings.every((requestedBinding) => {
    const requestedBindingKey = secureBindingKey(requestedBinding)
    return secret.bindings.some((binding) => secureBindingKey(binding) === requestedBindingKey)
  })
}

export function SecureSecretRequestCard({
  request,
  availability,
  secrets,
  disabled = false,
  onGrant,
  onDeny,
  onPrivateFulfill,
}: SecureSecretRequestCardProps) {
  const compatibleSecrets = useMemo(
    () => secrets.filter((secret) => matchesRequest(secret, request)),
    [request, secrets],
  )
  const suggestedSecret = compatibleSecrets.find(
    (secret) => secret.displayAlias === request.secretAlias,
  )
  const [secretId, setSecretId] = useState(
    suggestedSecret?.secretId ?? compatibleSecrets[0]?.secretId ?? '',
  )
  const [privateValueOpen, setPrivateValueOpen] = useState(false)
  const effectiveSecretId = compatibleSecrets.some((secret) => secret.secretId === secretId)
    ? secretId
    : suggestedSecret?.secretId ?? compatibleSecrets[0]?.secretId ?? ''
  const selectedSecret = compatibleSecrets.find(
    (secret) => secret.secretId === effectiveSecretId,
  )
  const unavailableReason =
    availability.state === 'available'
      ? null
      : availability.reason ?? formatSecureAvailability(availability.state)
  const canPrivateFulfill =
    Boolean(onPrivateFulfill)
    && !request.secretId
    && availability.state !== 'remote_origin'
    && availability.state !== 'unsupported_runtime'

  if (request.status !== 'pending') return null

  const approveSavedSecret = () => {
    if (!selectedSecret || availability.state !== 'available') return
    void onGrant({
      requestId: request.requestId,
      secretId: selectedSecret.secretId,
      bindings: request.requestedBindings,
      policy: request.requestedPolicy,
    })
  }

  return (
    <>
      <div
        className="max-w-2xl space-y-3 rounded-lg border border-amber-500/40 bg-card p-4"
        role="alert"
        data-secure-secret-request={request.requestId}
      >
        <div className="flex items-start gap-2">
          <KeyRound className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">Secret access requested</p>
            <p className="text-xs text-muted-foreground">
              {request.requestedByLabel ?? request.requestedByAgentId}
              {request.secretAlias ? ` requested ${request.secretAlias}` : ' requested a secret'}
            </p>
          </div>
        </div>

        <div className="space-y-2 rounded-md bg-muted/45 p-3 text-xs">
          <div>
            <span className="font-medium text-foreground">Purpose</span>
            <p className="mt-0.5 text-muted-foreground">{request.purpose}</p>
          </div>
          <dl className="grid gap-1 text-muted-foreground sm:grid-cols-2">
            <div>
              <dt className="inline font-medium text-foreground">
                {request.requestedBindings.length === 1 ? 'Binding: ' : 'Bindings: '}
              </dt>
              <dd className="inline">
                {request.requestedBindings.map(formatSecureBinding).join(', ')}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium text-foreground">Scope: </dt>
              <dd className="inline">{formatSecurePolicy(request.requestedPolicy)}</dd>
            </div>
          </dl>
        </div>

        {unavailableReason ? (
          <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <p>
              <span className="font-medium text-foreground">
                {availability.state === 'source_unavailable'
                  ? 'Secret source unavailable. '
                  : availability.state === 'remote_origin'
                    ? 'Remote origin. '
                    : 'Unsupported runtime. '}
              </span>
              <span className="text-muted-foreground">{unavailableReason}</span>
            </p>
          </div>
        ) : compatibleSecrets.length > 0 ? (
          <label className="block space-y-1.5 text-xs font-medium text-foreground">
            Approve with saved secret
            <select
              value={effectiveSecretId}
              onChange={(event) => setSecretId(event.target.value)}
              disabled={disabled}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-normal"
            >
              {compatibleSecrets.map((secret) => (
                <option key={secret.secretId} value={secret.secretId}>
                  {secret.displayName
                    ? `${secret.displayName} (${secret.displayAlias})`
                    : secret.displayAlias}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="text-xs text-muted-foreground">
            No saved secret supports the requested binding.
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          Approval applies to the owning manager&apos;s Secure Bash process scope,
          never the secret value in chat. A requesting worker does not receive the binding.
        </p>

        <div className="flex flex-wrap gap-2">
          {availability.state === 'available' ? (
            <Button
              type="button"
              size="sm"
              disabled={disabled || !selectedSecret}
              onClick={approveSavedSecret}
            >
              Approve
            </Button>
          ) : null}
          {canPrivateFulfill ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() => setPrivateValueOpen(true)}
            >
              Provide unsaved value
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => void onDeny(request.requestId)}
          >
            Deny
          </Button>
        </div>
      </div>

      {privateValueOpen && onPrivateFulfill ? (
        <PrivateSecretValueDialog
          alias={request.secretAlias}
          onFulfill={(value) => onPrivateFulfill(request.requestId, value)}
          onClose={() => setPrivateValueOpen(false)}
        />
      ) : null}
    </>
  )
}
