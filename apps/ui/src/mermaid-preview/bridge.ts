import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { resolveBackendWsUrl } from '@/lib/backend-url'

export type MermaidThemeMode = 'light' | 'dark'

export interface MermaidPreviewSize {
  width: number
  height: number
}

export interface MermaidPreviewReadyMessage {
  type: 'forge:mermaid-ready'
  instanceId: string
}

export interface MermaidPreviewRenderedMessage {
  type: 'forge:mermaid-rendered'
  instanceId: string
  requestId: string
  height?: number
  size?: MermaidPreviewSize
  renderMode?: string
}

export interface MermaidPreviewErrorMessage {
  type: 'forge:mermaid-error'
  instanceId: string
  requestId?: string
  message?: string
  error?: string
}

export interface MermaidPreviewSizeMessage {
  type: 'forge:mermaid-size'
  instanceId: string
  requestId?: string
  height?: number
  size?: MermaidPreviewSize
}

export interface MermaidPreviewExportSvgResultMessage {
  type: 'forge:mermaid-export-svg-result'
  instanceId: string
  requestId: string
  svg?: string
  error?: string
  renderMode?: string
}

export type MermaidPreviewChildMessage =
  | MermaidPreviewReadyMessage
  | MermaidPreviewRenderedMessage
  | MermaidPreviewErrorMessage
  | MermaidPreviewSizeMessage
  | MermaidPreviewExportSvgResultMessage

export interface MermaidPreviewRenderMessage {
  type: 'forge:mermaid-render'
  instanceId: string
  requestId: string
  code: string
  source?: string
  themeMode: MermaidThemeMode
}

export interface MermaidPreviewExportSvgMessage {
  type: 'forge:mermaid-export-svg'
  instanceId: string
  requestId: string
}

export interface MermaidPreviewPingMessage {
  type: 'forge:mermaid-ping'
  instanceId: string
}

export type MermaidPreviewParentMessage =
  | MermaidPreviewRenderMessage
  | MermaidPreviewExportSvgMessage
  | MermaidPreviewPingMessage

function isSizeObject(value: unknown): value is MermaidPreviewSize {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const maybe = value as Record<string, unknown>
  return typeof maybe.width === 'number' && typeof maybe.height === 'number'
}

export function isMermaidPreviewChildMessage(value: unknown): value is MermaidPreviewChildMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const maybe = value as Record<string, unknown>
  if (typeof maybe.type !== 'string' || typeof maybe.instanceId !== 'string') {
    return false
  }

  switch (maybe.type) {
    case 'forge:mermaid-ready':
      return true
    case 'forge:mermaid-rendered':
      return (
        typeof maybe.requestId === 'string' &&
        (typeof maybe.height === 'number' || isSizeObject(maybe.size))
      )
    case 'forge:mermaid-error':
      return typeof maybe.message === 'string' || typeof maybe.error === 'string'
    case 'forge:mermaid-size':
      return typeof maybe.height === 'number' || isSizeObject(maybe.size)
    case 'forge:mermaid-export-svg-result':
      return typeof maybe.requestId === 'string'
    default:
      return false
  }
}

export function resolveMermaidPreviewIframeUrl(
  instanceId: string,
  themeMode?: MermaidThemeMode,
): string {
  const query = new URLSearchParams({ instanceId })
  if (themeMode) {
    query.set('theme', themeMode)
  }

  return resolveApiEndpoint(
    resolveBackendWsUrl(),
    `/mermaid-preview/embed?${query.toString()}`,
  )
}
