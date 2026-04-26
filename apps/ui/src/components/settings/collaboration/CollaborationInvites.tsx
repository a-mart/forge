import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingsSection } from '../settings-row'
import {
  createCollaborationInvite,
  fetchCollaborationInvites,
  revokeCollaborationInvite,
  isAuthError,
} from '../collaboration-settings-api'
import type { CollaborationCreatedInvite, CollaborationInvite } from '@forge/protocol'

interface CollaborationInvitesProps {
  onAuthError?: () => void
}

const STATUS_BADGE_VARIANT: Record<string, 'secondary' | 'destructive' | 'outline'> = {
  pending: 'outline',
  revoked: 'destructive',
  expired: 'secondary',
  consumed: 'secondary',
}

export function CollaborationInvites({ onAuthError }: CollaborationInvitesProps) {
  const [invites, setInvites] = useState<CollaborationInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Create invite form
  const [email, setEmail] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createdInvite, setCreatedInvite] = useState<CollaborationCreatedInvite | null>(null)
  const [copied, setCopied] = useState(false)

  const loadInvites = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchCollaborationInvites()
      setInvites(data)
    } catch (err) {
      if (isAuthError(err)) {
        onAuthError?.()
        return
      }
      setError(err instanceof Error ? err.message : 'Failed to load invites')
    } finally {
      setLoading(false)
    }
  }, [onAuthError])

  useEffect(() => {
    void loadInvites()
  }, [loadInvites])

  const handleCreate = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      setCreateError(null)
      setCreatedInvite(null)

      const trimmed = email.trim()
      if (!trimmed) {
        setCreateError('Email is required')
        return
      }

      setCreating(true)
      try {
        const invite = await createCollaborationInvite(trimmed)
        setCreatedInvite(invite)
        setEmail('')
        // Reload list to show the new pending invite
        void loadInvites()
      } catch (err) {
        if (isAuthError(err)) {
          onAuthError?.()
          return
        }
        setCreateError(err instanceof Error ? err.message : 'Failed to create invite')
      } finally {
        setCreating(false)
      }
    },
    [email, loadInvites, onAuthError],
  )

  const handleRevoke = useCallback(
    async (invite: CollaborationInvite) => {
      try {
        await revokeCollaborationInvite(invite.inviteId)
        setInvites((prev) =>
          prev.map((i) =>
            i.inviteId === invite.inviteId
              ? { ...i, status: 'revoked' as const, revokedAt: new Date().toISOString() }
              : i,
          ),
        )
      } catch (err) {
        if (isAuthError(err)) {
          onAuthError?.()
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to revoke invite')
      }
    },
    [onAuthError],
  )

  const handleCopyLink = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback: select + copy
      const textArea = document.createElement('textarea')
      textArea.value = url
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [])

  return (
    <SettingsSection label="Invites" description="Invite new members to the collaboration workspace.">
      {/* Create invite form */}
      <div className="flex flex-col gap-3 px-2 py-2">
        <form
          onSubmit={(e) => void handleCreate(e)}
          className="flex flex-col gap-3"
          data-testid="create-invite-form"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="invite-email">Email address</Label>
            <div className="flex gap-2">
              <Input
                id="invite-email"
                name="email"
                type="email"
                required
                placeholder="user@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value)
                  setCreateError(null)
                  setCreatedInvite(null)
                }}
                disabled={creating}
                className="flex-1"
              />
              <Button type="submit" size="sm" disabled={creating || !email.trim()}>
                {creating ? 'Creating\u2026' : 'Create invite'}
              </Button>
            </div>
          </div>

          {createError && (
            <div
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              data-testid="create-invite-error"
            >
              {createError}
            </div>
          )}
        </form>

        {/* Freshly created invite link */}
        {createdInvite && (
          <div
            className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-3 flex flex-col gap-2"
            data-testid="created-invite-banner"
          >
            <span className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
              Invite created
            </span>
            {createdInvite.email && (
              <span className="text-xs text-muted-foreground">
                For: {createdInvite.email}
              </span>
            )}
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs break-all rounded bg-muted px-2 py-1">
                {createdInvite.inviteUrl}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleCopyLink(createdInvite.inviteUrl)}
                className="flex-shrink-0"
              >
                {copied ? 'Copied!' : 'Copy link'}
              </Button>
            </div>
            <span className="text-xs text-muted-foreground">
              Expires: {new Date(createdInvite.expiresAt).toLocaleDateString()}
            </span>
          </div>
        )}
      </div>

      {/* Invites list */}
      {loading ? (
        <div className="flex items-center gap-2 px-2 py-3">
          <span className="text-sm text-muted-foreground">Loading invites\u2026</span>
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 px-2 py-3">
          <span className="text-sm text-destructive">{error}</span>
          <button
            type="button"
            onClick={() => void loadInvites()}
            className="text-xs text-primary underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      ) : invites.length > 0 ? (
        <div className="flex flex-col gap-1" data-testid="invites-list">
          {invites.map((invite) => (
            <div
              key={invite.inviteId}
              className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-muted/50"
              data-testid={`invite-row-${invite.inviteId}`}
            >
              <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                <span className="text-sm truncate">
                  {invite.email || <span className="text-muted-foreground italic">No email</span>}
                </span>
                <span className="text-xs text-muted-foreground">
                  Created {new Date(invite.createdAt).toLocaleDateString()}
                  {' \u00b7 '}
                  Expires {new Date(invite.expiresAt).toLocaleDateString()}
                </span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Badge
                  variant={STATUS_BADGE_VARIANT[invite.status] ?? 'secondary'}
                  className="px-2 py-0 text-[10px] uppercase"
                >
                  {invite.status}
                </Badge>
                {invite.status === 'pending' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-destructive hover:text-destructive"
                    onClick={() => void handleRevoke(invite)}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-2 py-3 text-sm text-muted-foreground">No invites yet.</div>
      )}
    </SettingsSection>
  )
}
