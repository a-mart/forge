import { useEffect, useMemo, useState } from 'react'
import { Link2, Loader2, Plus, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { SettingsApiClient } from '../settings-api-client'
import {
  SecureSecretsError,
  updateSecureSecret,
  type SecureSecretBinding,
  type SecureSecretDeliveryKind,
  type SecureSecretSummary,
} from '@/lib/secure-secrets-api'
import {
  EmptyState,
} from './secret-ui'
import {
  CONFIGURABLE_DELIVERY_KINDS,
  DELIVERY_LABELS,
} from './secret-ui-values'
import { isValidBindingTarget } from './binding-target'

interface SecretBindingsPanelProps {
  apiClient: SettingsApiClient
  secrets: SecureSecretSummary[]
  onChanged: (message: string) => Promise<void>
  onError: (error: unknown) => void
}

export function SecretBindingsPanel({
  apiClient,
  secrets,
  onChanged,
  onError,
}: SecretBindingsPanelProps) {
  const [secretId, setSecretId] = useState('')
  const [deliveryKind, setDeliveryKind] = useState<SecureSecretDeliveryKind>('environment')
  const [targetName, setTargetName] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)

  useEffect(() => {
    if (!secrets.some((secret) => secret.secretId === secretId)) {
      setSecretId(secrets[0]?.secretId ?? '')
    }
  }, [secretId, secrets])

  const selectedSecret = useMemo(
    () => secrets.find((secret) => secret.secretId === secretId) ?? null,
    [secretId, secrets],
  )

  const addBinding = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedTarget = targetName.trim()
    if (
      !selectedSecret
      || !isValidBindingTarget(deliveryKind, normalizedTarget)
    ) {
      onError(new SecureSecretsError('SECURE_REQUEST_INVALID'))
      return
    }

    const binding = createBinding(deliveryKind, normalizedTarget)
    if (selectedSecret.bindings.some((existing) => sameBinding(existing, binding))) {
      onError(new SecureSecretsError('SECURE_REQUEST_INVALID'))
      return
    }

    setBusyKey('add')
    try {
      await updateSecureSecret(apiClient, selectedSecret.secretId, {
        bindings: [...selectedSecret.bindings, binding],
      })
      setTargetName('')
      await onChanged('Binding saved. It remains inactive until a task grant uses it.')
    } catch (error) {
      onError(error)
    } finally {
      setBusyKey(null)
    }
  }

  const removeBinding = async (secret: SecureSecretSummary, index: number) => {
    setBusyKey(`delete:${secret.secretId}:${index}`)
    try {
      await updateSecureSecret(apiClient, secret.secretId, {
        bindings: secret.bindings.filter((_binding, bindingIndex) => bindingIndex !== index),
      })
      await onChanged('Saved binding removed.')
    } catch (error) {
      onError(error)
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-base font-semibold">Advanced delivery bindings</h3>
          <p className="text-sm text-muted-foreground">
            Every saved secret already has a generated environment delivery. Add or replace
            bindings here only when a tool needs a specific askpass, file, stdin, or environment
            shape. Bindings never grant task access by themselves.
          </p>
        </div>

        {secrets.length === 0 ? (
          <EmptyState
            title="No secrets to bind"
            description="Save or connect a secret source before creating a delivery binding."
          />
        ) : (
          <div className="space-y-2">
            {secrets.map((secret) => (
              <div
                key={secret.secretId}
                className="rounded-md border border-border/70 bg-card/40 p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Link2 className="size-4 text-muted-foreground" />
                  <p className="font-mono text-sm font-medium">{secret.displayAlias}</p>
                  <Badge variant="outline" className="text-muted-foreground">
                    {secret.bindings.length} saved
                  </Badge>
                </div>
                {secret.bindings.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">No delivery bindings.</p>
                ) : (
                  <div className="mt-3 space-y-2">
                    {secret.bindings.map((binding, index) => (
                      <div
                        key={`${binding.deliveryKind}:${bindingTarget(binding) ?? ''}:${index}`}
                        className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/50 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium">
                            {DELIVERY_LABELS[binding.deliveryKind]}
                          </p>
                          <p className="truncate font-mono text-xs text-muted-foreground">
                            {bindingTarget(binding) ?? 'No target name'}
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="self-start gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive sm:self-auto"
                          disabled={busyKey !== null}
                          onClick={() => void removeBinding(secret, index)}
                        >
                          {busyKey === `delete:${secret.secretId}:${index}`
                            ? <Loader2 className="size-3.5 animate-spin" />
                            : <Trash2 className="size-3.5" />}
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {secrets.length > 0 ? (
        <section className="space-y-3 border-t border-border/70 pt-5">
          <div>
            <h3 className="text-base font-semibold">Add binding</h3>
            <p className="text-sm text-muted-foreground">
              Choose only the delivery shape. Task, worker, duration, and use count are chosen later
              when you grant access.
            </p>
          </div>

          <form className="space-y-4 rounded-md border border-border/70 p-4" onSubmit={addBinding}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="binding-secret">Saved secret</Label>
                <Select value={secretId} onValueChange={setSecretId} disabled={busyKey !== null}>
                  <SelectTrigger id="binding-secret" className="w-full">
                    <SelectValue placeholder="Choose a secret" />
                  </SelectTrigger>
                  <SelectContent>
                    {secrets.map((secret) => (
                      <SelectItem key={secret.secretId} value={secret.secretId}>
                        {secret.displayAlias}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="binding-kind">Delivery</Label>
                <Select
                  value={deliveryKind}
                  onValueChange={(value) => setDeliveryKind(value as SecureSecretDeliveryKind)}
                  disabled={busyKey !== null}
                >
                  <SelectTrigger id="binding-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONFIGURABLE_DELIVERY_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {DELIVERY_LABELS[kind]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="binding-target">
                {targetLabel(deliveryKind)}
                {requiresTarget(deliveryKind) ? '' : ' (optional)'}
              </Label>
              <Input
                id="binding-target"
                value={targetName}
                onChange={(event) => setTargetName(event.target.value)}
                placeholder={targetPlaceholder(deliveryKind)}
                disabled={busyKey !== null}
                className="font-mono"
              />
            </div>

            <Button
              type="submit"
              size="sm"
              className="gap-1.5"
              disabled={
                busyKey !== null
                || !selectedSecret
                || !isValidBindingTarget(deliveryKind, targetName.trim())
              }
            >
              {busyKey === 'add'
                ? <Loader2 className="size-3.5 animate-spin" />
                : <Plus className="size-3.5" />}
              Save binding
            </Button>
          </form>
        </section>
      ) : null}
    </div>
  )
}

function sameBinding(left: SecureSecretBinding, right: SecureSecretBinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function requiresTarget(kind: SecureSecretDeliveryKind): boolean {
  return kind === 'environment'
    || kind === 'file'
    || kind === 'askpass'
}

function targetLabel(kind: SecureSecretDeliveryKind): string {
  switch (kind) {
    case 'environment':
      return 'Environment variable name'
    case 'file':
      return 'File path'
    case 'askpass':
      return 'Askpass variable name'
    default:
      return 'Target name'
  }
}

function targetPlaceholder(kind: SecureSecretDeliveryKind): string {
  switch (kind) {
    case 'environment':
      return 'GITHUB_TOKEN'
    case 'file':
      return '/run/forge-secure/bindings/github-token'
    case 'askpass':
      return 'SSH_ASKPASS'
    default:
      return ''
  }
}

function createBinding(
  deliveryKind: SecureSecretDeliveryKind,
  target: string,
): SecureSecretBinding {
  switch (deliveryKind) {
    case 'environment':
      return { deliveryKind, targetName: target }
    case 'file':
      return { deliveryKind, targetPath: target }
    case 'askpass':
      return { deliveryKind, targetName: target }
    case 'stdin':
    case 'ssh_agent':
      return { deliveryKind }
  }
}

function bindingTarget(binding: SecureSecretBinding): string | null {
  if (binding.deliveryKind === 'file') return binding.targetPath
  if (binding.deliveryKind === 'environment' || binding.deliveryKind === 'askpass') {
    return binding.targetName
  }
  return null
}
