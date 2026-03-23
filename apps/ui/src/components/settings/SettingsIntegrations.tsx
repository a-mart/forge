import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Loader2,
  Plug,
  Save,
  TestTube2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { SettingsSection, SettingsWithCTA } from './settings-row'
import type {
  TelegramSettingsConfig,
  TelegramDraft,
} from './settings-types'
import {
  fetchTelegramSettings,
  updateTelegramSettings,
  disableTelegramSettings,
  testTelegramConnection,
  SHARED_INTEGRATION_MANAGER_ID,
  toErrorMessage,
} from './settings-api'
import type { AgentDescriptor, TelegramStatusEvent } from '@forge/protocol'

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function toTelegramDraft(config: TelegramSettingsConfig): TelegramDraft {
  return {
    enabled: config.enabled,
    botToken: '',
    allowedUserIds: Array.isArray(config.allowedUserIds) ? [...config.allowedUserIds] : [],
    timeoutSeconds: String(config.polling.timeoutSeconds),
    limit: String(config.polling.limit),
    dropPendingUpdatesOnStart: config.polling.dropPendingUpdatesOnStart,
    disableLinkPreview: config.delivery.disableLinkPreview,
    replyToInboundMessageByDefault: config.delivery.replyToInboundMessageByDefault,
    maxFileBytes: String(config.attachments.maxFileBytes),
    allowImages: config.attachments.allowImages,
    allowText: config.attachments.allowText,
    allowBinary: config.attachments.allowBinary,
  }
}

function buildTelegramPatch(draft: TelegramDraft): Record<string, unknown> {
  const timeoutSeconds = Number.parseInt(draft.timeoutSeconds, 10)
  const limit = Number.parseInt(draft.limit, 10)
  const maxFileBytes = Number.parseInt(draft.maxFileBytes, 10)
  const patch: Record<string, unknown> = {
    enabled: draft.enabled,
    allowedUserIds: draft.allowedUserIds,
    polling: {
      timeoutSeconds: Number.isFinite(timeoutSeconds) ? timeoutSeconds : 25,
      limit: Number.isFinite(limit) ? limit : 100,
      dropPendingUpdatesOnStart: draft.dropPendingUpdatesOnStart,
    },
    delivery: {
      parseMode: 'HTML',
      disableLinkPreview: draft.disableLinkPreview,
      replyToInboundMessageByDefault: draft.replyToInboundMessageByDefault,
    },
    attachments: {
      maxFileBytes: Number.isFinite(maxFileBytes) && maxFileBytes > 0 ? maxFileBytes : 10 * 1024 * 1024,
      allowImages: draft.allowImages,
      allowText: draft.allowText,
      allowBinary: draft.allowBinary,
    },
  }
  if (draft.botToken.trim()) patch.botToken = draft.botToken.trim()
  return patch
}

function parseCommaSeparated(value: string): string[] {
  return value.split(',').map((e) => e.trim()).filter((e) => e.length > 0)
}

function resolveManagerProfileId(agent: AgentDescriptor): string {
  const profileId = agent.profileId?.trim()
  return profileId && profileId.length > 0 ? profileId : agent.agentId
}

/* ------------------------------------------------------------------ */
/*  Badge components                                                  */
/* ------------------------------------------------------------------ */

