import { File, FileText, ImageIcon } from 'lucide-react'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { cn } from '@/lib/utils'
import type {
  ConversationImageAttachment,
  ConversationMessageAttachment,
} from '@middleman/protocol'

type PreviewableMessageImageAttachment =
  | ConversationImageAttachment
  | (ConversationMessageAttachment & { fileRef: string })

function isInlineImageAttachment(
  attachment: ConversationMessageAttachment,
): attachment is ConversationImageAttachment {
  const maybeType = attachment.type
  if (maybeType === 'text' || maybeType === 'binary') {
    return false
  }

  return 'data' in attachment && typeof attachment.data === 'string' && attachment.data.length > 0
}

function hasAttachmentFileRef(
  attachment: ConversationMessageAttachment,
): attachment is ConversationMessageAttachment & { fileRef: string } {
  return 'fileRef' in attachment && typeof attachment.fileRef === 'string' && attachment.fileRef.length > 0
}

function isMessageImageAttachment(
  attachment: ConversationMessageAttachment,
): attachment is PreviewableMessageImageAttachment {
  const maybeType = attachment.type
  if (maybeType === 'text' || maybeType === 'binary') {
    return false
  }

  if (isInlineImageAttachment(attachment)) {
    return true
  }

  // Metadata-only images need a server-side attachment reference for preview.
  // Without one, they fall back to the file card renderer below.
  return attachment.mimeType.startsWith('image/') && hasAttachmentFileRef(attachment)
}

function isImageFileAttachment(attachment: ConversationMessageAttachment): boolean {
  if (attachment.type === 'image') {
    return true
  }

  return attachment.type !== 'text' && attachment.type !== 'binary' && attachment.mimeType.startsWith('image/')
}

function resolveMessageImageSrc(
  attachment: PreviewableMessageImageAttachment,
  wsUrl?: string,
): string | null {
  if (isInlineImageAttachment(attachment)) {
    return `data:${attachment.mimeType};base64,${attachment.data}`
  }

  if (hasAttachmentFileRef(attachment)) {
    return resolveApiEndpoint(
      wsUrl,
      `/api/attachments/${encodeURIComponent(attachment.fileRef)}`,
    )
  }

  return null
}

function fileAttachmentSubtitle(attachment: ConversationMessageAttachment): string {
  if (attachment.type === 'text') {
    return 'Text file'
  }

  if (attachment.type === 'binary') {
    return 'Binary file'
  }

  return 'Image file'
}

function attachmentIcon(attachment: ConversationMessageAttachment) {
  if (attachment.type === 'text') {
    return <FileText className="size-3.5" />
  }

  if (isImageFileAttachment(attachment)) {
    return <ImageIcon className="size-3.5" />
  }

  return <File className="size-3.5" />
}

function MessageImageAttachments({
  attachments,
  isUser,
  wsUrl,
}: {
  attachments: PreviewableMessageImageAttachment[]
  isUser: boolean
  wsUrl?: string
}) {
  if (attachments.length === 0) {
    return null
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {attachments.map((attachment, index) => {
        const src = resolveMessageImageSrc(attachment, wsUrl)
        if (!src) {
          return null
        }

        const imageKey = isInlineImageAttachment(attachment)
          ? `${attachment.mimeType}-${attachment.data.slice(0, 32)}-${index}`
          : `${attachment.mimeType}-${attachment.fileRef}-${index}`

        return (
          <img
            key={imageKey}
            src={src}
            alt={attachment.fileName || `Attached image ${index + 1}`}
            className={cn(
              'max-h-56 w-full rounded-lg object-cover',
              isUser
                ? 'border border-primary-foreground/25'
                : 'border border-border',
            )}
            loading="lazy"
          />
        )
      })}
    </div>
  )
}

function MessageFileAttachments({
  attachments,
  isUser,
}: {
  attachments: ConversationMessageAttachment[]
  isUser: boolean
}) {
  if (attachments.length === 0) {
    return null
  }

  return (
    <div className="space-y-1.5">
      {attachments.map((attachment, index) => {
        const fileName = attachment.fileName || `Attachment ${index + 1}`
        const subtitle = fileAttachmentSubtitle(attachment)

        return (
          <div
            key={`${attachment.mimeType}-${fileName}-${index}`}
            className={cn(
              'flex items-center gap-2 rounded-md border px-2 py-1.5',
              isUser
                ? 'border-primary-foreground/25 bg-primary-foreground/10 text-primary-foreground'
                : 'border-border bg-muted/35 text-foreground',
            )}
          >
            <span
              className={cn(
                'inline-flex size-6 items-center justify-center rounded',
                isUser
                  ? 'bg-primary-foreground/15 text-primary-foreground'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {attachmentIcon(attachment)}
            </span>
            <span className="min-w-0">
              <p className="truncate text-xs font-medium">{fileName}</p>
              <p
                className={cn(
                  'truncate text-[11px]',
                  isUser
                    ? 'text-primary-foreground/80'
                    : 'text-muted-foreground',
                )}
              >
                {subtitle} • {attachment.mimeType}
              </p>
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function MessageAttachments({
  attachments,
  isUser,
  wsUrl,
}: {
  attachments: ConversationMessageAttachment[]
  isUser: boolean
  wsUrl?: string
}) {
  const imageAttachments = attachments.filter(isMessageImageAttachment)
  const fileAttachments = attachments.filter((attachment) => !isMessageImageAttachment(attachment))

  if (imageAttachments.length === 0 && fileAttachments.length === 0) {
    return null
  }

  return (
    <>
      <MessageImageAttachments attachments={imageAttachments} isUser={isUser} wsUrl={wsUrl} />
      <MessageFileAttachments attachments={fileAttachments} isUser={isUser} />
    </>
  )
}
