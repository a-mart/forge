import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
} from '@middleman/protocol'

export const DEFAULT_FAVICON_EMOJI = '🔨'
export const ACTIVE_FAVICON_EMOJI = '🔥'

type AgentLiveStatuses = Record<
  string,
  { status: AgentStatus; pendingCount: number; contextUsage?: AgentContextUsage }
>

const FAVICON_SIZE = 64
const FAVICON_FONT_SIZE = Math.round(FAVICON_SIZE * 0.85)
const FAVICON_LINK_SELECTOR = 'link[rel="icon"][data-middleman-favicon], link[rel="icon"]'
const emojiFaviconCache = new Map<string, string>()

export function createEmojiSvgFaviconDataUrl(emoji: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="50%" y="50%" dy=".08em" text-anchor="middle" dominant-baseline="middle" font-size="90">${emoji}</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function createEmojiCanvasFaviconDataUrl(emoji: string): string {
  if (typeof document === 'undefined') {
    return createEmojiSvgFaviconDataUrl(emoji)
  }

  const canvas = document.createElement('canvas')
  canvas.width = FAVICON_SIZE
  canvas.height = FAVICON_SIZE

  const context = canvas.getContext('2d')
  if (!context) {
    return createEmojiSvgFaviconDataUrl(emoji)
  }

  context.clearRect(0, 0, FAVICON_SIZE, FAVICON_SIZE)
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.font = `${FAVICON_FONT_SIZE}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`
  context.fillText(emoji, FAVICON_SIZE / 2, FAVICON_SIZE / 2 + 2)

  try {
    return canvas.toDataURL('image/png')
  } catch {
    return createEmojiSvgFaviconDataUrl(emoji)
  }
}

export function resolveEmojiFaviconDataUrl(emoji: string): string {
  const cached = emojiFaviconCache.get(emoji)
  if (cached) {
    return cached
  }

  const dataUrl = createEmojiCanvasFaviconDataUrl(emoji)
  emojiFaviconCache.set(emoji, dataUrl)
  return dataUrl
}

function getAgentLiveStatus(
  agent: AgentDescriptor,
  statuses: AgentLiveStatuses,
): AgentStatus {
  return statuses[agent.agentId]?.status ?? agent.status
}

export function resolveManagerFaviconEmoji(
  agents: AgentDescriptor[],
  statuses: AgentLiveStatuses,
): string {
  const hasStreamingAgent = agents.some((agent) => {
    return getAgentLiveStatus(agent, statuses) === 'streaming'
  })

  return hasStreamingAgent ? ACTIVE_FAVICON_EMOJI : DEFAULT_FAVICON_EMOJI
}

export function setDocumentFavicon(dataUrl: string): void {
  if (typeof document === 'undefined') {
    return
  }

  const existingLink = document.head.querySelector(FAVICON_LINK_SELECTOR)
  const link =
    existingLink instanceof HTMLLinkElement
      ? existingLink
      : document.createElement('link')

  link.rel = 'icon'
  link.href = dataUrl
  link.type = dataUrl.startsWith('data:image/png') ? 'image/png' : 'image/svg+xml'
  link.dataset.middlemanFavicon = 'true'

  if (!existingLink) {
    document.head.append(link)
  }
}
