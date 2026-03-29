import { createElement, isValidElement, memo, useCallback, useMemo, useState, type ReactNode } from 'react'
import { Check, ChevronRight, Copy, FileCode2, FileText, ZoomIn } from 'lucide-react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import {
  normalizeArtifactShortcodes,
  parseArtifactReference,
  type ArtifactReference,
} from '@/lib/artifacts'
import { cn } from '@/lib/utils'
import { MermaidBlock } from './message-list/MermaidBlock'
import { ContentZoomDialog } from './ContentZoomDialog'

const EXTRA_ALLOWED_PROTOCOLS = /^(vscode-insiders|vscode|swarm-file):\/\//i

const MARKDOWN_EXTENSION_PATTERN = /\.(md|markdown|mdx)$/i

function urlTransform(url: string): string {
  if (EXTRA_ALLOWED_PROTOCOLS.test(url)) return url
  return defaultUrlTransform(url)
}

interface MarkdownMessageProps {
  content: string
  variant?: 'message' | 'document'
  onArtifactClick?: (artifact: ArtifactReference) => void
  artifactSourceAgentId?: string | null
  enableMermaid?: boolean
  renderHeadingAdornment?: (args: { level: 1 | 2 | 3 | 4 | 5 | 6; text: string; index: number }) => ReactNode
}

