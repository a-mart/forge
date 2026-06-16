/* eslint-disable react-refresh/only-export-components -- TanStack route file exports Route + testable component */
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { CollaborationInviteLookupResult, CollaborationInviteRole } from '@forge/protocol'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export const Route = createFileRoute('/collaboration/invite/$token')({
  component: CollaborationInviteRoute,
})

type InviteState =
  | { status: 'loading' }
  | { status: 'valid'; invite: InviteInfo }
  | { status: 'invalid'; message: string }
  | { status: 'error'; message: string }
  | { status: 'redeemed'; email: string; signedIn: boolean; signInMessage?: string }

interface InviteInfo {
  inviteId: string
  email: string
  role: CollaborationInviteRole
  expiresAt: string
}

interface CollaborationInvitePageProps {
  token: string
  onRedeemed?: (result: { signedIn: boolean }) => void
}

function CollaborationInviteRoute() {
  const { token } = Route.useParams()
  const navigate = useNavigate({ from: '/collaboration/invite/$token' })

  return (
    <CollaborationInvitePage
      token={token}
      onRedeemed={({ signedIn }) => {
        if (signedIn) {
          void navigate({ to: '/', search: { surface: 'collab' }, replace: true })
        }
      }}
    />
  )
}

export function CollaborationInvitePage({ token, onRedeemed }: CollaborationInvitePageProps) {
  const [inviteState, setInviteState] = useState<InviteState>({ status: 'loading' })
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setInviteState({ status: 'loading' })
    setSubmitError(null)

    async function loadInvite() {
      try {
        const response = await fetch(`/api/collaboration/invites/${encodeURIComponent(token)}`, {
          credentials: 'include',
          signal: controller.signal,
        })
        const body = await readJsonBody<CollaborationInviteLookupResult & { error?: string }>(response)

        if (!response.ok) {
          throw new Error(extractErrorMessage(body, 'Unable to load collaboration invite'))
        }

        if (!body.valid || !body.invite?.email) {
          setInviteState({ status: 'invalid', message: inviteLookupErrorMessage(body.error) })
          return
        }

        setInviteState({
          status: 'valid',
          invite: {
            inviteId: body.invite.inviteId,
            email: body.invite.email,
            role: body.invite.role,
            expiresAt: body.invite.expiresAt,
          },
        })
      } catch (error) {
        if (controller.signal.aborted) return
        setInviteState({ status: 'error', message: error instanceof Error ? error.message : 'Unable to load collaboration invite' })
      }
    }

    void loadInvite()
    return () => controller.abort()
  }, [token])

  const validInvite = inviteState.status === 'valid' ? inviteState.invite : null
  const expiresLabel = useMemo(() => {
    if (!validInvite) return null
    return formatInviteExpiry(validInvite.expiresAt)
  }, [validInvite])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!validInvite || isSubmitting) return

    setSubmitError(null)
    setIsSubmitting(true)

    try {
      const redeemResponse = await fetch(`/api/collaboration/invites/${encodeURIComponent(token)}/redeem`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: validInvite.email,
          name: displayName.trim(),
          password,
        }),
      })
      const redeemBody = await readJsonBody<{ ok?: boolean; error?: string }>(redeemResponse)
      if (!redeemResponse.ok || redeemBody.ok === false) {
        throw new Error(extractErrorMessage(redeemBody, 'Unable to redeem collaboration invite'))
      }

      const signInResult = await signInWithPassword(validInvite.email, password)
      setInviteState({
        status: 'redeemed',
        email: validInvite.email,
        signedIn: signInResult.ok,
        ...(signInResult.ok ? {} : { signInMessage: signInResult.message }),
      })
      onRedeemed?.({ signedIn: signInResult.ok })
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Unable to redeem collaboration invite')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Accept collaboration invite</CardTitle>
          <CardDescription>Set up your Forge collaboration account to join this workspace.</CardDescription>
        </CardHeader>

        <CardContent>
          {inviteState.status === 'loading' && (
            <p className="text-sm text-muted-foreground">Loading invite…</p>
          )}

          {inviteState.status === 'invalid' && (
            <InviteMessage tone="destructive" title="Invite unavailable" message={inviteState.message} />
          )}

          {inviteState.status === 'error' && (
            <InviteMessage tone="destructive" title="Could not load invite" message={inviteState.message} />
          )}

          {inviteState.status === 'redeemed' && (
            <div className="flex flex-col gap-3">
              <InviteMessage
                tone={inviteState.signedIn ? 'success' : 'warning'}
                title={inviteState.signedIn ? 'Invite accepted' : 'Account created'}
                message={inviteState.signedIn
                  ? 'You are signed in and can continue to collaboration.'
                  : inviteState.signInMessage ?? 'Your account was created, but automatic sign-in did not complete.'}
              />
              {!inviteState.signedIn && (
                <p className="text-sm text-muted-foreground">
                  Sign in as <span className="font-medium text-foreground">{inviteState.email}</span> from Settings → Collaboration.
                </p>
              )}
            </div>
          )}

          {validInvite && (
            <form id="collaboration-invite-form" className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
              <div className="rounded-md border bg-muted/30 p-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-muted-foreground">Invited email</div>
                    <div className="font-medium">{validInvite.email}</div>
                  </div>
                  <Badge variant="secondary" className="uppercase">{validInvite.role}</Badge>
                </div>
                {expiresLabel && <div className="mt-2 text-xs text-muted-foreground">Expires {expiresLabel}</div>}
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="invite-email">Email</Label>
                <Input id="invite-email" name="email" type="email" value={validInvite.email} disabled readOnly />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="invite-name">Display name</Label>
                <Input
                  id="invite-name"
                  name="name"
                  autoComplete="name"
                  required
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  disabled={isSubmitting}
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="invite-password">Password</Label>
                <Input
                  id="invite-password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={isSubmitting}
                />
              </div>

              {submitError && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {submitError}
                </div>
              )}
            </form>
          )}
        </CardContent>

        <CardFooter className="flex justify-end gap-2">
          {validInvite && (
            <Button type="submit" form="collaboration-invite-form" disabled={isSubmitting || !displayName.trim() || !password}>
              {isSubmitting ? 'Accepting…' : 'Accept invite'}
            </Button>
          )}
          {inviteState.status === 'redeemed' && inviteState.signedIn && (
            <Button type="button" onClick={() => onRedeemed?.({ signedIn: true })}>Continue</Button>
          )}
          {inviteState.status === 'redeemed' && !inviteState.signedIn && (
            <Button type="button" variant="outline" onClick={() => { window.location.href = '/?view=settings&surface=builder&settingsTab=collaboration' }}>
              Open sign-in
            </Button>
          )}
        </CardFooter>
      </Card>
    </main>
  )
}

