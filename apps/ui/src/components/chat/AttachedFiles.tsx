import { File, FileText, X, ZoomIn } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  isPendingImageAttachment,
  isPendingTextAttachment,
  type PendingAttachment,
} from '@/lib/file-attachments'
import { usePeekPreview } from '@/hooks/use-peek-preview'
import { ContentZoomDialog } from './ContentZoomDialog'

interface AttachedFilesProps {
  attachments: PendingAttachment[]
  onRemove: (id: string) => void
}

export function AttachedFiles({ attachments, onRemove }: AttachedFilesProps) {
  const { target: zoomTarget, clearTarget, bind } = usePeekPreview<{ src: string; alt: string }>()

  if (attachments.length === 0) {
    return null
  }

  return (
    <div className="flex flex-wrap gap-2 border-b border-border px-4 py-2">
      {attachments.map((attachment) => {
        const isImage = isPendingImageAttachment(attachment)

        return (
          <div key={attachment.id} className="group relative">
            {isImage ? (
              <button
                type="button"
                {...bind({
                  src: attachment.dataUrl,
                  alt: attachment.fileName || 'Attached image',
                })}
                className="group/zoom relative cursor-zoom-in overflow-hidden rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                aria-label={`View full size: ${attachment.fileName || 'Attached image'}`}
              >
                <img
                  src={attachment.dataUrl}
                  alt={attachment.fileName || 'Attached image'}
                  className="size-16 rounded border border-border object-cover"
                />
                <span
                  className="pointer-events-none absolute inset-0 flex items-center justify-center rounded bg-black/40 text-white/90 opacity-0 transition-opacity duration-150 group-hover/zoom:opacity-100 group-focus-visible/zoom:opacity-100"
                  aria-hidden="true"
                >
                  <ZoomIn className="size-3.5" />
                </span>
              </button>
            ) : (
              <div className="flex h-16 w-52 items-center gap-2 rounded border border-border bg-muted/40 px-2 py-1.5">
                <div className="rounded bg-muted p-1.5 text-muted-foreground">
                  {isPendingTextAttachment(attachment) ? <FileText className="size-3.5" /> : <File className="size-3.5" />}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-foreground">{attachment.fileName}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {isPendingTextAttachment(attachment) ? 'Text file' : 'Binary file'} • {formatBytes(attachment.sizeBytes)}
                  </p>
                </div>
              </div>
            )}

            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onRemove(attachment.id)}
              className="absolute -right-1.5 -top-1.5 size-5 rounded-full bg-muted p-0.5 text-muted-foreground opacity-0 transition-colors hover:bg-red-600 hover:text-white focus:opacity-100 focus-visible:ring-red-300 group-hover:opacity-100"
              aria-label={`Remove ${attachment.fileName || 'attachment'}`}
            >
              <X className="size-3" />
            </Button>
          </div>
        )
      })}

      <ContentZoomDialog
        open={zoomTarget !== null}
        onOpenChange={(open) => {
          if (!open) clearTarget()
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
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }

  if (bytes < 1024) {
    return `${bytes} B`
  }

  const kb = bytes / 1024
  if (kb < 1024) {
    return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`
  }

  const mb = kb / 1024
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`
}
