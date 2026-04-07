import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Code,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  FileWarning,
  Loader2,
  WrapText,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { MarkdownPreview } from '@/components/file-browser/MarkdownPreview'
import {
  detectLanguage,
  highlightCode,
  getLanguageDisplayName,
} from '@/lib/syntax-highlight'
import { formatFileSize } from '@/components/file-browser/file-browser-utils'
import {
  readStoredEditorPreference,
  EDITOR_URL_SCHEMES,
  EDITOR_LABELS,
} from '@/lib/editor-preference'
import { toEditorHref } from '@/lib/artifacts'
import { fetchSkillFileContent } from './skills-viewer-api'
import type { SkillFileContentResponse } from './skills-viewer-types'
import '@/styles/syntax-highlight.css'
import '@/styles/file-browser.css'

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])

function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return MARKDOWN_EXTENSIONS.has(ext)
}

const MARKDOWN_RAW_STORAGE_KEY = 'forge-skills-viewer-markdown-raw'
const WORD_WRAP_STORAGE_KEY = 'forge-skills-viewer-word-wrap'

function readBoolPref(key: string, fallback = false): boolean {
  try { return localStorage.getItem(key) === 'true' } catch { return fallback }
}

function storeBoolPref(key: string, value: boolean): void {
  try { localStorage.setItem(key, String(value)) } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/*  Props                                                             */
/* ------------------------------------------------------------------ */

interface SkillFileViewerProps {
  wsUrl: string
  skillId: string
  filePath: string | null
  /** Root path of the skill for constructing absolute paths */
  rootPath: string
  onNavigateToDirectory?: (dirPath: string) => void
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export function SkillFileViewer({
  wsUrl,
  skillId,
  filePath,
  rootPath,
  onNavigateToDirectory,
}: SkillFileViewerProps) {
  const [content, setContent] = useState<SkillFileContentResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [markdownRaw, setMarkdownRaw] = useState(() => readBoolPref(MARKDOWN_RAW_STORAGE_KEY))
  const [wordWrap, setWordWrap] = useState(() => readBoolPref(WORD_WRAP_STORAGE_KEY))
  const [copied, setCopied] = useState(false)

  // Load file content when file path changes
  useEffect(() => {
    if (!filePath) {
      setContent(null)
      setError(null)
      return
    }

    let cancelled = false
    setContent(null)
    setIsLoading(true)
    setError(null)

    fetchSkillFileContent(wsUrl, skillId, filePath)
      .then((result) => {
        if (!cancelled) setContent(result)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load file')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => { cancelled = true }
  }, [wsUrl, skillId, filePath])

  const isMarkdown = useMemo(
    () => (filePath ? isMarkdownFile(filePath) : false),
    [filePath],
  )

  const language = useMemo(
    () => (filePath ? detectLanguage(filePath) : undefined),
    [filePath],
  )

  const languageDisplayName = useMemo(
    () => getLanguageDisplayName(language),
    [language],
  )

  const handleToggleMarkdownRaw = useCallback(() => {
    setMarkdownRaw((prev) => {
      const next = !prev
      storeBoolPref(MARKDOWN_RAW_STORAGE_KEY, next)
      return next
    })
  }, [])

  const handleToggleWordWrap = useCallback(() => {
    setWordWrap((prev) => {
      const next = !prev
      storeBoolPref(WORD_WRAP_STORAGE_KEY, next)
      return next
    })
  }, [])

  const handleCopyContent = useCallback(async () => {
    if (!content?.content) return
    try {
      await navigator.clipboard.writeText(content.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* Clipboard not available */ }
  }, [content?.content])

  // Empty state
  if (!filePath) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <FileText className="size-10 opacity-20" />
        <p className="text-sm">Select a file to view</p>
      </div>
    )
  }

  // Loading
  if (isLoading && !content) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <ViewerHeader
          filePath={filePath}
          rootPath={rootPath}
          absolutePath={null}
          isMarkdown={false}
          markdownRaw={false}
          wordWrap={wordWrap}
          onToggleMarkdownRaw={handleToggleMarkdownRaw}
          onToggleWordWrap={handleToggleWordWrap}
          onNavigateToDirectory={onNavigateToDirectory}
        />
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  // Error
  if (error) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <ViewerHeader
          filePath={filePath}
          rootPath={rootPath}
          absolutePath={null}
          isMarkdown={false}
          markdownRaw={false}
          wordWrap={wordWrap}
          onToggleMarkdownRaw={handleToggleMarkdownRaw}
          onToggleWordWrap={handleToggleWordWrap}
          onNavigateToDirectory={onNavigateToDirectory}
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <AlertTriangle className="size-8 text-destructive/60" />
          <p className="text-sm">Failed to load file</p>
          <p className="text-xs opacity-60">{error}</p>
        </div>
      </div>
    )
  }

  // Binary
  if (content?.binary) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <ViewerHeader
          filePath={filePath}
          rootPath={rootPath}
          absolutePath={content.absolutePath}
          isMarkdown={false}
          markdownRaw={false}
          wordWrap={wordWrap}
          onToggleMarkdownRaw={handleToggleMarkdownRaw}
          onToggleWordWrap={handleToggleWordWrap}
          onNavigateToDirectory={onNavigateToDirectory}
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <FileWarning className="size-10 opacity-40" />
          <p className="text-sm">Binary file — cannot display</p>
          {content.size != null && (
            <p className="text-xs opacity-60">{formatFileSize(content.size)}</p>
          )}
        </div>
      </div>
    )
  }

  const text = content?.content ?? ''

  // Markdown preview
  if (isMarkdown && !markdownRaw) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <ViewerHeader
          filePath={filePath}
          rootPath={rootPath}
          absolutePath={content?.absolutePath ?? null}
          isMarkdown
          markdownRaw={markdownRaw}
          wordWrap={wordWrap}
          onToggleMarkdownRaw={handleToggleMarkdownRaw}
          onToggleWordWrap={handleToggleWordWrap}
          onNavigateToDirectory={onNavigateToDirectory}
        />
        <MarkdownPreview content={text} />
        <StatusBar
          lines={content?.lines ?? null}
          size={content?.size ?? null}
          language={undefined}
        />
      </div>
    )
  }

  // Source view
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <ViewerHeader
        filePath={filePath}
        rootPath={rootPath}
        absolutePath={content?.absolutePath ?? null}
        isMarkdown={isMarkdown}
        markdownRaw={markdownRaw}
        wordWrap={wordWrap}
        onToggleMarkdownRaw={handleToggleMarkdownRaw}
        onToggleWordWrap={handleToggleWordWrap}
        onNavigateToDirectory={onNavigateToDirectory}
      />
      <div className="relative flex-1 overflow-hidden">
        <div className="absolute right-3 top-2 z-10">
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'inline-flex size-7 items-center justify-center rounded-md border border-border/50 bg-card/90 text-muted-foreground transition-colors',
                    'hover:bg-muted hover:text-foreground',
                  )}
                  onClick={handleCopyContent}
                  aria-label="Copy file content"
                >
                  {copied ? (
                    <Check className="size-3.5 text-green-500" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" sideOffset={4}>
                {copied ? 'Copied!' : 'Copy content'}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <CodeView content={text} language={language} wordWrap={wordWrap} />
      </div>
      <StatusBar
        lines={content?.lines ?? null}
        size={content?.size ?? null}
        language={languageDisplayName}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Viewer header with breadcrumb + actions                           */
/* ------------------------------------------------------------------ */

function ViewerHeader({
  filePath,
  rootPath,
  absolutePath,
  isMarkdown,
  markdownRaw,
  wordWrap,
  onToggleMarkdownRaw,
  onToggleWordWrap,
  onNavigateToDirectory,
}: {
  filePath: string
  rootPath: string
  absolutePath: string | null
  isMarkdown: boolean
  markdownRaw: boolean
  wordWrap: boolean
  onToggleMarkdownRaw: () => void
  onToggleWordWrap: () => void
  onNavigateToDirectory?: (dirPath: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const segments = filePath.split('/')
  const resolvedAbsPath = absolutePath ?? `${rootPath.replace(/[\\/]+$/, '')}/${filePath}`

  const editorPreference = readStoredEditorPreference()
  const editorScheme = EDITOR_URL_SCHEMES[editorPreference]
  const editorLabel = EDITOR_LABELS[editorPreference]

  const handleCopyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(resolvedAbsPath)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* ignore */ }
  }, [resolvedAbsPath])

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/40 bg-card/50 px-3">
      {/* Breadcrumb */}
      <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-xs" aria-label="File path">
        {segments.map((segment, i) => {
          const isLast = i === segments.length - 1
          const dirPath = segments.slice(0, i + 1).join('/')

          return (
            <Fragment key={dirPath}>
              {i > 0 && (
                <ChevronRight className="size-3 shrink-0 text-muted-foreground/40" />
              )}
              {isLast ? (
                <span className="truncate font-medium text-foreground">{segment}</span>
              ) : onNavigateToDirectory ? (
                <button
                  type="button"
                  className="shrink-0 truncate text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => onNavigateToDirectory(dirPath)}
                >
                  {segment}
                </button>
              ) : (
                <span className="shrink-0 truncate text-muted-foreground">
                  {segment}
                </span>
              )}
            </Fragment>
          )
        })}
      </nav>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-0.5">
        <TooltipProvider delayDuration={300}>
          {/* Markdown preview/source toggle */}
          {isMarkdown && (
            <div className="mr-1 flex items-center rounded-md border border-border/50">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'inline-flex h-6 items-center gap-1 rounded-l-[5px] px-2 text-[11px] transition-colors',
                      !markdownRaw
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    onClick={markdownRaw ? onToggleMarkdownRaw : undefined}
                    aria-label="Preview"
                  >
                    <Eye className="size-3" />
                    <span>Preview</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}>Rendered markdown</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'inline-flex h-6 items-center gap-1 rounded-r-[5px] px-2 text-[11px] transition-colors',
                      markdownRaw
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    onClick={markdownRaw ? undefined : onToggleMarkdownRaw}
                    aria-label="Source"
                  >
                    <Code className="size-3" />
                    <span>Source</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}>Raw source</TooltipContent>
              </Tooltip>
            </div>
          )}

          {/* Copy path */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors',
                  'hover:bg-muted hover:text-foreground',
                )}
                onClick={handleCopyPath}
                aria-label="Copy file path"
              >
                {copied ? (
                  <Check className="size-3.5 text-green-500" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {copied ? 'Copied!' : 'Copy path'}
            </TooltipContent>
          </Tooltip>

          {/* Word wrap */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  'inline-flex size-7 items-center justify-center rounded-md transition-colors',
                  wordWrap
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
                onClick={onToggleWordWrap}
                aria-label={wordWrap ? 'Disable word wrap' : 'Enable word wrap'}
              >
                <WrapText className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {wordWrap ? 'Disable word wrap' : 'Enable word wrap'}
            </TooltipContent>
          </Tooltip>

          {/* Open in editor */}
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={toEditorHref(resolvedAbsPath, editorScheme)}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors',
                  'hover:bg-muted hover:text-foreground',
                )}
                aria-label={`Open in ${editorLabel}`}
              >
                <ExternalLink className="size-3" />
                <span className="hidden lg:inline">{editorLabel}</span>
              </a>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              Open in {editorLabel}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Status bar                                                        */
/* ------------------------------------------------------------------ */

function StatusBar({
  lines,
  size,
  language,
}: {
  lines: number | null
  size: number | null
  language: string | undefined
}) {
  const parts: string[] = []
  if (language) parts.push(language)
  if (lines != null) parts.push(`${lines} lines`)
  if (size != null) parts.push(formatFileSize(size))

  if (parts.length === 0) return null

  return (
    <div className="flex h-6 shrink-0 items-center border-t border-border/40 bg-card/30 px-3">
      <span className="text-[11px] text-muted-foreground/70">{parts.join(' · ')}</span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Code view with syntax highlighting                                */
/* ------------------------------------------------------------------ */

function CodeView({
  content,
  language,
  wordWrap,
}: {
  content: string
  language: string | undefined
  wordWrap: boolean
}) {
  const lines = useMemo(() => content.split('\n'), [content])

  const highlightedLines = useMemo(
    () => lines.map((line) => highlightCode(line, language)),
    [lines, language],
  )

  const gutterWidth = useMemo(() => {
    const digits = String(lines.length).length
    return Math.max(digits * 8 + 24, 48)
  }, [lines.length])

  return (
    <div
      className={cn(
        'syntax-highlight file-browser-scroll h-full overflow-auto font-mono text-[13px] leading-[21px]',
      )}
    >
      <table className="w-full border-collapse">
        <tbody>
          {highlightedLines.map((html, i) => (
            <tr key={i} className="hover:bg-muted/30">
              <td
                className="sticky left-0 z-[1] select-none border-r border-border/30 bg-card/80 pr-3 text-right align-top text-muted-foreground/40"
                style={{ width: gutterWidth, minWidth: gutterWidth }}
              >
                <span className="leading-[21px]">{i + 1}</span>
              </td>
              <td
                className={cn(
                  'pl-4 align-top',
                  wordWrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
                )}
              >
                <span
                  className="leading-[21px]"
                  dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
