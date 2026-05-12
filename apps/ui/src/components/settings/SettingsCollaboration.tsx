import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
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
  getCollaborationConnectionOptions,
  getDefaultCollaborationConnection,
  upsertCollaborationConnection,
  removeCollaborationConnection,
  renameCollaborationConnection,
  subscribeToRegistryChanges,
  type CollaborationEndpointTarget,
} from '@/lib/collaboration-connections'
import type { CollaborationSessionInfo, CollaborationStatus } from '@forge/protocol'

// ---------------------------------------------------------------------------
// Props & types
// ---------------------------------------------------------------------------

interface SettingsCollaborationProps {
  wsUrl: string
  /**
   * When provided, pre-selects the connection matching this API base URL on
   * mount and uses it as the target for all operations.  Passed from the
   * SettingsPanel when the Collaboration tab is opened from a specific
   * collab backend context (e.g. CollabSurface settings view).
   */
  initialApiBaseUrl?: string
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

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SettingsCollaboration({ wsUrl: _wsUrl, initialApiBaseUrl }: SettingsCollaborationProps) {
  // ── Connection registry state ──
  const [connections, setConnections] = useState<CollaborationEndpointTarget[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // ── Add-connection form ──
  const [isAdding, setIsAdding] = useState(false)
  const [addUrl, setAddUrl] = useState('')
  const [addTestStatus, setAddTestStatus] = useState<ConnectionTestStatus>('idle')
  const [addTestError, setAddTestError] = useState<string | null>(null)

  // ── Rename-connection inline edit ──
  const [editingNameId, setEditingNameId] = useState<string | null>(null)
  const [editingNameValue, setEditingNameValue] = useState('')

  // ── Selected-connection detail state ──
  const [status, setStatus] = useState<CollaborationStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState<CollaborationSessionInfo | null>(null)
  const [sessionLoading, setSessionLoading] = useState(false)
  const [signInEmail, setSignInEmail] = useState('')
  const [signInPassword, setSignInPassword] = useState('')
  const [signInError, setSignInError] = useState<string | null>(null)
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [authError, setAuthError] = useState(false)

  // ── Derived ──
  const selectedTarget = connections.find((c) => c.connectionId === selectedId) ?? null
  const apiBaseUrl = selectedTarget?.apiBaseUrl

  // ── Registry load + subscribe ──

  const refreshConnections = useCallback(() => {
    const targets = getCollaborationConnectionOptions()
    setConnections(targets)
    return targets
  }, [])

  // Track selectedId stability across registry refreshes
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId

  useEffect(() => {
    const targets = refreshConnections()
    if (targets.length === 0) return

    // When opened from a specific collab backend context, pre-select
    // the connection matching that backend's apiBaseUrl.
    if (initialApiBaseUrl) {
      const match = targets.find((t) => t.apiBaseUrl === initialApiBaseUrl)
      if (match) {
        setSelectedId(match.connectionId)
        return
      }
    }

    // Fallback: auto-select default
    const defaultTarget = getDefaultCollaborationConnection()
    setSelectedId(defaultTarget.connectionId)
  }, [refreshConnections, initialApiBaseUrl])

  useEffect(() => {
    return subscribeToRegistryChanges(() => {
      const targets = refreshConnections()
      // If selected connection was removed, fall back to default
      const currentId = selectedIdRef.current
      if (currentId && !targets.find((t) => t.connectionId === currentId)) {
        const defaultTarget = getDefaultCollaborationConnection()
        setSelectedId(defaultTarget.connectionId)
      }
    })
  }, [refreshConnections])

  // ── Abort controller for stale-request protection ──
  // Aborted whenever selectedId/apiBaseUrl changes so responses for a
  // previously selected backend never overwrite the new backend's state.
  const fetchControllerRef = useRef<AbortController | null>(null)

  /** Abort any in-flight status/session requests from a prior selection. */
  const abortStaleFetches = useCallback(() => {
    fetchControllerRef.current?.abort()
    fetchControllerRef.current = null
  }, [])

  // ── Status + session fetch for selected connection ──

  const fetchSession = useCallback(async (baseUrl: string, signal?: AbortSignal) => {
    setSessionLoading(true)
    try {
      const data = await fetchCollaborationMe(baseUrl)
      if (signal?.aborted) return
      if (!data.authenticated) {
        setSession(null)
        return
      }
      setSession(data)
      setAuthError(false)
    } catch (err) {
      if (signal?.aborted) return
      if (isAuthError(err)) {
        setSession(null)
        setAuthError(true)
        return
      }
      setSession(null)
    } finally {
      if (!signal?.aborted) {
        setSessionLoading(false)
      }
    }
  }, [])

  const refreshStatus = useCallback(async (signal?: AbortSignal) => {
    if (!apiBaseUrl) return
    setLoading(true)
    setError(null)
    try {
      const data = await fetchCollaborationStatus(apiBaseUrl)
      if (signal?.aborted) return
      setStatus(data)
      if (data.enabled) {
        await fetchSession(apiBaseUrl, signal)
      } else {
        setSession(null)
      }
    } catch (err) {
      if (signal?.aborted) return
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
      if (!signal?.aborted) {
        setLoading(false)
      }
    }
  }, [apiBaseUrl, fetchSession])

  // Reset detail state and refresh when selection changes
  useEffect(() => {
    abortStaleFetches()
    setStatus(null)
    setSession(null)
    setError(null)
    setAuthError(false)
    setSignInEmail('')
    setSignInPassword('')
    setSignInError(null)
    if (selectedId) {
      const controller = new AbortController()
      fetchControllerRef.current = controller
      void refreshStatus(controller.signal)
    }
    return () => abortStaleFetches()
  }, [selectedId, refreshStatus, abortStaleFetches])

  // ── Add connection handlers ──

  const handleTestAddConnection = useCallback(async () => {
    const trimmed = addUrl.trim()
    if (!trimmed) {
      setAddTestError('Please enter a server URL')
      setAddTestStatus('error')
      return
    }
    if (!isValidUrl(trimmed)) {
      setAddTestError('Invalid URL format. Must start with https:// or http://')
      setAddTestStatus('error')
      return
    }

    setAddTestStatus('testing')
    setAddTestError(null)

    try {
      const baseUrl = trimmed.endsWith('/') ? trimmed : trimmed + '/'
      const endpoint = new URL('/api/collaboration/status', baseUrl).toString()
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

      setAddTestStatus('success')
    } catch (err) {
      setAddTestStatus('error')
      if (err instanceof Error) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
          setAddTestError('Connection timed out')
        } else if (err instanceof TypeError && /fetch|network/i.test(err.message)) {
          setAddTestError(
            'Could not reach the server. Verify the URL is correct and the server is running. ' +
            'If the server is on a different origin, ensure its CORS configuration allows requests from this UI.',
          )
        } else {
          setAddTestError(err.message)
        }
      } else {
        setAddTestError('Connection failed')
      }
    }
  }, [addUrl])

