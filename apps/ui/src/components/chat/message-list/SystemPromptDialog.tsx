import { useCallback, useEffect, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Check, Copy, Loader2, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import {
  fetchAgentSystemPrompt,
  type AgentSystemPromptResponse,
} from './system-prompt-api'

interface SystemPromptDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentId: string
  agentLabel: string
  wsUrl?: string
}

export function SystemPromptDialog({
  open,
  onOpenChange,
  agentId,
  agentLabel,
  wsUrl,
}: SystemPromptDialogProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<AgentSystemPromptResponse | null>(null)
  const [copied, setCopied] = useState(false)

  const doFetch = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchAgentSystemPrompt(wsUrl, agentId)
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch system prompt')
    } finally {
      setLoading(false)
    }
  }, [wsUrl, agentId])

  useEffect(() => {
    if (open) {
      void doFetch()
    }
  }, [open, doFetch])

  const handleCopy = useCallback(() => {
    if (!data?.systemPrompt) return
    void navigator.clipboard.writeText(data.systemPrompt).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [data])

  const promptText = data?.systemPrompt

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
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-border/50 px-5 py-3">
            <DialogTitle className="min-w-0 flex-1 truncate text-sm font-semibold">
              &ldquo;{agentLabel}&rdquo; &mdash; System Prompt
            </DialogTitle>

            {promptText ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                onClick={handleCopy}
                aria-label="Copy system prompt"
              >
                {copied ? (
                  <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Copy className="size-3.5 text-muted-foreground" />
                )}
              </Button>
            ) : null}

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

          {/* Body */}
          <ScrollArea className="h-[calc(100%-49px)]">
            <div className="p-5">
              {loading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2
                    className="size-5 animate-spin text-muted-foreground"
                    aria-hidden="true"
                  />
                </div>
              ) : error ? (
                <div className="flex flex-col items-center gap-3 py-16 text-center">
                  <p className="text-sm text-destructive">{error}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void doFetch()}
                  >
                    <RefreshCw className="mr-1.5 size-3.5" />
                    Retry
                  </Button>
                </div>
              ) : data && promptText == null ? (
                <p className="py-16 text-center text-sm text-muted-foreground">
                  System prompt not available for this agent (created before prompt
                  persistence was added).
                </p>
              ) : promptText ? (
                <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-foreground/90">
                  {promptText}
                </pre>
              ) : null}
            </div>
          </ScrollArea>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}
