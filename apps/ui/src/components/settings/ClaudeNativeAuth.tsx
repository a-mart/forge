import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react'
import type { ClaudeAuthStatus } from '@forge/protocol'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { SettingsApiClient } from './settings-api-client'

const endpoint = '/api/settings/claude-native'

export function ClaudeNativeAuth({ apiClient, inConversation = false }: {
  apiClient: SettingsApiClient
  inConversation?: boolean
}) {
  const [status, setStatus] = useState<ClaudeAuthStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const codeId = useId()
  const generation = useRef(0)
  const invalidate = useCallback(() => { generation.current++ }, [])
  const active = status && ['starting', 'waiting', 'verifying'].includes(status.phase)

  const request = useCallback(async (init?: RequestInit, background = false) => {
    const current = ++generation.current
    if (!background) setBusy(true)
    setError(null)
    try {
      const next = await apiClient.fetchJson<ClaudeAuthStatus>(endpoint, init)
      if (generation.current === current) setStatus(next)
    } catch (cause) {
      if (generation.current === current) setError(cause instanceof Error ? cause.message : 'Could not check the Claude connection.')
    } finally {
      if (generation.current === current && !background) setBusy(false)
    }
  }, [apiClient])

  useEffect(() => {
    setStatus(null)
    setCode('')
    void request()
    return invalidate
  }, [request, invalidate])

  useEffect(() => {
    setCopied(false)
    setCopyError(null)
  }, [status?.authorizationUrl])

  const copyLink = async () => {
    if (!status?.authorizationUrl) return
    setCopyError(null)
    try {
      await navigator.clipboard.writeText(status.authorizationUrl)
      setCopied(true)
    } catch {
      setCopyError('Could not copy the link. Select and copy the link below, then open it in your preferred browser.')
    }
  }

  // Poll only while the CLI owns an active login, without overlapping requests.
  useEffect(() => {
    if (!active || busy || error) return
    const timer = window.setTimeout(() => void request(undefined, true), 1500)
    return () => window.clearTimeout(timer)
  }, [active, busy, error, request, status])

  const mutate = (action: string) => {
    const value = code.trim()
    setCode('')
    void request({ method: action === 'cancel' ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, flowId: status?.flowId, ...(action === 'code' ? { code: value } : {}) }) })
  }

  return (
    <section aria-label="Claude native connection" className={inConversation
      ? 'border-b border-border bg-muted/30 px-4 py-3'
      : 'rounded-lg border border-border p-4'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            {status?.connected ? <Check className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" /> : null}
            {status?.connected ? 'Claude connected' : inConversation ? 'Connect Claude to continue' : 'Claude native'}
          </h3>
          <p className="max-w-prose text-xs text-muted-foreground">
            {status?.connected
              ? status.mode === 'api_key' ? 'Using your configured Anthropic API key.'
                : inConversation ? 'Your subscription is connected. Send your message again to continue.' : 'Using your Claude subscription. Sign-in is shared with Claude Code on this computer.'
              : active ? 'Copy the sign-in link and open it in your preferred browser. To switch accounts, choose a different account there, then paste the authorization code below.'
                : 'Use your Claude subscription. Sign-in is shared with Claude Code on this computer.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {status && status.mode === 'subscription' && !active ? (
            <Button size="sm" disabled={busy} onClick={() => mutate('start')}>{status.connected ? 'Switch account' : 'Sign in to Claude'}</Button>
          ) : null}
          {active ? <Button variant="outline" size="sm" disabled={busy} onClick={() => mutate('cancel')}>Cancel sign-in</Button> : null}
          {!active || error ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void request()}>
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
            Check connection
          </Button> : null}
        </div>
      </div>
      {active && status?.authorizationUrl ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void copyLink()}>
              {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
              {copied ? 'Link copied' : 'Copy sign-in link'}
            </Button>
            <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={status.authorizationUrl} target="_blank" rel="noreferrer">Open Claude sign-in <ExternalLink className="size-3.5" aria-hidden="true" /></a>
          </div>
          <form className="max-w-lg space-y-2" onSubmit={event => { event.preventDefault(); mutate('code') }}>
            <label htmlFor={codeId} className="text-xs text-muted-foreground">After authorizing on the Claude page, paste the complete authorization code here.</label>
            <div className="flex gap-2">
              <Input id={codeId} type="password" value={code} onChange={event => setCode(event.target.value)}
                autoComplete="off" spellCheck={false} placeholder="Authorization code" className="min-w-0"
                disabled={busy} />
              <Button size="sm" type="submit" disabled={busy || !code.trim()}>Submit code</Button>
            </div>
          </form>
          <Input aria-label="Claude sign-in link" readOnly value={status.authorizationUrl}
            onFocus={event => event.currentTarget.select()} className="max-w-lg text-xs" />
          {copyError ? <p role="alert" className="max-w-prose text-sm">{copyError}</p> : null}
        </div>
      ) : null}
      {error || status?.message ? <p role="alert" className="mt-3 max-w-prose break-words text-sm text-foreground">{error ?? status?.message}</p> : null}
      {active && !status?.message ? <p role="status" className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        {status?.phase === 'verifying' ? 'Checking saved sign-in…' : status?.phase === 'starting' ? 'Starting Claude sign-in…' : 'Waiting for sign-in…'}
      </p> : null}
    </section>
  )
}
