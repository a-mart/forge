import { useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { formatSecureBinding } from './format'
import type {
  SecureGrantInput,
  SecureLeasePolicyView,
  SecureSecretBindingView,
  SecureSecretOption,
} from './types'

const POLICY_OPTIONS: Array<{
  value: string
  label: string
  description: string
  policy: SecureLeasePolicyView
}> = [
  {
    value: 'one_use',
    label: 'Next Secure Bash command',
    description: 'Injected into the next Secure Bash command and then revoked, whether or not the command uses it.',
    policy: { kind: 'one_use' },
  },
  {
    value: 'task',
    label: 'Until Secure Session stops',
    description: 'Injected into every Secure Bash command and its child processes until you revoke it or stop the session.',
    policy: { kind: 'task' },
  },
  {
    value: 'timed:900',
    label: '15 minutes',
    description: 'Injected into every Secure Bash command and its child processes for up to 15 minutes.',
    policy: { kind: 'timed', durationSeconds: 900 },
  },
  {
    value: 'timed:3600',
    label: '1 hour',
    description: 'Injected into every Secure Bash command and its child processes for up to 1 hour.',
    policy: { kind: 'timed', durationSeconds: 3_600 },
  },
]

function selectDefaultBinding(
  bindings: SecureSecretBindingView[],
): SecureSecretBindingView | undefined {
  return bindings.find((binding) => (
    binding.kind === 'env'
    && binding.variable.startsWith('FORGE_SECRET_')
  )) ?? bindings[0]
}

interface SecureGrantDialogProps {
  secrets: SecureSecretOption[]
  onGrant: (
    grants: SecureGrantInput[],
  ) => boolean | void | Promise<boolean | void>
  onClose: () => void
}

export function SecureGrantDialog({
  secrets,
  onGrant,
  onClose,
}: SecureGrantDialogProps) {
  const availableSecrets = useMemo(
    () => secrets.filter((secret) => secret.available && secret.bindings.length > 0),
    [secrets],
  )
  const [selectedSecretIds, setSelectedSecretIds] = useState<string[]>(
    availableSecrets[0] ? [availableSecrets[0].secretId] : [],
  )
  const [policyKey, setPolicyKey] = useState('task')
  const [submitting, setSubmitting] = useState(false)
  const selectedPolicy = POLICY_OPTIONS.find((candidate) => candidate.value === policyKey)
  const scopeId = useId()

  useEffect(() => {
    const availableIds = new Set(availableSecrets.map((secret) => secret.secretId))
    setSelectedSecretIds((current) => {
      const retained = current.filter((secretId) => availableIds.has(secretId))
      return retained.length === current.length ? current : retained
    })
  }, [availableSecrets])

  const toggleSecret = (secretId: string, selected: boolean) => {
    setSelectedSecretIds((current) => selected
      ? [...current, secretId]
      : current.filter((candidate) => candidate !== secretId))
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const policy = POLICY_OPTIONS.find((candidate) => candidate.value === policyKey)?.policy
    if (!policy || selectedSecretIds.length === 0 || submitting) return

    const grants = selectedSecretIds.flatMap((secretId) => {
      const secret = availableSecrets.find((candidate) => candidate.secretId === secretId)
      const binding = secret ? selectDefaultBinding(secret.bindings) : undefined
      return secret && binding
        ? [{
            secretId: secret.secretId,
            bindings: [binding],
            policy,
          }]
        : []
    })
    if (grants.length !== selectedSecretIds.length) {
      setSelectedSecretIds(grants.map((grant) => grant.secretId))
      return
    }

    setSubmitting(true)
    try {
      const result = await onGrant(grants)
      if (result !== false) onClose()
    } catch {
      // The owner reports the actionable error; keep this reviewed selection open.
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => {
      if (!open && !submitting) onClose()
    }}>
      <DialogContent className="max-w-lg">
        <form className="space-y-5" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Grant secrets</DialogTitle>
            <DialogDescription>
              Choose one or more saved secrets and how long this task may use them.
              Secret values are never added to chat.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Saved secrets</Label>
              <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {availableSecrets.length === 0 ? (
                  <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                    No unleased saved secrets are available yet.
                  </p>
                ) : null}
                {availableSecrets.map((secret) => {
                  const checked = selectedSecretIds.includes(secret.secretId)
                  const selectedBinding = selectDefaultBinding(secret.bindings)
                  return (
                    <div
                      key={secret.secretId}
                      className="rounded-md border border-border/70 p-3"
                    >
                      <label className="flex cursor-pointer items-start gap-2.5">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={submitting}
                          onChange={(event) => toggleSecret(secret.secretId, event.target.checked)}
                          className="mt-0.5 size-4"
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">
                            {secret.displayName ?? secret.displayAlias}
                          </span>
                          {secret.displayName ? (
                            <span className="block truncate text-xs text-muted-foreground">
                              {secret.displayAlias}
                            </span>
                          ) : null}
                        </span>
                      </label>
                      {checked && selectedBinding ? (
                        <p className="mt-2 text-xs text-muted-foreground">
                          Available to commands as {formatSecureBinding(selectedBinding)}
                        </p>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={scopeId}>Scope</Label>
              <select
                id={scopeId}
                value={policyKey}
                disabled={submitting}
                onChange={(event) => setPolicyKey(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {POLICY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {selectedPolicy?.description}
              </p>
            </div>

            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-muted-foreground">
              Each selected secret is available to the whole command process, not only
              to the action you intend. Secure Session output filtering helps with
              accidental echoes, but authorized code can still use or transform the value.
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" disabled={submitting} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={selectedSecretIds.length === 0 || !policyKey || submitting}
            >
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Granting…
                </>
              ) : (
                `Grant ${selectedSecretIds.length === 1
                  ? '1 secret'
                  : `${selectedSecretIds.length} secrets`}`
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
