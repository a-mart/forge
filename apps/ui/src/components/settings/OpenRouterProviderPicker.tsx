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
  const [manual, setManual] = useState('')
  const [error, setError] = useState('')
  const add = (slug: string) => {
    if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(slug) || slug.length > 200) {
      setError('Enter a valid routing slug (letters, numbers, dots, underscores, slashes or hyphens).')
      return
    }
    setError('')
    if (!value.includes(slug)) onChange([...value, slug])
    setManual('')
  }
  const move = (index: number, direction: number) => {
    const next = [...value]
    ;[next[index], next[index + direction]] = [next[index + direction], next[index]]
    onChange(next)
  }
  const endpoints = metadata?.endpoints ?? []
  const matches = endpoints.filter((endpoint) => `${endpoint.tag} ${endpoint.providerName} ${endpoint.name}`.toLowerCase().includes(query.toLowerCase()))
  return <div className="space-y-2">
    <ol className="space-y-1" aria-label={`${label} selected providers`}>
      {value.map((slug, index) => <li key={slug} className="flex flex-wrap items-center gap-2 text-xs">
        <span className="break-all font-mono">{slug}</span>
        {metadata?.status !== 'fresh' || !endpoints.some((endpoint) => endpoint.tag === slug) ? <span className="text-muted-foreground">Unverified selection (retained)</span> : null}
        {ordered ? <>
          <Button type="button" variant="outline" size="sm" aria-label={`Move ${slug} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</Button>
          <Button type="button" variant="outline" size="sm" aria-label={`Move ${slug} down`} disabled={index === value.length - 1} onClick={() => move(index, 1)}>↓</Button>
        </> : null}
        <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${slug} from ${label}`} onClick={() => onChange(value.filter((item) => item !== slug))}>Remove</Button>
      </li>)}
    </ol>
    <Input aria-label={`Search ${label}`} placeholder="Search provider names or routing slugs" value={query} onChange={(event) => setQuery(event.target.value)} />
    {endpoints.length ? <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
      {matches.map((endpoint, index) => <div key={`${endpoint.tag}-${index}`} className="space-y-1 border-b border-border/40 py-2 text-xs last:border-0">
        <Button type="button" variant="outline" size="sm" disabled={value.includes(endpoint.tag)} onClick={() => add(endpoint.tag)} aria-label={`Add ${endpoint.tag} to ${label}`}>{endpoint.providerName} · {endpoint.tag}</Button>
        <p>{endpoint.name} · {endpoint.tag.includes('/') ? 'Specific endpoint slug' : 'Base provider slug (may include variants)'}</p>
        <p>ZDR advisory: {metadata?.zdrStatus === 'fresh' && metadata.status === 'fresh' ? endpoint.zdr : 'unknown'}; metadata {metadata?.status}</p>
        <p>Input/output USD per million: {endpoint.pricing?.prompt ?? 'unknown'} / {endpoint.pricing?.completion ?? 'unknown'} · Context {endpoint.contextLength ?? 'unknown'} · Output {endpoint.maxCompletionTokens ?? 'unknown'}</p>
        <p>Parameters: {endpoint.supportedParameters.join(', ') || 'unknown'}</p>
      </div>)}
      {!matches.length ? <p className="text-xs">No matching endpoints.</p> : null}
    </div> : <p className="text-xs text-muted-foreground">Endpoint discovery unavailable here. Saved selections are retained; enter an actual routing slug manually.</p>}
    <div className="flex gap-2">
      <Input aria-label={`Manual slug for ${label}`} placeholder="Provider or endpoint slug, e.g. google-vertex" value={manual} onChange={(event) => setManual(event.target.value)} />
      <Button type="button" variant="outline" size="sm" onClick={() => add(manual.trim())}>Add slug</Button>
    </div>
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
  </div>
}
