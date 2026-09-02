/** Maximum full legacy text transfer and maximum requested text preview prefix. */
export const CHAT_ARTIFACT_MAX_TEXT_BYTES = 2 * 1024 * 1024

/** Maximum image artifact size accepted by the Forge preview reader. */
export const CHAT_ARTIFACT_MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** Maximum PDF artifact size accepted by the Forge in-panel preview reader. */
export const CHAT_ARTIFACT_MAX_PDF_BYTES = 16 * 1024 * 1024

/**
 * Transcript-authorized artifact request. `previewBytes` and `imageTransport` are
 * additive: omitting both preserves the legacy full-text/base64 response.
 */
export interface ChatArtifactReadRequest {
  transcriptAgentId: string
  messageId: string
  path: string
  /** Bounded UTF-8 text prefix requested by capable clients. */
  previewBytes?: number
  /** Requests raw image or PDF bytes through a short-lived same-origin capability URL. */
  imageTransport?: 'http_ticket'
}

/** WS api_proxy variant; transcript ownership is bound to the active subscription. */
export type ChatArtifactProxyReadRequest = Omit<ChatArtifactReadRequest, 'transcriptAgentId'>

export interface ChatArtifactTextResponse {
  path: string
  content: string
  contentType: string
  binary?: false
  /** Present for bounded-preview requests. */
  truncated?: boolean
  /** Stable file size observed before the bounded read. Present for bounded-preview requests. */
  totalBytes?: number
}

/** Legacy response retained for clients that do not request the ticket transport. */
export interface ChatArtifactLegacyImageResponse {
  path: string
  content: string
  contentType: string
  binary: true
  encoding: 'base64'
}

export interface ChatArtifactImageTicket {
  /** Server-issued same-origin path. Clients must not accept a different origin. */
  url: string
  expiresAt: string
}

export interface ChatArtifactTicketImageResponse {
  path: string
  contentType: string
  binary: true
  transport: 'http_ticket'
  totalBytes: number
  ticket: ChatArtifactImageTicket
}

/** Same one-use ticket shape as images; `contentType` is `application/pdf`. */
export type ChatArtifactTicketPdfResponse = ChatArtifactTicketImageResponse

export type ChatArtifactReadResponse =
  | ChatArtifactTextResponse
  | ChatArtifactLegacyImageResponse
  | ChatArtifactTicketImageResponse
