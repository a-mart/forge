import { useEffect, useMemo } from 'react'
import {
  resolveEmojiFaviconDataUrl,
  resolveManagerFaviconEmoji,
  setDocumentFavicon,
} from '@/lib/favicon'
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
} from '@middleman/protocol'

interface UseDynamicFaviconOptions {
  agents: AgentDescriptor[]
  statuses: Record<
    string,
    { status: AgentStatus; pendingCount: number; contextUsage?: AgentContextUsage }
  >
}

export function useDynamicFavicon({ agents, statuses }: UseDynamicFaviconOptions): void {
  const faviconEmoji = useMemo(() => {
    return resolveManagerFaviconEmoji(agents, statuses)
  }, [agents, statuses])

  useEffect(() => {
    const faviconDataUrl = resolveEmojiFaviconDataUrl(faviconEmoji)
    setDocumentFavicon(faviconDataUrl)
  }, [faviconEmoji])
}
