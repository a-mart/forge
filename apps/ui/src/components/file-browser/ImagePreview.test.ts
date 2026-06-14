/** @vitest-environment jsdom */

import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ImagePreview } from './ImagePreview'

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
      createElement(ImagePreview, {
        wsUrl: 'ws://127.0.0.1:47187',
        filePath: 'assets/logo.png',
        agentId: 'session-a',
        worktreeId,
      }),
    )
  })
}

describe('ImagePreview worktree context', () => {
  it('includes worktreeId in the read-file URL when browsing a linked worktree', () => {
    renderPreview('feature-linked')

    const image = container.querySelector('img')
    expect(image).not.toBeNull()
    expect(image?.getAttribute('src')).toContain('worktreeId=feature-linked')
    expect(image?.getAttribute('src')).toContain('path=assets%2Flogo.png')
    expect(image?.getAttribute('src')).toContain('agentId=session-a')
  })

  it('omits worktreeId from the read-file URL for session browsing', () => {
    renderPreview(null)

    const image = container.querySelector('img')
    expect(image).not.toBeNull()
    expect(image?.getAttribute('src')).not.toContain('worktreeId=')
  })
})
