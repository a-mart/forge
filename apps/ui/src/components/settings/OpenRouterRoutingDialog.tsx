import { useEffect, useRef, useState } from 'react'
import { OPENROUTER_QUANTIZATIONS, resolveOpenRouterRouting, type OpenRouterEndpointsResponse, type OpenRouterRoutingConfig, type OpenRouterRoutingPolicy, type OpenRouterRoutingSettingsResponse } from '@forge/protocol'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import type { SettingsApiClient } from './settings-api-client'
import { fetchOpenRouterEndpoints, fetchOpenRouterRouting, saveOpenRouterRouting } from './openrouter-routing-api'
import { routingSummary } from './openrouter-routing-summary'
import { RoutingDisclosure, RoutingSource, RoutingSwitchRow } from './OpenRouterRoutingFields'
import { OpenRouterProviderPicker } from './OpenRouterProviderPicker'



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
  // Read controls independently of combined-policy validation, so an invalid draft
  // never makes unrelated switches or provider selections appear to reset.
  const value = <K extends keyof OpenRouterRoutingConfig>(key: K) => draft[key] === undefined ? inherited[key] : draft[key]
  const floor = (key: keyof OpenRouterRoutingConfig) => !!modelId && ((key === 'zdr' && inherited.zdr === true) || (key === 'data_collection' && inherited.data_collection === 'deny'))
  const source = (key: keyof OpenRouterRoutingConfig, label: string, customize?: () => void, prefix?: string) => <RoutingSource label={label} prefix={prefix} value={draft[key]} model={!!modelId} required={floor(key)} onReset={() => update(key, undefined)} onClear={() => update(key, null)} onCustomize={customize} />
  const toggle = (key: 'zdr' | 'data_collection' | 'allow_fallbacks' | 'require_parameters', label: string, description?: string) => <RoutingSwitchRow label={label} description={description} help={key === 'zdr' ? 'ZDR permits implicit in-memory prompt caching. Account guardrails still apply.' : key === 'data_collection' ? 'Collection and training are separate from retention; blocking collection is not a ZDR guarantee.' : undefined} source={source(key, label)} disabled={floor(key)} checked={floor(key) || (key === 'data_collection' ? value(key) === 'deny' : key === 'allow_fallbacks' ? value(key) !== false : value(key) === true)} onChange={(checked) => update(key, key === 'data_collection' ? checked ? 'deny' : 'allow' : checked)} />
  const providerMode = value('only') ? 'only' : value('order') ? 'prefer' : 'auto'
  const chooseProviderMode = (next: string) => setDraft((previous) => {
    if (next === 'auto') return { ...previous, only: null, order: null }
    if (next === 'prefer') return { ...previous, only: null, order: [...(value('order') ?? [])] }
    // Only and order are compatible. Preserve any saved / inherited preference.
    return { ...previous, only: [...(value('only') ?? [])] }
  })
  const providers = (key: 'order' | 'only' | 'ignore', label: string) => <div className="space-y-3">
    <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-medium">{label}</h3>{source(key, label, () => update(key, [...(value(key) ?? [])]))}</div>
    {value(key) ? <OpenRouterProviderPicker label={label} value={value(key) ?? []} onChange={(next) => update(key, next)} metadata={metadata} ordered={key === 'order'} /> : <Button type="button" size="sm" variant="ghost" className="h-7 px-0 text-xs text-muted-foreground" onClick={() => update(key, [])}>Add {label.toLowerCase()}</Button>}
  </div>
  const dirty = settings && JSON.stringify(draft) !== JSON.stringify(modelId ? settings.routing ?? {} : settings.defaults)
  const hardConstraints = effective.zdr || effective.data_collection === 'deny' || effective.only || effective.ignore || effective.allow_fallbacks === false || effective.require_parameters || effective.max_price || effective.quantizations

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
  return <TooltipProvider><Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
    <DialogContent className="flex max-h-[min(90dvh,850px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]">
      <DialogHeader className="shrink-0 border-b border-border/60 px-6 pb-5 pt-6 sm:px-7">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">OpenRouter / {modelId ? 'Model routing' : 'Shared routing'}</p>
        <DialogTitle className="break-words pr-5 text-xl">{modelId ?? 'OpenRouter defaults'}</DialogTitle>
        <DialogDescription className="text-xs">{modelId ? 'Shared across agents using this model on this backend.' : 'Shared across all OpenRouter models on this backend.'}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto overscroll-contain px-6 sm:px-7">
        {error ? <p role="alert" className="mt-4 text-xs text-destructive">{error}</p> : null}
        {stale ? <div role="alert" className="mt-4 space-y-2 rounded-md bg-muted p-3 text-xs"><p>Settings changed or the save failed. Your draft is retained. Reload to review current settings; this discards your draft.</p><Button type="button" size="sm" variant="outline" disabled={saving || loading} onClick={() => setReloadKey((key) => key + 1)}>Reload settings</Button></div> : null}
        {loading ? <p role="status" className="py-6 text-sm">Loading routing…</p> : settings ? <fieldset disabled={saving} className="min-w-0">
          <section className="space-y-5 border-b border-border/60 py-5" aria-label="Privacy">
            <h2 className="text-[13px] font-semibold">Privacy</h2>
            {toggle('zdr', 'Zero data retention', 'Use only ZDR-eligible endpoints')}
            {toggle('data_collection', 'Block data collection', 'Disallow provider collection and training')}
            {floor('zdr') || floor('data_collection') ? <p className="rounded-md bg-muted/60 px-3 py-2 text-[11px] text-muted-foreground">Shared privacy requirements cannot be weakened for this model.</p> : null}
          </section>
          <section className="space-y-4 border-b border-border/60 py-5" aria-label="Providers">
            <div className="flex items-center justify-between"><h2 className="text-[13px] font-semibold">Providers</h2><Button type="button" variant="ghost" className="h-6 px-0 text-[11px] text-muted-foreground" onClick={() => setDraft((previous) => { const next = { ...previous }; delete next.only; delete next.order; return next })}>{modelId ? 'Use shared defaults' : 'Use defaults'}</Button></div>
            <div role="group" aria-label="Provider routing mode" className="flex gap-1 rounded-lg border border-border/60 bg-muted/50 p-1">
              {([['auto', 'Automatic'], ['prefer', 'Prefer providers'], ['only', 'Only selected']] as const).map(([mode, label]) => <Button key={mode} type="button" variant="ghost" aria-pressed={providerMode === mode} className={`h-8 min-w-0 flex-1 px-1 text-xs ${providerMode === mode ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`} onClick={() => chooseProviderMode(mode)}>{label}</Button>)}
            </div>
            {providerMode === 'auto' ? <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[11px] text-muted-foreground">Let OpenRouter choose from eligible providers.</p><div className="flex gap-2">{source('only', 'Allowed providers only', undefined, 'Selection')}{source('order', 'Preferred providers', undefined, 'Preference')}</div></div> : <>
              {providers(providerMode === 'only' ? 'only' : 'order', providerMode === 'only' ? 'Allowed providers only' : 'Preferred providers')}
              <p className="text-[11px] text-muted-foreground">{providerMode === 'only' ? 'Requests stay within your selected providers.' : 'Selection order sets preference. Other eligible providers may be used.'}</p>
              {providerMode === 'only' ? <RoutingDisclosure title="Preference within selection" hint={value('order') ? `${value('order')?.length} preferred` : 'Optional'}>{providers('order', 'Preferred providers')}</RoutingDisclosure> : null}
            </>}
            {toggle('allow_fallbacks', 'Provider fallback')}
            {hardConstraints ? <p className="rounded-md bg-muted/60 px-3 py-2 text-[11px] text-muted-foreground">Hard constraints disable Forge’s automatic model fallback.</p> : null}
          </section>
          <RoutingDisclosure title="Advanced routing" hint="Price, speed & compatibility">
            <div className="flex flex-wrap items-center justify-between gap-2"><label htmlFor="routing-sort" className="text-xs">Optimize for</label><div className="flex items-center gap-2">{source('sort', 'Routing strategy')}<Select value={value('sort') ?? 'clear'} onValueChange={(next) => update('sort', next === 'clear' ? null : next as 'price' | 'latency' | 'throughput')}><SelectTrigger id="routing-sort" aria-label="Routing strategy" size="sm" className="text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="clear">OpenRouter default</SelectItem><SelectItem value="price">Lowest price</SelectItem><SelectItem value="latency">Lowest latency</SelectItem><SelectItem value="throughput">Highest throughput</SelectItem></SelectContent></Select></div></div>
            {value('order') ? <p className="text-[11px] text-muted-foreground">Sorting conflicts with preferred order. Clear Preferred providers via its source menu before choosing a strategy.</p> : null}
            <div className="space-y-3"><div className="flex items-center justify-between"><div><h3 className="text-xs">Price limits</h3><p className="mt-1 text-[11px] text-muted-foreground">USD per million tokens · not a session budget</p></div>{source('max_price', 'Price ceilings')}</div>
              <div className="grid grid-cols-2 gap-3">{(['prompt', 'completion'] as const).map((part) => <label key={part} className="space-y-1 text-[11px] text-muted-foreground">{part === 'prompt' ? 'Input' : 'Output'}<Input className="h-8 text-xs" aria-label={`${part === 'prompt' ? 'Input' : 'Output'} price ceiling`} placeholder="No limit" type="number" min="0" step="any" value={value('max_price')?.[part] ?? ''} onChange={(event) => { const price = { ...value('max_price') }; if (event.target.value === '') delete price[part]; else price[part] = Number(event.target.value); update('max_price', Object.keys(price).length ? price : null) }} /></label>)}</div>
            </div>
            {toggle('require_parameters', 'Require parameter support')}
            <div className="space-y-3"><div className="flex items-center justify-between"><h3 className="text-xs">Allowed quantizations</h3>{source('quantizations', 'Allowed quantizations')}</div><div className="flex flex-wrap gap-x-4 gap-y-2">{OPENROUTER_QUANTIZATIONS.map((quantization) => <label key={quantization} className="flex items-center gap-1.5 text-xs"><input className="accent-primary" type="checkbox" checked={value('quantizations')?.includes(quantization) ?? false} onChange={(event) => { const next = event.target.checked ? [...(value('quantizations') ?? []), quantization] : value('quantizations')?.filter((item) => item !== quantization); update('quantizations', next?.length ? next : null) }} />{quantization}</label>)}</div><p className="text-[11px] text-muted-foreground">None selected allows any quantization.</p></div>
            {providers('ignore', 'Excluded providers')}
            <Button type="button" variant="ghost" className="h-7 px-0 text-xs text-muted-foreground" onClick={() => setDraft({})}>{modelId ? 'Reset all to inherit' : 'Reset all defaults'}</Button>
          </RoutingDisclosure>
          <RoutingDisclosure title="Scope & privacy details">
            <div className="space-y-3 text-xs leading-relaxed text-muted-foreground">
              <p>Shared on this backend, not just this project. Changes apply to subsequent model calls, not calls already in progress. {modelId ? 'Only this exact model ID is affected.' : 'Defaults apply across OpenRouter models.'}</p>
              <p>ZDR and no collection/training are separate policies. ZDR permits implicit in-memory prompt caching. These filters govern OpenRouter inference, not Forge local transcripts, tools, or separately configured non-OpenRouter summarization. They do not certify compliance; account guardrails still apply.</p>
              <p>Source menus let each field use shared defaults or explicitly clear a restriction. Lists and price limits replace the entire inherited field, never merge. Shared privacy requirements always apply, even over saved false values or clears.</p>
              <p>Provider fallback stays within hard filters. No matching endpoint means failure, not relaxed filters. Base provider slugs may include endpoint variants; model publishers are not necessarily serving providers. Endpoint metadata is advisory, not proof of account-specific routability or collection policy. Saving does not run a paid test.</p>
              <p><a className="underline" href="https://openrouter.ai/docs/guides/features/zdr" target="_blank" rel="noreferrer">ZDR policy</a> · <a className="underline" href="https://openrouter.ai/docs/guides/routing/provider-selection" target="_blank" rel="noreferrer">Provider routing</a> · <a className="underline" href="https://openrouter.ai/settings/privacy" target="_blank" rel="noreferrer">Account privacy</a></p>
              {modelId ? <><p>Endpoint metadata: {metadata?.status ?? 'unavailable'} · ZDR metadata: {metadata?.zdrStatus ?? 'unavailable'}</p><Button type="button" size="sm" variant="outline" onClick={() => setRefreshKey((key) => key + 1)}>Refresh endpoints</Button>{metadataError ? <p role="status">{metadataError}</p> : null}</> : <p>For shared defaults, enter real provider or endpoint slugs manually.</p>}
              {!stale ? <Button type="button" size="sm" variant="outline" disabled={saving || loading} onClick={() => setReloadKey((key) => key + 1)}>Reload settings</Button> : null}
            </div>
          </RoutingDisclosure>
        </fieldset> : <Button type="button" variant="outline" className="my-4" onClick={() => setReloadKey((key) => key + 1)}>Reload settings</Button>}
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-border/60 bg-muted/20 px-6 py-4 sm:px-7">
        <section aria-label="Effective routing preview" aria-live="polite" className="min-w-0 space-y-1 text-[11px] text-muted-foreground">
          {validation ? <p role="alert" className="text-destructive">{validation}</p> : <p className="line-clamp-2" title={routingSummary(effective)}>{routingSummary(effective)}</p>}
          {dirty ? <p>Unsaved changes · next model call</p> : null}
        </section>
        <div className="flex shrink-0 gap-2"><Button type="button" variant="outline" size="sm" disabled={saving} onClick={onClose}>Cancel</Button><Button type="button" size="sm" disabled={saving || loading || !settings || !!validation || stale} onClick={() => void save()}>{saving ? 'Saving…' : 'Save changes'}</Button></div>
      </footer>
    </DialogContent>
  </Dialog></TooltipProvider>
}