function InviteMessage({ tone, title, message }: { tone: 'destructive' | 'success' | 'warning'; title: string; message: string }) {
  const toneClass = tone === 'destructive'
    ? 'border-destructive/30 bg-destructive/10 text-destructive'
    : tone === 'success'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
      : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'

  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${toneClass}`}>
      <div className="font-medium">{title}</div>
      <div>{message}</div>
    </div>
  )
}

async function readJsonBody<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T
  } catch {
    return {} as T
  }
}

function extractErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const maybeError = (body as { error?: unknown; message?: unknown }).error ?? (body as { message?: unknown }).message
    if (typeof maybeError === 'string' && maybeError.trim()) {
      return maybeError
    }
  }
  return fallback
}

function inviteLookupErrorMessage(error: unknown): string {
  switch (error) {
    case 'expired':
      return 'This invite has expired. Ask an administrator for a new invite.'
    case 'revoked':
      return 'This invite has been revoked. Ask an administrator for a new invite.'
    case 'consumed':
      return 'This invite has already been used.'
    case 'unsupported':
      return 'This invite cannot be accepted from the web page. Ask an administrator for a new invite.'
    case 'not_found':
    default:
      return 'This invite is invalid or no longer exists.'
  }
}

function formatInviteExpiry(expiresAt: string): string | null {
  const date = new Date(expiresAt)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

async function signInWithPassword(email: string, password: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch('/api/auth/sign-in/email', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (response.ok) return { ok: true }

    const body = await readJsonBody<{ message?: string; error?: string }>(response)
    return { ok: false, message: extractErrorMessage(body, 'Automatic sign-in failed. Use your new password to sign in.') }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Automatic sign-in failed. Use your new password to sign in.' }
  }
}
