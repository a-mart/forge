import { Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ProjectAgentInfo } from '@forge/protocol'

const suggestions = [
  'Help me plan a feature',
  'What can you do?',
  'Start a coding task',
]

export function EmptyState({
  activeAgentId,
  projectAgent,
  onSuggestionClick,
}: {
  activeAgentId?: string | null
  projectAgent?: ProjectAgentInfo | null
  onSuggestionClick?: (suggestion: string) => void
}) {
  if (!activeAgentId) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <h2 className="mb-2 text-base font-medium text-foreground">
          No manager selected
        </h2>
        <p className="text-sm text-muted-foreground">
          Create a manager from the sidebar to start a thread.
        </p>
      </div>
    )
  }

  // Custom empty state for project agents created via the Agent Architect
  if (projectAgent?.creatorSessionId) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <div className="mb-4 flex size-10 items-center justify-center rounded-full bg-violet-500/10 text-violet-400">
          <Bot className="size-5" />
        </div>
        <h2 className="mb-1 text-base font-medium text-foreground">
          @{projectAgent.handle}
        </h2>
        <p className="mx-auto mb-4 max-w-sm text-sm text-muted-foreground">
          {projectAgent.whenToUse}
        </p>
        <p className="mx-auto mb-4 max-w-sm text-xs text-muted-foreground/70">
          Created by the Agent Architect. To adjust this agent&apos;s configuration,
          right-click it in the sidebar and select <span className="font-medium text-muted-foreground">Settings</span>.
        </p>
        {onSuggestionClick ? (
          <Button
            onClick={() => onSuggestionClick('What can you help me with?')}
            type="button"
            variant="outline"
            className="h-auto rounded-full bg-muted px-3 py-1.5 text-sm font-normal text-foreground transition-colors hover:bg-muted/80"
          >
            Send a message to get started
          </Button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col items-center justify-center p-6 text-center">
      <h2 className="mb-4 text-base font-medium text-foreground">
        What can I do for you?
      </h2>
      {onSuggestionClick ? (
        <div className="flex max-w-[320px] flex-wrap justify-center gap-2">
          {suggestions.map((suggestion) => (
            <Button
              key={suggestion}
              onClick={() => onSuggestionClick(suggestion)}
              type="button"
              variant="outline"
              className="h-auto rounded-full bg-muted px-3 py-1.5 text-sm font-normal text-foreground transition-colors hover:bg-muted/80"
            >
              {suggestion}
            </Button>
          ))}
        </div>
      ) : null}
      <p className="mt-6 text-xs text-muted-foreground">
        AI can make mistakes. Always verify important actions.
      </p>
    </div>
  )
}
