export interface ConversationImageAttachment {
  type?: 'image'
  mimeType: string
  data: string
  fileName?: string
  filePath?: string
}

export interface ConversationTextAttachment {
  type: 'text'
  mimeType: string
  text: string
  fileName?: string
  filePath?: string
}

export interface ConversationBinaryAttachment {
  type: 'binary'
  mimeType: string
  data: string
  fileName?: string
  filePath?: string
}

export type ConversationAttachment =
  | ConversationImageAttachment
  | ConversationTextAttachment
  | ConversationBinaryAttachment
