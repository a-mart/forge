import { useCallback, useRef, useState, type FormEvent } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { resolveCollaborationApiBaseUrl } from '@/lib/collaboration-endpoints'

interface LoginScreenProps {
  onAuthenticated: () => void
}

export function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const emailRef = useRef<HTMLInputElement>(null)

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault()
      setError(null)
      setIsSubmitting(true)

      const baseUrl = resolveCollaborationApiBaseUrl()

      try {
        const signInUrl = new URL('/api/auth/sign-in/email', baseUrl).toString()
        const response = await fetch(signInUrl, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), password }),
        })

        if (!response.ok) {
          let message = 'Invalid email or password'
          try {
            const body = (await response.json()) as { message?: string }
            if (body.message) {
              message = body.message
            }
          } catch {
            // use default message
          }
          throw new Error(message)
        }

        onAuthenticated()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Sign-in failed')
        setIsSubmitting(false)
      }
    },
    [email, password, onAuthenticated],
  )

  return (
    <div className="flex h-dvh w-full items-center justify-center bg-background">
      <Card className="w-full max-w-sm border-border/50">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold tracking-tight">Forge</CardTitle>
          <CardDescription>Sign in to continue</CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={(e) => void handleSubmit(e)} className="grid gap-4" autoComplete="on">
            {error ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <div className="grid gap-2">
              <Label htmlFor="login-email">Email</Label>
              <Input
                ref={emailRef}
                id="login-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isSubmitting}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="login-password">Password</Label>
              <Input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isSubmitting}
              />
            </div>

            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? 'Signing in\u2026' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
