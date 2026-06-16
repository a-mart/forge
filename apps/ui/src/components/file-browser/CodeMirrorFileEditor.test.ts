/** @vitest-environment jsdom */

import { EditorView } from '@codemirror/view'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeMirrorFileEditor, type CodeMirrorFileEditorProps } from './CodeMirrorFileEditor'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  container.style.height = '400px'
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
})

function renderEditor(props: Partial<CodeMirrorFileEditorProps> = {}) {
  const defaultProps: CodeMirrorFileEditorProps = {
    value: 'hello',
    language: 'typescript',
    wordWrap: false,
    onChange: vi.fn(),
    ...props,
  }

  root ??= createRoot(container)
  flushSync(() => {
    root?.render(createElement(CodeMirrorFileEditor, defaultProps))
  })

  return defaultProps
}

function contentElement() {
  const content = container.querySelector<HTMLElement>('.cm-content')
  expect(content).not.toBeNull()
  return content as HTMLElement
}

function editorView() {
  const editor = container.querySelector<HTMLElement>('.cm-editor')
  expect(editor).not.toBeNull()
  const view = EditorView.findFromDOM(editor as HTMLElement)
  expect(view).not.toBeNull()
  return view as EditorView
}

describe('CodeMirrorFileEditor', () => {
  it('renders the controlled value', () => {
    renderEditor({ value: 'const answer = 42' })

    expect(contentElement().textContent).toContain('const answer = 42')
  })

  it('updates rendered content when the controlled value changes', () => {
    renderEditor({ value: 'before' })

    flushSync(() => {
      root?.render(createElement(CodeMirrorFileEditor, {
        value: 'after',
        language: 'typescript',
        wordWrap: false,
        onChange: vi.fn(),
      } satisfies CodeMirrorFileEditorProps))
    })

    expect(contentElement().textContent).toContain('after')
  })

  it('does not call onChange when syncing an external controlled value', () => {
    const onChange = vi.fn()
    renderEditor({ value: 'before', onChange })

    flushSync(() => {
      root?.render(createElement(CodeMirrorFileEditor, {
        value: 'after',
        language: 'typescript',
        wordWrap: false,
        onChange,
      } satisfies CodeMirrorFileEditorProps))
    })

    expect(contentElement().textContent).toContain('after')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('calls onChange for editor document changes', () => {
    const onChange = vi.fn()
    renderEditor({ value: 'hello', onChange })

    const view = editorView()
    view.dispatch({ changes: { from: view.state.doc.length, insert: '!' } })

    expect(onChange).toHaveBeenCalledWith('hello!')
  })

  it('calls onSaveShortcut for focused Mod-s and prevents the browser default', () => {
    const onSaveShortcut = vi.fn()
    renderEditor({ onSaveShortcut })

    const view = editorView()
    view.focus()
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 's',
      ctrlKey: true,
    })
    view.contentDOM.dispatchEvent(event)

    expect(onSaveShortcut).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('ignores the save shortcut while read-only', () => {
    const onSaveShortcut = vi.fn()
    renderEditor({ readOnly: true, onSaveShortcut })

    const view = editorView()
    view.focus()
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 's',
      ctrlKey: true,
    })
    view.contentDOM.dispatchEvent(event)

    expect(onSaveShortcut).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('reports focus changes, accessibility label, and supports read-only mode', () => {
    const onFocusedChange = vi.fn()
    renderEditor({ readOnly: true, ariaLabel: 'Editing package.json', onFocusedChange })

    const content = contentElement()
    content.focus()
    content.blur()

    expect(onFocusedChange).toHaveBeenCalledWith(true)
    expect(onFocusedChange).toHaveBeenCalledWith(false)
    expect(content.getAttribute('aria-label')).toBe('Editing package.json')
    expect(content.getAttribute('contenteditable')).toBe('false')
  })

  it('defaults the accessibility label', () => {
    renderEditor()

    expect(contentElement().getAttribute('aria-label')).toBe('File editor')
  })

  it('enables CodeMirror line wrapping when wordWrap is true', () => {
    renderEditor({ wordWrap: true })

    expect(container.querySelector('.cm-lineWrapping')).not.toBeNull()
  })

  it('destroys the EditorView when unmounted', () => {
    const destroySpy = vi.spyOn(EditorView.prototype, 'destroy')
    renderEditor()

    flushSync(() => root?.unmount())
    root = null

    expect(destroySpy).toHaveBeenCalledTimes(1)
    destroySpy.mockRestore()
  })
})
