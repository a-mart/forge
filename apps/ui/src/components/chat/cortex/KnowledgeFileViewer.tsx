import type { CortexDocumentEntry } from '@forge/protocol'
import type { ArtifactReference } from '@/lib/artifacts'
import { CortexDocumentViewerShell, type CortexDocumentDescriptor } from './CortexDocumentViewerShell'

interface KnowledgeFileViewerProps {
  wsUrl: string
  document: CortexDocumentDescriptor | null
  documents?: CortexDocumentEntry[]
  agentId?: string | null
  refreshKey?: number
  onArtifactClick?: (artifact: ArtifactReference) => void
  onOpenSession?: (agentId: string) => void
  canOpenSession?: (agentId: string) => boolean
}

export function KnowledgeFileViewer({
  wsUrl,
  document,
  documents,
  agentId,
  refreshKey = 0,
  onArtifactClick,
  onOpenSession,
  canOpenSession,
}: KnowledgeFileViewerProps) {
  return (
    <CortexDocumentViewerShell
      wsUrl={wsUrl}
      document={document}
      documents={documents}
      agentId={agentId}
      refreshKey={refreshKey}
      onArtifactClick={onArtifactClick}
      onOpenSession={onOpenSession}
      canOpenSession={canOpenSession}
    />
  )
}
