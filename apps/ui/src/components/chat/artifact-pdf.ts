import { CHAT_ARTIFACT_MAX_PDF_BYTES } from '@forge/protocol'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { isPdfFile } from '@/components/file-browser/file-browser-utils'

export const ARTIFACT_PDF_FILE_PATTERN = /\.pdf$/i

export function isArtifactPdfPath(fileName?: string | null, path?: string | null): boolean {
  return Boolean(
    (fileName && (isPdfFile(fileName) || ARTIFACT_PDF_FILE_PATTERN.test(fileName)))
    || (path && (isPdfFile(path) || ARTIFACT_PDF_FILE_PATTERN.test(path))),
  )
}

export interface ArtifactPdfTicketFile {
  binary?: boolean
  transport?: 'http_ticket'
  contentType?: string
  totalBytes?: number
  ticket?: { url: string; expiresAt: string }
}

export function resolveSafeArtifactPdfTicketUrl(wsUrl: string, file: ArtifactPdfTicketFile): string {
  const contentType = file.contentType?.trim().toLowerCase()
  const expiresAt = file.ticket ? Date.parse(file.ticket.expiresAt) : Number.NaN
  if (
    file.binary !== true
    || file.transport !== 'http_ticket'
    || !file.ticket
    || contentType !== 'application/pdf'
    || typeof file.totalBytes !== 'number'
    || file.totalBytes < 0
    || file.totalBytes > CHAT_ARTIFACT_MAX_PDF_BYTES
    || !Number.isFinite(expiresAt)
    || expiresAt <= Date.now()
  ) {
    throw new Error('Invalid PDF ticket response.')
  }

  const endpoint = new URL(resolveApiEndpoint(wsUrl, '/api/chat-artifacts/read'), window.location.href)
  const ticket = new URL(file.ticket.url, endpoint)
  if (
    ticket.origin !== endpoint.origin
    || !/^https?:$/.test(ticket.protocol)
    || !/^\/api\/chat-artifacts\/tickets\/[A-Za-z0-9_-]{16,128}$/.test(ticket.pathname)
    || ticket.username
    || ticket.password
    || ticket.search
    || ticket.hash
  ) {
    throw new Error('Invalid PDF ticket response.')
  }

  return ticket.toString()
}

export async function createArtifactPdfBlobUrl(ticketUrl: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(ticketUrl, {
    method: 'GET',
    credentials: 'include',
    signal,
  })
  if (!response.ok) {
    throw new Error('Unable to load PDF preview.')
  }

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (contentType !== 'application/pdf') {
    throw new Error('Invalid PDF ticket response.')
  }

  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > CHAT_ARTIFACT_MAX_PDF_BYTES) {
    throw new Error('This PDF is too large to preview.')
  }

  return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
}

export function revokeArtifactPdfBlobUrl(url: string | null | undefined): void {
  if (url?.startsWith('blob:')) {
    URL.revokeObjectURL(url)
  }
}
