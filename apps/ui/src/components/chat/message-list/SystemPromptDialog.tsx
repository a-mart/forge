import { useCallback, useEffect, useRef, useState } from 'react'
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
  const requestGeneration = useRef(0)

  const doFetch = useCallback(async () => {
    const generation = ++requestGeneration.current
    setLoading(true)
    setError(null)
    setData(null)
    try {
      const result = await fetchAgentSystemPrompt(wsUrl, agentId)
      if (requestGeneration.current === generation) {
        setData(result)
      }
    } catch (err) {
      if (requestGeneration.current === generation) {
        setError(err instanceof Error ? err.message : 'Failed to fetch initial model input')
      }
    } finally {
      if (requestGeneration.current === generation) {
        setLoading(false)
      }
    }
  }, [wsUrl, agentId])

  useEffect(() => {
    if (!open) {
      requestGeneration.current += 1
      setLoading(false)
      setError(null)
      setData(null)
      setCopied(false)
      return
    }

    void doFetch()
    return () => {
      requestGeneration.current += 1
    }
  }, [open, doFetch])

  // Do not render a previous agent's capture during the render before the
  // identity-change effect clears it.
  const currentData = data?.agentId === agentId ? data : null
  const capture = currentData?.initialModelInput.status === 'available'
    ? currentData.initialModelInput.capture
    : undefined
  const rawCapture = capture ? JSON.stringify(capture, null, 2) : undefined

  const handleCopy = useCallback(() => {
    if (!rawCapture) return
    void navigator.clipboard.writeText(rawCapture).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [rawCapture])

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
          aria-describedby={undefined}
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
            <DialogTitle className="min-w-0 flex-1 truncate text-sm font-semibold">
              &ldquo;{agentLabel}&rdquo; &mdash; Initial Model Input
            </DialogTitle>

            {rawCapture ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                onClick={handleCopy}
                aria-label="Copy initial model input"
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

          <ScrollArea className="h-[calc(100%-49px)]">
            <div className="space-y-5 p-5">
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
              ) : capture ? (
                <InitialModelInputCapture capture={capture} rawCapture={rawCapture!} />
              ) : currentData?.initialModelInput.status === 'unsupported' ? (
                <p className="py-16 text-center text-sm text-muted-foreground">
                  {currentData.initialModelInput.message}
                </p>
              ) : currentData?.initialModelInput.status === 'pending' ? (
                <p className="py-16 text-center text-sm text-muted-foreground">
                  {currentData.initialModelInput.message}
                </p>
              ) : null}
            </div>
          </ScrollArea>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}

function InitialModelInputCapture({
  capture,
  rawCapture,
}: {
  capture: Extract<AgentSystemPromptResponse['initialModelInput'], { status: 'available' }>['capture']
  rawCapture: string
}) {
  return (
    <>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Provider / model</dt>
          <dd className="font-mono text-foreground">{capture.model.provider}/{capture.model.id}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Captured</dt>
          <dd className="font-mono text-foreground">{capture.capturedAt}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Capture point</dt>
          <dd className="font-mono text-foreground">{capture.fidelity.capturePoint}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Image payloads</dt>
          <dd className="font-mono text-foreground">{capture.fidelity.images}</dd>
        </div>
      </dl>

      <CaptureSection title="Final system prompt" value={capture.systemPrompt} />
      <CaptureSection title="Converted messages" value={capture.messages} />
      <CaptureSection title="Active tools and schemas" value={capture.tools} />
      <CaptureSection title="Safe request metadata" value={capture.requestMetadata} />
      <CaptureSection title="Raw capture" value={rawCapture} />
    </>
  )
}

function CaptureSection({ title, value }: { title: string; value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      <pre className="max-h-[42vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 p-3 font-mono text-[13px] leading-relaxed text-foreground/90">
        {text}
      </pre>
    </section>
  )
}
