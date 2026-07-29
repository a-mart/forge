import { useMemo, useState, type FormEvent } from 'react'
import { Loader2, Pencil, Server, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { SettingsApiClient } from '../settings-api-client'
import {
  createSecureSshTrustedHost,
  deleteSecureSshTrustedHost,
  updateSecureSshTrustedHost,
  type SecureSshTrustedHostSummary,
} from '@/lib/secure-secrets-api'
import type { ManagerProfile } from '@forge/protocol'

interface SshTrustedHostsPanelProps {
  apiClient: SettingsApiClient
  trustedHosts: SecureSshTrustedHostSummary[]
  profiles: ManagerProfile[]
  initialProfileId?: string
  onChanged: (message: string) => void | Promise<void>
  onError: (error: unknown) => void
}

interface HostDraft {
  profileId: string
  alias: string
  hostName: string
  port: string
  username: string
  hostKey: string
}

function emptyDraft(profileId = ''): HostDraft {
  return {
    profileId,
    alias: '',
    hostName: '',
    port: '22',
    username: '',
    hostKey: '',
  }
}

export function SshTrustedHostsPanel({
  apiClient,
  trustedHosts,
  profiles,
  initialProfileId,
  onChanged,
  onError,
}: SshTrustedHostsPanelProps) {
  const defaultProfileId = profiles.some((profile) => profile.profileId === initialProfileId)
    ? initialProfileId!
    : profiles[0]?.profileId ?? ''
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<HostDraft>(() => emptyDraft(defaultProfileId))
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const profileNames = useMemo(
    () => new Map(profiles.map((profile) => [profile.profileId, profile.displayName])),
    [profiles],
  )

  const reset = () => {
    setEditingId(null)
    setDraft(emptyDraft(defaultProfileId))
    setValidationError(null)
  }

  const beginEdit = (host: SecureSshTrustedHostSummary) => {
    setEditingId(host.trustedHostId)
    setValidationError(null)
    setDraft({
      profileId: host.profileId,
      alias: host.alias,
      hostName: host.hostName,
      port: String(host.port),
      username: host.username,
      hostKey: '',
    })
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving) return
    setValidationError(null)
    const port = Number(draft.port)
    if (
      !draft.profileId
      || !draft.alias.trim()
      || !draft.hostName.trim()
      || !draft.username.trim()
      || !Number.isInteger(port)
      || port < 1
      || port > 65_535
      || (!editingId && !draft.hostKey.trim())
    ) {
      setValidationError(
        'Enter a project, alias, host, username, valid port, and public host key.',
      )
      return
    }
    if (
      editingId
      && draft.hostKey.trim()
      && !window.confirm(
        'Replace the trusted host key? Existing SSH connections using this alias will trust the new key.',
      )
    ) return

    setSaving(true)
    try {
      if (editingId) {
        await updateSecureSshTrustedHost(apiClient, editingId, {
          alias: draft.alias.trim(),
          hostName: draft.hostName.trim(),
          port,
          username: draft.username.trim(),
          ...(draft.hostKey.trim() ? { hostKey: draft.hostKey.trim() } : {}),
        })
        reset()
        await onChanged('SSH host updated.')
      } else {
        await createSecureSshTrustedHost(apiClient, {
          profileId: draft.profileId,
          alias: draft.alias.trim(),
          hostName: draft.hostName.trim(),
          port,
          username: draft.username.trim(),
          hostKey: draft.hostKey.trim(),
        })
        reset()
        await onChanged('SSH host trusted for this project.')
      }
    } catch (error) {
      onError(error)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (host: SecureSshTrustedHostSummary) => {
    if (deletingId) return
    setDeletingId(host.trustedHostId)
    try {
      await deleteSecureSshTrustedHost(apiClient, host.trustedHostId)
      if (editingId === host.trustedHostId) reset()
      await onChanged('SSH host removed.')
    } catch (error) {
      onError(error)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-base font-semibold">Trusted SSH hosts</h3>
          <p className="text-sm text-muted-foreground">
            Agents can use each alias with ordinary SSH commands. Forge applies the project&apos;s
            address, username, and strict host-key verification automatically.
          </p>
        </div>

        {trustedHosts.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            No SSH hosts are trusted yet.
          </div>
        ) : (
          <div className="space-y-2">
            {trustedHosts.map((host) => (
              <div
                key={host.trustedHostId}
                className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Server className="size-4 text-muted-foreground" aria-hidden="true" />
                    <span className="font-mono text-sm font-semibold">{host.alias}</span>
                    <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                      {profileNames.get(host.profileId) ?? host.profileId}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {host.username}@{host.hostName}:{host.port}
                  </p>
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    {host.hostKeyAlgorithm} {host.hostKeyFingerprint}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => beginEdit(host)}>
                    <Pencil className="size-3.5" aria-hidden="true" />
                    Edit
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={deletingId === host.trustedHostId}
                    onClick={() => void remove(host)}
                  >
                    {deletingId === host.trustedHostId
                      ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      : <Trash2 className="size-3.5" aria-hidden="true" />}
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3 border-t border-border pt-5">
        <div>
          <h3 className="text-base font-semibold">
            {editingId ? 'Edit SSH host' : 'Trust an SSH host'}
          </h3>
          <p className="text-sm text-muted-foreground">
            Paste the public host key from a trusted source. The private login credential remains
            a separate saved secret.
          </p>
        </div>

        <form className="space-y-4 rounded-lg border border-border bg-card p-4" onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm font-medium">
              Project
              <select
                aria-label="SSH host project"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-normal disabled:opacity-60"
                value={draft.profileId}
                disabled={Boolean(editingId)}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  profileId: event.target.value,
                }))}
              >
                {profiles.map((profile) => (
                  <option key={profile.profileId} value={profile.profileId}>
                    {profile.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1.5 text-sm font-medium">
              Alias
              <Input
                value={draft.alias}
                placeholder="production-api"
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  alias: event.target.value,
                }))}
              />
            </label>
            <label className="space-y-1.5 text-sm font-medium">
              Host or address
              <Input
                value={draft.hostName}
                placeholder="10.0.0.25"
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  hostName: event.target.value,
                }))}
              />
            </label>
            <div className="grid grid-cols-[1fr_7rem] gap-3">
              <label className="space-y-1.5 text-sm font-medium">
                Username
                <Input
                  value={draft.username}
                  placeholder="deploy"
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    username: event.target.value,
                  }))}
                />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Port
                <Input
                  type="number"
                  min={1}
                  max={65_535}
                  value={draft.port}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    port: event.target.value,
                  }))}
                />
              </label>
            </div>
          </div>

          <label className="block space-y-1.5 text-sm font-medium">
            Trusted public host key{editingId ? ' (leave blank to keep current)' : ''}
            <Textarea
              rows={3}
              value={draft.hostKey}
              placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA…"
              className="font-mono text-xs"
              onChange={(event) => setDraft((current) => ({
                ...current,
                hostKey: event.target.value,
              }))}
            />
          </label>

          {validationError ? (
            <p role="alert" className="text-sm text-destructive">
              {validationError}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={saving || profiles.length === 0}>
              {saving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              {editingId ? 'Save changes' : 'Trust host'}
            </Button>
            {editingId ? (
              <Button type="button" size="sm" variant="ghost" onClick={reset}>
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      </section>
    </div>
  )
}
