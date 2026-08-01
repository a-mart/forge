import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Key,
  Loader2,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
  XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { SettingsSection } from './settings-row'
import { isElectron, type CliInstallResult } from '@/lib/electron-bridge'
import type { CliAccessKeyDescriptor } from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'
import {
  fetchCliAccessKeys,
  generateCliAccessKey,
  revokeCliAccessKey,
  rotateCliAccessKey,
} from './cli-access-api'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface OneTimeSecret {
  keyId: string
  plaintextKey: string
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function KeyStatusBadge({ descriptor }: { descriptor: CliAccessKeyDescriptor }) {
  if (descriptor.revokedAt) {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
      >
        Revoked
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
    >
      <Check className="size-3" />
      Active
    </Badge>
  )
}

function formatRelativeTime(isoString: string): string {
  const now = Date.now()
  const then = new Date(isoString).getTime()
  const diffMs = now - then
  if (diffMs < 60_000) return 'just now'
  if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m ago`
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3600_000)}h ago`
  const days = Math.floor(diffMs / 86_400_000)
  if (days < 30) return `${days}d ago`
  return new Date(isoString).toLocaleDateString()
}

function LastUsedLabel({ descriptor }: { descriptor: CliAccessKeyDescriptor }) {
  if (!descriptor.lastUsedAt) {
    return <span className="text-xs text-muted-foreground">Never used</span>
  }
  const source = descriptor.lastUsedSource
    ? ` via ${descriptor.lastUsedSource}`
    : ''
  return (
    <span className="text-xs text-muted-foreground">
      Last used {formatRelativeTime(descriptor.lastUsedAt)}{source}
    </span>
  )
}

function OneTimeKeyBanner({
  secret,
  onDismiss,
}: {
  secret: OneTimeSecret
  onDismiss: () => void
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(secret.plaintextKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback: select the text in the input for manual copy
    }
  }, [secret.plaintextKey])

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            Copy your API key now
          </p>
          <p className="text-xs text-muted-foreground">
            This key will not be shown again. Store it securely.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Input
          readOnly
          value={secret.plaintextKey}
          className="font-mono text-xs"
          onFocus={(e) => e.target.select()}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5"
          onClick={handleCopy}
        >
          {copied ? (
            <>
              <Check className="size-3.5" />
              Copied
            </>
          ) : (
            <>
              <Copy className="size-3.5" />
              Copy
            </>
          )}
        </Button>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-xs text-muted-foreground"
        onClick={onDismiss}
      >
        Dismiss
      </Button>
    </div>
  )
}

