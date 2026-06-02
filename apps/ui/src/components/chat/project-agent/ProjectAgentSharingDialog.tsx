import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { ProjectAgentInfo, ProjectAgentShareEligibleTarget, ProjectAgentShareGrantInfo } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ProjectAgentSharingSection } from './ProjectAgentSharingSection'

export interface ProjectAgentSharingDialogProps {
  agentId: string
  sessionLabel: string
  currentProjectAgent: ProjectAgentInfo
  onClose: () => void
  onGetProjectAgentSharing: (agentId: string) => Promise<{ agentId: string; grants: ProjectAgentShareGrantInfo[]; eligibleTargets: ProjectAgentShareEligibleTarget[] }>
  onSetProjectAgentSharing: (agentId: string, targetProfileIds: string[]) => Promise<{ agentId: string; grants: ProjectAgentShareGrantInfo[]; eligibleTargets: ProjectAgentShareEligibleTarget[]; addedTargetProfileIds: string[]; removedTargetProfileIds: string[] }>
}

export function ProjectAgentSharingDialog({
  agentId,
  sessionLabel,
  currentProjectAgent,
  onClose,
  onGetProjectAgentSharing,
  onSetProjectAgentSharing,
}: ProjectAgentSharingDialogProps) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [grants, setGrants] = useState<ProjectAgentShareGrantInfo[]>([])
  const [eligibleTargets, setEligibleTargets] = useState<ProjectAgentShareEligibleTarget[]>([])
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>([])
  const [savedTargetIds, setSavedTargetIds] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void onGetProjectAgentSharing(agentId).then((result) => {
      if (cancelled) return
      const activeTargetIds = result.eligibleTargets
        .filter((target) => target.alreadyShared)
        .map((target) => target.profileId)
      setGrants(result.grants)
      setEligibleTargets(result.eligibleTargets)
      setSelectedTargetIds(activeTargetIds)
      setSavedTargetIds(activeTargetIds)
      setLoading(false)
    }).catch((err) => {
      if (cancelled) return
      setError(err instanceof Error ? err.message : 'Failed to load sharing settings.')
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [agentId, onGetProjectAgentSharing])

  const normalizedSelectedTargetIds = useMemo(
    () => [...selectedTargetIds].sort(),
    [selectedTargetIds],
  )
  const normalizedSavedTargetIds = useMemo(
    () => [...savedTargetIds].sort(),
    [savedTargetIds],
  )
  const dirty = normalizedSelectedTargetIds.join('|') !== normalizedSavedTargetIds.join('|')

  const handleSave = useCallback(async () => {
    if (!dirty) return
    setSaving(true)
    setError(null)
    try {
      const result = await onSetProjectAgentSharing(agentId, normalizedSelectedTargetIds)
      const activeTargetIds = result.eligibleTargets
        .filter((target) => target.alreadyShared)
        .map((target) => target.profileId)
      setGrants(result.grants)
      setEligibleTargets(result.eligibleTargets)
      setSelectedTargetIds(activeTargetIds)
      setSavedTargetIds(activeTargetIds)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save sharing settings.')
    } finally {
      setSaving(false)
    }
  }, [agentId, dirty, normalizedSelectedTargetIds, onClose, onSetProjectAgentSharing])

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Share Project Agent</DialogTitle>
          <DialogDescription>
            Share {sessionLabel} into other Builder projects. Shared agents appear in target project directories and mention autocomplete using aliases like <code>@namespace/{currentProjectAgent.handle}</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 shrink-0 animate-spin" />
              <span>Loading sharing targets…</span>
            </div>
          ) : null}

          {error ? (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
              {error}
            </p>
          ) : null}

          {!loading ? (
            <ProjectAgentSharingSection
              grants={grants}
              eligibleTargets={eligibleTargets}
              selectedTargetIds={selectedTargetIds}
              projectAgentHandle={currentProjectAgent.handle}
              onSelectedTargetIdsChange={setSelectedTargetIds}
            />
          ) : null}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={() => void handleSave()} disabled={!dirty || loading || saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
