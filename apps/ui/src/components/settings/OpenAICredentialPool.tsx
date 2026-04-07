import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleAlert,
  Clipboard,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import type { CredentialPoolState, PooledCredentialInfo, CredentialPoolStrategy } from '@forge/protocol'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  fetchCredentialPool,
  setCredentialPoolStrategy,
  renamePooledCredential,
  setPrimaryPooledCredential,
  resetPooledCredentialCooldown,
  removePooledCredential,
  toErrorMessage,
  SETTINGS_AUTH_PROVIDER_META,
  startPoolAddAccountOAuthStream,
  submitPoolAddAccountOAuthPrompt,
  createIdleSettingsAuthOAuthFlowState,
} from './settings-api'
import type { SettingsAuthOAuthFlowState } from './settings-types'

/* ------------------------------------------------------------------ */
/*  Health badge                                                      */
/* ------------------------------------------------------------------ */

function HealthBadge({ credential }: { credential: PooledCredentialInfo }) {
  if (credential.health === 'healthy') {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      >
        <span className="inline-block size-1.5 rounded-full bg-emerald-500" />
        Healthy
      </Badge>
    )
  }

  if (credential.health === 'cooldown') {
    const remaining = credential.cooldownUntil
      ? Math.max(0, Math.ceil((credential.cooldownUntil - Date.now()) / 60_000))
      : 0
    return (
      <Badge
        variant="outline"
        className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
      >
        <span className="inline-block size-1.5 rounded-full bg-amber-500" />
        Cooldown: {remaining}m remaining
      </Badge>
    )
  }

  return (
    <Badge
      variant="outline"
      className="gap-1 border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
    >
      <CircleAlert className="size-3" />
      Auth Error
    </Badge>
  )
}

/* ------------------------------------------------------------------ */
/*  Credential row                                                    */
/* ------------------------------------------------------------------ */