function KeyRow({
  descriptor,
  isBusy,
  onRevoke,
  onRotate,
}: {
  descriptor: CliAccessKeyDescriptor
  isBusy: boolean
  onRevoke: (keyId: string) => void
  onRotate: (keyId: string) => void
}) {
  const isRevoked = !!descriptor.revokedAt

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-card/40 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex items-center gap-2">
          <Key className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">
            {descriptor.name ?? descriptor.id}
          </span>
          <KeyStatusBadge descriptor={descriptor} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-5.5">
          <span className="text-xs text-muted-foreground">
            Created {formatRelativeTime(descriptor.createdAt)}
          </span>
          <LastUsedLabel descriptor={descriptor} />
        </div>
      </div>

      {!isRevoked && (
        <div className="flex shrink-0 items-center gap-1.5 pl-5.5 sm:pl-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1 text-xs"
            disabled={isBusy}
            onClick={() => onRotate(descriptor.id)}
          >
            {isBusy ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            Rotate
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={isBusy}
            onClick={() => onRevoke(descriptor.id)}
          >
            {isBusy ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Trash2 className="size-3" />
            )}
            Revoke
          </Button>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

/** Derive the backend HTTP base URL from the wsUrl prop, respecting the Electron bridge. */
function resolveBackendBaseUrl(wsUrl: string): string {
  // In Electron, the ws URL points to the real backend — use it.
  // On web, the ws URL also resolves correctly via protocol swap.
  try {
    const parsed = new URL(wsUrl)
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    return parsed.origin
  } catch {
    return 'http://127.0.0.1:47187'
  }
}

export function SettingsCliAccess({
  wsUrl,
  apiClient,
}: {
  wsUrl: string
  apiClient: SettingsApiClient
}) {
  const [keys, setKeys] = useState<CliAccessKeyDescriptor[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [oneTimeSecret, setOneTimeSecret] = useState<OneTimeSecret | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const loadKeys = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const fetched = await fetchCliAccessKeys(apiClient)
      if (mountedRef.current) setKeys(fetched)
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : 'Failed to load CLI keys')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [apiClient])

  useEffect(() => {
    void loadKeys()
  }, [loadKeys])

  const handleGenerate = useCallback(async () => {
    try {
      setGenerating(true)
      setError(null)
      const result = await generateCliAccessKey(apiClient, {
        name: newKeyName.trim() || undefined,
      })
      if (!mountedRef.current) return
      setOneTimeSecret({ keyId: result.key.id, plaintextKey: result.plaintextKey })
      setNewKeyName('')
      await loadKeys()
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : 'Failed to generate key')
    } finally {
      if (mountedRef.current) setGenerating(false)
    }
  }, [apiClient, newKeyName, loadKeys])

  const handleRevoke = useCallback(async (keyId: string) => {
    try {
      setBusyKeyId(keyId)
      setError(null)
      await revokeCliAccessKey(apiClient, keyId)
      if (!mountedRef.current) return
      if (oneTimeSecret?.keyId === keyId) setOneTimeSecret(null)
      await loadKeys()
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : 'Failed to revoke key')
    } finally {
      if (mountedRef.current) setBusyKeyId(null)
    }
  }, [apiClient, loadKeys, oneTimeSecret])

  const handleRotate = useCallback(async (keyId: string) => {
    try {
      setBusyKeyId(keyId)
      setError(null)
      const existing = keys.find((k) => k.id === keyId)
      const result = await rotateCliAccessKey(apiClient, keyId, { name: existing?.name })
      if (!mountedRef.current) return
      setOneTimeSecret({ keyId: result.key.id, plaintextKey: result.plaintextKey })
      await loadKeys()
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : 'Failed to rotate key')
    } finally {
      if (mountedRef.current) setBusyKeyId(null)
    }
  }, [apiClient, keys, loadKeys])

  const activeKeys = keys.filter((k) => !k.revokedAt)
  const revokedKeys = keys
    .filter((k) => !!k.revokedAt)
    .sort((a, b) => Date.parse(b.revokedAt!) - Date.parse(a.revokedAt!))
    .slice(0, 3)

  return (
    <div className="space-y-6">
      <SettingsSection
        label="CLI Access Keys"
        description="Manage API keys for the Forge CLI. Keys authenticate headless CLI connections to this backend."
      >
        {/* LAN warning */}
        <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <p className="text-xs text-muted-foreground">
            This backend may be reachable over your local network. CLI keys authorize
            full session access to any device that can reach this server.
          </p>
        </div>

        {/* Error banner */}
        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        {/* One-time secret banner */}
        {oneTimeSecret && (
          <OneTimeKeyBanner
            secret={oneTimeSecret}
            onDismiss={() => setOneTimeSecret(null)}
          />
        )}

        {/* Generate new key */}
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <label htmlFor="cli-key-name" className="text-xs font-medium text-muted-foreground">
              Key name (optional)
            </label>
            <Input
              id="cli-key-name"
              placeholder="e.g. CI pipeline, laptop"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              maxLength={120}
              className="text-sm"
              disabled={generating}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void handleGenerate()
                }
              }}
            />
          </div>
          <Button
            type="button"
            size="sm"
            className="gap-1.5 shrink-0"
            disabled={generating}
            onClick={handleGenerate}
          >
            {generating ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
            Generate key
          </Button>
        </div>

        <Separator />

        {/* Key list */}
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : activeKeys.length === 0 && revokedKeys.length === 0 ? (
          <div className="py-6 text-center">
            <Key className="mx-auto mb-2 size-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No CLI keys configured</p>
            <p className="text-xs text-muted-foreground/70">
              Generate a key to connect the Forge CLI to this backend.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {activeKeys.map((key) => (
              <KeyRow
                key={key.id}
                descriptor={key}
                isBusy={busyKeyId === key.id}
                onRevoke={handleRevoke}
                onRotate={handleRotate}
              />
            ))}
            {revokedKeys.length > 0 && activeKeys.length > 0 && (
              <Separator className="my-2" />
            )}
            {revokedKeys.map((key) => (
              <KeyRow
                key={key.id}
                descriptor={key}
                isBusy={busyKeyId === key.id}
                onRevoke={handleRevoke}
                onRotate={handleRotate}
              />
            ))}
          </div>
        )}
      </SettingsSection>

      <CliInstallSection wsUrl={wsUrl} />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  CLI Installation section                                           */
/* ------------------------------------------------------------------ */