  const handleSaveNewConnection = useCallback(() => {
    const trimmed = addUrl.trim()
    if (!trimmed || !isValidUrl(trimmed)) {
      setAddTestError('Invalid URL format. Must start with https:// or http://')
      setAddTestStatus('error')
      return
    }

    try {
      const id = upsertCollaborationConnection({ serverUrl: trimmed })
      refreshConnections()
      setSelectedId(id)
      setIsAdding(false)
      setAddUrl('')
      setAddTestStatus('idle')
      setAddTestError(null)
    } catch (err) {
      setAddTestError(err instanceof Error ? err.message : 'Failed to save connection')
      setAddTestStatus('error')
    }
  }, [addUrl, refreshConnections])

  const handleCancelAdd = useCallback(() => {
    setIsAdding(false)
    setAddUrl('')
    setAddTestStatus('idle')
    setAddTestError(null)
  }, [])

  // ── Remove connection ──

  const handleRemoveConnection = useCallback(
    (connId: string) => {
      removeCollaborationConnection(connId)
      const targets = refreshConnections()
      if (connId === selectedId) {
        if (targets.length > 0) {
          const defaultTarget = getDefaultCollaborationConnection()
          setSelectedId(defaultTarget.connectionId)
        } else {
          setSelectedId(null)
        }
      }
    },
    [selectedId, refreshConnections],
  )

  // ── Rename connection ──

  const startRenamingConnection = useCallback(
    (connId: string) => {
      const conn = connections.find((c) => c.connectionId === connId)
      if (!conn) return
      setEditingNameId(connId)
      setEditingNameValue(conn.label)
    },
    [connections],
  )

  const commitRenameConnection = useCallback(() => {
    if (!editingNameId) return
    const trimmed = editingNameValue.trim()
    if (trimmed) {
      renameCollaborationConnection(editingNameId, trimmed)
    }
    setEditingNameId(null)
    setEditingNameValue('')
  }, [editingNameId, editingNameValue])

  const cancelRenameConnection = useCallback(() => {
    setEditingNameId(null)
    setEditingNameValue('')
  }, [])

  // ── Sign in / sign out scoped to selected connection ──

