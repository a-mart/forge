import { AlertCircle, Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { TerminalDescriptor } from '@forge/protocol'
import type { TerminalWsState } from '@/lib/terminal-ws-client'
import { cn } from '@/lib/utils'

interface TerminalOverlayProps {
  terminal: TerminalDescriptor
  connectionState: TerminalWsState | 'loading'
  errorMessage?: string | null
  onRetry?: () => void
  showRestoredBanner?: boolean
}

export function TerminalOverlay({
  terminal,
  connectionState,
  errorMessage,
  onRetry,
  showRestoredBanner = false,
}: TerminalOverlayProps) {
  const exitCode = terminal.exitCode
  const hasExited = terminal.state === 'exited' || terminal.state === 'restore_failed'
  const exitLabel = hasExited
    ? terminal.state === 'restore_failed'
      ? 'Restore failed'
      : `Process exited${exitCode != null ? ` (${exitCode})` : ''}`
    : null

  return (
    <>
      {showRestoredBanner ? (
        <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex justify-center">
          <div className="rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-100 backdrop-blur-sm">
            ↻ Session restored — new shell
          </div>
        </div>
      ) : null}

      {hasExited && exitLabel ? (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex justify-center">
          <div
            className={cn(
              'rounded-md border px-3 py-1 text-xs backdrop-blur-sm',
              terminal.state === 'restore_failed' || (exitCode ?? 0) !== 0
                ? 'border-red-500/30 bg-red-500/10 text-red-100'
                : 'border-border/50 bg-black/30 text-zinc-200',
            )}
          >
            {exitLabel}
          </div>
        </div>
      ) : null}

      {connectionState === 'connected' ? null : (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0f1220]/55 backdrop-blur-[2px]">
          <div className="flex max-w-sm flex-col items-center gap-3 rounded-xl border border-white/10 bg-black/35 px-5 py-4 text-center text-zinc-100 shadow-lg">
            {connectionState === 'failed' ? (
              <AlertCircle className="size-5 text-red-300" />
            ) : (
              <Loader2 className="size-5 animate-spin text-zinc-200" />
            )}

            <div className="space-y-1">
              <p className="text-sm font-medium">
                {connectionState === 'loading'
                  ? 'Loading terminal…'
                  : connectionState === 'connecting'
                    ? 'Connecting…'
                    : connectionState === 'disconnected'
                      ? 'Reconnecting…'
                      : 'Connection lost'}
              </p>
              {errorMessage ? (
                <p className="text-xs text-zinc-300/80">{errorMessage}</p>
              ) : connectionState === 'disconnected' ? (
                <p className="text-xs text-zinc-300/80">Trying to restore the terminal connection.</p>
              ) : null}
            </div>

            {connectionState === 'failed' && onRetry ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-8 gap-2 bg-white/10 text-zinc-100 hover:bg-white/20"
                onClick={onRetry}
              >
                <RotateCcw className="size-3.5" />
                Retry now
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </>
  )
}
