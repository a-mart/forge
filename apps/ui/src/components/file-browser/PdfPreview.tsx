import { useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import '@/styles/file-browser.css'

export function buildPdfRawUrl(
  wsUrl: string,
  filePath: string,
  agentId: string,
  worktreeId?: string | null,
): string {
  const params = new URLSearchParams({ path: filePath, agentId })
  if (worktreeId) {
    params.set('worktreeId', worktreeId)
  }
  return resolveApiEndpoint(wsUrl, `/api/files/raw?${params.toString()}`)
}

interface PdfPreviewProps {
  wsUrl: string
  filePath: string
  agentId: string
  worktreeId?: string | null
}

export function PdfPreview({ wsUrl, filePath, agentId, worktreeId = null }: PdfPreviewProps) {
  const pdfUrl = useMemo(
    () => buildPdfRawUrl(wsUrl, filePath, agentId, worktreeId),
    [wsUrl, filePath, agentId, worktreeId],
  )

  const fileName = filePath.split('/').pop() ?? 'Document.pdf'

  return (
    <div
      className="file-browser-scroll flex h-full flex-col items-center justify-center gap-3 overflow-auto p-8 text-muted-foreground"
      data-testid="pdf-preview"
      data-pdf-url={pdfUrl}
      role="status"
      aria-label={`Loading PDF preview for ${fileName}`}
    >
      <Loader2 className="size-6 animate-spin opacity-60" aria-hidden="true" />
      <p className="text-sm">Loading PDF…</p>
      <p className="font-mono text-xs opacity-60">{fileName}</p>
    </div>
  )
}