  const handleSignIn = useCallback(
    async (event: FormEvent) => {
      event.preventDefault()
      if (!apiBaseUrl) return
      // Capture the target URL and abort controller at call time so late
      // resolution after an await always checks the *original* selection's
      // controller — not whichever controller is current after a backend
      // switch.  If the user switches backends mid-flight the captured
      // controller will have been aborted by the selection-change effect.
      const targetBaseUrl = apiBaseUrl
      const controller = fetchControllerRef.current
      setSignInError(null)
      setIsSigningIn(true)

      try {
        const signInUrl = new URL('/api/auth/sign-in/email', targetBaseUrl).toString()
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

        // Guard: if selection changed while request was in-flight, drop result
        if (controller?.signal.aborted) return

        setSignInEmail('')
        setSignInPassword('')
        await fetchSession(targetBaseUrl, controller?.signal)
        // Notify other listeners of a potential auth state change
        window.dispatchEvent(new Event('forge-collab-connections-change'))
      } catch (err) {
        if (controller?.signal.aborted) return
        setSignInError(err instanceof Error ? err.message : 'Sign-in failed')
      } finally {
        if (!controller?.signal.aborted) {
          setIsSigningIn(false)
        }
      }
    },
    [apiBaseUrl, signInEmail, signInPassword, fetchSession],
  )

