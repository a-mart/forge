import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Loader2,
  Plug,
  Save,
  Trash2,
} from 'lucide-react'
import type { OpenAIBrokerSettingsState, OpenAICodexAuthMode } from '@forge/protocol'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import type { SettingsApiClient } from './settings-api-client'
import {
  clearOpenAIBrokerSettings,
  disableOpenAIBrokerSettings,
  fetchOpenAIBrokerSettings,
  redeemOpenAIBrokerInvite,
  testOpenAIBrokerSettings,
  toErrorMessage,
  updateOpenAIBrokerSettings,
} from './settings-api'

function BrokerStatusBadge({ settings }: { settings: OpenAIBrokerSettingsState }) {
  const status = settings.broker.status
  if (settings.effectiveMode === 'central_broker' && settings.broker.configured && status?.ok) {
    return (
      <Badge variant="outline" className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        <Check className="size-3" />
        Forge Auth broker active
      </Badge>
    )
  }

  if (settings.effectiveMode === 'central_broker' && settings.broker.configured) {
    return (
      <Badge variant="outline" className="gap-1 border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">
        <AlertTriangle className="size-3" />
        Forge Auth broker degraded
      </Badge>
    )
  }

  if (settings.broker.configured) {
    return (
      <Badge variant="outline" className="gap-1 border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300">
        <Plug className="size-3" />
        Forge Auth broker configured
      </Badge>
    )
  }

  return (
    <Badge variant="outline" className="gap-1 border-border/60 bg-muted/40 text-muted-foreground">
      Local auth
    </Badge>
  )
}

function formatDegradedReason(value: string | undefined): string | undefined {
  switch (value) {
    case 'unreachable':
      return 'Forge Auth broker unreachable'
    case 'invalid_bearer':
      return 'Invalid Forge Auth broker token'
    case 'no_accounts':
      return 'No Forge Auth broker accounts available'
    case 'all_cooldown':
      return 'All Forge Auth broker accounts cooling down'
    case 'auth_errors':
      return 'Forge Auth broker accounts reporting auth errors'
    case 'usage_unavailable':
      return 'Forge Auth broker usage unavailable'
    case 'token_shape_unverified':
      return 'Forge Auth broker lease shape unsupported'
    default:
      return value
  }
}

interface OpenAIBrokerAuthPanelProps {
  apiClient: SettingsApiClient
  onError: (message: string) => void
  onSuccess: (message: string) => void
  onSettingsChanged?: (settings: OpenAIBrokerSettingsState) => void
  onBrokerSettingsMutated?: () => void
}

