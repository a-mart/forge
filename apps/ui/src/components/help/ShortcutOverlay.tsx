import { useCallback, useEffect, useMemo, useState } from 'react'
import { Search, Keyboard } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { getShortcuts } from './help-registry'
import { useHelp } from './help-hooks'
import { cn } from '@/lib/utils'
import type { ShortcutDef } from './help-types'

const isMac =
  typeof navigator !== 'undefined' &&
  (/Mac|iPhone|iPad|iPod/.test(navigator.platform) ||
    (navigator as unknown as { userAgentData?: { platform?: string } })
      .userAgentData?.platform === 'macOS')

export function ShortcutOverlay() {
  const { isShortcutOverlayOpen, closeShortcutOverlay } = useHelp()
  const [search, setSearch] = useState('')

  // Reset search when dialog closes
  useEffect(() => {
    if (!isShortcutOverlayOpen) {
      setSearch('')
    }
  }, [isShortcutOverlayOpen])

  const allShortcuts = useMemo(() => getShortcuts(), [])

  const filteredShortcuts = useMemo(() => {
    if (!search.trim()) return allShortcuts
    const q = search.toLowerCase()
    return allShortcuts.filter(
      (s) =>
        s.label.toLowerCase().includes(q) ||
        s.group.toLowerCase().includes(q) ||
        resolveKeys(s).toLowerCase().includes(q),
    )
  }, [allShortcuts, search])

  const grouped = useMemo(() => {
    const groups = new Map<string, ShortcutDef[]>()
    for (const shortcut of filteredShortcuts) {
      const existing = groups.get(shortcut.group)
      if (existing) {
        existing.push(shortcut)
      } else {
        groups.set(shortcut.group, [shortcut])
      }
    }
    return groups
  }, [filteredShortcuts])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeShortcutOverlay()
      }
    },
    [closeShortcutOverlay],
  )

  return (
    <Dialog open={isShortcutOverlayOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className={cn(
          'max-h-[min(80vh,600px)] w-[min(95vw,480px)] gap-0 overflow-hidden p-0',
          'border-border/50 bg-background',
        )}
      >
        <DialogHeader className="space-y-0 border-b border-border/40 px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            <Keyboard className="size-4 text-muted-foreground" />
            Keyboard Shortcuts
          </DialogTitle>
        </DialogHeader>

        {/* Search */}
        <div className="border-b border-border/40 px-5 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search shortcuts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 border-border/50 bg-muted/30 pl-9 text-sm placeholder:text-muted-foreground/60"
              aria-label="Search shortcuts"
              autoFocus
            />
          </div>
        </div>

        {/* Shortcuts list */}
        <ScrollArea className="max-h-[min(56vh,420px)]">
          <div className="px-5 py-3">
            {grouped.size === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <p className="text-sm text-muted-foreground">
                  No shortcuts matching &ldquo;{search}&rdquo;
                </p>
              </div>
            ) : (
              <div className="space-y-5">
                {[...grouped.entries()].map(([group, shortcuts]) => (
                  <div key={group}>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {group}
                    </h3>
                    <div className="space-y-1">
                      {shortcuts.map((shortcut) => (
                        <ShortcutRow key={shortcut.id} shortcut={shortcut} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Footer hint */}
        <div className="border-t border-border/40 px-5 py-2.5">
          <p className="text-[11px] text-muted-foreground/60">
            Press <Kbd>?</Kbd> to toggle this overlay
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ShortcutRow({ shortcut }: { shortcut: ShortcutDef }) {
  const keys = resolveKeys(shortcut)

  return (
    <div className="flex items-center justify-between rounded-md px-2 py-1.5">
      <span className="text-sm text-foreground/90">{shortcut.label}</span>
      <KeyCombo keys={keys} />
    </div>
  )
}

function KeyCombo({ keys }: { keys: string }) {
  const parts = keys.split('+').map((k) => k.trim())

  return (
    <div className="flex items-center gap-1">
      {parts.map((part, i) => (
        <Kbd key={i}>{part}</Kbd>
      ))}
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border px-1.5',
        'border-border/60 bg-muted/50 font-mono text-[11px] font-medium text-muted-foreground',
      )}
    >
      {children}
    </kbd>
  )
}

function resolveKeys(shortcut: ShortcutDef): string {
  if (isMac && shortcut.keysMac) {
    return shortcut.keysMac
  }
  return shortcut.keys
}
