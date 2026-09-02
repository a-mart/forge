/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHAT_ARTIFACT_MAX_PDF_BYTES } from '@forge/protocol'
import {
  createArtifactPdfBlobUrl,
  isArtifactPdfPath,
  resolveSafeArtifactPdfTicketUrl,
  revokeArtifactPdfBlobUrl,
} from './artifact-pdf'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('isArtifactPdfPath', () => {
  it('detects pdf names and paths case-insensitively', () => {
    expect(isArtifactPdfPath('spec.pdf', '/tmp/spec.pdf')).toBe(true)
    expect(isArtifactPdfPath('SPEC.PDF', undefined)).toBe(true)
    expect(isArtifactPdfPath('notes.md', '/tmp/notes.md')).toBe(false)
  })
})

describe('resolveSafeArtifactPdfTicketUrl', () => {
  it('accepts a same-origin PDF ticket and rejects cross-origin or oversized claims', () => {
    const expiresAt = new Date(Date.now() + 30_000).toISOString()
    expect(resolveSafeArtifactPdfTicketUrl('wss://forge.example.test/socket', {
      binary: true,
      transport: 'http_ticket',
      contentType: 'application/pdf',
      totalBytes: 1024,
      ticket: { url: '/api/chat-artifacts/tickets/opaque_pdf_token', expiresAt },
    })).toBe('https://forge.example.test/api/chat-artifacts/tickets/opaque_pdf_token')

    expect(() => resolveSafeArtifactPdfTicketUrl('wss://forge.example.test/socket', {
      binary: true,
      transport: 'http_ticket',
      contentType: 'application/pdf',
      totalBytes: CHAT_ARTIFACT_MAX_PDF_BYTES + 1,
      ticket: { url: '/api/chat-artifacts/tickets/opaque_pdf_token', expiresAt },
    })).toThrow('Invalid PDF ticket response.')

    expect(() => resolveSafeArtifactPdfTicketUrl('wss://forge.example.test/socket', {
      binary: true,
      transport: 'http_ticket',
      contentType: 'application/pdf',
      totalBytes: 1024,
      ticket: { url: 'https://attacker.example/ticket', expiresAt },
    })).toThrow('Invalid PDF ticket response.')
  })
})

describe('createArtifactPdfBlobUrl', () => {
  it('creates a blob URL from PDF bytes and revokes it', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(pdfBytes, {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    })))
    const createObjectURL = vi.fn(() => 'blob:https://forge.example.test/pdf')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })

    await expect(createArtifactPdfBlobUrl('https://forge.example.test/api/chat-artifacts/tickets/opaque'))
      .resolves.toBe('blob:https://forge.example.test/pdf')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    revokeArtifactPdfBlobUrl('blob:https://forge.example.test/pdf')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://forge.example.test/pdf')
  })
})
