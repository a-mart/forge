import { useCallback, useEffect, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Check, Copy, Loader2, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  InitialModelInputContent,
  type InitialModelInputViewMode,
} from './InitialModelInputContent'
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
  const [viewMode, setViewMode] = useState<InitialModelInputViewMode>('prompt')
  const requestGeneration = useRef(0)
  const contentScrollRef = useRef<HTMLDivElement>(null)
  const copyGeneration = useRef(0)
  const copyResetTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const doFetch = useCallback(async () => {
    const generation = ++requestGeneration.current
    setLoading(true)
    setError(null)
    setData(null)
    setViewMode('prompt')
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
      setViewMode('prompt')
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

  useEffect(() => {
    if (contentScrollRef.current) {
      contentScrollRef.current.scrollTop = 0
    }
  }, [viewMode, capture?.capturedAt])

  useEffect(() => {
    copyGeneration.current += 1
    setCopied(false)
    if (copyResetTimeout.current) {
      clearTimeout(copyResetTimeout.current)
      copyResetTimeout.current = null
    }

    return () => {
      copyGeneration.current += 1
      if (copyResetTimeout.current) {
        clearTimeout(copyResetTimeout.current)
        copyResetTimeout.current = null
      }
    }
  }, [viewMode, capture?.capturedAt])

  const handleViewModeChange = useCallback((mode: InitialModelInputViewMode) => {
    copyGeneration.current += 1
    setCopied(false)
    if (copyResetTimeout.current) {
      clearTimeout(copyResetTimeout.current)
      copyResetTimeout.current = null
    }
    setViewMode(mode)
  }, [])

  const copyText = viewMode === 'raw' ? rawCapture : capture?.systemPrompt
  const handleCopy = useCallback(() => {
    if (!copyText) return
    const generation = ++copyGeneration.current
    void navigator.clipboard.writeText(copyText).then(() => {
      if (copyGeneration.current !== generation) return
      setCopied(true)
      if (copyResetTimeout.current) {
        clearTimeout(copyResetTimeout.current)
      }
      copyResetTimeout.current = setTimeout(() => {
        if (copyGeneration.current === generation) {
          setCopied(false)
        }
        copyResetTimeout.current = null
      }, 1500)
    })
  }, [copyText])

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
              <>
                <div
                  className="flex shrink-0 items-center rounded-md border border-border/60 bg-muted/30 p-0.5"
                  aria-label="Initial model input view"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'h-6 rounded px-2 text-[11px]',
                      viewMode === 'prompt' && 'bg-background text-foreground shadow-sm',
                    )}
                    aria-pressed={viewMode === 'prompt'}
                    onClick={() => handleViewModeChange('prompt')}
                  >
                    Prompt
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'h-6 rounded px-2 text-[11px]',
                      viewMode === 'raw' && 'bg-background text-foreground shadow-sm',
                    )}
                    aria-pressed={viewMode === 'raw'}
                    onClick={() => handleViewModeChange('raw')}
                  >
                    Raw JSON
                  </Button>
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  onClick={handleCopy}
                  aria-label={viewMode === 'raw' ? 'Copy raw initial model input' : 'Copy system prompt'}
                >
                  {copied ? (
                    <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <Copy className="size-3.5 text-muted-foreground" />
                  )}
                </Button>
              </>
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

          <div
            ref={contentScrollRef}
            className={cn(
              'h-[calc(100%-49px)] overflow-y-auto overscroll-contain [scrollbar-gutter:stable]',
              '[&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-muted/20',
              '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border',
              '[&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/50',
              '[scrollbar-width:thin] [scrollbar-color:var(--color-border)_transparent]',
            )}
          >
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
              ) : capture ? (
                <InitialModelInputContent
                  capture={capture}
                  rawCapture={rawCapture!}
                  mode={viewMode}
                />
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
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}
