import type { ArtifactReference } from '@/lib/artifacts'
import { CortexDocumentViewerShell, type CortexDocumentDescriptor } from './CortexDocumentViewerShell'

interface KnowledgeFileViewerProps {
  wsUrl: string
  document: CortexDocumentDescriptor | null
  agentId?: string | null
  refreshKey?: number
  onArtifactClick?: (artifact: ArtifactReference) => void
}

export function KnowledgeFileViewer({
  wsUrl,
  document,
  agentId,
  refreshKey = 0,
  onArtifactClick,
}: KnowledgeFileViewerProps) {
  return (
    <CortexDocumentViewerShell
      wsUrl={wsUrl}
      document={document}
      agentId={agentId}
      refreshKey={refreshKey}
      onArtifactClick={onArtifactClick}
    />
  )
}
