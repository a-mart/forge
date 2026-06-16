/** @vitest-environment jsdom */

import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileStatusBar } from './FileStatusBar'

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

function renderStatusBar(props: Partial<Parameters<typeof FileStatusBar>[0]> = {}) {
  root ??= createRoot(container)
  flushSync(() => {
    root?.render(createElement(FileStatusBar, {
      fileCount: null,
      fileCountMethod: null,
      selectedFile: 'src/file.ts',
      languageDisplayName: 'TypeScript',
      lineCount: 1,
      fileSize: 5,
      ...props,
    }))
  })
}

describe('FileStatusBar metadata labels', () => {
  it('does not label old-shape text metadata as read-only when encoding is missing', () => {
    renderStatusBar({ encoding: null, editability: null })

    expect(container.textContent).toContain('TypeScript')
    expect(container.textContent).not.toContain('Read-only')
  })

  it('labels files read-only only when editability says they are not editable', () => {
    renderStatusBar({
      encoding: null,
      editability: { editable: false, reason: 'unsupported_encoding', maxEditableBytes: 1024 },
    })

    expect(container.textContent).toContain('Read-only')
    expect(container.textContent).toContain('Unsupported encoding')
  })
})
