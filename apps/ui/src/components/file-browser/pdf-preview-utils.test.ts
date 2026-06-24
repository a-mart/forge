import { describe, expect, it } from 'vitest'
import {
  clampPageNumber,
  computeFitWidthScale,
  formatPdfPreviewError,
} from './pdf-preview-utils'

describe('formatPdfPreviewError', () => {
  it('maps password-protected PDFs to a specific message', () => {
    const error = new Error('No password given')
    error.name = 'PasswordException'
    expect(formatPdfPreviewError(error)).toBe('This PDF is password-protected and cannot be previewed.')
  })

  it('truncates long generic errors', () => {
    expect(formatPdfPreviewError(new Error('x'.repeat(130))).endsWith('…')).toBe(true)
  })
})

describe('computeFitWidthScale', () => {
  it('fits page width into the available container width', () => {
    expect(computeFitWidthScale(400, 432, 32)).toBe(1)
  })
})

describe('clampPageNumber', () => {
  it('keeps page numbers within bounds', () => {
    expect(clampPageNumber(0, 5)).toBe(1)
    expect(clampPageNumber(3, 5)).toBe(3)
    expect(clampPageNumber(9, 5)).toBe(5)
  })
})
