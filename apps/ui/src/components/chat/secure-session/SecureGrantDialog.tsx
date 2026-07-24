import { useId, useMemo, useState, type FormEvent } from 'react'
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
import { formatSecureBinding, secureBindingKey } from './format'
import type {
  SecureGrantInput,
  SecureLeasePolicyView,
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
    label: 'Current task',
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

interface SecureGrantDialogProps {
  secrets: SecureSecretOption[]
  onGrant: (grant: SecureGrantInput) => void | Promise<void>
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
  const [secretId, setSecretId] = useState(availableSecrets[0]?.secretId ?? '')
  const selectedSecret = availableSecrets.find((secret) => secret.secretId === secretId)
  const [bindingKey, setBindingKey] = useState(
    selectedSecret?.bindings[0] ? secureBindingKey(selectedSecret.bindings[0]) : '',
  )
  const [policyKey, setPolicyKey] = useState('one_use')
  const selectedPolicy = POLICY_OPTIONS.find((candidate) => candidate.value === policyKey)
  const aliasId = useId()
  const bindingId = useId()
  const scopeId = useId()

  const handleSecretChange = (nextSecretId: string) => {
    const nextSecret = availableSecrets.find((secret) => secret.secretId === nextSecretId)
    setSecretId(nextSecretId)
    setBindingKey(
      nextSecret?.bindings[0] ? secureBindingKey(nextSecret.bindings[0]) : '',
    )
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const binding = selectedSecret?.bindings.find(
      (candidate) => secureBindingKey(candidate) === bindingKey,
    )
    const policy = POLICY_OPTIONS.find((candidate) => candidate.value === policyKey)?.policy
    if (!selectedSecret || !binding || !policy) return

    void onGrant({
      secretId: selectedSecret.secretId,
      bindings: [binding],
      policy,
    })
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => {
      if (!open) onClose()
    }}>
      <DialogContent className="max-w-md">
        <form className="space-y-5" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Grant a secret</DialogTitle>
            <DialogDescription>
              Choose the alias, binding, and lease scope. Secret values are never added to chat.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor={aliasId}>Secret alias</Label>
              <select
                id={aliasId}
                value={secretId}
                onChange={(event) => handleSecretChange(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {availableSecrets.map((secret) => (
                  <option key={secret.secretId} value={secret.secretId}>
                    {secret.displayName
                      ? `${secret.displayName} (${secret.displayAlias})`
                      : secret.displayAlias}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={bindingId}>Binding</Label>
              <select
                id={bindingId}
                value={bindingKey}
                onChange={(event) => setBindingKey(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {selectedSecret?.bindings.map((binding) => {
                  const key = secureBindingKey(binding)
                  return (
                    <option key={key} value={key}>
                      {formatSecureBinding(binding)}
                    </option>
                  )
                })}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={scopeId}>Scope</Label>
              <select
                id={scopeId}
                value={policyKey}
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
              The selected binding is available to the whole command process, not only
              to the action you intend. Secure Session output filtering helps with
              accidental echoes, but authorized code can still use or transform the value.
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!selectedSecret || !bindingKey || !policyKey}
            >
              Grant access
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
