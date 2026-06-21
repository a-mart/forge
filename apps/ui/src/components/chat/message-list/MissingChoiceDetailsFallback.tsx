import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface MissingChoiceDetailsFallbackProps {
  choiceId: string
  responseAgentId?: string | null
  onCancel?: (agentId: string, choiceId: string) => void
}

export function MissingChoiceDetailsFallback({
  choiceId,
  responseAgentId,
  onCancel,
}: MissingChoiceDetailsFallbackProps) {
  const canCancel = Boolean(responseAgentId && onCancel)

  return (
    <div className="max-w-2xl space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
      <div className="flex items-center gap-2 font-medium text-foreground">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <span>Input request details unavailable</span>
      </div>
      <p className="text-muted-foreground">
        The session is waiting on a choice, but the options were not delivered to this client.
      </p>
      <p className="break-all font-mono text-xs text-muted-foreground">Choice ID: {choiceId}</p>
      {canCancel && responseAgentId ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onCancel?.(responseAgentId, choiceId)}
        >
          Skip
        </Button>
      ) : null}
    </div>
  )
}
