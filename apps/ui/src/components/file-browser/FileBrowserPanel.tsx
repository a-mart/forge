import { useEffect, useMemo, useRef } from 'react'
import { FileCode2, FileImage, FileText, FileType, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useResizablePanel } from '@/components/diff-viewer/useResizablePanel'
import { FileContentViewer, useFileViewerInfo } from './FileContentViewer'
import { FileStatusBar } from './FileStatusBar'
import { useDirectoryListing, useFileContent } from './use-file-browser-queries'
import type { FileContentResult } from './use-file-browser-queries'
import type { FileEditSessionController } from './use-file-edit-session'
import type { FileEditorSessionKey } from './use-file-editor-coordinator'
import { isImageFile, isPdfFile } from './file-browser-utils'
import { useSelectionContainment } from '@/hooks/useSelectionContainment'

const IMAGE_FILE_PATTERN = /\.(png|jpg|jpeg|gif|webp|svg)$/i
const MARKDOWN_FILE_PATTERN = /\.(md|markdown|mdx)$/i

interface FileBrowserPanelProps {
  wsUrl: string
  agentId: string | null
  filePath: string | null
  onClose: () => void
  onNavigateToDirectory: (dirPath: string) => void
  worktreeId?: string | null
  desktopOnly?: boolean
  mobileOnly?: boolean
  resizeHandlePlacement?: 'left' | 'right'
  inlineEditingEnabled?: boolean
  editSession?: FileEditSessionController | null
  editorSessionKey?: FileEditorSessionKey | null
  onContentLoaded?: (key: FileEditorSessionKey, content: FileContentResult | null) => void
}

export function FileBrowserPanel({
  wsUrl,
  agentId,
  filePath,
  onClose,
  onNavigateToDirectory,
  worktreeId = null,
  desktopOnly = false,
  mobileOnly = false,
  resizeHandlePlacement = 'left',
  inlineEditingEnabled = false,
  editSession = null,
  editorSessionKey = null,
  onContentLoaded,
}: FileBrowserPanelProps) {
  const gatedAgentId = filePath ? agentId : null

  // Fetch root listing for cwd (re-uses cache from sidebar)
  const rootList = useDirectoryListing(wsUrl, gatedAgentId, '', worktreeId)
  const cwd = rootList.data?.cwd ?? ''

  // Only fetch file content for non-image, non-PDF files
  const shouldFetchContent = useMemo(
    () => filePath && !isImageFile(filePath) && !isPdfFile(filePath),
    [filePath],
  )
  const fileContent = useFileContent(
    wsUrl,
    gatedAgentId,
    shouldFetchContent ? filePath : null,
    worktreeId,
  )

  const viewerInfo = useFileViewerInfo(filePath, fileContent.data)

  useEffect(() => {
    if (!editorSessionKey || !onContentLoaded) return
    onContentLoaded(editorSessionKey, fileContent.data ?? null)
  }, [editorSessionKey, fileContent.data, onContentLoaded])

  const panelRef = useRef<HTMLDivElement>(null)
  const { onPointerDown: onSelectionPointerDown } = useSelectionContainment(panelRef)

  const { width, isDragging, handleRef } = useResizablePanel({
    storageKey: 'forge-file-viewer-width',
    defaultWidth: 850,
    minWidth: 300,
    maxWidth: 1400,
    invertDelta: resizeHandlePlacement === 'left',
  })

  const fileName = filePath?.split('/').pop() ?? ''
  const isImage = IMAGE_FILE_PATTERN.test(fileName)
  const isPdf = isPdfFile(fileName)
  const isMarkdown = MARKDOWN_FILE_PATTERN.test(fileName)
  const FileIcon = isImage ? FileImage : isPdf ? FileType : isMarkdown ? FileText : FileCode2

  if (!filePath) {
    return null
  }

  return (
    <>
      {resizeHandlePlacement === 'left' ? (
        <FileViewerResizeHandle
          handleRef={handleRef}
          isDragging={isDragging}
          desktopOnly={desktopOnly}
          mobileOnly={mobileOnly}
        />
      ) : null}

      {/* Panel */}
      <div
        ref={panelRef}
        onPointerDown={onSelectionPointerDown}
        className={cn(
          'flex h-full shrink-0 flex-col bg-background',
          resizeHandlePlacement === 'left' ? 'border-l border-border/80' : 'border-r border-border/80',
          desktopOnly && 'max-md:hidden',
          mobileOnly && 'md:hidden',
        )}
        style={{ width }}
      >
        {/* Header */}
        <header className="flex h-[62px] shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-card/80 px-5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileIcon className="size-3.5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-sm font-bold text-foreground">{fileName}</h2>
                {editSession?.state.dirty ? (
                  <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                    Unsaved
                  </span>
                ) : null}
              </div>
              <p className="truncate font-mono text-[11px] text-muted-foreground">{filePath}</p>
            </div>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              'size-8 rounded-md shrink-0',
              'text-muted-foreground transition-colors',
              'hover:bg-muted hover:text-foreground',
            )}
            onClick={onClose}
            aria-label="Close file viewer"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </header>

        {/* Content */}
        <div className="flex min-h-0 flex-1 flex-col">
          {gatedAgentId && filePath ? (
            <FileContentViewer
              wsUrl={wsUrl}
              agentId={gatedAgentId}
              cwd={cwd}
              filePath={filePath}
              content={fileContent.data}
              isLoading={fileContent.isLoading}
              error={fileContent.error}
              onNavigateToDirectory={onNavigateToDirectory}
              worktreeId={worktreeId}
              inlineEditingEnabled={inlineEditingEnabled && !mobileOnly}
              editSession={editSession}
            />
          ) : null}
        </div>

        {/* Status bar */}
        <FileStatusBar
          fileCount={null}
          fileCountMethod={null}
          selectedFile={filePath}
          languageDisplayName={viewerInfo.languageDisplayName}
          lineCount={viewerInfo.lineCount}
          fileSize={viewerInfo.fileSize}
          encoding={viewerInfo.encoding}
          editability={viewerInfo.editability}
          isDirty={editSession?.state.dirty ?? false}
          saveState={editSession?.state.saveState}
        />
      </div>

      {resizeHandlePlacement === 'right' ? (
        <FileViewerResizeHandle
          handleRef={handleRef}
          isDragging={isDragging}
          desktopOnly={desktopOnly}
          mobileOnly={mobileOnly}
        />
      ) : null}
    </>
  )
}

function FileViewerResizeHandle({
  handleRef,
  isDragging,
  desktopOnly,
  mobileOnly,
}: {
  handleRef: (node: HTMLDivElement | null) => void
  isDragging: boolean
  desktopOnly: boolean
  mobileOnly: boolean
}) {
  return (
    <div
      ref={handleRef}
      className={cn(
        'group relative h-full shrink-0 cursor-col-resize transition-colors',
        isDragging ? 'bg-primary/40' : 'bg-transparent hover:bg-border',
        desktopOnly && 'max-md:hidden',
        mobileOnly && 'md:hidden',
      )}
      style={{ width: 6 }}
    >
      <div className="absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/0 transition-colors group-hover:bg-foreground/25" />
    </div>
  )
}
