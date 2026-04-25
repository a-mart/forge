import { cn } from '@/lib/utils'
import { inferModelPreset } from '@/lib/model-preset'
import type { AgentDescriptor } from '@forge/protocol'

export function SessionStatusDot({ running }: { running: boolean }) {
  return (
    <span
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        running ? 'bg-emerald-500' : 'bg-muted-foreground/40',
      )}
      aria-label={running ? 'Running' : 'Idle'}
    />
  )
}

export function SidebarModelIcon({ agent }: { agent: AgentDescriptor }) {
  const provider = agent.model.provider.toLowerCase()
  const preset = inferModelPreset(agent)

  if (preset === 'pi-opus' || provider.includes('anthropic') || provider.includes('claude')) {
    return <img src="/agents/claude-logo.svg" alt="" aria-hidden="true" className="size-3 shrink-0 object-contain opacity-70" />
  }

  if (preset === 'pi-codex' || preset === 'pi-5.4' || provider.includes('openai')) {
    return <img src="/agents/codex-logo.svg" alt="" aria-hidden="true" className="size-3 shrink-0 object-contain opacity-70 dark:invert" />
  }

  return <span className="inline-block size-1.5 rounded-full bg-muted-foreground/40" aria-hidden="true" />
}

export function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>

  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const parts: React.ReactNode[] = []
  let lastIndex = 0

  let searchFrom = 0
  while (searchFrom < lowerText.length) {
    const index = lowerText.indexOf(lowerQuery, searchFrom)
    if (index === -1) break

    if (index > lastIndex) {
      parts.push(text.slice(lastIndex, index))
    }
    parts.push(
      <span key={index} className="rounded-sm bg-yellow-500/20">
        {text.slice(index, index + query.length)}
      </span>,
    )
    lastIndex = index + query.length
    searchFrom = lastIndex
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return <>{parts}</>
}
