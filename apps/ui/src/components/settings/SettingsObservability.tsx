import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2, Loader2, RefreshCw, Send, XCircle } from 'lucide-react'
import type {
  PhoenixObservabilityContentMode,
  PhoenixObservabilitySettings,
  PhoenixObservabilitySettingsResponse,
  PhoenixObservabilityStatus,
} from '@forge/protocol'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { SettingsApiClient } from './settings-api-client'
import { SettingsSection, SettingsWithCTA } from './settings-row'
import {
  buildPhoenixObservabilityPatchFromSettings,
  fetchPhoenixObservabilitySettings,
  fetchPhoenixObservabilityStatus,
  testPhoenixObservabilityConnection,
  updatePhoenixObservabilitySettings,
} from './observability-api'

interface SettingsObservabilityProps {
  apiClient: SettingsApiClient
}

interface LoadState {
  settings: PhoenixObservabilitySettings | null
  status: PhoenixObservabilityStatus | null
}

export function SettingsObservability({ apiClient }: SettingsObservabilityProps) {
  const [state, setState] = useState<LoadState>({ settings: null, status: null })
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testMessage, setTestMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchPhoenixObservabilitySettings(apiClient)
      setState({ settings: result.settings, status: result.status })
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [apiClient])

  useEffect(() => {
    void load()
  }, [load])

  const settings = state.settings
  const status = state.status

  const updateLocalSettings = useCallback((updater: (current: PhoenixObservabilitySettings) => PhoenixObservabilitySettings) => {
    setSaved(false)
    setTestMessage(null)
    setState((current) => current.settings ? { ...current, settings: updater(current.settings) } : current)
  }, [])

  const save = useCallback(async () => {
    if (!settings) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const result: PhoenixObservabilitySettingsResponse = await updatePhoenixObservabilitySettings(
        apiClient,
        buildPhoenixObservabilityPatchFromSettings(settings),
      )
      setState({ settings: result.settings, status: result.status })
      setSaved(true)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }, [apiClient, settings])

  const refreshStatus = useCallback(async () => {
    setError(null)
    try {
      const next = await fetchPhoenixObservabilityStatus(apiClient)
      setState((current) => ({ ...current, status: next }))
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError))
    }
  }, [apiClient])

  const testConnection = useCallback(async () => {
    if (!settings) return
    setTesting(true)
    setError(null)
    setTestMessage(null)
    try {
      const result = await testPhoenixObservabilityConnection(
        apiClient,
        buildPhoenixObservabilityPatchFromSettings(settings),
      )
      setState((current) => ({ ...current, status: result.status }))
      setTestMessage(result.ok ? 'Test span exported successfully.' : (result.error ?? 'Test export failed.'))
    } catch (testError) {
      setTestMessage(testError instanceof Error ? testError.message : String(testError))
    } finally {
      setTesting(false)
    }
  }, [apiClient, settings])

  const extraPatterns = useMemo(
    () => settings?.privacy.extraRedactionPatterns.join('\n') ?? '',
    [settings?.privacy.extraRedactionPatterns],
  )

  if (loading && !settings) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading Phoenix observability settings…
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        {error ?? 'Unable to load Phoenix observability settings.'}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">Phoenix Observability</h2>
          <p className="text-sm text-muted-foreground">
            Export content-rich Forge traces to a local Phoenix OTLP endpoint. Builder-only, fail-open, and loopback-restricted.
          </p>
        </div>
        <StatusBadge status={status} />
      </div>

      {error ? (
        <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
      {saved ? (
        <div className="flex gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          <span>Settings saved.</span>
        </div>
      ) : null}
      {testMessage ? (
        <div className="flex gap-2 rounded-md border border-border bg-card/50 p-3 text-sm text-muted-foreground">
          <Send className="mt-0.5 size-4 shrink-0" />
          <span>{testMessage}</span>
        </div>
      ) : null}

      <SettingsSection label="Exporter" description="Phoenix Desktop defaults to http://127.0.0.1:6006/v1/traces.">
        <SettingsWithCTA label="Enable Phoenix export" description="When disabled, instrumentation stays inert and no spans are exported.">
          <Switch
            checked={settings.enabled}
            onCheckedChange={(enabled) => updateLocalSettings((current) => ({ ...current, enabled }))}
            aria-label="Enable Phoenix observability"
          />
        </SettingsWithCTA>
        <SettingsWithCTA label="Endpoint" description="Loopback HTTP(S) only; query strings and fragments are rejected.">
          <Input
            value={settings.endpoint}
            onChange={(event) => updateLocalSettings((current) => ({ ...current, endpoint: event.target.value }))}
            className="font-mono text-xs sm:max-w-md"
          />
        </SettingsWithCTA>
        <SettingsWithCTA label="Project name" description="Shown as the Phoenix project/dataset grouping label.">
          <Input
            value={settings.projectName ?? ''}
            onChange={(event) => updateLocalSettings((current) => ({ ...current, projectName: event.target.value }))}
            className="sm:max-w-xs"
          />
        </SettingsWithCTA>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="button" size="sm" onClick={save} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
            Save
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={testConnection} disabled={testing} className="gap-1.5">
            {testing ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            Test export
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={refreshStatus} className="gap-1.5">
            <RefreshCw className="size-3.5" />
            Refresh status
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection label="Capture" description="Tune what content Forge includes in local Phoenix traces.">
        <SettingsWithCTA label="Content mode" description="Metadata-only keeps spans useful without prompt/model body capture.">
          <Select
            value={settings.contentMode}
            onValueChange={(value) => updateLocalSettings((current) => ({ ...current, contentMode: value as PhoenixObservabilityContentMode }))}
          >
            <SelectTrigger style={{ width: 180 }}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rich">Rich</SelectItem>
              <SelectItem value="metadata_only">Metadata only</SelectItem>
            </SelectContent>
          </Select>
        </SettingsWithCTA>
        {(
          [
            ['prompts', 'Resolved prompts'],
            ['modelInputs', 'Model inputs'],
            ['modelOutputs', 'Model outputs'],
            ['toolInputs', 'Tool inputs'],
            ['toolResults', 'Tool results'],
            ['feedbackComments', 'Feedback comments'],
            ['imageData', 'Image data'],
          ] as const
        ).map(([key, label]) => (
          <SettingsWithCTA key={key} label={label}>
            <Switch
              checked={settings.capture[key]}
              onCheckedChange={(checked) => updateLocalSettings((current) => ({
                ...current,
                capture: { ...current.capture, [key]: checked },
              }))}
              aria-label={label}
            />
          </SettingsWithCTA>
        ))}
      </SettingsSection>

      <SettingsSection label="Privacy and limits" description="Redaction and caps are enforced in the backend before export.">
        <SettingsWithCTA label="Redaction" description="Apply built-in secret/path redaction plus the custom patterns below.">
          <Switch
            checked={settings.privacy.redactionEnabled}
            onCheckedChange={(checked) => updateLocalSettings((current) => ({
              ...current,
              privacy: { ...current.privacy, redactionEnabled: checked },
            }))}
            aria-label="Enable redaction"
          />
        </SettingsWithCTA>
        <SettingsWithCTA label="Display names" description="Include visible agent names instead of redacting them.">
          <Switch
            checked={settings.privacy.includeDisplayNames}
            onCheckedChange={(checked) => updateLocalSettings((current) => ({
              ...current,
              privacy: { ...current.privacy, includeDisplayNames: checked },
            }))}
            aria-label="Include display names"
          />
        </SettingsWithCTA>
        <div className="grid gap-3 sm:grid-cols-3">
          <NumberField label="Content cap" value={settings.privacy.maxContentChars} onChange={(value) => updateLocalSettings((current) => ({ ...current, privacy: { ...current.privacy, maxContentChars: value } }))} />
          <NumberField label="Attribute cap" value={settings.privacy.maxAttributeChars} onChange={(value) => updateLocalSettings((current) => ({ ...current, privacy: { ...current.privacy, maxAttributeChars: value } }))} />
          <NumberField label="Span cap" value={settings.privacy.maxSpanContentChars} onChange={(value) => updateLocalSettings((current) => ({ ...current, privacy: { ...current.privacy, maxSpanContentChars: value } }))} />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Extra redaction regexes</label>
          <Textarea
            value={extraPatterns}
            onChange={(event) => updateLocalSettings((current) => ({
              ...current,
              privacy: {
                ...current.privacy,
                extraRedactionPatterns: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean),
              },
            }))}
            placeholder="One regex per line"
            className="min-h-24 font-mono text-xs"
          />
        </div>
      </SettingsSection>

      {status ? (
        <SettingsSection label="Operational status">
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <StatusItem label="Endpoint" value={status.exporter.endpoint} />
            <StatusItem label="Project" value={status.exporter.projectName} />
            <StatusItem label="Last success" value={status.exporter.lastSuccessfulExportAt ?? 'Never'} />
            <StatusItem label="Last error" value={status.exporter.lastErrorMessage ?? 'None'} tone={status.exporter.lastErrorMessage ? 'danger' : undefined} />
          </div>
          <Separator />
          <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
            {Object.entries(status.counters).map(([key, value]) => (
              <div key={key} className="rounded-md border border-border/60 bg-card/40 p-2">
                <div className="font-mono text-foreground">{value}</div>
                <div>{key}</div>
              </div>
            ))}
          </div>
        </SettingsSection>
      ) : null}
    </div>
  )
}

function StatusBadge({ status }: { status: PhoenixObservabilityStatus | null }) {
  if (!status?.enabled) {
    return <Badge variant="outline" className="gap-1 text-muted-foreground"><Activity className="size-3" />Disabled</Badge>
  }
  if (status.exporter.lastErrorMessage) {
    return <Badge variant="outline" className="gap-1 border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"><XCircle className="size-3" />Error</Badge>
  }
  return <Badge variant="outline" className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="size-3" />Active</Badge>
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="space-y-1.5 text-sm font-medium">
      <span>{label}</span>
      <Input
        type="number"
        min={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value) || 1)}
        className="font-mono text-xs"
      />
    </label>
  )
}

function StatusItem({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  return (
    <div className="rounded-md border border-border/60 bg-card/40 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={tone === 'danger' ? 'break-words text-destructive' : 'break-words text-foreground'}>{value}</div>
    </div>
  )
}
