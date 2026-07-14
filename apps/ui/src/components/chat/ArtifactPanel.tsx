import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FrontMatterBlock } from '@/components/ui/FrontMatterBlock'
import { parseFrontMatter } from '@/lib/parse-front-matter'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Check, ClipboardCopy, ExternalLink, FileCode2, FileImage, FileText, FolderOpen, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { ArtifactReference } from '@/lib/artifacts'
import { toEditorHref } from '@/lib/artifacts'
import {
  EDITOR_LABELS,
  EDITOR_URL_SCHEMES,
  readStoredEditorPreference,
} from '@/lib/editor-preference'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { isElectron } from '@/lib/electron-bridge'
import { useSelectionContainment } from '@/hooks/useSelectionContainment'
import { MarkdownMessage } from './MarkdownMessage'

interface ArtifactPanelProps {
  artifact: ArtifactReference | null
  wsUrl: string
  activeAgentId?: string | null
  onClose: () => void
  onArtifactClick?: (artifact: ArtifactReference) => void
}

interface ReadFileResult {
  path: string
  content: string
  binary?: boolean
  encoding?: string
  contentType?: string
}

const MARKDOWN_FILE_PATTERN = /\.(md|markdown|mdx)$/i
const IMAGE_FILE_PATTERN = /\.(png|jpg|jpeg|gif|webp|svg)$/i