type ZoomTarget = {
  type: 'image'
  src: string
  alt: string
}

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  variant = 'message',
  onArtifactClick,
  artifactSourceAgentId,
  enableMermaid = false,
  renderHeadingAdornment,
}: MarkdownMessageProps) {
  const isDocument = variant === 'document'
  const normalizedContent = useMemo(() => normalizeArtifactShortcodes(content), [content])
  const [zoomTarget, setZoomTarget] = useState<ZoomTarget | null>(null)
  const headingInstanceCounts = new Map<string, number>()

  const renderHeading = useCallback(
    (level: 1 | 2 | 3 | 4 | 5 | 6, children: ReactNode, className: string) => {
      const text = flattenText(children).trim()
      const key = `${level}:${normalizeHeadingText(text)}`
      const index = headingInstanceCounts.get(key) ?? 0
      headingInstanceCounts.set(key, index + 1)
      const adornment = text ? renderHeadingAdornment?.({ level, text, index }) : null

      return createHeadingElement(level, className, children, adornment)
    },
    [headingInstanceCounts, renderHeadingAdornment],
  )

  return (
    <>
      <div className={cn('min-w-0 overflow-hidden', isDocument ? 'text-[15px] leading-[1.8]' : 'text-sm leading-relaxed')}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={urlTransform}
          components={{
            p({ children }) {
              return (
                <p
                  className={cn(
                    'break-words whitespace-pre-wrap',
                    isDocument
                      ? 'mb-5 text-foreground/90 last:mb-0'
                      : 'mb-2 last:mb-0',
                  )}
                >
                  {children}
                </p>
              )
            },
            h1({ children }) {
              return renderHeading(
                1,
                children,
                cn(
                  isDocument
                    ? 'mb-4 mt-8 border-b border-border/50 pb-3 text-2xl font-bold tracking-tight text-foreground first:mt-0'
                    : 'mb-2 text-base font-semibold',
                ),
              )
            },
            h2({ children }) {
              return renderHeading(
                2,
                children,
                cn(
                  isDocument
                    ? 'mb-3 mt-7 border-b border-border/40 pb-2 text-xl font-semibold tracking-tight text-foreground first:mt-0'
                    : 'mb-2 text-[15px] font-semibold',
                ),
              )
            },
            h3({ children }) {
              return renderHeading(
                3,
                children,
                cn(
                  isDocument
                    ? 'mb-2 mt-6 text-lg font-semibold tracking-tight text-foreground first:mt-0'
                    : 'mb-2 text-sm font-semibold',
                ),
              )
            },
            h4({ children }) {
              return renderHeading(
                4,
                children,
                cn(
                  isDocument
                    ? 'mb-2 mt-5 text-base font-semibold text-foreground first:mt-0'
                    : 'mb-2 text-sm font-semibold',
                ),
              )
            },
            ul({ children }) {
              return (
                <ul
                  className={cn(
                    isDocument
                      ? 'mb-5 list-disc space-y-1.5 pl-6 text-foreground/90 last:mb-0'
                      : 'mb-2 list-disc space-y-0.5 pl-5 last:mb-0',
                  )}
                >
                  {children}
                </ul>
              )
            },
            ol({ children }) {
              return (
                <ol
                  className={cn(
                    isDocument
                      ? 'mb-5 list-decimal space-y-1.5 pl-6 text-foreground/90 last:mb-0'
                      : 'mb-2 list-decimal space-y-0.5 pl-5 last:mb-0',
                  )}
                >
                  {children}
                </ol>
              )
            },
            li({ children }) {
              return <li className="break-words [&>p]:mb-1.5 [&>p]:last:mb-0 [&>input[type=checkbox]]:pointer-events-none [&>input[type=checkbox]]:mr-1.5 [&>input[type=checkbox]]:accent-primary [&>input[type=checkbox]]:opacity-80">{children}</li>
            },
            input(props) {
              if (props.type === 'checkbox') {
                return (
                  <span
                    className={cn(
                      'mr-1.5 inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm border text-[10px] leading-none align-middle',
                      props.checked
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground/40 bg-background',
                    )}
                    aria-checked={!!props.checked}
                    role="checkbox"
                  >
                    {props.checked ? '✓' : ''}
                  </span>
                )
              }
              return <input {...props} />
            },
            blockquote({ children }) {
              return (
                <blockquote
                  className={cn(
                    'my-4 border-l-2 pl-4 italic text-muted-foreground',
                    isDocument ? 'border-primary/30 text-[15px]' : 'border-border text-sm',
                  )}
                >
                  {children}
                </blockquote>
              )
            },
            hr() {
              return <hr className={cn('my-6 border-border/50', isDocument && 'my-8')} />
            },
            a({ children, href }) {
              const artifact = parseArtifactReference(href, {
                title: extractLinkText(children),
                sourceAgentId: artifactSourceAgentId,
              })
              if (artifact && onArtifactClick) {
                return <ArtifactReferenceCard artifact={artifact} onClick={onArtifactClick} />
              }

              return (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    'break-all text-primary underline decoration-primary/30 underline-offset-2',
                    'transition-colors hover:decoration-primary/60',
                    isDocument && 'hover:text-primary/80',
                  )}
                >
                  {children}
                </a>
              )
            },
            img({ src, alt, title }) {
              const imageSrc = typeof src === 'string' ? src : null
              if (!imageSrc) {
                return null
              }

              const imageAlt = alt ?? title ?? 'Image preview'

              return (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setZoomTarget({ type: 'image', src: imageSrc, alt: imageAlt })}
                  className={cn(
                    'group/zoom relative inline-block h-auto w-full cursor-zoom-in overflow-hidden rounded-lg border border-border/55 p-0 text-left',
                    'bg-muted/15 text-left transition-all duration-150',
                    'hover:scale-[1.005] hover:border-primary/35',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35',
                    isDocument ? 'my-5' : 'my-2',
                  )}
                  aria-label={`Expand image: ${imageAlt}`}
                >
                  <img
                    src={imageSrc}
                    alt={alt ?? ''}
                    title={title}
                    loading="lazy"
                    className="mx-auto h-auto max-h-[460px] w-auto max-w-full"
                  />
                  <span
                    className={cn(
                      'pointer-events-none absolute right-3 top-3 inline-flex size-7 items-center justify-center rounded-md',
                      'bg-black/55 text-white/85 shadow-sm backdrop-blur-sm',
                      'opacity-0 transition-opacity duration-150',
                      'group-hover/zoom:opacity-100 group-focus-visible/zoom:opacity-100',
                    )}
                    aria-hidden="true"
                  >
                    <ZoomIn className="size-3.5" />
                  </span>
                </Button>
              )
            },
            code({ className, children }) {
              const contentValue = String(children)
              const language = resolveCodeLanguage(className)
              const hasLanguageClass = /language-/.test(className ?? '')
              const isBlock = hasLanguageClass || contentValue.includes('\n')

              if (isBlock) {
                const normalizedCode = contentValue.replace(/\n$/, '')

                if (enableMermaid && language === 'mermaid') {
                  return (
                    <MermaidBlock
                      code={normalizedCode}
                      isDocument={isDocument}
                    />
                  )
                }

                return (
                  <div className={cn('group/code relative', isDocument ? 'my-5' : 'my-2')}>
                    {language ? (
                      <div className="flex items-center justify-between rounded-t-lg border border-b-0 border-border/50 bg-muted/40 px-3 py-1.5">
                        <span className="font-mono text-[11px] font-medium text-muted-foreground">{language}</span>
                        <CodeBlockCopyButton code={normalizedCode} />
                      </div>
                    ) : (
                      <span className="absolute right-2 top-2 z-10 opacity-0 transition-opacity duration-150 group-hover/code:opacity-100">
                        <CodeBlockCopyButton code={normalizedCode} />
                      </span>
                    )}
                    <div
                      className={cn(
                        'w-full border border-border/50 bg-muted/25',
                        language ? 'rounded-b-lg' : 'rounded-lg',
                      )}
                    >
                      <pre className="overflow-x-auto p-4">
                        <code className={cn('font-mono text-foreground/90', isDocument ? 'text-[13px] leading-6' : 'text-xs leading-5')}>
                          {normalizedCode}
                        </code>
                      </pre>
                    </div>
                  </div>
                )
              }

              return (
                <code
                  className={cn(
                    'rounded bg-muted/70 font-mono text-foreground',
                    isDocument
                      ? 'px-1.5 py-0.5 text-[13px]'
                      : 'px-1 py-0.5 text-xs',
                  )}
                >
                  {children}
                </code>
              )
            },
            pre({ children }) {
              return <>{children}</>
            },
            table({ children }) {
              return (
                <div className={cn('my-4 w-full overflow-x-auto', isDocument && 'my-5')}>
                  <table className="w-full border-collapse text-sm">
                    {children}
                  </table>
                </div>
              )
            },
            th({ children }) {
              return (
                <th className="border border-border/50 bg-muted/40 px-3 py-2 text-left text-xs font-semibold text-foreground">
                  {children}
                </th>
              )
            },
            td({ children }) {
              return (
                <td className="border border-border/50 px-3 py-2 text-foreground/90">
                  {children}
                </td>
              )
            },
            strong({ children }) {
              return <strong className="font-semibold text-foreground">{children}</strong>
            },
            em({ children }) {
              return <em className="italic">{children}</em>
            },
          }}
        >
          {normalizedContent}
        </ReactMarkdown>
      </div>

      <ContentZoomDialog
        open={zoomTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setZoomTarget(null)
          }
        }}
        title="Expanded image preview"
      >
        {zoomTarget ? (
          <img
            src={zoomTarget.src}
            alt={zoomTarget.alt}
            className="h-auto max-h-full w-auto max-w-full rounded-md"
          />
        ) : null}
      </ContentZoomDialog>
    </>
  )
})