function CliInstallSection({ wsUrl }: { wsUrl: string }) {
  const [installing, setInstalling] = useState(false)
  const [installResult, setInstallResult] = useState<CliInstallResult | null>(null)
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; output: string } | null>(null)
  const isDesktop = useMemo(() => isElectron(), [])
  const backendUrl = useMemo(() => resolveBackendBaseUrl(wsUrl), [wsUrl])

  const handleDesktopInstall = useCallback(async () => {
    const bridge = window.electronBridge
    if (!bridge?.installCli) return

    setInstalling(true)
    setInstallResult(null)
    setVerifyResult(null)

    try {
      const result = await bridge.installCli()
      setInstallResult(result)

      // Auto-verify the installed shim (main resolves the path internally)
      if (result.success && bridge.verifyCliInstall) {
        const verify = await bridge.verifyCliInstall()
        setVerifyResult(verify)
      }
    } catch (err) {
      setInstallResult({
        success: false,
        installedPath: '',
        binDir: '',
        pathIncluded: false,
        pathInstructions: null,
        error: err instanceof Error ? err.message : 'Install failed',
      })
    } finally {
      setInstalling(false)
    }
  }, [])

  return (
    <SettingsSection
      label="CLI Installation"
      description="Install the Forge CLI to interact with this backend from a terminal."
    >
      {/* Desktop install */}
      {isDesktop && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Button
              type="button"
              size="sm"
              className="gap-1.5"
              disabled={installing}
              onClick={handleDesktopInstall}
            >
              {installing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              {installResult?.success ? 'Reinstall CLI' : 'Install CLI'}
            </Button>
            <span className="text-xs text-muted-foreground">
              No Node.js required — uses the bundled Forge Desktop runtime.
            </span>
          </div>

          {/* Install result */}
          {installResult && (
            <div
              className={`rounded-md border p-3 space-y-2 ${
                installResult.success
                  ? 'border-emerald-500/30 bg-emerald-500/5'
                  : 'border-red-500/30 bg-red-500/5'
              }`}
            >
              {installResult.success ? (
                <>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                    <span className="text-sm font-medium text-foreground">CLI installed</span>
                  </div>
                  <div className="space-y-1 pl-6">
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium">Path:</span>{' '}
                      <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[11px]">
                        {installResult.installedPath}
                      </code>
                    </p>
                    {installResult.pathIncluded ? (
                      <p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                        <Check className="size-3" />
                        Already on PATH — run <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[11px]">forge --version</code> to verify.
                      </p>
                    ) : (
                      <div className="space-y-1.5">
                        <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="size-3" />
                          Not on PATH yet. Add the directory to use <code className="font-mono">forge</code> from any terminal:
                        </p>
                        <pre className="rounded-md bg-muted/50 px-3 py-2 text-xs font-mono whitespace-pre-wrap">
                          {installResult.pathInstructions}
                        </pre>
                      </div>
                    )}
                  </div>

                  {/* Verify result */}
                  {verifyResult && (
                    <div className="pl-6">
                      {verifyResult.ok ? (
                        <p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                          <Terminal className="size-3" />
                          Verified: forge {verifyResult.output}
                        </p>
                      ) : (
                        <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                          <XCircle className="size-3" />
                          Verification issue: {verifyResult.output}
                        </p>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <XCircle className="size-4 shrink-0 text-red-500" />
                  <span className="text-sm text-red-600 dark:text-red-400">
                    {installResult.error ?? 'Installation failed'}
                  </span>
                </div>
              )}
            </div>
          )}

          <Separator />
        </div>
      )}

      {/* npm / manual install instructions */}
      <div className="space-y-3 text-sm text-muted-foreground">
        <div className="space-y-1.5">
          <p className="font-medium text-foreground text-xs">npm (requires Node.js 22+)</p>
          <code className="block rounded-md bg-muted/50 px-3 py-2 text-xs font-mono">
            npm install -g @forge/cli
          </code>
        </div>
        <div className="space-y-1.5">
          <p className="font-medium text-foreground text-xs">Configure</p>
          <code className="block rounded-md bg-muted/50 px-3 py-2 text-xs font-mono whitespace-pre">{`forge config set url ${backendUrl}\nforge config set api-key <your-key>`}</code>
        </div>
        <p className="text-xs text-muted-foreground/70">
          Or set <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[11px]">FORGE_URL</code> and{' '}
          <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[11px]">FORGE_CLI_API_KEY</code> environment
          variables.
        </p>
      </div>
    </SettingsSection>
  )
}
