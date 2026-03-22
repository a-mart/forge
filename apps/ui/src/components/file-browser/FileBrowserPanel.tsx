import { useMemo } from 'react'
import { FileCode2, FileImage, FileText, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useResizablePanel } from '@/components/diff-viewer/useResizablePanel'
import { FileContentViewer, useFileViewerInfo } from './FileContentViewer'
import { FileStatusBar } from './FileStatusBar'
import { useDirectoryListing, useFileContent } from './use-file-browser-queries'
import { isImageFile } from './file-browser-utils'

const IMAGE_FILE_PATTERN = /\.(png|jpg|jpeg|gif|webp|svg)$/i
const MARKDOWN_FILE_PATTERN = /\.(md|markdown|mdx)$/i

interface FileBrowserPanelProps {
  wsUrl: string
  agentId: string | null
  filePath: string | null
  onClose: () => void
  onNavigateToDirectory: (dirPath: string) => void
}

export function FileBrowserPanel({
  wsUrl,
  agentId,
  filePath,
  onClose,
  onNavigateToDirectory,
}: FileBrowserPanelProps) {
  const gatedAgentId = filePath ? agentId : null

  // Fetch root listing for cwd (re-uses cache from sidebar)
  const rootList = useDirectoryListing(wsUrl, gatedAgentId, '')
  const cwd = rootList.data?.cwd ?? ''

  // Only fetch file content for non-image files
  const shouldFetchContent = useMemo(
    () => filePath && !isImageFile(filePath),
    [filePath],
  )
  const fileContent = useFileContent(
    wsUrl,
    gatedAgentId,
    shouldFetchContent ? filePath : null,
  )

  const viewerInfo = useFileViewerInfo(filePath, fileContent.data)

  const { width, isDragging, handleRef } = useResizablePanel({
    storageKey: 'forge-file-viewer-width',
    defaultWidth: 600,
    minWidth: 300,
    maxWidth: 1200,
    invertDelta: true,
  })

  const fileName = filePath?.split('/').pop() ?? ''
  const isImage = IMAGE_FILE_PATTERN.test(fileName)
  const isMarkdown = MARKDOWN_FILE_PATTERN.test(fileName)
  const FileIcon = isImage ? FileImage : isMarkdown ? FileText : FileCode2

  if (!filePath) {
    return null
  }

  return (
    <>
      {/* Drag handle (left edge) */}
      <div
        ref={handleRef}
        className={cn(
          'group relative h-full shrink-0 cursor-col-resize transition-colors',
          isDragging ? 'bg-primary/40' : 'bg-transparent hover:bg-border',
        )}
        style={{ width: 6 }}
      >
        <div className="absolute left-1/2 top-1/2 h-8 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/0 transition-colors group-hover:bg-foreground/25" />
      </div>

      {/* Panel */}
      <div
        className="flex h-full shrink-0 flex-col border-l border-border/80 bg-background"
        style={{ width }}
      >
        {/* Header */}
        <header className="flex h-[62px] shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-card/80 px-5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileIcon className="size-3.5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-bold text-foreground">{fileName}</h2>
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
        />
      </div>
    </>
  )
}
