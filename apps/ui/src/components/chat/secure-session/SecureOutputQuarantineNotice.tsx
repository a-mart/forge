import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StopProcessesAndRevokeDialog } from './StopProcessesAndRevokeDialog'

interface SecureOutputQuarantineNoticeProps {
  reason?: string
  onStopProcessesAndRevoke?: () => void | Promise<void>
}

export function SecureOutputQuarantineNotice({
  reason,
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
          <span>Secure output quarantined</span>
        </div>
        <p className="text-sm text-muted-foreground">
          {reason ?? 'Output was withheld because it may contain protected secret material.'}
        </p>
        {onStopProcessesAndRevoke ? (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => setConfirmOpen(true)}
          >
            Stop processes and revoke
          </Button>
        ) : null}
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