  const handleSignOut = useCallback(async () => {
    if (!apiBaseUrl || isSigningOut) return
    // Capture the controller at call time so late resolution after the
    // fetch checks the *original* selection — not a new one after switch.
    const controller = fetchControllerRef.current
    setIsSigningOut(true)

    try {
      const signOutUrl = new URL('/api/auth/sign-out', apiBaseUrl).toString()
      await fetch(signOutUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    } catch {
      // Best-effort sign out
    } finally {
      // Only commit state changes if the selection hasn't changed
      if (!controller?.signal.aborted) {
        setSession(null)
        setAuthError(false)
        window.dispatchEvent(new Event('forge-collab-connections-change'))
        setIsSigningOut(false)
      }
    }
  }, [apiBaseUrl, isSigningOut])

  const handleAuthError = useCallback(() => {
    setAuthError(true)
    setSession(null)
  }, [])

  const handlePasswordChanged = useCallback(() => {
    if (apiBaseUrl) {
      void fetchSession(apiBaseUrl, fetchControllerRef.current?.signal)
    }
  }, [apiBaseUrl, fetchSession])

  // ── Derived display state ──
  const isAdmin = session?.authenticated && session.user?.role === 'admin'
  const passwordChangeRequired = session?.authenticated && session.passwordChangeRequired

  // ── Render ──

  return (
    <div className="flex flex-col gap-8">
      {/* ── Connection List ── */}
      <SettingsSection
        label="Connections"
        description="Manage collaboration server connections."
        cta={
          !isAdding ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsAdding(true)}
              data-testid="add-connection-btn"
            >
              Add connection
            </Button>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-1" data-testid="connection-list">
          {connections.map((conn) => {
            const isSelected = conn.connectionId === selectedId
            const isEditing = editingNameId === conn.connectionId
            return (
              <button
                key={conn.connectionId}
                type="button"
                className={`flex items-center justify-between gap-3 rounded-md px-3 py-2 text-left transition-colors ${
                  isSelected
                    ? 'bg-muted ring-1 ring-border'
                    : 'hover:bg-muted/50'
                }`}
                onClick={() => {
                  if (!isEditing) setSelectedId(conn.connectionId)
                }}
                data-testid={`connection-item-${conn.connectionId}`}
                aria-pressed={isSelected}
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span
                    className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${
                      isSelected ? 'bg-emerald-500' : 'bg-muted-foreground/40'
                    }`}
                  />
                  {isEditing ? (
                    <input
                      type="text"
                      value={editingNameValue}
                      onChange={(e) => setEditingNameValue(e.target.value)}
                      onBlur={commitRenameConnection}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          commitRenameConnection()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          cancelRenameConnection()
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="text-sm font-medium bg-transparent border-b border-primary outline-none min-w-0 flex-1 py-0"
                      autoFocus
                      aria-label={`Connection name for ${conn.label}`}
                      data-testid={`rename-connection-input-${conn.connectionId}`}
                    />
                  ) : (
                    <>
                      <span className="text-sm font-medium truncate">{conn.label}</span>
                      {conn.serverUrl && (
                        <span className="text-[10px] text-muted-foreground truncate hidden sm:inline">
                          {conn.serverUrl}
                        </span>
                      )}
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Badge
                    variant="secondary"
                    className="px-2 py-0 text-[10px] uppercase"
                  >
                    {conn.kind === 'same-origin' ? 'Local' : 'Remote'}
                  </Badge>
                  {!isEditing && !conn.virtual && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            role="button"
                            tabIndex={0}
                            className="inline-flex items-center justify-center h-5 w-5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                            onClick={(e) => {
                              e.stopPropagation()
                              startRenamingConnection(conn.connectionId)
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.stopPropagation()
                                e.preventDefault()
                                startRenamingConnection(conn.connectionId)
                              }
                            }}
                            data-testid={`rename-connection-${conn.connectionId}`}
                            aria-label={`Rename ${conn.label}`}
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                              <path d="m15 5 4 4" />
                            </svg>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="left">Rename connection</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                  {conn.kind === 'remote' && !isEditing && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            role="button"
                            tabIndex={0}
                            className="inline-flex items-center justify-center h-5 w-5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleRemoveConnection(conn.connectionId)
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.stopPropagation()
                                e.preventDefault()
                                handleRemoveConnection(conn.connectionId)
                              }
                            }}
                            data-testid={`remove-connection-${conn.connectionId}`}
                            aria-label={`Remove ${conn.label}`}
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="left">Remove connection</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              </button>
            )
          })}

          {connections.length === 0 && !isAdding && (
            <div className="px-2 py-3 text-sm text-muted-foreground">
              No connections configured. Add a remote collaboration server to get started.
            </div>
          )}
        </div>

        {/* ── Add Connection Form ── */}
        {isAdding && (
          <div className="flex flex-col gap-3 rounded-md border border-dashed p-3 mt-2" data-testid="add-connection-form">
            <div className="flex flex-col gap-2">
              <Label htmlFor="add-collab-url">Server URL</Label>
              <div className="flex gap-2">
                <Input
                  id="add-collab-url"
                  type="url"
                  placeholder="https://collab.example.com"
                  value={addUrl}
                  onChange={(e) => {
                    setAddUrl(e.target.value)
                    setAddTestStatus('idle')
                    setAddTestError(null)
                  }}
                  className="flex-1"
                  autoFocus
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleTestAddConnection()}
                  disabled={addTestStatus === 'testing' || !addUrl.trim()}
                >
                  {addTestStatus === 'testing' ? 'Testing\u2026' : 'Test'}
                </Button>
              </div>

              {addTestStatus === 'success' && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">
                  Connection successful
                </p>
              )}
              {addTestStatus === 'error' && addTestError && (
                <p className="text-xs text-destructive">{addTestError}</p>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button size="sm" onClick={handleSaveNewConnection} disabled={!addUrl.trim()}>
                Add
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCancelAdd}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>

      {/* ── Selected Connection Detail ── */}
      {selectedTarget && (
        <>
          <Separator />

          {/* Status */}
          <SettingsSection
            label="Collaboration Status"
            description={
              connections.length > 1
                ? `Status for ${selectedTarget.label}`
                : 'Current collaboration mode status on the connected server'
            }
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
                    abortStaleFetches()
                    setError(null)
                    setLoading(true)
                    const controller = new AbortController()
                    fetchControllerRef.current = controller
                    void refreshStatus(controller.signal)
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

          {/* Authentication — only shown when collab is enabled on this connection */}
          {selectedTarget.isRemote && status?.enabled && (
            <SettingsSection
              label="Authentication"
              description={
                connections.length > 1
                  ? `Sign in to ${selectedTarget.label}`
                  : 'Sign in to the remote collaboration server'
              }
            >
              {sessionLoading ? (
                <div className="flex items-center gap-2 px-2 py-3">
                  <span className="text-sm text-muted-foreground">Checking session\u2026</span>
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
                      {isSigningOut ? 'Signing out\u2026' : 'Sign out'}
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
                      {isSigningIn ? 'Signing in\u2026' : 'Sign in'}
                    </Button>
                  </form>
                </div>
              )}
            </SettingsSection>
          )}

          {/* Auth error banner */}
          {authError && !sessionLoading && (
            <CollaborationAuthError onSignIn={() => setAuthError(false)} />
          )}

          {/* Password change required */}
          {passwordChangeRequired && !authError && (
            <CollaborationPasswordChange required apiBaseUrl={apiBaseUrl} onChanged={handlePasswordChanged} />
          )}

          {/* Non-required password change (always available for authenticated users) */}
          {session?.authenticated && !passwordChangeRequired && !authError && (
            <CollaborationPasswordChange apiBaseUrl={apiBaseUrl} onChanged={handlePasswordChanged} />
          )}

          {/* Admin-only panels */}
          {isAdmin && !passwordChangeRequired && !authError && (
            <>
              <CollaborationMembers
                currentUserId={session.user!.userId}
                apiBaseUrl={apiBaseUrl}
                onAuthError={handleAuthError}
              />
              <CollaborationInvites
                apiBaseUrl={apiBaseUrl}
                onAuthError={handleAuthError}
              />
            </>
          )}
        </>
      )}
    </div>
  )
}
