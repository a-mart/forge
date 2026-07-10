import { useCallback, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface CollaborationInlineLoginDialogProps {
  apiBaseUrl: string
  onAuthenticated: () => Promise<void> | void
}

export function CollaborationInlineLoginDialog({
  apiBaseUrl,
  onAuthenticated,
}: CollaborationInlineLoginDialogProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setSubmitting(true)

    try {
      const signInResponse = await fetch(new URL('/api/auth/sign-in/email', apiBaseUrl).toString(), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // Better Auth defaults this to true, but send it explicitly so this
        // direct-browser flow always receives the 21-day persistent cookie.
        body: JSON.stringify({ email: email.trim(), password, rememberMe: true }),
      })

      if (!signInResponse.ok) {
        const body = await signInResponse.json().catch(() => null) as { message?: string } | null
        throw new Error(body?.message || 'Invalid email or password')
      }

      const sessionResponse = await fetch(new URL('/api/collaboration/me', apiBaseUrl).toString(), {
        credentials: 'include',
      })
      const session = await sessionResponse.json().catch(() => null) as { authenticated?: boolean } | null
      if (!sessionResponse.ok || session?.authenticated !== true) {
        throw new Error('Sign-in succeeded, but the collaboration session could not be verified.')
      }

      await onAuthenticated()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to sign in. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }, [apiBaseUrl, email, onAuthenticated, password])

  return (
    <Dialog open>
      <DialogContent
        data-testid="collaboration-inline-login"
        className="sm:max-w-md"
        hideClose
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Sign in to collaboration</DialogTitle>
          <DialogDescription>
            Sign in to continue to the Builder page you requested.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          <div className="space-y-2">
            <Label htmlFor="inline-collaboration-email">Email</Label>
            <Input
              id="inline-collaboration-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoFocus
              disabled={submitting}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="inline-collaboration-password">Password</Label>
            <Input
              id="inline-collaboration-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              disabled={submitting}
            />
          </div>
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
