import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingsSection, SettingsWithCTA } from './settings-row'
import {
  fetchCollaborationStatus,
  fetchCollaborationMe,
  isAuthError,
} from './collaboration-settings-api'
import { CollaborationPasswordChange } from './collaboration/CollaborationPasswordChange'
import { CollaborationMembers } from './collaboration/CollaborationMembers'
import { CollaborationInvites } from './collaboration/CollaborationInvites'
import { CollaborationAuthError } from './collaboration/CollaborationAuthError'
import {
  getCollabServerUrl,
  setCollabServerUrl,
  resolveCollaborationApiBaseUrl,
} from '@/lib/collaboration-endpoints'
import type { CollaborationSessionInfo, CollaborationStatus } from '@forge/protocol'

interface SettingsCollaborationProps {
  wsUrl: string
}

type ConnectionTestStatus = 'idle' | 'testing' | 'success' | 'error'

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

export function SettingsCollaboration({ wsUrl: _wsUrl }: SettingsCollaborationProps) {
  const [status, setStatus] = useState<CollaborationStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Remote server config state
  const [serverUrl, setServerUrl] = useState(() => getCollabServerUrl() ?? '')
  const [testStatus, setTestStatus] = useState<ConnectionTestStatus>('idle')
  const [testError, setTestError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Auth state (sign-in form for remote server)
  const [session, setSession] = useState<CollaborationSessionInfo | null>(null)
  const [sessionLoading, setSessionLoading] = useState(false)
  const [signInEmail, setSignInEmail] = useState('')
  const [signInPassword, setSignInPassword] = useState('')
  const [signInError, setSignInError] = useState<string | null>(null)
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)

  // Auth error state for management panels (401/403 or unauthenticated response)
  const [authError, setAuthError] = useState(false)

  const currentConfiguredUrl = getCollabServerUrl()
  const hasUnsavedChanges = serverUrl.trim() !== (currentConfiguredUrl ?? '')

  // Fetch session info from the collab server via the shared API helper
  const fetchSession = useCallback(async () => {
    setSessionLoading(true)
    try {
      const data = await fetchCollaborationMe()
      if (!data.authenticated) {
        setSession(null)
        setAuthError(true)
        return
      }
      setSession(data)
      setAuthError(false)
    } catch (err) {
      if (isAuthError(err)) {
        setSession(null)
        setAuthError(true)
        return
      }
      setSession(null)
    } finally {
      setSessionLoading(false)
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchCollaborationStatus()
      setStatus(data)
      if (data.enabled && getCollabServerUrl()) {
        await fetchSession()
      } else {
        setSession(null)
      }
    } catch (err) {
      setStatus(null)
      setSession(null)
      if (err instanceof TypeError && /fetch|network/i.test(err.message)) {
        setError(
          'Could not reach the collaboration server. ' +
          'Check that the server URL is correct and the server is running.',
        )
      } else {
        setError(err instanceof Error ? err.message : 'Could not load collaboration status')
      }
    } finally {
      setLoading(false)
    }
  }, [fetchSession])

  useEffect(() => {
    void refreshStatus()
  }, [currentConfiguredUrl, refreshStatus])

  const handleTestConnection = useCallback(async () => {
    const trimmed = serverUrl.trim()
    if (!trimmed) {
      setTestError('Please enter a server URL')
      setTestStatus('error')
      return
    }
    if (!isValidUrl(trimmed)) {
      setTestError('Invalid URL format. Must start with https:// or http://')
      setTestStatus('error')
      return
    }

    setTestStatus('testing')
    setTestError(null)

    try {
      const baseUrl = trimmed.endsWith('/') ? trimmed : trimmed + '/'
      const endpoint = new URL('/api/collaboration/status', baseUrl).toString()
      // Use default credentials (same-origin) for the test — the status endpoint
      // is public and omitting credentials relaxes CORS requirements so servers
      // with `Access-Control-Allow-Origin: *` are reachable.
      const response = await fetch(endpoint, {
        signal: AbortSignal.timeout(10_000),
      })

      if (!response.ok) {
        throw new Error(`Server responded with ${response.status} ${response.statusText}`)
      }

      const body = (await response.json()) as { enabled?: boolean }
      if (typeof body.enabled !== 'boolean') {
        throw new Error('Invalid response — not a Forge collaboration server')
      }

      setTestStatus('success')
    } catch (err) {
      setTestStatus('error')
      if (err instanceof Error) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
          setTestError('Connection timed out')
        } else if (err instanceof TypeError && /fetch|network/i.test(err.message)) {
          // Browser-level network / CORS failure (e.g. "Failed to fetch",
          // "NetworkError when attempting to fetch resource").
          setTestError(
            'Could not reach the server. Verify the URL is correct and the server is running. ' +
            'If the server is on a different origin, ensure its CORS configuration allows requests from this UI.',
          )
        } else {
          setTestError(err.message)
        }
      } else {
        setTestError('Connection failed')
      }
    }
  }, [serverUrl])

  const handleSave = useCallback(() => {
    const trimmed = serverUrl.trim()
    if (trimmed && !isValidUrl(trimmed)) {
      setTestError('Invalid URL format. Must start with https:// or http://')
      setTestStatus('error')
      return
    }

    setCollabServerUrl(trimmed || null)
    window.dispatchEvent(new Event('forge-collab-server-url-change'))
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    void refreshStatus()
  }, [refreshStatus, serverUrl])

  const handleDisconnect = useCallback(() => {
    setCollabServerUrl(null)
    window.dispatchEvent(new Event('forge-collab-server-url-change'))
    setServerUrl('')
    setTestStatus('idle')
    setTestError(null)
    setSession(null)
    setAuthError(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    void refreshStatus()
  }, [refreshStatus])

  const handleSignIn = useCallback(
    async (event: FormEvent) => {
      event.preventDefault()
      setSignInError(null)
      setIsSigningIn(true)

      const baseUrl = resolveCollaborationApiBaseUrl()

      try {
        const signInUrl = new URL('/api/auth/sign-in/email', baseUrl).toString()
        const response = await fetch(signInUrl, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: signInEmail.trim(), password: signInPassword }),
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

        // Clear form and refresh session state.
        setSignInEmail('')
        setSignInPassword('')
        await fetchSession()
        window.dispatchEvent(new Event('forge-collab-server-url-change'))
      } catch (err) {
        setSignInError(err instanceof Error ? err.message : 'Sign-in failed')
      } finally {
        setIsSigningIn(false)
      }
    },
    [signInEmail, signInPassword, fetchSession],
  )

  const handleSignOut = useCallback(async () => {
    if (isSigningOut) return
    setIsSigningOut(true)

    const baseUrl = resolveCollaborationApiBaseUrl()

    try {
      const signOutUrl = new URL('/api/auth/sign-out', baseUrl).toString()
      await fetch(signOutUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    } catch {
      // Best-effort sign out
    } finally {
      setSession(null)
      setAuthError(false)
      window.dispatchEvent(new Event('forge-collab-server-url-change'))
      setIsSigningOut(false)
    }
  }, [isSigningOut])

  const handleAuthError = useCallback(() => {
    setAuthError(true)
    setSession(null)
  }, [])

  const handlePasswordChanged = useCallback(() => {
    // After password change, refresh session so passwordChangeRequired clears
    void fetchSession()
  }, [fetchSession])

  const isAdmin = session?.authenticated && session.user?.role === 'admin'
  const passwordChangeRequired = session?.authenticated && session.passwordChangeRequired

  return (
    <div className="flex flex-col gap-8">
      {/* Remote server configuration */}
      <SettingsSection
        label="Collaboration Server"
        description="Connect to a remote Forge collaboration server for multi-user access."
      >
        <div className="flex flex-col gap-4 px-2 py-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="collab-server-url">Server URL</Label>
            <div className="flex gap-2">
              <Input
                id="collab-server-url"
                type="url"
                placeholder="https://collab.example.com"
                value={serverUrl}
                onChange={(e) => {
                  setServerUrl(e.target.value)
                  setTestStatus('idle')
                  setTestError(null)
                  setSaved(false)
                }}
                className="flex-1"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleTestConnection()}
                disabled={testStatus === 'testing' || !serverUrl.trim()}
              >
                {testStatus === 'testing' ? 'Testing\u2026' : 'Test'}
              </Button>
            </div>

            {/* Test result feedback */}
            {testStatus === 'success' && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400">
                Connection successful
              </p>
            )}
            {testStatus === 'error' && testError && (
              <p className="text-xs text-destructive">{testError}</p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!hasUnsavedChanges && !saved}
            >
              {saved ? 'Saved' : 'Save'}
            </Button>
            {currentConfiguredUrl && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDisconnect}
              >
                Disconnect
              </Button>
            )}
          </div>

          {/* Current connection status */}
          {currentConfiguredUrl && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
              Connected to <code className="text-[10px]">{currentConfiguredUrl}</code>
            </div>
          )}
          {!currentConfiguredUrl && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/50" />
              No remote server configured
            </div>
          )}
        </div>
      </SettingsSection>

      {/* Existing collab status display */}
      <SettingsSection
        label="Collaboration Status"
        description="Current collaboration mode status on the connected server"
      >
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-3">
            <span className="text-sm text-muted-foreground">Loading collaboration status...</span>
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 px-2 py-3">
            <span className="text-sm text-destructive">{error}</span>
            <button
              type="button"
              onClick={() => {
                setError(null)
                setLoading(true)
                void refreshStatus()
              }}
              className="text-xs text-primary underline hover:no-underline"
            >
              Retry
            </button>
          </div>
        ) : status && !status.enabled ? (
          <SettingsWithCTA
            label="Status"
            description={
              <>
                Collaboration mode is not active on the connected server. Set{' '}
                <code className="text-[10px]">FORGE_COLLABORATION_ENABLED=true</code>{' '}
                and configure the required environment variables to enable multi-user access.
              </>
            }
          >
            <Badge variant="secondary">Disabled</Badge>
          </SettingsWithCTA>
        ) : status ? (
          <>
            <SettingsWithCTA
              label="Status"
              description="Collaboration mode is active with auth-gated access."
            >
              <Badge className="border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                Enabled
              </Badge>
            </SettingsWithCTA>

            <SettingsWithCTA
              label="Admin Account"
              description="Whether an admin account has been bootstrapped for this instance."
            >
              <Badge variant={status.adminExists ? 'secondary' : 'destructive'}>
                {status.adminExists ? 'Configured' : 'Not configured'}
              </Badge>
            </SettingsWithCTA>

            {status.baseUrl && (
              <SettingsWithCTA
                label="Base URL"
                description="The canonical URL used for invite links and external access."
              >
                <code className="text-xs text-muted-foreground">{status.baseUrl}</code>
              </SettingsWithCTA>
            )}

            {/* Current user info (when authenticated) */}
            {session?.authenticated && session.user && (
              <SettingsWithCTA
                label="Signed in as"
                description={session.user.email}
              >
                <Badge
                  variant="secondary"
                  className="px-2 py-0 text-[10px] uppercase"
                >
                  {session.user.role}
                </Badge>
              </SettingsWithCTA>
            )}
          </>
        ) : null}
      </SettingsSection>

      {/* Authentication — only shown when collab is enabled and a remote server is configured */}
      {currentConfiguredUrl && status?.enabled && (
        <SettingsSection
          label="Authentication"
          description="Sign in to the remote collaboration server"
        >
          {sessionLoading ? (
            <div className="flex items-center gap-2 px-2 py-3">
              <span className="text-sm text-muted-foreground">Checking session…</span>
            </div>
          ) : session?.authenticated && session.user ? (
            <div className="flex flex-col gap-4 px-2 py-3">
              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">
                    {session.user.name || session.user.email}
                  </span>
                  {session.user.name && (
                    <span className="text-xs text-muted-foreground">{session.user.email}</span>
                  )}
                  <Badge variant="secondary" className="mt-1 w-fit px-2 py-0 text-[10px] uppercase">
                    {session.user.role}
                  </Badge>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleSignOut()}
                  disabled={isSigningOut}
                  aria-label="Sign out of collaboration server"
                >
                  {isSigningOut ? 'Signing out…' : 'Sign out'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4 px-2 py-3">
              <form onSubmit={(e) => void handleSignIn(e)} className="flex flex-col gap-3" autoComplete="on">
                {signInError && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {signInError}
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  <Label htmlFor="collab-sign-in-email">Email</Label>
                  <Input
                    id="collab-sign-in-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    placeholder="you@example.com"
                    value={signInEmail}
                    onChange={(e) => setSignInEmail(e.target.value)}
                    disabled={isSigningIn}
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="collab-sign-in-password">Password</Label>
                  <Input
                    id="collab-sign-in-password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    placeholder="Password"
                    value={signInPassword}
                    onChange={(e) => setSignInPassword(e.target.value)}
                    disabled={isSigningIn}
                  />
                </div>

                <Button type="submit" size="sm" className="w-fit" disabled={isSigningIn}>
                  {isSigningIn ? 'Signing in…' : 'Sign in'}
                </Button>
              </form>
            </div>
          )}
        </SettingsSection>
      )}

      {/* Auth error banner */}
      {authError && !sessionLoading && <CollaborationAuthError />}

      {/* Password change required — blocks other panels */}
      {passwordChangeRequired && !authError && (
        <CollaborationPasswordChange required onChanged={handlePasswordChanged} />
      )}

      {/* Non-required password change (always available for authenticated users) */}
      {session?.authenticated && !passwordChangeRequired && !authError && (
        <CollaborationPasswordChange onChanged={handlePasswordChanged} />
      )}

      {/* Admin-only panels */}
      {isAdmin && !passwordChangeRequired && !authError && (
        <>
          <CollaborationMembers
            currentUserId={session.user!.userId}
            onAuthError={handleAuthError}
          />
          <CollaborationInvites onAuthError={handleAuthError} />
        </>
      )}
    </div>
  )
}
