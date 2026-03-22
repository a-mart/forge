import { useEffect, useMemo, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { FileCode2, FileImage, FileText, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
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
  const [isVisible, setIsVisible] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const closingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  // Animation
  useEffect(() => {
    if (!filePath) {
      setIsVisible(false)
      setIsClosing(false)
      return
    }

    setIsClosing(false)
    setIsVisible(false)
    const frame = window.requestAnimationFrame(() => {
      setIsVisible(true)
    })

    return () => {
      window.cancelAnimationFrame(frame)
    }
  }, [filePath])

  useEffect(() => {
    return () => {
      if (closingTimerRef.current) {
        clearTimeout(closingTimerRef.current)
      }
    }
  }, [])

  const handleAnimatedClose = () => {
    setIsClosing(true)
    setIsVisible(false)
    if (closingTimerRef.current) {
      clearTimeout(closingTimerRef.current)
    }
    closingTimerRef.current = setTimeout(() => {
      setIsClosing(false)
      onClose()
    }, 260)
  }

  const fileName = filePath?.split('/').pop() ?? ''
  const isImage = IMAGE_FILE_PATTERN.test(fileName)
  const isMarkdown = MARKDOWN_FILE_PATTERN.test(fileName)
  const FileIcon = isImage ? FileImage : isMarkdown ? FileText : FileCode2

  if (!filePath && !isClosing) {
    return null
  }

  const isOpen = Boolean(filePath) || isClosing

  return (
    <Dialog
      open={isOpen}
      modal={false}
      onOpenChange={(open) => {
        if (!open) {
          handleAnimatedClose()
        }
      }}
    >
      <DialogPortal>
        <DialogOverlay
          className={cn(
            'fixed inset-0 z-50 pointer-events-none',
            'transition-[backdrop-filter,background-color] duration-300 ease-out',
            isVisible
              ? 'bg-background/60 backdrop-blur-[2px]'
              : 'bg-transparent backdrop-blur-0',
            isClosing && !isVisible && 'bg-transparent backdrop-blur-0',
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            'fixed right-0 top-0 z-50 flex h-full w-full flex-col',
            'max-md:max-w-full md:max-w-[min(880px,90vw)]',
            'border-l border-border/80 bg-background',
            'shadow-[-8px_0_32px_-4px_rgba(0,0,0,0.12)] outline-none',
            'transition-all duration-[260ms] ease-[cubic-bezier(0.32,0.72,0,1)]',
            isVisible
              ? 'translate-x-0 opacity-100'
              : 'translate-x-[40%] opacity-0',
          )}
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            handleAnimatedClose()
          }}
          onInteractOutside={(event) => {
            // Allow interaction with elements outside (chat input, sidebar, etc.)
            event.preventDefault()
          }}
        >
          <DialogTitle className="sr-only">
            {filePath ? `File: ${fileName}` : 'File viewer'}
          </DialogTitle>

          {/* Header */}
          <header className="flex h-[62px] shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-card/80 px-5 backdrop-blur">
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
              onClick={handleAnimatedClose}
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
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}
