import { useState } from 'react'
import type { CodexElicitationPersistScope, CodexElicitationRequestEvent } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function CodexElicitationCard({
  request,
  onRespond,
}: {
  request: CodexElicitationRequestEvent
  onRespond: (decision: 'allow' | 'deny' | 'cancel', values?: Record<string, unknown>, persistScope?: CodexElicitationPersistScope) => void
}) {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [persistScope, setPersistScope] = useState<CodexElicitationPersistScope | undefined>()
  const valid = request.fields?.every((field) => !field.required || (values[field.key] !== undefined && values[field.key] !== '')) ?? true
  return <div className="max-w-2xl space-y-3 rounded-lg border border-amber-500/40 bg-card p-4" role="alert">
    <div><p className="text-sm font-semibold">Codex permission requested</p>{request.title ? <p className="text-sm font-medium">{request.title}</p> : null}<p className="text-sm text-muted-foreground">{request.message}</p></div>
    {request.mode === 'url' && request.url ? <p className="break-all text-xs text-muted-foreground">URL provided by Codex: {request.url} <span className="font-medium">(not opened automatically)</span></p> : null}
    {request.fields?.map((field) => <label key={field.key} className="block space-y-1 text-sm"><span>{field.label}{field.required ? ' *' : ''}</span>{field.type === 'boolean' ? <input type="checkbox" checked={values[field.key] === true} onChange={(event) => setValues({ ...values, [field.key]: event.target.checked })} /> : field.type === 'enum' ? <select className="w-full rounded border bg-background p-2" value={String(values[field.key] ?? '')} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}><option value="">Select…</option>{field.options?.map((option) => <option key={option} value={option}>{option}</option>)}</select> : <Input type={field.sensitive ? 'password' : field.type === 'number' ? 'number' : 'text'} value={String(values[field.key] ?? '')} onChange={(event) => setValues({ ...values, [field.key]: field.type === 'number' ? Number(event.target.value) : event.target.value })} autoComplete="off" />}</label>)}
    {request.persistScopes.length ? <label className="block text-xs text-muted-foreground">Remember only if Codex offered it<select className="ml-2 rounded border bg-background p-1" value={persistScope ?? ''} onChange={(event) => setPersistScope(event.target.value === 'session' || event.target.value === 'always' ? event.target.value : undefined)}><option value="">This request only</option>{request.persistScopes.includes('session') ? <option value="session">Allow for this session</option> : null}{request.persistScopes.includes('always') ? <option value="always">Always allow this advertised scope</option> : null}</select></label> : null}
    <div className="flex gap-2"><Button size="sm" disabled={!valid} onClick={() => onRespond('allow', values, persistScope)}>Allow</Button><Button size="sm" variant="secondary" onClick={() => onRespond('deny')}>Deny</Button><Button size="sm" variant="ghost" onClick={() => onRespond('cancel')}>Cancel</Button></div>
  </div>
}
