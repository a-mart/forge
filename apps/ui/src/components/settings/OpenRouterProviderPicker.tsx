import { useState } from 'react'
import type { OpenRouterEndpointsResponse } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function OpenRouterProviderPicker({ label, value, onChange, metadata, ordered = false }: {
  label: string
  value: string[]
  onChange: (value: string[]) => void
  metadata: OpenRouterEndpointsResponse | null
  ordered?: boolean
}) {
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const add = (slug: string) => {
    if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(slug) || slug.length > 200) {
      setError('Enter a valid routing slug (letters, numbers, dots, underscores, slashes or hyphens).')
      return
    }
    setError('')
    if (!value.includes(slug)) onChange([...value, slug])
    setQuery('')
  }
  const move = (index: number, direction: number) => {
    const next = [...value]
    ;[next[index], next[index + direction]] = [next[index + direction], next[index]]
    onChange(next)
  }
  const endpoints = metadata?.endpoints ?? []
  const matches = endpoints.filter((endpoint) => `${endpoint.tag} ${endpoint.providerName} ${endpoint.name}`.toLowerCase().includes(query.toLowerCase()))
  return <div className="space-y-2">
    {value.length ? <ol className="divide-y divide-border/60 rounded-md border border-border/60" aria-label={`${label} selected providers`}>
      {value.map((slug, index) => <li key={slug} className="flex items-center gap-2 px-3 py-2 text-xs">
        {ordered ? <span className="text-[10px] text-muted-foreground">{index + 1}</span> : null}
        <div className="min-w-0 flex-1"><span className="break-all">{slug}</span>
          {metadata?.status !== 'fresh' || !endpoints.some((endpoint) => endpoint.tag === slug) ? <p className="mt-0.5 text-[10px] text-muted-foreground">Unverified selection (retained)</p> : null}
        </div>
        {ordered ? <>
          <Button type="button" variant="ghost" className="size-7 p-0" aria-label={`Move ${slug} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</Button>
          <Button type="button" variant="ghost" className="size-7 p-0" aria-label={`Move ${slug} down`} disabled={index === value.length - 1} onClick={() => move(index, 1)}>↓</Button>
        </> : null}
        <Button type="button" variant="ghost" className="size-7 p-0 text-muted-foreground" aria-label={`Remove ${slug} from ${label}`} onClick={() => onChange(value.filter((item) => item !== slug))}>×</Button>
      </li>)}
    </ol> : null}
    <div className="flex gap-2">
      <Input className="h-8 text-xs" aria-label={`Search ${label}`} placeholder="Search providers or enter a slug…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(query.trim()) } }} />
      <Button type="button" variant="outline" size="sm" className="h-8 text-xs" disabled={!query.trim()} onClick={() => add(query.trim())}>Add slug</Button>
    </div>
    {endpoints.length ? <div className="max-h-40 divide-y divide-border/60 overflow-y-auto rounded-md border border-border/60">
      {matches.map((endpoint, index) => <div key={`${endpoint.tag}-${index}`} className="px-3 py-2 text-xs">
        <div className="flex items-center justify-between gap-2"><Button type="button" variant="ghost" className="h-auto min-w-0 justify-start whitespace-normal p-0 text-left text-xs font-normal" disabled={value.includes(endpoint.tag)} onClick={() => add(endpoint.tag)} aria-label={`Add ${endpoint.tag} to ${label}`}>{endpoint.providerName} · {endpoint.tag}</Button><span className="shrink-0 text-[10px] text-muted-foreground">{metadata?.zdrStatus === 'fresh' && metadata.status === 'fresh' && endpoint.zdr === 'eligible' ? 'ZDR eligible*' : 'ZDR unverified'}</span></div>
        <details className="mt-1 text-[10px] text-muted-foreground"><summary className="cursor-pointer">Endpoint details</summary><div className="mt-2 space-y-1">
          <p>{endpoint.name} · {endpoint.tag.includes('/') ? 'Specific endpoint slug' : 'Base provider slug (may include variants)'}</p>
          <p>ZDR advisory: {metadata?.zdrStatus === 'fresh' && metadata.status === 'fresh' ? endpoint.zdr : 'unknown'}; metadata {metadata?.status}</p>
          <p>Input/output USD per million: {endpoint.pricing?.prompt ?? 'unknown'} / {endpoint.pricing?.completion ?? 'unknown'} · Context {endpoint.contextLength ?? 'unknown'} · Output {endpoint.maxCompletionTokens ?? 'unknown'}</p>
          <p>Parameters: {endpoint.supportedParameters.join(', ') || 'unknown'}</p>
        </div></details>
      </div>)}
      {!matches.length ? <p className="p-3 text-xs text-muted-foreground">No matching endpoints. Add a routing slug above.</p> : null}
    </div> : <p className="text-[11px] text-muted-foreground">Discovery unavailable. Saved selections are retained; enter a routing slug above.</p>}
    {endpoints.length ? <p className="text-[10px] text-muted-foreground">*Endpoint metadata is advisory; account eligibility may differ.</p> : null}
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
  </div>
}
