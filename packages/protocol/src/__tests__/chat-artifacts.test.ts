import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  CHAT_ARTIFACT_MAX_IMAGE_BYTES,
  CHAT_ARTIFACT_MAX_TEXT_BYTES,
  type ChatArtifactLegacyImageResponse,
  type ChatArtifactProxyReadRequest,
  type ChatArtifactReadRequest,
  type ChatArtifactReadResponse,
  type ChatArtifactTicketImageResponse,
  type ChatArtifactTextResponse,
} from '../index.js'

describe('chat artifact preview contract', () => {
  it('keeps legacy requests and responses valid while adding bounded previews', () => {
    const legacyRequest: ChatArtifactReadRequest = {
      transcriptAgentId: 'manager', messageId: 'message', path: '/project/report.md',
    }
    const previewRequest: ChatArtifactReadRequest = {
      ...legacyRequest, previewBytes: 256 * 1024, imageTransport: 'http_ticket',
    }
    const proxyRequest: ChatArtifactProxyReadRequest = {
      messageId: 'message', path: '/project/report.md', previewBytes: 256 * 1024, imageTransport: 'http_ticket',
    }
    expect(legacyRequest.previewBytes).toBeUndefined()
    expect(previewRequest.imageTransport).toBe('http_ticket')
    expect(proxyRequest).not.toHaveProperty('transcriptAgentId')
  })

  it('models legacy base64, bounded text, and same-origin ticket responses as one additive union', () => {
    const legacy: ChatArtifactLegacyImageResponse = {
      path: '/project/image.png', binary: true, encoding: 'base64', contentType: 'image/png', content: 'AA==',
    }
    const text: ChatArtifactTextResponse = {
      path: '/project/report.md', contentType: 'application/octet-stream', content: 'hello', truncated: true, totalBytes: 2_000_000,
    }
    const ticket: ChatArtifactTicketImageResponse = {
      path: '/project/image.png', binary: true, transport: 'http_ticket', contentType: 'image/png', totalBytes: 4_000_000,
      ticket: { url: '/api/chat-artifacts/tickets/opaque', expiresAt: new Date(0).toISOString() },
    }
    expectTypeOf(legacy).toMatchTypeOf<ChatArtifactReadResponse>()
    expectTypeOf(text).toMatchTypeOf<ChatArtifactReadResponse>()
    expectTypeOf(ticket).toMatchTypeOf<ChatArtifactReadResponse>()
    expect(CHAT_ARTIFACT_MAX_TEXT_BYTES).toBe(2 * 1024 * 1024)
    expect(CHAT_ARTIFACT_MAX_IMAGE_BYTES).toBe(4 * 1024 * 1024)
  })
})
