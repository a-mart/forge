import type { ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

interface GitMutationConfirmDialogProps {
  open: boolean
  title: string
  description: string
  warnings?: string[]
  blockedReasons?: string[]
  confirmLabel: string
  isSubmitting?: boolean
  extraContent?: ReactNode
  onConfirm: () => void
  onCancel: () => void
}

export function GitMutationConfirmDialog({
  open,
  title,
  description,
  warnings = [],
  blockedReasons = [],
  confirmLabel,
  isSubmitting = false,
  extraContent,
  onConfirm,
  onCancel,
}: GitMutationConfirmDialogProps) {
  const blocked = blockedReasons.length > 0

  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onCancel() }}>
      <AlertDialogContent
        className="overflow-hidden"
        style={{ maxHeight: 'calc(100vh - 2rem)', gridTemplateRows: 'auto minmax(0, 1fr) auto' }}
      >
        <AlertDialogHeader className="min-w-0">
          <AlertDialogTitle>{title}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogDescription asChild>
          <div className="min-h-0 space-y-3 overflow-y-auto overflow-x-hidden pr-1 text-sm text-muted-foreground">
            <p className="break-words">{description}</p>
            {extraContent}
            {warnings.length > 0 ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-900 dark:text-amber-100">
                <p className="font-medium">Warnings</p>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {warnings.map((warning) => (
                    <li className="break-words" key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {blockedReasons.length > 0 ? (
              <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-red-900 dark:text-red-100">
                <p className="font-medium">Blocked</p>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {blockedReasons.map((reason) => (
                    <li className="break-words" key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </AlertDialogDescription>
        <AlertDialogFooter className="shrink-0 border-t border-border pt-3">
          <Button variant="outline" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={blocked || isSubmitting}>
            {isSubmitting ? 'Working…' : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
