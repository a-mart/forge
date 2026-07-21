import { useState } from 'react'
import type { CodexElicitationPersistScope, CodexElicitationRequestEvent } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function CodexElicitationCard({
  request,
  onRespond,
}: {
  request: CodexElicitationRequestEvent
  onRespond: (
    decision: 'allow' | 'deny' | 'cancel',
    values?: Record<string, unknown>,
    persistScope?: CodexElicitationPersistScope,
  ) => void
}) {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [persistScope, setPersistScope] = useState<CodexElicitationPersistScope | undefined>()
  const [urlFlowStarted, setUrlFlowStarted] = useState(false)
  const canCopyUrl = typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.writeText)
  const validFields = request.fields?.every(
    (field) => !field.required || (values[field.key] !== undefined && values[field.key] !== ''),
  ) ?? true
  const valid = validFields && (request.mode !== 'url' || (Boolean(request.url) && urlFlowStarted))

  function setFieldValue(key: string, value: unknown): void {
    setValues((current) => ({ ...current, [key]: value }))
  }

  function setNumberFieldValue(key: string, input: HTMLInputElement): void {
    setValues((current) => {
      const next = { ...current }
      if (input.value === '' || Number.isNaN(input.valueAsNumber)) {
        delete next[key]
      } else {
        next[key] = input.valueAsNumber
      }
      return next
    })
  }

  function openUrl(): void {
    if (!request.url) return
    if (window.open(request.url, '_blank', 'noopener,noreferrer') !== null) {
      setUrlFlowStarted(true)
    }
  }

  async function copyUrl(): Promise<void> {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (!request.url || !clipboard?.writeText) return
    try {
      await clipboard.writeText(request.url)
      setUrlFlowStarted(true)
    } catch {
      // Keep Allow disabled if the browser declined the copy request.
    }
  }

  return (
    <div
      className="max-w-2xl space-y-3 rounded-lg border border-amber-500/40 bg-card p-4"
      role="alert"
    >
      <div>
        <p className="text-sm font-semibold">Codex permission requested</p>
        {request.title ? <p className="text-sm font-medium">{request.title}</p> : null}
        <p className="text-sm text-muted-foreground">{request.message}</p>
      </div>

      {request.mode === 'url' ? (
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            {request.urlOrigin
              ? `Codex provided a link to ${request.urlOrigin}.`
              : 'The secure link is no longer available after reconnecting.'}
            {' Forge does not open links automatically.'}
          </p>
          {request.url ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={openUrl}>
                Open link
              </Button>
              {canCopyUrl ? (
                <Button size="sm" variant="secondary" onClick={() => void copyUrl()}>
                  Copy link
                </Button>
              ) : null}
            </div>
          ) : null}
          {request.url && !urlFlowStarted ? (
            <p>Open or copy the link, complete the requested flow, then return here to allow it.</p>
          ) : null}
          {urlFlowStarted ? <p>Complete the requested flow before allowing it here.</p> : null}
        </div>
      ) : null}

      {request.fields?.map((field) => (
        <label key={field.key} className="block space-y-1 text-sm">
          <span>
            {field.label}
            {field.required ? ' *' : ''}
          </span>
          {field.type === 'boolean' ? (
            <input
              type="checkbox"
              checked={values[field.key] === true}
              onChange={(event) => setFieldValue(field.key, event.target.checked)}
            />
          ) : field.type === 'enum' ? (
            <select
              className="w-full rounded border bg-background p-2"
              value={String(values[field.key] ?? '')}
              onChange={(event) => setFieldValue(field.key, event.target.value)}
            >
              <option value="">Select…</option>
              {field.options?.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <Input
              type={field.sensitive ? 'password' : field.type === 'number' ? 'number' : 'text'}
              value={String(values[field.key] ?? '')}
              onChange={(event) =>
                field.type === 'number'
                  ? setNumberFieldValue(field.key, event.target)
                  : setFieldValue(field.key, event.target.value)
              }
              autoComplete="off"
            />
          )}
        </label>
      ))}

      {request.persistScopes.length ? (
        <label className="block text-xs text-muted-foreground">
          Remember only if Codex offered it
          <select
            className="ml-2 rounded border bg-background p-1"
            value={persistScope ?? ''}
            onChange={(event) =>
              setPersistScope(
                event.target.value === 'session' || event.target.value === 'always'
                  ? event.target.value
                  : undefined,
              )
            }
          >
            <option value="">This request only</option>
            {request.persistScopes.includes('session') ? (
              <option value="session">Allow for this session</option>
            ) : null}
            {request.persistScopes.includes('always') ? (
              <option value="always">Always allow this advertised scope</option>
            ) : null}
          </select>
        </label>
      ) : null}

      <div className="flex gap-2">
        <Button size="sm" disabled={!valid} onClick={() => onRespond('allow', values, persistScope)}>
          Allow
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onRespond('deny')}>
          Deny
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onRespond('cancel')}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
