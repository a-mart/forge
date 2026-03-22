import { MarkdownMessage } from '@/components/chat/MarkdownMessage'
import '@/styles/file-browser.css'

interface MarkdownPreviewProps {
  content: string
}

/**
 * Rendered markdown preview for the file browser.
 *
 * Uses MarkdownMessage with variant="document" and mermaid support.
 * Wrapped in a scrollable container with centered content for readability.
 *
 * Known v1 limitation: relative links/images will be broken — they resolve
 * relative to the Forge app URL rather than the repo directory. This is
 * documented and accepted for v1.
 */
export function MarkdownPreview({ content }: MarkdownPreviewProps) {
  return (
    <div className="file-browser-scroll h-full overflow-auto">
      <div className="mx-auto max-w-3xl px-8 py-6">
        <MarkdownMessage
          content={content}
          variant="document"
          enableMermaid
        />
      </div>
    </div>
  )
}
