import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export function RosterPromptDialog({
  open,
  onOpenChange,
  loading,
  error,
  markdown,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  loading: boolean
  error: string | null
  markdown: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-3xl max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Generated Roster Prompt</DialogTitle>
          <DialogDescription>
            This is the specialist roster block injected into the manager system prompt.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
            <p className="text-xs text-destructive">{error}</p>
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto rounded-md border bg-muted/50 p-3">
            <pre className="text-xs leading-relaxed whitespace-pre-wrap break-words font-mono">
              {markdown || '(empty)'}
            </pre>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
