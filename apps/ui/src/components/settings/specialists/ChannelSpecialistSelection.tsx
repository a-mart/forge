import { useCallback, useEffect, useState } from 'react'
import type { ResolvedSpecialistDefinition } from '@forge/protocol'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { SettingsSection } from '../settings-row'
import type { SettingsApiClient } from '../settings-api-client'
import {
  fetchSharedSpecialists,
  updateChannelSpecialistSelection,
} from '../specialists-api'
import { getBehaviorModeCardMetadata, isDelegationChoiceSpecialist } from './utils'

interface ChannelSpecialistSelectionProps {
  clientOrWsUrl: SettingsApiClient | string
  channelId: string
  channelLabel: string
  selectedGlobalHandles: string[]
  missingHandles: string[]
  specialistChangeKey: number
  onSelectionSaved: () => void
}

/**
 * Global specialist selection controls for a channel.
 * Shows all available global collab specialists with checkboxes,
 * letting the admin choose which are active for this channel.
 */
export function ChannelSpecialistSelection({
  clientOrWsUrl,
  channelId,
  channelLabel,
  selectedGlobalHandles,
  missingHandles,
  specialistChangeKey,
  onSelectionSaved,
}: ChannelSpecialistSelectionProps) {
  const [globalSpecialists, setGlobalSpecialists] = useState<ResolvedSpecialistDefinition[]>([])
  const [selectedHandles, setSelectedHandles] = useState<Set<string>>(
    new Set(selectedGlobalHandles),
  )
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Sync from props when they change
  useEffect(() => {
    setSelectedHandles(new Set(selectedGlobalHandles))
  }, [selectedGlobalHandles])

  // Load global collab specialists
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    fetchSharedSpecialists(clientOrWsUrl)
      .then((specs) => {
        if (!cancelled) {
          setGlobalSpecialists(
            specs.filter((s) =>
              s.targetSpace.includes('collaboration') &&
              isDelegationChoiceSpecialist(s.specialistId),
            ),
          )
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load specialists')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [clientOrWsUrl, specialistChangeKey])

  const handleToggle = useCallback((handle: string, checked: boolean) => {
    setSelectedHandles((prev) => {
      const next = new Set(prev)
      if (checked) next.add(handle)
      else next.delete(handle)
      return next
    })
  }, [])

  const hasChanges = (() => {
    const currentSet = new Set(selectedGlobalHandles)
    if (currentSet.size !== selectedHandles.size) return true
    for (const h of selectedHandles) {
      if (!currentSet.has(h)) return true
    }
    return false
  })()

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      await updateChannelSpecialistSelection(
        clientOrWsUrl,
        channelId,
        Array.from(selectedHandles),
      )
      onSelectionSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update selection')
    } finally {
      setSaving(false)
    }
  }, [clientOrWsUrl, channelId, selectedHandles, onSelectionSaved])

  return (
    <SettingsSection
      label="Delegation Availability"
      description={`Choose which shared behavior modes and custom specialists are available to #${channelLabel}. Existing system-managed selections are preserved but not offered here.`}
      cta={
        hasChanges ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save selection'}
          </Button>
        ) : null
      }
    >
      {loading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      ) : globalSpecialists.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground/70 italic">
          No shared behavior modes or custom specialists available.
        </p>
      ) : (
        <div className="space-y-2">
          {globalSpecialists.map((spec) => {
            const behaviorMode = getBehaviorModeCardMetadata(spec.specialistId)
            return (
            <label
              key={spec.specialistId}
              className="flex cursor-pointer items-center gap-3 rounded-md border border-border/50 px-3 py-2.5 transition-colors hover:bg-muted/30"
            >
              <Checkbox
                checked={selectedHandles.has(spec.specialistId)}
                onCheckedChange={(checked) =>
                  handleToggle(spec.specialistId, checked === true)
                }
                disabled={saving}
              />
              <div
                className="size-3 shrink-0 rounded-full"
                style={{ backgroundColor: spec.color }}
              />
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium">{spec.displayName}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {behaviorMode ? behaviorMode.mode : spec.specialistId}
                </span>
              </div>
            </label>
            )
          })}
        </div>
      )}

      {missingHandles.length > 0 && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-yellow-500" />
          <div className="text-xs text-yellow-400/90">
            <p className="font-medium">Missing saved delegation handles</p>
            <p className="mt-0.5">
              {missingHandles.join(', ')} — these handles are saved but do not
              resolve to existing specialists. They are ignored at runtime.
            </p>
          </div>
        </div>
      )}
    </SettingsSection>
  )
}