function TelegramConnectionBadge({ status }: { status: TelegramStatusEvent | null }) {
  const state = status?.state ?? 'disabled'
  const className =
    state === 'connected'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : state === 'connecting'
        ? 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400'
        : state === 'error'
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-border/50 bg-muted/50 text-muted-foreground'
  return (
    <Badge variant="outline" className={cn('capitalize', className)}>
      {state}
    </Badge>
  )
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  const switchId = useId()
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-border/70 p-3">
      <div className="min-w-0 space-y-1">
        <Label htmlFor={switchId} className="text-xs font-medium text-foreground">
          {label}
        </Label>
        {description ? <p className="text-[11px] text-muted-foreground">{description}</p> : null}
      </div>
      <Switch id={switchId} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function FeedbackBanner({ error, success }: { error: string | null; success: string | null }) {
  return (
    <>
      {error ? (
        <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
          <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
          <p className="text-xs text-destructive">{error}</p>
        </div>
      ) : null}
      {success ? (
        <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
          <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <p className="text-xs text-emerald-600 dark:text-emerald-400">{success}</p>
        </div>
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  Main integrations settings tab                                    */
/* ------------------------------------------------------------------ */

interface SettingsIntegrationsProps {
  wsUrl: string
  managers: AgentDescriptor[]
  telegramStatus?: TelegramStatusEvent | null
}

export function SettingsIntegrations({
  wsUrl,
  managers,
  telegramStatus,
}: SettingsIntegrationsProps) {
  const managerOptions = useMemo(() => {
    const seenProfileIds = new Set<string>()
    const options: AgentDescriptor[] = []

    for (const agent of managers) {
      if (agent.role !== 'manager') continue
      if (agent.status !== 'idle' && agent.status !== 'streaming') continue

      const profileId = resolveManagerProfileId(agent)
      if (seenProfileIds.has(profileId)) continue

      seenProfileIds.add(profileId)
      options.push(agent)
    }

    return options
  }, [managers])
  const [selectedIntegrationManagerId, setSelectedIntegrationManagerId] = useState<string>(
    SHARED_INTEGRATION_MANAGER_ID,
  )

  useEffect(() => {
    setSelectedIntegrationManagerId((previous) => {
      if (previous === SHARED_INTEGRATION_MANAGER_ID) return previous
      const availableIds = managerOptions.map((m) => resolveManagerProfileId(m))
      if (availableIds.includes(previous)) return previous
      return SHARED_INTEGRATION_MANAGER_ID
    })
  }, [managerOptions])

  // ---- Telegram state ----
  const [telegramConfig, setTelegramConfig] = useState<TelegramSettingsConfig | null>(null)
  const [telegramDraft, setTelegramDraft] = useState<TelegramDraft | null>(null)
  const [telegramStatusFromApi, setTelegramStatusFromApi] = useState<TelegramStatusEvent | null>(null)
  const [telegramError, setTelegramError] = useState<string | null>(null)
  const [telegramSuccess, setTelegramSuccess] = useState<string | null>(null)
  const [isLoadingTelegram, setIsLoadingTelegram] = useState(false)
  const [isSavingTelegram, setIsSavingTelegram] = useState(false)
  const [isTestingTelegram, setIsTestingTelegram] = useState(false)
  const [isDisablingTelegram, setIsDisablingTelegram] = useState(false)

  const effectiveTelegramStatus =
    telegramStatus && (!telegramStatus.managerId || telegramStatus.managerId === selectedIntegrationManagerId)
      ? telegramStatus
      : telegramStatusFromApi
  const hasSelectedIntegrationManager = selectedIntegrationManagerId.trim().length > 0
  const isSharedIntegrationSelection =
    selectedIntegrationManagerId === SHARED_INTEGRATION_MANAGER_ID

  const loadTelegram = useCallback(async () => {
    if (!hasSelectedIntegrationManager) {
      setTelegramConfig(null)
      setTelegramDraft(null)
      setTelegramStatusFromApi(null)
      setTelegramError(null)
      return
    }

    setIsLoadingTelegram(true)
    setTelegramError(null)
    try {
      const result = await fetchTelegramSettings(wsUrl, selectedIntegrationManagerId)
      setTelegramConfig(result.config)
      setTelegramDraft(toTelegramDraft(result.config))
      setTelegramStatusFromApi(result.status)
    } catch (err) {
      setTelegramError(toErrorMessage(err))
    } finally {
      setIsLoadingTelegram(false)
    }
  }, [hasSelectedIntegrationManager, wsUrl, selectedIntegrationManagerId])

  useEffect(() => {
    void loadTelegram()
  }, [loadTelegram])

  const handleSaveTelegram = async () => {
    if (!telegramDraft || !hasSelectedIntegrationManager) return
    setTelegramError(null); setTelegramSuccess(null); setIsSavingTelegram(true)
    try {
      const updated = await updateTelegramSettings(wsUrl, selectedIntegrationManagerId, buildTelegramPatch(telegramDraft))
      setTelegramConfig(updated.config); setTelegramDraft(toTelegramDraft(updated.config)); setTelegramStatusFromApi(updated.status)
      setTelegramSuccess('Telegram settings saved.')
    } catch (error) { setTelegramError(toErrorMessage(error)) } finally { setIsSavingTelegram(false) }
  }

  const handleTestTelegram = async () => {
    if (!telegramDraft || !hasSelectedIntegrationManager) return
    setTelegramError(null); setTelegramSuccess(null); setIsTestingTelegram(true)
    const patch: Record<string, unknown> = {}
    if (telegramDraft.botToken.trim()) patch.botToken = telegramDraft.botToken.trim()
    try {
      const result = await testTelegramConnection(wsUrl, selectedIntegrationManagerId, Object.keys(patch).length > 0 ? patch : undefined)
      const identity = result.botUsername ?? result.botDisplayName ?? result.botId ?? 'Telegram bot'
      setTelegramSuccess(`Connected to ${identity}.`)
      await loadTelegram()
    } catch (error) { setTelegramError(toErrorMessage(error)) } finally { setIsTestingTelegram(false) }
  }

  const handleDisableTelegram = async () => {
    if (!hasSelectedIntegrationManager) return
    setTelegramError(null); setTelegramSuccess(null); setIsDisablingTelegram(true)
    try {
      const disabled = await disableTelegramSettings(wsUrl, selectedIntegrationManagerId)
      setTelegramConfig(disabled.config); setTelegramDraft(toTelegramDraft(disabled.config)); setTelegramStatusFromApi(disabled.status)
      setTelegramSuccess('Telegram integration disabled.')
    } catch (error) { setTelegramError(toErrorMessage(error)) } finally { setIsDisablingTelegram(false) }
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Manager picker */}
      <SettingsSection
        label="Manager"
        description="Choose the shared integration default or a manager-specific override."
      >
        <SettingsWithCTA label="Configuration scope" description="Select which integration config to edit">
          <Select
            value={selectedIntegrationManagerId}
            onValueChange={(value) => {
              setSelectedIntegrationManagerId(value)
              setTelegramError(null); setTelegramSuccess(null)
            }}
          >
            <SelectTrigger className="w-full sm:w-64">
              <SelectValue placeholder="Select configuration scope" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SHARED_INTEGRATION_MANAGER_ID}>Shared (all managers)</SelectItem>
              {managerOptions.length === 0 ? (
                <SelectItem value="__no_manager__" disabled>No manager overrides available</SelectItem>
              ) : (
                managerOptions.map((m) => {
                  const profileId = resolveManagerProfileId(m)
                  return (
                    <SelectItem key={profileId} value={profileId}>
                      {profileId}
                    </SelectItem>
                  )
                })
              )}
            </SelectContent>
          </Select>
          {isSharedIntegrationSelection ? (
            <p className="text-[11px] text-muted-foreground">
              Shared settings are used by managers that do not have a custom override.
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              This manager override takes priority over the shared integration settings.
            </p>
          )}
        </SettingsWithCTA>
      </SettingsSection>

      {/* Telegram */}
      <SettingsSection
        label="Telegram"
        description="Bot API + long polling delivery"
        cta={<TelegramConnectionBadge status={effectiveTelegramStatus} />}
      >
        {effectiveTelegramStatus?.message ? <p className="text-[11px] text-muted-foreground">{effectiveTelegramStatus.message}</p> : null}
        <FeedbackBanner error={telegramError} success={telegramSuccess} />
        {!hasSelectedIntegrationManager ? (
          <p className="text-[11px] text-muted-foreground">Select a manager to configure Telegram integration.</p>
        ) : isLoadingTelegram || !telegramDraft ? (
          <div className="flex items-center justify-center py-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <ToggleRow label="Enable Telegram integration" description="Telegram stays opt-in until explicitly enabled." checked={telegramDraft.enabled} onChange={(next) => setTelegramDraft((prev) => (prev ? { ...prev, enabled: next } : prev))} />
              <ToggleRow label="Drop pending updates on start" description="Skip backlog and only process new updates after startup." checked={telegramDraft.dropPendingUpdatesOnStart} onChange={(next) => setTelegramDraft((prev) => (prev ? { ...prev, dropPendingUpdatesOnStart: next } : prev))} />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <ToggleRow label="Disable link previews" description="Send outbound messages without link preview cards." checked={telegramDraft.disableLinkPreview} onChange={(next) => setTelegramDraft((prev) => (prev ? { ...prev, disableLinkPreview: next } : prev))} />
              <ToggleRow label="Reply to inbound message" description="Reply to the triggering Telegram message by default." checked={telegramDraft.replyToInboundMessageByDefault} onChange={(next) => setTelegramDraft((prev) => (prev ? { ...prev, replyToInboundMessageByDefault: next } : prev))} />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <ToggleRow label="Allow image attachments" description="Ingest Telegram image uploads as Forge attachments." checked={telegramDraft.allowImages} onChange={(next) => setTelegramDraft((prev) => (prev ? { ...prev, allowImages: next } : prev))} />
              <ToggleRow label="Allow text attachments" description="Include text-like documents as prompt attachments." checked={telegramDraft.allowText} onChange={(next) => setTelegramDraft((prev) => (prev ? { ...prev, allowText: next } : prev))} />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <ToggleRow label="Allow binary attachments" description="Enable binary document ingestion (base64)." checked={telegramDraft.allowBinary} onChange={(next) => setTelegramDraft((prev) => (prev ? { ...prev, allowBinary: next } : prev))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="telegram-bot-token" className="text-xs font-medium text-muted-foreground">Bot token</Label>
              <Input id="telegram-bot-token" type="password" value={telegramDraft.botToken} onChange={(e) => setTelegramDraft((prev) => (prev ? { ...prev, botToken: e.target.value } : prev))} placeholder={telegramConfig?.botToken ?? '123456:ABC-...'} autoComplete="off" spellCheck={false} />
              <p className="text-[11px] text-muted-foreground">{telegramConfig?.hasBotToken ? 'Token saved. Enter a new value to rotate.' : 'Token not set yet.'}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="telegram-allowed-user-ids" className="text-xs font-medium text-muted-foreground">Allowed users</Label>
              <Input id="telegram-allowed-user-ids" value={telegramDraft.allowedUserIds.join(', ')} onChange={(e) => setTelegramDraft((prev) => (prev ? { ...prev, allowedUserIds: parseCommaSeparated(e.target.value) } : prev))} placeholder="123456789, 987654321" />
              <p className="text-[11px] text-muted-foreground">Leave empty to allow all users.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="telegram-timeout-seconds" className="text-xs font-medium text-muted-foreground">Poll timeout (seconds)</Label>
                <Input id="telegram-timeout-seconds" value={telegramDraft.timeoutSeconds} onChange={(e) => setTelegramDraft((prev) => (prev ? { ...prev, timeoutSeconds: e.target.value } : prev))} placeholder="25" inputMode="numeric" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="telegram-limit" className="text-xs font-medium text-muted-foreground">Poll limit</Label>
                <Input id="telegram-limit" value={telegramDraft.limit} onChange={(e) => setTelegramDraft((prev) => (prev ? { ...prev, limit: e.target.value } : prev))} placeholder="100" inputMode="numeric" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="telegram-max-file-bytes" className="text-xs font-medium text-muted-foreground">Max attachment size (bytes)</Label>
              <Input id="telegram-max-file-bytes" value={telegramDraft.maxFileBytes} onChange={(e) => setTelegramDraft((prev) => (prev ? { ...prev, maxFileBytes: e.target.value } : prev))} placeholder="10485760" inputMode="numeric" />
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => void handleTestTelegram()} disabled={isTestingTelegram || !hasSelectedIntegrationManager} className="gap-1.5">
                {isTestingTelegram ? <Loader2 className="size-3.5 animate-spin" /> : <TestTube2 className="size-3.5" />}
                {isTestingTelegram ? 'Testing...' : 'Test connection'}
              </Button>
              <Button type="button" variant="outline" onClick={() => void handleDisableTelegram()} disabled={isDisablingTelegram || !hasSelectedIntegrationManager} className="gap-1.5">
                {isDisablingTelegram ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
                {isDisablingTelegram ? 'Disabling...' : 'Disable'}
              </Button>
              <Button type="button" onClick={() => void handleSaveTelegram()} disabled={isSavingTelegram || !hasSelectedIntegrationManager} className="gap-1.5">
                {isSavingTelegram ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                {isSavingTelegram ? 'Saving...' : 'Save Telegram settings'}
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>
    </div>
  )
}