export function ArtifactPanel({ artifact, wsUrl, activeAgentId, onClose, onArtifactClick }: ArtifactPanelProps) {
  const [isVisible, setIsVisible] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null)
  const [resolvedPath, setResolvedPath] = useState<string | null>(null)
  const closingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const { onPointerDown: onSelectionPointerDown } = useSelectionContainment(contentRef)

  const editorPreference = readStoredEditorPreference()
  const editorScheme = EDITOR_URL_SCHEMES[editorPreference]
  const editorLabel = EDITOR_LABELS[editorPreference]

  const artifactPath = artifact?.path ?? null
  const artifactFileName = artifact?.fileName ?? null
  const artifactSourceAgentId = artifact?.sourceAgentId ?? null
  const transcriptAgentId = artifact?.transcriptAgentId ?? null
  const transcriptMessageId = artifact?.messageId ?? null
  const [pathCopied, setPathCopied] = useState(false)

  useEffect(() => {
    if (!artifactPath) {
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
  }, [artifactPath])

  useEffect(() => {
    if (!artifactPath) {
      setContent('')
      setImagePreviewUrl(null)
      setResolvedPath(null)
      setError(null)
      setIsLoading(false)
      return
    }

    const isImageArtifact =
      IMAGE_FILE_PATTERN.test(artifactFileName ?? '') || IMAGE_FILE_PATTERN.test(artifactPath)
    const hasTranscriptProvenance = Boolean(transcriptAgentId && transcriptMessageId)
    if (isImageArtifact && !hasTranscriptProvenance) {
      setContent('')
      setImagePreviewUrl(resolveReadFileUrl(wsUrl, artifactPath, artifactSourceAgentId ?? activeAgentId))
      setResolvedPath(artifactPath)
      setError(null)
      setIsLoading(false)
      return
    }

    const abortController = new AbortController()

    setIsLoading(true)
    setError(null)
    setContent('')
    setImagePreviewUrl(null)
    setResolvedPath(null)

    void (async () => {
      try {
        const file = hasTranscriptProvenance
          ? await readTranscriptArtifactFile({
              wsUrl,
              transcriptAgentId: transcriptAgentId!,
              messageId: transcriptMessageId!,
              path: artifactPath,
              signal: abortController.signal,
            })
          : await readLegacyArtifactFile({
              wsUrl,
              path: artifactPath,
              agentId: artifactSourceAgentId ?? activeAgentId,
              signal: abortController.signal,
            })

        if (abortController.signal.aborted) {
          return
        }

        if (isImageArtifact) {
          setImagePreviewUrl(toSafeImageDataUrl(file))
          setContent('')
        } else {
          if (file.binary) {
            throw new Error('Binary files cannot be displayed as text.')
          }
          setContent(file.content)
        }
        setResolvedPath(file.path)
        setError(null)
      } catch (readError) {
        if (abortController.signal.aborted) {
          return
        }

        setError(readError instanceof Error ? readError.message : 'Failed to read file.')
      } finally {
        if (!abortController.signal.aborted) {
          setIsLoading(false)
        }
      }
    })()

    return () => {
      abortController.abort()
    }
  }, [
    activeAgentId,
    artifactFileName,
    artifactPath,
    artifactSourceAgentId,
    transcriptAgentId,
    transcriptMessageId,
    wsUrl,
  ])

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

  const displayPath = resolvedPath ?? artifactPath ?? ''
  const handleCopyPath = useCallback(() => {
    const pathToCopy = displayPath || artifact?.path
    if (!pathToCopy) return
    void navigator.clipboard.writeText(pathToCopy).then(() => {
      setPathCopied(true)
      setTimeout(() => setPathCopied(false), 1500)
    })
  }, [displayPath, artifact?.path])

  const isImage = useMemo(
    () => IMAGE_FILE_PATTERN.test(artifact?.fileName ?? '') || IMAGE_FILE_PATTERN.test(displayPath),
    [artifact?.fileName, displayPath],
  )
  const isMarkdown = useMemo(() => MARKDOWN_FILE_PATTERN.test(displayPath), [displayPath])
  const frontMatter = useMemo(
    () => (isMarkdown && content ? parseFrontMatter(content) : null),
    [isMarkdown, content],
  )
  const markdownBody = frontMatter ? frontMatter.body : content

  const handleNestedArtifactClick = useCallback(
    (nextArtifact: ArtifactReference) => {
      onArtifactClick?.({
        ...nextArtifact,
        sourceAgentId:
          nextArtifact.sourceAgentId ?? artifact?.sourceAgentId ?? activeAgentId ?? undefined,
      })
    },
    [activeAgentId, artifact?.sourceAgentId, onArtifactClick],
  )

  if (!artifact && !isClosing) {
    return null
  }

  const FileIcon = isImage ? FileImage : isMarkdown ? FileText : FileCode2
  const isOpen = Boolean(artifactPath) || isClosing

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
          ref={contentRef}
          onPointerDown={onSelectionPointerDown}
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
            // Allow interaction with elements outside the panel (e.g. chat input)
            event.preventDefault()
          }}
        >
          <DialogTitle className="sr-only">{artifact ? `Artifact: ${artifact.fileName}` : 'Artifact panel'}</DialogTitle>
          {/* Header */}
          <header className="flex h-[62px] shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-card/80 px-5 backdrop-blur">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <FileIcon className="size-3.5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-bold text-foreground">{artifact?.fileName}</h2>
                <p className="truncate font-mono text-[11px] text-muted-foreground">{displayPath}</p>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleCopyPath}
                    className={cn(
                      'inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors',
                      pathCopied
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-muted-foreground/50 hover:text-muted-foreground',
                    )}
                    aria-label={pathCopied ? 'Copied' : 'Copy path'}
                  >
                    {pathCopied ? <Check className="size-3.5" aria-hidden="true" /> : <ClipboardCopy className="size-3.5" aria-hidden="true" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{pathCopied ? 'Copied!' : 'Copy path'}</TooltipContent>
              </Tooltip>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              <a
                href={toEditorHref(displayPath || artifact?.path || '', editorScheme)}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium',
                  'text-muted-foreground transition-colors',
                  'hover:bg-muted hover:text-foreground',
                )}
              >
                <ExternalLink className="size-3" aria-hidden="true" />
                <span className="hidden sm:inline">Open in {editorLabel}</span>
                <span className="sm:hidden">{editorLabel}</span>
              </a>

              {isElectron() && window.electronBridge?.revealInFolder && (() => {
                const pathToReveal = displayPath || artifact?.path || ''
                const isAbsolute = pathToReveal.startsWith('/') || /^[a-zA-Z]:\\/.test(pathToReveal)
                if (!pathToReveal || !isAbsolute) return null
                return (
                  <button
                    type="button"
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium',
                      'text-muted-foreground transition-colors',
                      'hover:bg-muted hover:text-foreground',
                    )}
                    onClick={() => {
                      window.electronBridge?.revealInFolder?.(pathToReveal)
                    }}
                    aria-label="Show in folder"
                  >
                    <FolderOpen className="size-3" aria-hidden="true" />
                    <span className="hidden sm:inline">Show in folder</span>
                  </button>
                )
              })()}

              <div className="mx-0.5 h-4 w-px bg-border/60" aria-hidden="true" />

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  'size-8 rounded-md',
                  'text-muted-foreground transition-colors',
                  'hover:bg-muted hover:text-foreground',
                )}
                onClick={handleAnimatedClose}
                aria-label="Close artifact panel"
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </header>

          {/* Content */}
          <ScrollArea
            className={cn(
              'min-h-0 flex-1',
              '[&>[data-slot=scroll-area-scrollbar]]:w-2',
              '[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-transparent',
              'hover:[&>[data-slot=scroll-area-scrollbar]>[data-slot=scroll-area-thumb]]:bg-border',
            )}
          >
            <div className="px-6 py-6">
              {isLoading ? (
                <div className="flex items-center gap-2.5 py-12 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  <span>Loading file…</span>
                </div>
              ) : error ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                  {error}
                </div>
              ) : isImage ? (
                imagePreviewUrl ? (
                  <div className="mx-auto flex max-w-[820px] justify-center">
                    <img
                      src={imagePreviewUrl}
                      alt={artifact?.fileName || 'Artifact image'}
                      onError={() => setError('Unable to load image preview.')}
                      className="max-h-[calc(100vh-180px)] max-w-full rounded-lg border border-border/60 bg-muted/20 object-contain"
                    />
                  </div>
                ) : (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                    Unable to load image preview.
                  </div>
                )
              ) : isMarkdown ? (
                <article className="mx-auto max-w-[680px]">
                  {frontMatter && frontMatter.entries.length > 0 && (
                    <FrontMatterBlock entries={frontMatter.entries} />
                  )}
                  <MarkdownMessage
                    content={markdownBody}
                    variant="document"
                    enableMermaid
                    artifactSourceAgentId={artifact?.sourceAgentId ?? activeAgentId}
                    onArtifactClick={handleNestedArtifactClick}
                  />
                </article>
              ) : (
                <ScrollArea className="w-full rounded-lg border border-border/60 bg-muted/25">
                  <pre className="p-4">
                    <code className="font-mono text-[13px] leading-relaxed whitespace-pre text-foreground/90">{content}</code>
                  </pre>
                </ScrollArea>
              )}
          </div>
        </ScrollArea>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}

