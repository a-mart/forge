import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingsSection, SettingsWithCTA } from './settings-row'
import { fetchCollaborationStatus } from './collaboration-settings-api'
import { getCollabServerUrl, setCollabServerUrl } from '@/lib/collaboration-endpoints'
import type { CollaborationStatus } from '@forge/protocol'

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

export function SettingsCollaboration({ wsUrl }: SettingsCollaborationProps) {
  const [status, setStatus] = useState<CollaborationStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Remote server config state
  const [serverUrl, setServerUrl] = useState(() => getCollabServerUrl() ?? '')
  const [testStatus, setTestStatus] = useState<ConnectionTestStatus>('idle')
  const [testError, setTestError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const currentConfiguredUrl = getCollabServerUrl()
  const hasUnsavedChanges = serverUrl.trim() !== (currentConfiguredUrl ?? '')

  useEffect(() => {
    setLoading(true)
    setError(null)
    void fetchCollaborationStatus(wsUrl)
      .then((data) => {
        setStatus(data)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Could not load collaboration status')
      })
      .finally(() => {
        setLoading(false)
      })
  }, [wsUrl])

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
      const response = await fetch(endpoint, {
        credentials: 'include',
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
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [serverUrl])

  const handleDisconnect = useCallback(() => {
    setCollabServerUrl(null)
    setServerUrl('')
    setTestStatus('idle')
    setTestError(null)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [])

  return (
    <div className="flex flex-col gap-8">
      {/* Remote server configuration */}
      <SettingsSection
        label="Collaboration Server"
        description="Connect to a remote Forge collaboration server. Leave empty to use same-origin (private fork)."
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
              Using same-origin (no remote server configured)
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
                void fetchCollaborationStatus(wsUrl)
                  .then((data) => {
                    setStatus(data)
                  })
                  .catch((err) => {
                    setError(err instanceof Error ? err.message : 'Could not load collaboration status')
                  })
                  .finally(() => {
                    setLoading(false)
                  })
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
          </>
        ) : null}
      </SettingsSection>
    </div>
  )
}
