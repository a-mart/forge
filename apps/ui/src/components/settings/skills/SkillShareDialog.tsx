import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Copy, ExternalLink, Loader2, Share2 } from 'lucide-react'
import type { SkillBundleIssue, SkillInventoryEntry, SkillShareResponse } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { SettingsApiClient } from '../settings-api-client'
import { toErrorMessage } from '../settings-api'
import { shareSkill } from './skills-viewer-api'

interface SkillShareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  clientOrWsUrl: SettingsApiClient | string
  skill: SkillInventoryEntry | null
}

export function SkillShareDialog({ open, onOpenChange, clientOrWsUrl, skill }: SkillShareDialogProps) {
  const [isSharing, setIsSharing] = useState(false)
  const [share, setShare] = useState<SkillShareResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'web' | 'direct' | null>(null)

  useEffect(() => {
    if (!open) {
      setShare(null)
      setError(null)
      setCopied(null)
      setIsSharing(false)
    }
  }, [open])

  const shareable = skill?.sourceKind === 'machine-local' || skill?.sourceKind === 'profile'
  const title = skill ? `Share ${skill.name}` : 'Share skill'
  const expiry = useMemo(() => formatExpiry(share?.expiresAt), [share?.expiresAt])

  const handleCreateShare = async () => {
    if (!skill || !shareable) return
    setError(null)
    setIsSharing(true)
    try {
      setShare(await shareSkill(clientOrWsUrl, skill.skillId))
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setIsSharing(false)
    }
  }

  const handleCopy = async (kind: 'web' | 'direct', value: string) => {
    try {
      await navigator.clipboard?.writeText(value)
      setCopied(kind)
    } catch {
      setError('Could not copy the link. Select and copy it manually.')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Create a temporary bearer link for one user-created skill. Anyone with the link can preview and import it until it expires.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {!shareable && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
              Built-in and repository skills are not shareable in v1. Share a global skill or project skill you created.
            </div>
          )}

          {skill && (
            <div className="rounded-md border border-border bg-card/40 p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{skill.name}</span>
                <Badge variant="secondary" className="text-[10px]">{skill.sourceKind}</Badge>
              </div>
              <p className="mt-1 break-all text-xs text-muted-foreground">{skill.rootPath}</p>
            </div>
          )}

          {!share && (
            <Button onClick={handleCreateShare} disabled={!shareable || isSharing}>
              {isSharing ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Share2 className="mr-2 size-4" />}
              Create share link
            </Button>
          )}

          {share && (
            <div className="flex flex-col gap-4">
              <div className="rounded-md border border-border bg-card/40 p-3 text-xs text-muted-foreground">
                Link expires {expiry}. The bundle includes authored files only; environment variable values and Forge secrets are not included.
              </div>

              <CopyableLink
                label="Web share link"
                description="Default link to send. It opens a safe landing page with an Open in Forge button and paste fallback."
                value={share.shareUrl}
                copied={copied === 'web'}
                onCopy={() => void handleCopy('web', share.shareUrl)}
              />
              <CopyableLink
                label="Direct Forge import link"
                description="Secondary desktop deep link. Recipients still review the local confirmation screen before install."
                value={share.importUrl}
                copied={copied === 'direct'}
                onCopy={() => void handleCopy('direct', share.importUrl)}
              />

              {share.warnings.length > 0 && (
                <IssueList issues={share.warnings} />
              )}
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CopyableLink({
  label,
  description,
  value,
  copied,
  onCopy,
}: {
  label: string
  description: string
  value: string
  copied: boolean
  onCopy: () => void
}) {
  const canOpen = isSafeExternalShareLink(value)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <Label className="text-xs font-medium">{label}</Label>
          <p className="text-[11px] text-muted-foreground">{description}</p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onCopy}>
          <Copy className="mr-1.5 size-3.5" />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <div className="flex gap-2">
        <Input value={value} readOnly className="h-8 font-mono text-xs" />
        <Button type="button" size="icon" variant="ghost" disabled={!canOpen} onClick={() => openSafeExternalShareLink(value)}>
          <ExternalLink className="size-4" />
          <span className="sr-only">Open link</span>
        </Button>
      </div>
    </div>
  )
}

function IssueList({ issues }: { issues: SkillBundleIssue[] }) {
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-amber-200">
        <AlertTriangle className="size-4" />
        Export warnings
      </div>
      <ul className="space-y-1 text-xs text-amber-100/90">
        {issues.map((issue, index) => (
          <li key={`${issue.code}-${issue.path ?? ''}-${index}`}>
            <span className="font-medium">{issue.code}</span>{issue.path ? ` (${issue.path})` : ''}: {issue.message}
          </li>
        ))}
      </ul>
    </div>
  )
}

function openSafeExternalShareLink(value: string): void {
  if (!isSafeExternalShareLink(value)) return
  window.open(value, '_blank', 'noopener,noreferrer')
}

function isSafeExternalShareLink(value: string): boolean {
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'https:') return true
    return parsed.protocol === 'forge:' && parsed.hostname === 'skill-import'
  } catch {
    return false
  }
}

function formatExpiry(value: string | undefined): string {
  if (!value) return 'soon'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}