async function readLegacyArtifactFile({
  wsUrl,
  path,
  agentId,
  signal,
}: {
  wsUrl: string
  path: string
  agentId?: string | null
  signal: AbortSignal
}): Promise<ReadFileResult> {
  return readArtifactFileResponse(
    resolveReadFileEndpoint(wsUrl),
    { path, agentId: agentId?.trim() || undefined },
    path,
    signal,
  )
}

async function readTranscriptArtifactFile({
  wsUrl,
  transcriptAgentId,
  messageId,
  path,
  signal,
}: {
  wsUrl: string
  transcriptAgentId: string
  messageId: string
  path: string
  signal: AbortSignal
}): Promise<ReadFileResult> {
  return readArtifactFileResponse(
    resolveApiEndpoint(wsUrl, '/api/chat-artifacts/read'),
    { transcriptAgentId, messageId, path },
    path,
    signal,
    true,
  )
}

async function readArtifactFileResponse(
  endpoint: string,
  body: Record<string, string | undefined>,
  requestedPath: string,
  signal: AbortSignal,
  includeCredentials = false,
): Promise<ReadFileResult> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    ...(includeCredentials ? { credentials: 'include' as const } : {}),
    body: JSON.stringify(body),
    signal,
  })
  const payload: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : `File read failed (${response.status})`
    throw new Error(message)
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid file read response.')
  }

  const value = payload as Record<string, unknown>
  return {
    path: typeof value.path === 'string' ? value.path : requestedPath,
    content: typeof value.content === 'string' ? value.content : '',
    ...(typeof value.binary === 'boolean' ? { binary: value.binary } : {}),
    ...(typeof value.encoding === 'string' ? { encoding: value.encoding } : {}),
    ...(typeof value.contentType === 'string' ? { contentType: value.contentType } : {}),
  }
}

function toSafeImageDataUrl(file: ReadFileResult): string {
  const contentType = file.contentType?.trim().toLowerCase()
  const base64 = file.content.trim()
  if (
    file.binary !== true ||
    file.encoding !== 'base64' ||
    !contentType ||
    !/^image\/(?:png|jpeg|gif|webp|svg\+xml)$/.test(contentType) ||
    !base64 ||
    base64.length % 4 !== 0 ||
    !/^[a-z\d+/]*={0,2}$/i.test(base64)
  ) {
    throw new Error('Invalid image response.')
  }
  return `data:${contentType};base64,${base64}`
}

function resolveReadFileEndpoint(wsUrl: string): string {
  return resolveApiEndpoint(wsUrl, '/api/read-file')
}

function resolveApiEndpoint(wsUrl: string, pathname: string): string {
  try {
    const parsed = new URL(wsUrl)
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    parsed.pathname = pathname
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return pathname
  }
}

function resolveReadFileUrl(wsUrl: string, path: string, agentId?: string | null): string {
  const endpoint = resolveReadFileEndpoint(wsUrl)
  const searchParams = new URLSearchParams({
    path,
  })

  const normalizedAgentId = agentId?.trim()
  if (normalizedAgentId) {
    searchParams.set('agentId', normalizedAgentId)
  }

  const separator = endpoint.includes('?') ? '&' : '?'
  return `${endpoint}${separator}${searchParams.toString()}`
}
