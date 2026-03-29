import type { CortexDocumentEntry } from '@forge/protocol'
import type { ArtifactReference } from '@/lib/artifacts'
import type { DiffViewerInitialState } from '@/components/diff-viewer/DiffViewerDialog'
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
  onSelectDocument?: (documentId: string) => void
  onOpenDiffViewer?: (initialState: DiffViewerInitialState) => void
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
  onSelectDocument,
  onOpenDiffViewer,
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
      onSelectDocument={onSelectDocument}
      onOpenDiffViewer={onOpenDiffViewer}
    />
  )
}
