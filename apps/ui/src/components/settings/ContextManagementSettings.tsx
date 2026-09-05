import { useEffect, useRef, useState } from 'react'
import { DEFAULT_CONTEXT_MODE, isContextMode, type ContextMode } from '@forge/protocol'
import { Loader2 } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  CONTEXT_MANAGEMENT_DESCRIPTION,
  CONTEXT_MANAGEMENT_TITLE,
  CONTEXT_MODE_APPLIES_LATER,
  CONTEXT_MODE_OPTION_LABELS,
} from './context-mode-copy'
import {
  fetchProjectContextMode,
  updateProjectContextMode,
} from './context-mode-api'
import type { SettingsApiClient } from './settings-api-client'

export function ContextManagementSettings({
  apiClient,
  profileId,
  connectionEpoch,
  liveMode,
}: {
  apiClient: SettingsApiClient
  profileId: string
  connectionEpoch?: number
  liveMode?: ContextMode
}) {
  const [mode, setMode] = useState<ContextMode>(liveMode ?? DEFAULT_CONTEXT_MODE)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const scopeIdRef = useRef(0)
  const savingRef = useRef(false)
  const lastLiveModeRef = useRef(liveMode)

  const isCurrentScope = (scopeId: number) => scopeIdRef.current === scopeId

  const load = (scopeId = scopeIdRef.current) => {
    setLoading(true)
    setError(null)
    setLoadFailed(false)
    void fetchProjectContextMode(apiClient, profileId)
      .then((snapshot) => {
        if (!isCurrentScope(scopeId) || savingRef.current) return
        setMode(snapshot.mode)
        setLoading(false)
      })
      .catch((loadError) => {
        if (!isCurrentScope(scopeId)) return
        setLoadFailed(true)
        setLoading(false)
        setError(loadError instanceof Error ? loadError.message : 'Could not load context management settings.')
      })
  }

  useEffect(() => {
    const scopeId = ++scopeIdRef.current
    savingRef.current = false
    lastLiveModeRef.current = liveMode
    setSaving(false)
    setError(null)
    setLoadFailed(false)
    setMode(liveMode ?? DEFAULT_CONTEXT_MODE)
    load(scopeId)
    return () => {
      if (scopeIdRef.current === scopeId) scopeIdRef.current += 1
      savingRef.current = false
    }
    // Reload for a different project, reconnect, or a new API client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiClient, profileId, connectionEpoch])

  useEffect(() => {
    if (savingRef.current || liveMode === undefined || liveMode === lastLiveModeRef.current) return
    lastLiveModeRef.current = liveMode
    setMode(liveMode)
  }, [liveMode])

  const selectMode = (value: string) => {
    if (!isContextMode(value) || value === mode || saving) return
    const previous = mode
    const scopeId = scopeIdRef.current
    savingRef.current = true
    setSaving(true)
    setError(null)
    setMode(value)
    void updateProjectContextMode(apiClient, profileId, value)
      .then((snapshot) => {
        if (!isCurrentScope(scopeId)) return
        setMode(snapshot.mode)
      })
      .catch((saveError) => {
        if (!isCurrentScope(scopeId)) return
        setMode(previous)
        setError(saveError instanceof Error ? saveError.message : 'Could not update context management.')
      })
      .finally(() => {
        if (!isCurrentScope(scopeId)) return
        savingRef.current = false
        setSaving(false)
      })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{CONTEXT_MANAGEMENT_TITLE}</CardTitle>
        <CardDescription>{CONTEXT_MANAGEMENT_DESCRIPTION}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={mode} onValueChange={selectMode} disabled={loading || saving}>
            <SelectTrigger className="w-full sm:w-72" aria-label="Context management">
              <SelectValue placeholder="Select context management" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="summary">{CONTEXT_MODE_OPTION_LABELS.summary}</SelectItem>
              <SelectItem value="fresh">{CONTEXT_MODE_OPTION_LABELS.fresh}</SelectItem>
            </SelectContent>
          </Select>
          {(loading || saving) ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label={saving ? 'Saving' : 'Loading'} />
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{CONTEXT_MODE_APPLIES_LATER}</p>
        {error ? (
          <div className="flex flex-wrap items-center gap-2 text-sm text-destructive" role="alert">
            <span>{error}</span>
            {loadFailed ? (
              <button
                type="button"
                className="font-medium underline-offset-2 hover:underline"
                onClick={() => load()}
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
