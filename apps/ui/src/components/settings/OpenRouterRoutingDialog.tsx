import { useEffect, useRef, useState, type ReactNode } from 'react'
import { OPENROUTER_QUANTIZATIONS, resolveOpenRouterRouting, type OpenRouterEndpointsResponse, type OpenRouterRoutingConfig, type OpenRouterRoutingPolicy, type OpenRouterRoutingSettingsResponse } from '@forge/protocol'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { SettingsApiClient } from './settings-api-client'
import { fetchOpenRouterEndpoints, fetchOpenRouterRouting, saveOpenRouterRouting } from './openrouter-routing-api'
import { routingSummary } from './openrouter-routing-summary'
import { OpenRouterProviderPicker } from './OpenRouterProviderPicker'


function Field({ label, children, description }: { label: string; children: ReactNode; description?: string }) {
  return <fieldset className="space-y-2 rounded-md border border-border/60 p-3"><legend className="px-1 text-sm font-medium">{label}</legend>{description ? <p className="text-xs text-muted-foreground">{description}</p> : null}{children}</fieldset>
}
const selectClass = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm'

export function OpenRouterRoutingDialog({ clientOrWsUrl, modelId, modelConfigChangeKey, onClose, onSaved }: {
  clientOrWsUrl: SettingsApiClient | string | undefined
  modelId?: string
  modelConfigChangeKey: number
  onClose: () => void
  onSaved: () => void
}) {
  const [settings, setSettings] = useState<OpenRouterRoutingSettingsResponse | null>(null)
  const [draft, setDraft] = useState<OpenRouterRoutingConfig>({})
  const [metadata, setMetadata] = useState<OpenRouterEndpointsResponse | null>(null)
  const [metadataError, setMetadataError] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)
  const [stale, setStale] = useState(false)
  const initialEvent = useRef(modelConfigChangeKey)
  // The parent keys this editor by backend and model. Cleanup prevents old-origin loads.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void fetchOpenRouterRouting(clientOrWsUrl, modelId).then((response) => {
      if (cancelled) return
      setSettings(response)
      setDraft(modelId ? response.routing ?? {} : response.defaults)
      setStale(false)
    }).catch((reason: unknown) => { if (!cancelled) setError(String(reason)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [clientOrWsUrl, modelId, reloadKey])
  useEffect(() => {
    if (initialEvent.current !== modelConfigChangeKey) {
      initialEvent.current = modelConfigChangeKey
      setStale(true)
    }
  }, [modelConfigChangeKey])
  useEffect(() => {
    if (!modelId) return
    let cancelled = false
    setMetadataError('')
    void fetchOpenRouterEndpoints(clientOrWsUrl, modelId, refreshKey > 0).then((response) => {
      if (!cancelled) setMetadata(response)
    }).catch(() => {
      if (!cancelled) {
        setMetadata((previous) => previous ? { ...previous, status: 'stale', zdrStatus: 'unavailable' } : null)
        setMetadataError('Endpoint discovery unavailable. Selections remain unchanged; metadata is unverified.')
      }
    })
    return () => { cancelled = true }
  }, [clientOrWsUrl, modelId, refreshKey])

  const update = <K extends keyof OpenRouterRoutingConfig>(key: K, value: OpenRouterRoutingConfig[K]) => setDraft((previous) => {
    const next = { ...previous }
    if (value === undefined) delete next[key]
    else next[key] = value
    return next
  })
  let effective: OpenRouterRoutingPolicy = {}
  let validation = ''
  try { effective = resolveOpenRouterRouting(modelId ? settings?.defaults : {}, draft) } catch (reason) { validation = reason instanceof Error ? reason.message : String(reason) }
  const inherited = modelId ? settings?.defaults ?? {} : {}
  const mode = (key: keyof OpenRouterRoutingConfig) => draft[key] === undefined ? 'inherit' : draft[key] === null ? 'clear' : 'custom'
  const modeOptions = <><option value="inherit">{modelId ? 'Inherit Forge default' : 'Unset (OpenRouter default)'}</option><option value="clear">OpenRouter default / no restriction (clear)</option></>
  const scalar = (key: 'zdr' | 'data_collection' | 'allow_fallbacks' | 'require_parameters' | 'sort', label: string, options: [string, string][], description: string) => {
    const floor = !!modelId && ((key === 'zdr' && inherited.zdr === true) || (key === 'data_collection' && inherited.data_collection === 'deny'))
    return <Field label={label} description={description}>
      <select className={selectClass} aria-label={label} value={draft[key] === undefined ? 'inherit' : draft[key] === null ? 'clear' : String(draft[key])} onChange={(event) => {
        const value = event.target.value
        update(key, value === 'inherit' ? undefined : value === 'clear' ? null : value === 'true' ? true : value === 'false' ? false : value as 'allow' | 'deny' | 'price' | 'throughput' | 'latency')
      }}>
        <option value="inherit">{modelId ? 'Inherit Forge default' : 'Unset (OpenRouter default)'}</option>
        <option value="clear" disabled={floor}>OpenRouter default / no restriction (clear)</option>
        {options.map(([value, text]) => <option key={value} value={value} disabled={floor && value !== 'true' && value !== 'deny'}>{text}</option>)}
      </select>
      {floor ? <p className="text-xs font-medium">Shared privacy floor enforced. This model cannot weaken it, including previously saved clears.</p> : null}
      {modelId ? <p className="text-xs text-muted-foreground">Forge default: {String(inherited[key] ?? 'OpenRouter default')}</p> : null}
    </Field>
  }
  const providers = (key: 'order' | 'only' | 'ignore', label: string, description: string) => <Field label={label} description={description}>
    <select className={selectClass} aria-label={`${label} mode`} value={mode(key)} onChange={(event) => update(key, event.target.value === 'inherit' ? undefined : event.target.value === 'clear' ? null : [...(inherited[key] ?? [])])}>
      {modeOptions}<option value="custom">Custom list (replaces inherited list)</option>
    </select>
    {modelId ? <p className="break-all text-xs text-muted-foreground">Forge default: {inherited[key]?.join(', ') || 'No restriction'}</p> : null}
    {mode(key) === 'custom' ? <OpenRouterProviderPicker label={label} value={draft[key] ?? []} onChange={(value) => update(key, value)} metadata={metadata} ordered={key === 'order'} /> : null}
  </Field>

  const save = async () => {
    if (!settings || validation || stale) return
    setSaving(true)
    setError('')
    try {
      await saveOpenRouterRouting(clientOrWsUrl, modelId, settings.revision, draft)
      onSaved()
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      // Never retry a failed write automatically, especially a revision conflict.
      setStale(true)
    } finally { setSaving(false) }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>{modelId ? `Configure routing: ${modelId}` : 'OpenRouter defaults'}</DialogTitle>
        <DialogDescription>Shared configuration on the selected backend. Applies to all managers and workers {modelId ? 'using this exact model' : 'using OpenRouter'}, not just this project. Applies to subsequent model calls. Calls already in progress are unchanged.</DialogDescription>
      </DialogHeader>
      <p className="text-xs text-muted-foreground">These filters constrain OpenRouter inference routing only. ZDR is separate from no training/data collection and permits implicit in-memory prompt caching. They do not erase Forge local transcripts, control tools’ data handling or separately configured non-OpenRouter summarization, or certify compliance. Account guardrails still apply.</p>
      <p className="text-xs"><a className="underline" href="https://openrouter.ai/docs/guides/features/zdr" target="_blank" rel="noreferrer">ZDR policy</a> · <a className="underline" href="https://openrouter.ai/docs/guides/routing/provider-selection" target="_blank" rel="noreferrer">Provider routing and policies</a> · <a className="underline" href="https://openrouter.ai/settings/privacy" target="_blank" rel="noreferrer">OpenRouter privacy settings</a></p>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {stale ? <p role="alert" className="text-sm text-amber-700">Settings changed or the save failed. Your draft is retained. Reload settings and review before saving; reload discards the draft.</p> : null}
      <Button type="button" variant="outline" disabled={saving || loading} onClick={() => setReloadKey((key) => key + 1)}>Reload settings</Button>
      {loading ? <p role="status">Loading routing…</p> : settings ? <>
        <fieldset disabled={saving} className="space-y-3">
          {scalar('zdr', 'Require zero data retention', [['true', 'Require ZDR'], ['false', 'No additional requirement']], 'Only eligible zero-retention endpoints. No additional requirement does not disable account-level ZDR.')}
          {scalar('data_collection', 'Provider data collection', [['deny', 'Disallow collection'], ['allow', 'Allow collection']], 'Separate from retention: disallow provider data collection/training. This is not a ZDR guarantee.')}
          {modelId ? <div className="space-y-2 text-xs"><p>Endpoint metadata: {metadata?.status ?? 'unavailable'} · ZDR metadata: {metadata?.zdrStatus ?? 'unavailable'}. Advisory only, not proof of account-specific routability or collection policy.</p><Button type="button" size="sm" variant="outline" onClick={() => setRefreshKey((key) => key + 1)}>Refresh endpoints</Button>{metadataError ? <p role="status">{metadataError}</p> : null}</div> : <p className="text-xs text-muted-foreground">Defaults span all models; enter real provider/endpoint slugs manually. The model publisher is not a serving-provider slug.</p>}
          {providers('order', 'Preferred providers', 'Ordered preference, not a hard allowlist. Other eligible providers may still be used. Use move controls to reorder.')}
          {providers('only', 'Allowed providers only', 'Hard allowlist. A single entry pins a provider; base slugs may include variants. Arrays replace, never merge.')}
          {scalar('allow_fallbacks', 'Provider fallback', [['true', 'Allow eligible provider fallback'], ['false', 'Disable provider fallback']], 'Always bounded by hard routing filters. Hard routing filters disable Forge’s automatic model fallback; OpenRouter endpoint fallback remains controlled by these settings.')}
          {scalar('sort', 'Routing strategy', [['price', 'Lowest price'], ['throughput', 'Highest throughput'], ['latency', 'Lowest latency']], 'Automatic sorting and preferred order are mutually exclusive. To sort while inheriting an order, explicitly clear Preferred providers first (and vice versa).')}
          <details className="space-y-3 rounded-md border p-3"><summary className="cursor-pointer text-sm font-medium">Advanced routing</summary>
            {providers('ignore', 'Excluded providers', 'These providers cannot serve the request. Must not conflict with the allowlist.')}
            {scalar('require_parameters', 'Require parameter support', [['true', 'Require support for all request parameters'], ['false', 'No additional parameter requirement']], 'Recommended for tool-using agents, but may reduce availability. Not enabled automatically.')}
            <Field label="Price ceilings" description="Endpoint filters in USD per million tokens, not a session budget or maximum invoice. Custom prices replace the entire inherited price object: a blank input/output ceiling is unrestricted, not inherited.">
              <select className={selectClass} aria-label="Price ceilings mode" value={mode('max_price')} onChange={(event) => update('max_price', event.target.value === 'inherit' ? undefined : event.target.value === 'clear' ? null : { ...(inherited.max_price ?? {}) })}>{modeOptions}<option value="custom">Custom ceilings (replace both fields)</option></select>
              {modelId ? <p className="text-xs">Forge default: {JSON.stringify(inherited.max_price ?? 'No restriction')}</p> : null}
              {mode('max_price') === 'custom' ? (['prompt', 'completion'] as const).map((part) => <label key={part} className="block text-xs">{part === 'prompt' ? 'Input' : 'Output'} USD / million tokens<Input aria-label={`${part === 'prompt' ? 'Input' : 'Output'} price ceiling`} type="number" min="0" step="any" value={draft.max_price?.[part] ?? ''} onChange={(event) => { const price = { ...draft.max_price }; if (event.target.value === '') delete price[part]; else price[part] = Number(event.target.value); update('max_price', price) }} /></label>) : null}
            </Field>
            <Field label="Allowed quantizations" description="Optional hard filter; can reduce availability.">
              <select className={selectClass} aria-label="Allowed quantizations mode" value={mode('quantizations')} onChange={(event) => update('quantizations', event.target.value === 'inherit' ? undefined : event.target.value === 'clear' ? null : [...(inherited.quantizations ?? [])])}>{modeOptions}<option value="custom">Custom quantizations</option></select>
              {modelId ? <p className="text-xs">Forge default: {inherited.quantizations?.join(', ') || 'No restriction'}</p> : null}
              {mode('quantizations') === 'custom' ? <div className="flex flex-wrap gap-3">{OPENROUTER_QUANTIZATIONS.map((value) => <label key={value} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={draft.quantizations?.includes(value) ?? false} onChange={(event) => update('quantizations', event.target.checked ? [...(draft.quantizations ?? []), value] : draft.quantizations?.filter((item) => item !== value))} />{value}</label>)}</div> : null}
            </Field>
          </details>
          <Button type="button" variant="outline" onClick={() => setDraft({})}>{modelId ? 'Reset all to inherit' : 'Reset all defaults'}</Button>
        </fieldset>
        <section className="space-y-2 rounded-md border bg-muted/30 p-3" aria-label="Effective routing preview" aria-live="polite"><h3 className="text-sm font-semibold">Effective routing preview</h3>{validation ? <p role="alert" className="text-sm text-destructive">{validation}</p> : <><p className="text-xs">{routingSummary(effective)}</p><pre className="overflow-x-auto text-xs">{JSON.stringify(effective, null, 2)}</pre></>}<p className="text-xs text-muted-foreground">Advisory: OpenRouter enforces current availability and account restrictions at request time. No matching endpoint means failure, not relaxed filters. Saving does not run a paid test.</p></section>
        <Button type="button" disabled={saving || !!validation || stale} onClick={() => void save()}>{saving ? 'Saving…' : 'Save routing'}</Button>
      </> : null}
      <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>Cancel</Button>
    </DialogContent>
  </Dialog>
}
