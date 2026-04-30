import { useCallback, useEffect, useState } from 'react'
import type { CollaborationCategory, ResolvedSpecialistDefinition } from '@forge/protocol'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { SettingsSection } from '../settings-row'
import type { SettingsApiClient } from '../settings-api-client'
import {
  fetchSharedSpecialists,
  updateCategoryDefaultSpecialists,
} from '../specialists-api'

interface CategoryDefaultsViewProps {
  clientOrWsUrl: SettingsApiClient | string
  category: CollaborationCategory
  specialistChangeKey: number
  onCategoryUpdated?: (category: CollaborationCategory) => void
}

/**
 * Category specialist defaults view for Settings > Specialists.
 * Shows a checklist of available global collaboration specialists and lets
 * the admin select which are the default for new channels in this category.
 */
export function CategoryDefaultsView({
  clientOrWsUrl,
  category,
  specialistChangeKey,
  onCategoryUpdated,
}: CategoryDefaultsViewProps) {
  const [globalSpecialists, setGlobalSpecialists] = useState<ResolvedSpecialistDefinition[]>([])
  const [selectedHandles, setSelectedHandles] = useState<Set<string>>(
    new Set(category.defaultSelectedSpecialistHandles),
  )
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Sync state when category prop changes
  useEffect(() => {
    setSelectedHandles(new Set(category.defaultSelectedSpecialistHandles))
  }, [category])

  // Load global collab specialists
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    fetchSharedSpecialists(clientOrWsUrl, 'collaboration')
      .then((specs) => {
        if (!cancelled) {
          // Only show enabled collab specialists
          setGlobalSpecialists(
            specs.filter((s) => s.targetSpace.includes('collaboration')),
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
    const currentSet = new Set(category.defaultSelectedSpecialistHandles)
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
      const updated = await updateCategoryDefaultSpecialists(
        clientOrWsUrl,
        category.categoryId,
        Array.from(selectedHandles),
      )
      onCategoryUpdated?.(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save defaults')
    } finally {
      setSaving(false)
    }
  }, [clientOrWsUrl, category.categoryId, selectedHandles, onCategoryUpdated])

  const missingHandles = category.missingDefaultSpecialistHandles ?? []

  return (
    <SettingsSection
      label={`Category: ${category.name}`}
      description="Default specialists for new channels in this category. Changes apply only to newly created channels."
      cta={
        hasChanges ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save defaults'}
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
          No global collaboration specialists available.
        </p>
      ) : (
        <div className="space-y-2">
          {globalSpecialists.map((spec) => (
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
                  {spec.specialistId}
                </span>
              </div>
            </label>
          ))}
        </div>
      )}

      {selectedHandles.size === 0 && !loading && (
        <p className="mt-2 text-xs text-muted-foreground/70 italic">
          No global specialists selected for new channels. Channel-local specialists can still be added later.
        </p>
      )}

      {missingHandles.length > 0 && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-yellow-500" />
          <div className="text-xs text-yellow-400/90">
            <p className="font-medium">Missing specialist handles</p>
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
