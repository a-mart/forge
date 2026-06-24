/** @vitest-environment jsdom */

import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PdfPreview } from './PdfPreview'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
})

function renderPreview(worktreeId?: string | null) {
  root ??= createRoot(container)
  flushSync(() => {
    root?.render(
      createElement(PdfPreview, {
        wsUrl: 'ws://127.0.0.1:47187',
        filePath: 'docs/spec.pdf',
        agentId: 'session-a',
        worktreeId,
      }),
    )
  })
}

describe('PdfPreview raw route URL', () => {
  it('includes worktreeId in the raw file URL when browsing a linked worktree', () => {
    renderPreview('feature-linked')

    const preview = container.querySelector('[data-testid="pdf-preview"]')
    expect(preview).not.toBeNull()
    expect(preview?.getAttribute('data-pdf-url')).toContain('/api/files/raw?')
    expect(preview?.getAttribute('data-pdf-url')).toContain('worktreeId=feature-linked')
    expect(preview?.getAttribute('data-pdf-url')).toContain('path=docs%2Fspec.pdf')
    expect(preview?.getAttribute('data-pdf-url')).toContain('agentId=session-a')
  })

  it('omits worktreeId from the raw file URL for session browsing', () => {
    renderPreview(null)

    const preview = container.querySelector('[data-testid="pdf-preview"]')
    expect(preview).not.toBeNull()
    expect(preview?.getAttribute('data-pdf-url')).not.toContain('worktreeId=')
  })
})