function CredentialRow({
  credential,
  isBusy,
  onSetPrimary,
  onRename,
  onResetCooldown,
  onRemove,
}: {
  credential: PooledCredentialInfo
  isBusy: boolean
  onSetPrimary: () => void
  onRename: (newLabel: string) => void
  onResetCooldown: () => void
  onRemove: () => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(credential.label)
  const [showConfirm, setShowConfirm] = useState(false)

  const commitRename = () => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== credential.label) {
      onRename(trimmed)
    }
    setIsEditing(false)
  }

  return (
    <>
      <div className="group flex items-center gap-3 rounded-md border border-border bg-background/50 px-3 py-2.5 transition-colors hover:bg-background/80">
        {/* Primary star */}
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onSetPrimary}
                disabled={isBusy || credential.isPrimary}
                className="shrink-0 text-muted-foreground/50 transition-colors hover:text-amber-500 disabled:cursor-default disabled:opacity-100"
              >
                <Star
                  className={`size-4 ${credential.isPrimary ? 'fill-amber-500 text-amber-500' : ''}`}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {credential.isPrimary ? 'Primary account' : 'Set as primary'}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/* Label + auto-label */}
        <div className="min-w-0 flex-1">
          {isEditing ? (
            <div className="flex items-center gap-1.5">
              <Input
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') setIsEditing(false)
                }}
                className="h-7 text-xs"
                autoFocus
              />
              <Button type="button" variant="ghost" size="icon" className="size-6" onClick={commitRename}>
                <Check className="size-3" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() => setIsEditing(false)}
              >
                <X className="size-3" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-medium text-foreground">{credential.label}</span>
              <button
                type="button"
                onClick={() => {
                  setEditValue(credential.label)
                  setIsEditing(true)
                }}
                disabled={isBusy}
                className="shrink-0 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
              >
                <Pencil className="size-3" />
              </button>
              {credential.isPrimary && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  Primary
                </Badge>
              )}
            </div>
          )}
          {credential.autoLabel && !isEditing && (
            <p className="truncate text-[11px] text-muted-foreground">{credential.autoLabel}</p>
          )}
        </div>

        {/* Health */}
        <HealthBadge credential={credential} />

        {/* Request count */}
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {credential.requestCount.toLocaleString()} req
        </span>

        {/* Actions */}
        <div className="flex items-center gap-0.5">
          {credential.health === 'cooldown' && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-foreground"
                    onClick={onResetCooldown}
                    disabled={isBusy}
                  >
                    <RotateCcw className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Reset cooldown</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:text-destructive"
                  onClick={() => setShowConfirm(true)}
                  disabled={isBusy}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Remove account</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {/* Remove confirmation dialog */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove account</DialogTitle>
            <DialogDescription>
              Remove <strong>{credential.label}</strong> from the credential pool? This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setShowConfirm(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setShowConfirm(false)
                onRemove()
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  Copy URL button                                                   */
/* ------------------------------------------------------------------ */

function CopyUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard write can fail in insecure contexts — ignore silently
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/30 px-2 py-1 text-[11px] text-primary hover:bg-muted/50"
    >
      {copied ? (
        <>
          <Check className="size-3" />
          Copied!
        </>
      ) : (
        <>
          <Clipboard className="size-3" />
          Copy URL
        </>
      )}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/*  Main pool panel                                                   */
/* ------------------------------------------------------------------ */

interface OpenAICredentialPoolProps {
  wsUrl: string
  onError: (message: string) => void
  onSuccess: (message: string) => void
  onAuthReload: () => void
}

export function OpenAICredentialPool({ wsUrl, onError, onSuccess, onAuthReload }: OpenAICredentialPoolProps) {
  const [pool, setPool] = useState<CredentialPoolState | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isBusy, setIsBusy] = useState(false)
  const [oauthFlow, setOauthFlow] = useState<SettingsAuthOAuthFlowState>(createIdleSettingsAuthOAuthFlowState())
  const [oauthAbort, setOauthAbort] = useState<AbortController | null>(null)

  const loadPool = useCallback(async () => {
    try {
      const state = await fetchCredentialPool(wsUrl, 'openai-codex')
      setPool(state)
    } catch (err) {
      onError(toErrorMessage(err))
    } finally {
      setIsLoading(false)
    }
  }, [wsUrl, onError])

  useEffect(() => {
    void loadPool()
  }, [loadPool])

  // Cleanup OAuth abort controller on unmount
  useEffect(() => {
    return () => {
      oauthAbort?.abort()
    }
  }, [oauthAbort])

  const handleStrategyChange = async (value: string) => {
    const strategy = value as CredentialPoolStrategy
    setIsBusy(true)
    try {
      await setCredentialPoolStrategy(wsUrl, 'openai-codex', strategy)
      setPool((prev) => (prev ? { ...prev, strategy } : prev))
      onSuccess(`Strategy updated to ${strategy === 'fill_first' ? 'Fill First' : 'Spread Load'}.`)
    } catch (err) {
      onError(toErrorMessage(err))
    } finally {
      setIsBusy(false)
    }
  }

  const handleRename = async (id: string, label: string) => {
    setIsBusy(true)
    try {
      await renamePooledCredential(wsUrl, 'openai-codex', id, label)
      await loadPool()
      onSuccess('Account renamed.')
    } catch (err) {
      onError(toErrorMessage(err))
    } finally {
      setIsBusy(false)
    }
  }

  const handleSetPrimary = async (id: string) => {
    setIsBusy(true)
    try {
      await setPrimaryPooledCredential(wsUrl, 'openai-codex', id)
      await loadPool()
      onSuccess('Primary account updated.')
    } catch (err) {
      onError(toErrorMessage(err))
    } finally {
      setIsBusy(false)
    }
  }

  const handleResetCooldown = async (id: string) => {
    setIsBusy(true)
    try {
      await resetPooledCredentialCooldown(wsUrl, 'openai-codex', id)
      await loadPool()
      onSuccess('Cooldown reset.')
    } catch (err) {
      onError(toErrorMessage(err))
    } finally {
      setIsBusy(false)
    }
  }

  const handleRemove = async (id: string) => {
    setIsBusy(true)
    try {
      await removePooledCredential(wsUrl, 'openai-codex', id)
      await loadPool()
      onAuthReload()
      onSuccess('Account removed.')
    } catch (err) {
      onError(toErrorMessage(err))
    } finally {
      setIsBusy(false)
    }
  }

  const handleAddAccount = async () => {
    // Abort any existing flow
    oauthAbort?.abort()

    const controller = new AbortController()
    setOauthAbort(controller)
    setOauthFlow({
      ...createIdleSettingsAuthOAuthFlowState(),
      status: 'starting',
      progressMessage: 'Starting OAuth login...',
    })

    let completed = false
    try {
      await startPoolAddAccountOAuthStream(
        wsUrl,
        'openai-codex',
        {
          onAuthUrl: (event) => {
            setOauthFlow((prev) => ({
              ...prev,
              status: prev.status === 'waiting_for_code' ? 'waiting_for_code' : 'waiting_for_auth',
              authUrl: event.url,
              instructions: event.instructions,
              errorMessage: undefined,
            }))
          },
          onPrompt: (event) => {
            setOauthFlow((prev) => ({
              ...prev,
              status: 'waiting_for_code',
              promptMessage: event.message,
              promptPlaceholder: event.placeholder,
              errorMessage: undefined,
            }))
          },
          onProgress: (event) => {
            setOauthFlow((prev) => ({
              ...prev,
              status: prev.status === 'waiting_for_code' ? 'waiting_for_code' : 'waiting_for_auth',
              progressMessage: event.message,
            }))
          },
          onComplete: () => {
            completed = true
            setOauthFlow((prev) => ({
              ...prev,
              status: 'complete',
              progressMessage: 'Connected.',
              errorMessage: undefined,
              isSubmittingCode: false,
              codeValue: '',
            }))
            onSuccess('OpenAI account added to the pool.')
          },
          onError: (message) => {
            setOauthFlow((prev) => ({
              ...prev,
              status: 'error',
              errorMessage: message,
              isSubmittingCode: false,
            }))
            onError(message)
          },
        },
        controller.signal,
      )
      if (!controller.signal.aborted && completed) {
        await loadPool()
        onAuthReload()
      }
    } catch (error) {
      if (controller.signal.aborted) return
      const message = toErrorMessage(error)
      onError(message)
      setOauthFlow((prev) => ({
        ...prev,
        status: 'error',
        errorMessage: message,
        isSubmittingCode: false,
      }))
    }
  }

  const handleSubmitOAuthCode = async () => {
    const value = oauthFlow.codeValue.trim()
    if (!value) return
    setOauthFlow((prev) => ({ ...prev, isSubmittingCode: true, errorMessage: undefined }))
    try {
      await submitPoolAddAccountOAuthPrompt(wsUrl, 'openai-codex', value)
      setOauthFlow((prev) => ({
        ...prev,
        status: 'waiting_for_auth',
        codeValue: '',
        isSubmittingCode: false,
        progressMessage: 'Authorization code submitted. Waiting for completion...',
        errorMessage: undefined,
      }))
    } catch (error) {
      const message = toErrorMessage(error)
      onError(message)
      setOauthFlow((prev) => ({
        ...prev,
        status: 'waiting_for_code',
        isSubmittingCode: false,
        errorMessage: message,
      }))
    }
  }

  const resetOAuthFlow = () => {
    oauthAbort?.abort()
    setOauthAbort(null)
    setOauthFlow(createIdleSettingsAuthOAuthFlowState())
  }

  const oauthInProgress =
    oauthFlow.status === 'starting' ||
    oauthFlow.status === 'waiting_for_auth' ||
    oauthFlow.status === 'waiting_for_code'

  const metadata = SETTINGS_AUTH_PROVIDER_META['openai-codex']

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border bg-card/50 p-4">
        <div className="flex items-center gap-2">
          <p className="text-[13px] font-semibold text-foreground">{metadata.label}</p>
        </div>
        <div className="flex items-center justify-center py-6">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border bg-card/50 p-4 transition-colors hover:bg-card/80">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-[13px] font-semibold text-foreground">{metadata.label}</p>
            {pool && pool.credentials.length > 0 ? (
              <Badge
                variant="outline"
                className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              >
                <Check className="size-3" />
                {pool.credentials.length} account{pool.credentials.length !== 1 ? 's' : ''}
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
              >
                <AlertTriangle className="size-3" />
                Not configured
              </Badge>
            )}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">{metadata.description}</p>
        </div>
      </div>

      {/* Strategy selector */}
      {pool && pool.credentials.length > 1 && (
        <div className="mt-3 flex items-center gap-2">
          <span className="shrink-0 text-[11px] font-medium text-muted-foreground">Strategy:</span>
          <Select
            value={pool.strategy}
            onValueChange={(v) => void handleStrategyChange(v)}
            disabled={isBusy}
          >
            <SelectTrigger className="h-8 w-[320px] text-xs">
              <SelectValue />
              <ChevronDown className="ml-auto size-3 opacity-50" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fill_first">
                Fill First — Use primary until rate-limited
              </SelectItem>
              <SelectItem value="least_used">
                Spread Load — Distribute across accounts
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Account list */}
      {pool && pool.credentials.length > 0 && (
        <div className="mt-3 space-y-2">
          {pool.credentials.map((cred) => (
            <CredentialRow
              key={cred.id}
              credential={cred}
              isBusy={isBusy}
              onSetPrimary={() => void handleSetPrimary(cred.id)}
              onRename={(label) => void handleRename(cred.id, label)}
              onResetCooldown={() => void handleResetCooldown(cred.id)}
              onRemove={() => void handleRemove(cred.id)}
            />
          ))}
        </div>
      )}

      {/* Add Account + OAuth flow */}
      <div className="mt-3 space-y-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleAddAccount()}
          disabled={isBusy || oauthInProgress || oauthFlow.isSubmittingCode}
          className="gap-1.5"
        >
          {oauthInProgress ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Plus className="size-3.5" />
          )}
          {oauthInProgress ? 'Authorizing...' : 'Add Account'}
        </Button>

        {/* OAuth flow inline UI */}
        {(oauthInProgress || oauthFlow.status === 'complete' || oauthFlow.status === 'error') && (
          <div className="space-y-2 rounded-md border border-border/70 bg-background/40 p-3">
            {oauthFlow.authUrl && (
              <div className="flex items-center gap-1.5">
                <a
                  href={oauthFlow.authUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/30 px-2 py-1 text-[11px] text-primary hover:bg-muted/50"
                >
                  Open authorization URL
                </a>
                <CopyUrlButton url={oauthFlow.authUrl} />
              </div>
            )}

            {oauthFlow.instructions && (
              <p className="text-[11px] text-muted-foreground">{oauthFlow.instructions}</p>
            )}

            {oauthFlow.progressMessage && (
              <p className="text-[11px] text-muted-foreground">{oauthFlow.progressMessage}</p>
            )}

            {oauthFlow.status === 'waiting_for_code' && (
              <div className="space-y-2">
                <p className="text-[11px] text-muted-foreground">
                  {oauthFlow.promptMessage ?? 'Paste the authorization code to continue.'}
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    placeholder={oauthFlow.promptPlaceholder ?? 'Paste authorization code or URL'}
                    value={oauthFlow.codeValue}
                    onChange={(e) =>
                      setOauthFlow((prev) => ({ ...prev, codeValue: e.target.value, errorMessage: undefined }))
                    }
                    disabled={isBusy || oauthFlow.isSubmittingCode}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono text-xs"
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void handleSubmitOAuthCode()}
                    disabled={!oauthFlow.codeValue.trim() || isBusy || oauthFlow.isSubmittingCode}
                    className="gap-1.5"
                  >
                    {oauthFlow.isSubmittingCode ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Check className="size-3.5" />
                    )}
                    {oauthFlow.isSubmittingCode ? 'Submitting...' : 'Submit'}
                  </Button>
                </div>
              </div>
            )}

            {oauthFlow.status === 'complete' && (
              <Badge
                variant="outline"
                className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              >
                <Check className="size-3" />
                Connected
              </Badge>
            )}

            {oauthFlow.errorMessage && (
              <p className="text-[11px] text-destructive">{oauthFlow.errorMessage}</p>
            )}

            {(oauthFlow.status === 'complete' || oauthFlow.status === 'error') && (
              <div className="flex justify-end">
                <Button type="button" variant="ghost" size="sm" onClick={resetOAuthFlow}>
                  Clear
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