function createHeadingElement(
  level: 1 | 2 | 3 | 4 | 5 | 6,
  className: string,
  children: ReactNode,
  adornment: ReactNode,
) {
  const tag = `h${level}` as const
  return createElement(
    tag,
    { className },
    <span>{children}</span>,
    adornment,
  )
}

function normalizeHeadingText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function CodeBlockCopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [code])

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'inline-flex size-6 items-center justify-center rounded-md transition-colors',
        copied
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-muted-foreground/50 hover:text-muted-foreground',
      )}
      aria-label={copied ? 'Copied' : 'Copy code'}
      title={copied ? 'Copied' : 'Copy code'}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  )
}

function ArtifactReferenceCard({
  artifact,
  onClick,
}: {
  artifact: ArtifactReference
  onClick: (artifact: ArtifactReference) => void
}) {
  const isMarkdownFile = MARKDOWN_EXTENSION_PATTERN.test(artifact.fileName)
  const CardIcon = isMarkdownFile ? FileText : FileCode2

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => onClick(artifact)}
      className={cn(
        'group/card my-2.5 h-auto w-full justify-start gap-3 rounded-lg border px-3 py-2.5 text-left text-sm font-normal',
        'border-primary/20 bg-primary/[0.04] transition-all duration-150',
        'hover:border-primary/35 hover:bg-primary/[0.07] hover:shadow-sm',
        'active:scale-[0.995]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
      )}
      data-artifact-card="true"
    >
      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover/card:bg-primary/15">
        <CardIcon className="size-4" aria-hidden="true" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-foreground">
          {artifact.title ?? artifact.fileName}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{artifact.path}</span>
      </span>

      <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-all group-hover/card:text-primary">
        <ChevronRight className="size-4" aria-hidden="true" />
      </span>
    </Button>
  )
}

function extractLinkText(children: ReactNode): string | undefined {
  const text = flattenText(children).trim()
  return text || undefined
}

function flattenText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }

  if (Array.isArray(node)) {
    return node.map((child) => flattenText(child)).join('')
  }

  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode }
    return flattenText(props.children)
  }

  return ''
}

function resolveCodeLanguage(className: string | undefined): string | null {
  if (!className) {
    return null
  }

  const token = className
    .split(/\s+/)
    .find((entry) => entry.trim().toLowerCase().startsWith('language-'))

  if (!token) {
    return null
  }

  return token.replace(/^language-/i, '').toLowerCase()
}
