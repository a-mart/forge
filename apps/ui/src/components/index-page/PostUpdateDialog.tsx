import { useEffect, useState } from 'react'
import { Bot, Check, ExternalLink, GitBranch, Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import { applyRecommendedManagerDefaults } from '@/lib/manager-selection-catalog-api'
import type { PostUpdateInfo } from '@/lib/electron-bridge'

export function PostUpdateDialog({ source }: { source: SettingsApiClient | string }) {
  const [info, setInfo] = useState<PostUpdateInfo | null>(null)
  const [applying, setApplying] = useState(false)
  const [appliedProjects, setAppliedProjects] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.electronBridge?.getPostUpdateInfo?.()
      .then((next) => {
        if (!cancelled) setInfo(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const applyDefaults = async () => {
    setApplying(true)
    setError(null)
    try {
      const result = await applyRecommendedManagerDefaults(source)
      setAppliedProjects(result.profileIds.length)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update defaults.')
    } finally {
      setApplying(false)
    }
  }

  if (!info) return null

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !applying) setInfo(null) }}>
      <DialogContent className="max-w-xl overflow-hidden p-0" hideClose={applying}>
        <div className="relative border-b border-border/70 bg-gradient-to-br from-emerald-500/15 via-background to-sky-500/10 px-6 pb-5 pt-6">
          <div className="absolute right-5 top-5 rounded-full border border-emerald-500/25 bg-emerald-500/10 p-2 text-emerald-400">
            <Sparkles className="size-5" aria-hidden="true" />
          </div>
          <DialogHeader className="pr-14">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400">
              Forge v{info.currentVersion}
            </p>
            <DialogTitle className="text-xl">Forge has been updated</DialogTitle>
            <DialogDescription className="text-sm">
              You were previously running v{info.previousVersion}.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-5 px-6 py-5">
          {info.offerRecommendedDefaults ? (
            <>
              <div>
                <h3 className="text-sm font-semibold">Use the new recommended defaults?</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  This updates your user projects while preserving explicit session model, work-mode,
                  and roster overrides.
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Recommendation icon={<Bot className="size-4" />} label="Manager model" value="GPT-6 Sol · High" detail="Codex native" />
                <Recommendation icon={<GitBranch className="size-4" />} label="Work mode" value="Hands-on" detail="Manager owns the critical path" />
                <Recommendation icon={<Sparkles className="size-4" />} label="Roster" value="Default" detail="Planning, review, and research support" wide />
              </div>
              {appliedProjects !== null ? (
                <div className="flex items-center gap-2 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
                  <Check className="size-4" />
                  Recommended defaults applied to {appliedProjects} user {appliedProjects === 1 ? 'project' : 'projects'}.
                </div>
              ) : null}
              {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Take a look at the release notes for everything included in this update.
            </p>
          )}
        </div>

        <DialogFooter className="border-t border-border/70 bg-muted/20 px-6 py-4 sm:items-center sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            onClick={() => { void window.electronBridge?.openReleaseNotes?.() }}
          >
            Release notes
            <ExternalLink className="size-3.5" />
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            {info.offerRecommendedDefaults && appliedProjects === null ? (
              <>
                <Button type="button" variant="outline" disabled={applying} onClick={() => setInfo(null)}>
                  Keep current defaults
                </Button>
                <Button type="button" disabled={applying} onClick={() => { void applyDefaults() }}>
                  {applying ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                  Use recommended defaults
                </Button>
              </>
            ) : (
              <Button type="button" onClick={() => setInfo(null)}>Done</Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Recommendation({
  icon,
  label,
  value,
  detail,
  wide = false,
}: {
  icon: React.ReactNode
  label: string
  value: string
  detail: string
  wide?: boolean
}) {
  return (
    <div className={`rounded-lg border border-border/70 bg-muted/25 p-3 ${wide ? 'sm:col-span-2' : ''}`}>
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-[10px] font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-2 text-sm font-medium">{value}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{detail}</p>
    </div>
  )
}
