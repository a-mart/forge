import { useEffect, useMemo, useRef } from 'react'
import { MarkdownMessage } from '@/components/chat/MarkdownMessage'
import { FrontMatterBlock } from '@/components/ui/FrontMatterBlock'
import { parseFrontMatter } from '@/lib/parse-front-matter'
import '@/styles/file-browser.css'

interface MarkdownPreviewProps {
  content: string
  initialScroll?: { top: number; left?: number }
  restoreKey?: string
  onScrollSnapshotChange?: (snapshot: { top: number; left: number }) => void
}

/**
 * Rendered markdown preview for the file browser.
 *
 * Uses MarkdownMessage with variant="document" and mermaid support.
 * Wrapped in a scrollable container with centered content for readability.
 *
 * YAML front matter (between `---` delimiters at the start of the file) is
 * stripped from the rendered body and shown in a collapsible metadata block.
 *
 * Known v1 limitation: relative links/images will be broken — they resolve
 * relative to the Forge app URL rather than the repo directory. This is
 * documented and accepted for v1.
 */
export function MarkdownPreview({ content, initialScroll, restoreKey, onScrollSnapshotChange }: MarkdownPreviewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const applyingScrollRef = useRef(false)
  const initialScrollRef = useRef(initialScroll)
  const onScrollSnapshotChangeRef = useRef(onScrollSnapshotChange)
  const parsed = useMemo(() => parseFrontMatter(content), [content])

  useEffect(() => {
    initialScrollRef.current = initialScroll
  }, [initialScroll])

  useEffect(() => {
    onScrollSnapshotChangeRef.current = onScrollSnapshotChange
  }, [onScrollSnapshotChange])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return undefined
    const handleScroll = () => {
      if (applyingScrollRef.current) return
      onScrollSnapshotChangeRef.current?.({ top: node.scrollTop, left: node.scrollLeft })
    }
    node.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      handleScroll()
      node.removeEventListener('scroll', handleScroll)
    }
  }, [])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    applyingScrollRef.current = true
    requestAnimationFrame(() => {
      const scroll = initialScrollRef.current
      node.scrollTop = scroll?.top ?? 0
      node.scrollLeft = scroll?.left ?? 0
      requestAnimationFrame(() => {
        applyingScrollRef.current = false
      })
    })
  }, [restoreKey])

  const body = parsed ? parsed.body : content

  return (
    <div ref={scrollRef} className="file-browser-scroll h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-8 py-6">
        {parsed && parsed.entries.length > 0 && <FrontMatterBlock entries={parsed.entries} />}
        <MarkdownMessage
          content={body}
          variant="document"
          enableMermaid
        />
      </div>
    </div>
  )
}