export function OpenAIBrokerAuthPanel({
  apiClient,
  onError,
  onSuccess,
  onSettingsChanged,
  onBrokerSettingsMutated,
}: OpenAIBrokerAuthPanelProps) {
  const [settings, setSettings] = useState<OpenAIBrokerSettingsState | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [isRedeeming, setIsRedeeming] = useState(false)
  const [isDisabling, setIsDisabling] = useState(false)
  const [isClearing, setIsClearing] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showToken, setShowToken] = useState(false)

  const [inviteDraft, setInviteDraft] = useState('')
  const [urlDraft, setUrlDraft] = useState('')
  const [tokenDraft, setTokenDraft] = useState('')
  const [instanceLabelDraft, setInstanceLabelDraft] = useState('')
  const [userLabelDraft, setUserLabelDraft] = useState('')
  const [timeoutDraft, setTimeoutDraft] = useState('10000')
  const [modeDraft, setModeDraft] = useState<OpenAICodexAuthMode>('local')

  const applySettingsToDrafts = useCallback((next: OpenAIBrokerSettingsState) => {
    setSettings(next)
    setModeDraft(next.mode)
    setUrlDraft(next.broker.url ?? '')
    setInstanceLabelDraft(next.broker.instanceLabel ?? '')
    setUserLabelDraft(next.broker.userLabel ?? '')
    setTimeoutDraft(String(next.broker.timeoutMs ?? 10000))
    setTokenDraft('')
    onSettingsChanged?.(next)
  }, [onSettingsChanged])

  const loadSettings = useCallback(async () => {
    setIsLoading(true)
    try {
      const next = await fetchOpenAIBrokerSettings(apiClient)
      applySettingsToDrafts(next)
    } catch (error) {
      onError(toErrorMessage(error))
    } finally {
      setIsLoading(false)
    }
  }, [apiClient, applySettingsToDrafts, onError])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  const buildBrokerPatch = () => ({
    ...(urlDraft.trim() ? { url: urlDraft.trim() } : {}),
    ...(tokenDraft.trim() ? { token: tokenDraft.trim() } : {}),
    ...(instanceLabelDraft.trim() ? { instanceLabel: instanceLabelDraft.trim() } : {}),
    ...(userLabelDraft.trim() ? { userLabel: userLabelDraft.trim() } : {}),
    timeoutMs: Number(timeoutDraft),
  })

  const handleTest = async () => {
    setIsTesting(true)
    try {
      const result = await testOpenAIBrokerSettings(apiClient, { broker: buildBrokerPatch() })
      if (result.ok) {
        onSuccess('Forge Auth broker connection test succeeded.')
        await loadSettings()
      } else {
        onError(result.error ?? result.status?.message ?? 'Forge Auth broker test failed.')
      }
    } catch (error) {
      onError(toErrorMessage(error))
    } finally {
      setIsTesting(false)
    }
  }

  const handleSave = async (nextMode: OpenAICodexAuthMode) => {
    setIsSaving(true)
    try {
      const next = await updateOpenAIBrokerSettings(apiClient, {
        mode: nextMode,
        broker: buildBrokerPatch(),
        ...(nextMode === 'central_broker' ? { testBeforeEnable: true } : {}),
      })
      applySettingsToDrafts(next)
      onBrokerSettingsMutated?.()
      onSuccess(nextMode === 'central_broker' ? 'Forge Auth broker enabled.' : 'Forge Auth broker settings saved.')
    } catch (error) {
      onError(toErrorMessage(error))
    } finally {
      setIsSaving(false)
    }
  }

  const handleRedeemInvite = async () => {
    const invite = inviteDraft.trim()
    if (!invite) {
      onError('Paste a Forge Auth broker setup link first.')
      return
    }

    setIsRedeeming(true)
    try {
      const next = await redeemOpenAIBrokerInvite(apiClient, { invite })
      applySettingsToDrafts(next)
      setModeDraft('central_broker')
      setInviteDraft('')
      onBrokerSettingsMutated?.()
      onSuccess('Forge Auth broker invite redeemed. Broker mode is active.')
    } catch (error) {
      onError(toErrorMessage(error))
    } finally {
      setIsRedeeming(false)
    }
  }

  const handleDisableBroker = async () => {
    setIsDisabling(true)
    try {
      const next = await disableOpenAIBrokerSettings(apiClient)
      applySettingsToDrafts(next)
      onBrokerSettingsMutated?.()
      onSuccess('Switched OpenAI auth back to local credentials.')
    } catch (error) {
      onError(toErrorMessage(error))
    } finally {
      setIsDisabling(false)
    }
  }

  const handleSelectLocalCredentials = () => {
    if (settings?.effectiveMode === 'central_broker') {
      void handleDisableBroker()
      return
    }
    setModeDraft('local')
  }

  const handleSelectBrokerCredentials = () => {
    if (settings?.broker.configured && settings.effectiveMode !== 'central_broker') {
      void handleSave('central_broker')
      return
    }
    setModeDraft('central_broker')
  }

  const handleClearBrokerSettings = async () => {
    if (typeof window !== 'undefined') {
      const confirmed = window.confirm(
        'Remove the saved Forge Auth broker URL and token from Forge settings? Local OpenAI credentials will be used unless broker auth is set by environment variables.',
      )
      if (!confirmed) return
    }

    setIsClearing(true)
    try {
      const next = await clearOpenAIBrokerSettings(apiClient)
      applySettingsToDrafts(next)
      onBrokerSettingsMutated?.()
      onSuccess('Removed stored Forge Auth broker settings. Local credentials are active.')
    } catch (error) {
      onError(toErrorMessage(error))
    } finally {
      setIsClearing(false)
    }
  }

  if (isLoading || !settings) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const envLocked = settings.envOverride
  const brokerActive = settings.effectiveMode === 'central_broker'
  const isBusy = isSaving || isTesting || isRedeeming || isDisabling || isClearing
  const statusDetail = settings.broker.status?.message
    ?? formatDegradedReason(settings.broker.status?.degraded)

  return (
    <div className="rounded-lg border border-border bg-card/50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[13px] font-semibold text-foreground">OpenAI auth source</p>
            <BrokerStatusBadge settings={settings} />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Use local OAuth/API credentials or opt in to the Forge Auth broker for OpenAI/Codex, which issues short-lived leases.
          </p>
          {brokerActive ? (
            <p className="text-[11px] text-muted-foreground">
              Local OpenAI credentials below are visible for reference but cannot be edited while Forge Auth broker mode is active.
            </p>
          ) : null}
        </div>
      </div>

      {envLocked ? (
        <div className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          OpenAI/Codex auth is controlled by environment variables. Remove `FORGE_OPENAI_CODEX_AUTH_MODE` to edit Forge Auth broker settings here.
          If `FORGE_OPENAI_CODEX_AUTH_MODE=central_broker` is set, Forge uses only `FORGE_OPENAI_AUTH_BROKER_URL` and `FORGE_OPENAI_AUTH_BROKER_TOKEN` from the environment; saved Forge Auth broker URL/token values are ignored.
        </div>
      ) : null}

      <div className="mt-4 space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant={modeDraft === 'local' ? 'default' : 'outline'}
            disabled={envLocked || isBusy}
            onClick={handleSelectLocalCredentials}
          >
            {isDisabling ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            Local credentials
          </Button>
          <Button
            type="button"
            size="sm"
            variant={modeDraft === 'central_broker' ? 'default' : 'outline'}
            disabled={envLocked || isBusy}
            onClick={handleSelectBrokerCredentials}
          >
            {isSaving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            Forge Auth broker
          </Button>
        </div>

        {modeDraft === 'central_broker' || settings.broker.configured ? (
          <div className="space-y-3 rounded-md border border-border/70 bg-background/40 p-3">
            {!envLocked ? (
              <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-foreground" htmlFor="openai-broker-invite">Paste setup link</label>
                  <p className="text-[11px] text-muted-foreground">
                    Paste the one-time Forge Auth broker invite link from your administrator. Forge redeems it server-to-server and never displays the invite secret or broker token.
                  </p>
                </div>
                <Textarea
                  id="openai-broker-invite"
                  value={inviteDraft}
                  onChange={(event) => setInviteDraft(event.target.value)}
                  placeholder="https://broker.example.com/-/forge-auth/invite#forge_auth_broker=…"
                  disabled={isBusy}
                  className="min-h-20 font-mono text-xs"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleRedeemInvite()}
                  disabled={isBusy || !inviteDraft.trim()}
                  className="gap-1.5"
                >
                  {isRedeeming ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
                  Redeem invite
                </Button>
              </div>
            ) : null}

            <button
              type="button"
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => setShowAdvanced((current) => !current)}
              disabled={envLocked || isBusy}
            >
              {showAdvanced ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
              Advanced manual setup
            </button>

            {showAdvanced ? (
              <div className="space-y-3 rounded-md border border-border/60 bg-background/50 p-3">
                <div className="space-y-2">
                  <label className="text-xs font-medium text-foreground" htmlFor="openai-broker-url">Broker URL</label>
                  <Input
                    id="openai-broker-url"
                    value={urlDraft}
                    onChange={(event) => setUrlDraft(event.target.value)}
                    placeholder="https://broker.example.test"
                    disabled={envLocked || isBusy}
                    className="font-mono text-xs"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-medium text-foreground" htmlFor="openai-broker-token">Broker token</label>
                  <div className="relative">
                    <Input
                      id="openai-broker-token"
                      type={showToken ? 'text' : 'password'}
                      value={tokenDraft}
                      onChange={(event) => setTokenDraft(event.target.value)}
                      placeholder={settings.broker.hasToken ? settings.broker.tokenMasked ?? '********' : 'Bearer token'}
                      disabled={envLocked || isBusy}
                      className="pr-9 font-mono text-xs"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setShowToken((current) => !current)}
                      disabled={envLocked || isBusy}
                      className="absolute right-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground/70 hover:text-foreground"
                    >
                      {showToken ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </Button>
                  </div>
                  {settings.broker.hasToken && !tokenDraft ? (
                    <p className="text-[11px] text-muted-foreground">
                      Stored token: <code className="font-mono">{settings.broker.tokenMasked ?? '********'}</code>
                    </p>
                  ) : null}
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-foreground" htmlFor="openai-broker-instance-label">Instance label</label>
                    <Input
                      id="openai-broker-instance-label"
                      value={instanceLabelDraft}
                      onChange={(event) => setInstanceLabelDraft(event.target.value)}
                      disabled={envLocked || isBusy}
                      className="text-xs"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-foreground" htmlFor="openai-broker-user-label">User label</label>
                    <Input
                      id="openai-broker-user-label"
                      value={userLabelDraft}
                      onChange={(event) => setUserLabelDraft(event.target.value)}
                      disabled={envLocked || isBusy}
                      className="text-xs"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-foreground" htmlFor="openai-broker-timeout">Timeout (ms)</label>
                    <Input
                      id="openai-broker-timeout"
                      type="number"
                      min={1000}
                      max={60000}
                      value={timeoutDraft}
                      onChange={(event) => setTimeoutDraft(event.target.value)}
                      disabled={envLocked || isBusy}
                      className="text-xs"
                    />
                  </div>
                </div>
              </div>
            ) : null}

            {statusDetail ? (
              <p className="text-[11px] text-muted-foreground">{statusDetail}</p>
            ) : null}

            {settings.broker.status?.accounts ? (
              <p className="text-[11px] text-muted-foreground">
                Forge Auth broker accounts: {settings.broker.status.accounts.healthy} healthy, {settings.broker.status.accounts.cooldown} cooldown, {settings.broker.status.accounts.draining ?? 0} draining
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {showAdvanced ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void handleTest()}
                    disabled={envLocked || isBusy}
                    className="gap-1.5"
                  >
                    {isTesting ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
                    Test connection
                  </Button>

                  {modeDraft === 'central_broker' ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void handleSave('central_broker')}
                      disabled={envLocked || isBusy}
                      className="gap-1.5"
                    >
                      {isSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                      Enable Forge Auth broker
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void handleSave('local')}
                      disabled={envLocked || isBusy}
                      className="gap-1.5"
                    >
                      {isSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                      Save Forge Auth broker settings
                    </Button>
                  )}
                </>
              ) : null}

              {brokerActive ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleDisableBroker()}
                  disabled={envLocked || isBusy}
                >
                  {isDisabling ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Switch back to local
                </Button>
              ) : null}

              {settings.broker.configured ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleClearBrokerSettings()}
                  disabled={envLocked || isBusy}
                  className="gap-1.5 text-destructive hover:text-destructive"
                >
                  {isClearing ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  Remove Forge Auth broker settings
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {brokerActive ? <Separator className="my-4" /> : null}
    </div>
  )
}
