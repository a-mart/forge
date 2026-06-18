import { describe, expect, it } from 'vitest'
import {
  SESSION_AUDIT_DETAIL_HIGHLIGHT_MAX_BYTES,
  SESSION_AUDIT_DETAIL_HIGHLIGHT_MAX_LINE_CHARS,
  SESSION_AUDIT_DETAIL_HIGHLIGHT_MAX_LINES,
  shouldUsePlainJsonDetailView,
} from './session-audit-json-detail'

describe('shouldUsePlainJsonDetailView', () => {
  it('allows highlighted rendering for small payloads', () => {
    expect(shouldUsePlainJsonDetailView('{\n  "ok": true\n}')).toBe(false)
  })

  it('falls back to plain rendering when UTF-8 bytes exceed the cap', () => {
    const text = 'x'.repeat(SESSION_AUDIT_DETAIL_HIGHLIGHT_MAX_BYTES + 1)
    expect(shouldUsePlainJsonDetailView(text)).toBe(true)
  })

  it('falls back to plain rendering when line count exceeds the cap', () => {
    const text = Array.from({ length: SESSION_AUDIT_DETAIL_HIGHLIGHT_MAX_LINES + 1 }, (_, index) => `"line-${index}"`).join('\n')
    expect(shouldUsePlainJsonDetailView(text)).toBe(true)
  })

  it('falls back to plain rendering for minified single-line payloads', () => {
    const text = `{"data":"${'y'.repeat(SESSION_AUDIT_DETAIL_HIGHLIGHT_MAX_LINE_CHARS + 1)}"}`
    expect(shouldUsePlainJsonDetailView(text)).toBe(true)
  })
})
