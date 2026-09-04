import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StopProcessesAndRevokeDialog } from './StopProcessesAndRevokeDialog'

interface SecureOutputQuarantineNoticeProps {
  reason?: string
  onDismiss?: () => void
  onStopProcessesAndRevoke?: () => void | Promise<void>
}

export function SecureOutputQuarantineNotice({
  reason,
  onDismiss,
  onStopProcessesAndRevoke,
}: SecureOutputQuarantineNoticeProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)

  return (
    <>
      <div
        className="max-w-2xl space-y-2 rounded-lg border border-destructive/35 bg-destructive/5 p-4"
        role="alert"
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ShieldAlert className="size-4 text-destructive" aria-hidden="true" />
          <span>Protected output redacted</span>
        </div>
        <p className="text-sm text-muted-foreground">
          {reason ?? 'Forge removed protected material before it reached the agent. The command completed and the Secure Session can continue.'}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => onDismiss?.()}
          >
            Dismiss
          </Button>
          {onStopProcessesAndRevoke ? (
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => setConfirmOpen(true)}
            >
              Stop Secure Session
            </Button>
          ) : null}
        </div>
      </div>

      {onStopProcessesAndRevoke ? (
        <StopProcessesAndRevokeDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          onConfirm={onStopProcessesAndRevoke}
        />
      ) : null}
    </>
  )
}
