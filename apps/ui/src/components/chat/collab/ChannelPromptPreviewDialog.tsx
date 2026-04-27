import { useCallback, useEffect, useMemo, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Loader2, RefreshCw, ScrollText, X } from 'lucide-react'
import type { CollaborationChannelPromptPreviewResponse } from '@forge/protocol'
import { Button } from '@/components/ui/button'
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { fetchChannelPromptPreview } from '@/lib/collaboration-api'
import { cn } from '@/lib/utils'

interface ChannelPromptPreviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  channelId: string
  channelName: string
}

type PromptPreviewView = 'combined' | 'sections'

export function ChannelPromptPreviewDialog({
  open,
  onOpenChange,
  channelId,
  channelName,
}: ChannelPromptPreviewDialogProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<CollaborationChannelPromptPreviewResponse | null>(null)
  const [view, setView] = useState<PromptPreviewView>('combined')

  const loadPreview = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const result = await fetchChannelPromptPreview(channelId)
      setData(result)
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      // The backend route may not exist on public/non-collab backends — show
      // a deliberate message instead of the raw "404: Not Found" error.
      setError(raw.startsWith('404:')
        ? 'Prompt preview isn\u2019t available on this backend yet.'
        : raw || 'Failed to fetch AI prompt preview')
    } finally {
      setLoading(false)
    }
  }, [channelId])

  useEffect(() => {
    if (!open) {
      return
    }

    void loadPreview()
  }, [loadPreview, open])

  useEffect(() => {
    if (!open) {
      setView('combined')
    }
  }, [open])

  const combinedPreview = useMemo(() => {
    if (!data) {
      return ''
    }

    return data.sections
      .map((section) => `## ${section.label}\n\n${section.content}`)
      .join('\n\n')
  }, [data])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay
          className={cn(
            'fixed inset-0 z-[120] bg-black/85 backdrop-blur-[2px]',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
          )}
        />

        <DialogPrimitive.Content
          aria-describedby="channel-prompt-preview-dialog-description"
          className={cn(
            'fixed left-1/2 top-1/2 z-[121] h-[min(92vh,1400px)] w-[min(95vw,1600px)]',
            '-translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-white/10',
            'bg-background/95 shadow-[0_16px_80px_rgba(0,0,0,0.6)] outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
          )}
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            onOpenChange(false)
          }}
        >
          <div className="flex items-center gap-2 border-b border-border/50 px-5 py-3">
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-sm font-semibold">
                #{channelName} — AI Prompt Preview
              </DialogTitle>
              <p id="channel-prompt-preview-dialog-description" className="mt-1 text-xs text-muted-foreground">
                Read-only runtime prompt preview for collaboration members. Absolute Forge paths are redacted.
              </p>
            </div>

            <DialogPrimitive.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label="Close"
              >
                <X className="size-4" />
              </Button>
            </DialogPrimitive.Close>
          </div>

          <div className="flex items-center justify-between gap-3 border-b border-border/40 px-5 py-3">
            <Tabs value={view} onValueChange={(value) => setView(value as PromptPreviewView)}>
              <TabsList>
                <TabsTrigger value="combined">Combined</TabsTrigger>
                <TabsTrigger value="sections">Sections</TabsTrigger>
              </TabsList>
            </Tabs>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadPreview()}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 size-3.5" />
              )}
              Refresh
            </Button>
          </div>

          <ScrollArea className="h-[calc(100%-109px)]">
            <div className="p-5">
              {loading && !data ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
                </div>
              ) : error ? (
                <div className="flex flex-col items-center gap-3 py-16 text-center">
                  <p className="text-sm text-destructive">{error}</p>
                  <Button variant="outline" size="sm" onClick={() => void loadPreview()}>
                    <RefreshCw className="mr-1.5 size-3.5" />
                    Retry
                  </Button>
                </div>
              ) : data ? (
                view === 'combined' ? (
                  <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-foreground/90">
                    {combinedPreview}
                  </pre>
                ) : (
                  <div className="space-y-5">
                    {data.sections.map((section) => (
                      <section key={section.label} className="rounded-lg border border-border/60 bg-muted/20">
                        <div className="flex items-center gap-2 border-b border-border/50 px-4 py-2.5 text-sm font-medium">
                          <ScrollText className="size-4 text-muted-foreground" />
                          <span>{section.label}</span>
                        </div>
                        <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[13px] leading-relaxed text-foreground/90">
                          {section.content}
                        </pre>
                      </section>
                    ))}
                  </div>
                )
              ) : null}
            </div>
          </ScrollArea>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}
