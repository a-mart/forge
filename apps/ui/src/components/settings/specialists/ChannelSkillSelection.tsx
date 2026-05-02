import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  CollaborationSkillSelectionInput,
  CollaborationSkillSelectionState,
  SkillInventoryEntry,
} from '@forge/protocol'
import { AlertTriangle, Loader2, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { SettingsSection } from '../settings-row'
import type { SettingsApiClient } from '../settings-api-client'
import {
  fetchCollabSkillInventory,
  updateChannelSkillSelection,
} from '../specialists-api'
import { normalizeCollabSkillHandle } from './utils'

interface ChannelSkillSelectionProps {
  clientOrWsUrl: SettingsApiClient | string
  channelId: string
  channelLabel: string
  /** Current skill selection state from the channel DTO. */
  activeSkillSelection: CollaborationSkillSelectionState | undefined
  /** Triggers a reload when incremented. */
  changeKey: number
  /** Called after a successful save so the parent can refresh. */
  onSelectionSaved: (updated: { activeSkillSelection?: CollaborationSkillSelectionState }) => void
}

/**
 * Skill selection controls for a collaboration channel.
 *
 * Supports two modes:
 * - **All** — every available skill is loaded at runtime (minus always-on duplicates).
 * - **Custom** — only the explicitly selected skills (plus always-on) are loaded.
 *
 * Always-on skills (e.g. "memory") are displayed but cannot be toggled off.
 */
export function ChannelSkillSelection({
  clientOrWsUrl,
  channelId,
  channelLabel,
  activeSkillSelection,
  changeKey,
  onSelectionSaved,
}: ChannelSkillSelectionProps) {
  /* ---- Inventory ---- */
  const [inventory, setInventory] = useState<SkillInventoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    fetchCollabSkillInventory(clientOrWsUrl)
      .then((skills) => {
        if (!cancelled) setInventory(skills)
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load skill inventory')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [clientOrWsUrl, changeKey])

  /* ---- Derived state ---- */
  const currentMode = activeSkillSelection?.mode ?? 'all'
  const alwaysOnHandles = useMemo(
    () => new Set(activeSkillSelection?.alwaysOnSkillHandles ?? ['memory']),
    [activeSkillSelection],
  )
  const savedCustomHandles = useMemo(
    () => new Set(activeSkillSelection?.savedSelectedSkillHandles ?? []),
    [activeSkillSelection],
  )
  const missingHandles = activeSkillSelection?.missingSkillHandles ?? []

  /* ---- Local editing state ---- */
  const [mode, setMode] = useState<'all' | 'custom'>(currentMode)
  const [selectedHandles, setSelectedHandles] = useState<Set<string>>(savedCustomHandles)
  const [saving, setSaving] = useState(false)

  // Sync from props when they change (e.g. after save or external update)
  useEffect(() => {
    setMode(activeSkillSelection?.mode ?? 'all')
    setSelectedHandles(new Set(activeSkillSelection?.savedSelectedSkillHandles ?? []))
  }, [activeSkillSelection])

  /* ---- Change detection ---- */
  const hasChanges = useMemo(() => {
    if (mode !== currentMode) return true
    if (mode === 'all') return false
    // In custom mode, compare selected handles
    if (selectedHandles.size !== savedCustomHandles.size) return true
    for (const h of selectedHandles) {
      if (!savedCustomHandles.has(h)) return true
    }
    return false
  }, [mode, currentMode, selectedHandles, savedCustomHandles])

  /* ---- Handlers ---- */
  const handleModeChange = useCallback((newMode: 'all' | 'custom') => {
    setMode(newMode)
    if (newMode === 'all') {
      // Reset custom selection to current saved state
      setSelectedHandles(new Set(activeSkillSelection?.savedSelectedSkillHandles ?? []))
    }
  }, [activeSkillSelection])

  const handleToggle = useCallback((handle: string, checked: boolean) => {
    setSelectedHandles((prev) => {
      const next = new Set(prev)
      if (checked) next.add(handle)
      else next.delete(handle)
      return next
    })
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const selection: CollaborationSkillSelectionInput =
        mode === 'all'
          ? { mode: 'all' }
          : { mode: 'custom', savedSelectedSkillHandles: Array.from(selectedHandles).map(normalizeCollabSkillHandle) }

      const updated = await updateChannelSkillSelection(clientOrWsUrl, channelId, selection)
      onSelectionSaved({ activeSkillSelection: updated.activeSkillSelection })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update skill selection')
    } finally {
      setSaving(false)
    }
  }, [clientOrWsUrl, channelId, mode, selectedHandles, onSelectionSaved])

  /* ---- Available (non-always-on) skills from inventory ---- */
  const optionalSkills = useMemo(
    () => inventory.filter((s) => !alwaysOnHandles.has(normalizeCollabSkillHandle(s.directoryName))),
    [inventory, alwaysOnHandles],
  )

  const alwaysOnSkills = useMemo(
    () => inventory.filter((s) => alwaysOnHandles.has(normalizeCollabSkillHandle(s.directoryName))),
    [inventory, alwaysOnHandles],
  )

  /* ---- Render ---- */
  return (
    <SettingsSection
      label="Skill Selection"
      description={`Choose which skills are loaded for #${channelLabel}. Always-on skills like memory are always included.`}
      cta={
        hasChanges ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save selection'}
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
      ) : (
        <div className="space-y-4">
          {/* Mode selector */}
          <div className="flex items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name={`skill-mode-${channelId}`}
                value="all"
                checked={mode === 'all'}
                onChange={() => handleModeChange('all')}
                disabled={saving}
                className="accent-primary"
              />
              <span className="text-sm">All skills</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name={`skill-mode-${channelId}`}
                value="custom"
                checked={mode === 'custom'}
                onChange={() => handleModeChange('custom')}
                disabled={saving}
                className="accent-primary"
              />
              <span className="text-sm">Custom selection</span>
            </label>
          </div>

          {mode === 'all' ? (
            <p className="text-xs text-muted-foreground/70 italic">
              All {inventory.length} available skill{inventory.length === 1 ? '' : 's'} will be loaded at runtime.
            </p>
          ) : (
            <>
              {/* Always-on skills (locked, informational) */}
              {alwaysOnSkills.length > 0 && (
                <div className="space-y-1">
                  <Label className="text-xs font-medium text-muted-foreground">Always on</Label>
                  {alwaysOnSkills.map((skill) => (
                    <div
                      key={skill.directoryName}
                      className="flex items-center gap-3 rounded-md border border-border/30 bg-muted/20 px-3 py-2"
                    >
                      <Lock className="size-3 shrink-0 text-muted-foreground/50" />
                      <div className="min-w-0 flex-1">
                        <span className="text-sm font-medium text-muted-foreground">
                          {skill.name}
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground/60">
                          {skill.directoryName}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Selectable skills */}
              {optionalSkills.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground/70 italic">
                  No optional skills available.
                </p>
              ) : (
                <div className="space-y-1">
                  <Label className="text-xs font-medium text-muted-foreground">Optional skills</Label>
                  <div className="space-y-1.5">
                    {optionalSkills.map((skill) => (
                      <label
                        key={skill.directoryName}
                        className="flex cursor-pointer items-center gap-3 rounded-md border border-border/50 px-3 py-2.5 transition-colors hover:bg-muted/30"
                      >
                        <Checkbox
                          checked={selectedHandles.has(normalizeCollabSkillHandle(skill.directoryName))}
                          onCheckedChange={(checked) =>
                            handleToggle(normalizeCollabSkillHandle(skill.directoryName), checked === true)
                          }
                          disabled={saving}
                        />
                        <div className="min-w-0 flex-1">
                          <span className="text-sm font-medium">{skill.name}</span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {skill.directoryName}
                          </span>
                          {skill.description && (
                            <p className="mt-0.5 text-xs text-muted-foreground/70 line-clamp-1">
                              {skill.description}
                            </p>
                          )}
                        </div>
                        <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground/60 bg-muted/40">
                          {skill.sourceKind}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {selectedHandles.size === 0 && (
                <p className="text-xs text-muted-foreground/70 italic">
                  No optional skills selected. Only always-on skills will be loaded.
                </p>
              )}
            </>
          )}

          {/* Missing handles warning */}
          {missingHandles.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-yellow-500" />
              <div className="text-xs text-yellow-400/90">
                <p className="font-medium">Missing skill handles</p>
                <p className="mt-0.5">
                  {missingHandles.join(', ')} — these handles are saved but no longer
                  resolve to available skills. They are ignored at runtime.
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  )
}
