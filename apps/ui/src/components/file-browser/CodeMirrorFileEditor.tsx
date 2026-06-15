import { keymap, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, lineNumbers, rectangularSelection, crosshairCursor, EditorView } from '@codemirror/view'
import { Prec, Compartment, EditorState, type Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { searchKeymap } from '@codemirror/search'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { bracketMatching, defaultHighlightStyle, foldGutter, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { useEffect, useMemo, useRef } from 'react'

export interface CodeMirrorFileEditorProps {
  value: string
  language: string | undefined
  wordWrap: boolean
  readOnly?: boolean
  ariaLabel?: string
  onChange: (next: string) => void
  onFocusedChange?: (focused: boolean) => void
  onSaveShortcut?: () => void
}

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--card)',
    color: 'var(--foreground)',
    fontSize: '13px',
  },
  '.cm-scroller': {
    fontFamily: 'var(--app-font-mono)',
    lineHeight: '1.55',
  },
  '.cm-content': {
    caretColor: 'var(--primary)',
    padding: '12px 0',
  },
  '.cm-line': {
    padding: '0 12px',
  },
  '.cm-gutters': {
    backgroundColor: 'color-mix(in srgb, var(--muted) 35%, transparent)',
    color: 'var(--muted-foreground)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent)',
    color: 'var(--foreground)',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 12%, transparent)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: 'var(--primary)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--primary) 28%, transparent)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'rgb(250 204 21 / 0.35)',
    outline: '1px solid rgb(250 204 21 / 0.45)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'rgb(251 146 60 / 0.45)',
  },
})

function languageExtension(language: string | undefined): Extension {
  const normalized = language?.trim().toLowerCase()
  switch (normalized) {
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return css()
    case 'html':
    case 'htm':
    case 'xml':
    case 'svg':
      return html()
    case 'javascript':
    case 'js':
    case 'jsx':
    case 'typescript':
    case 'ts':
    case 'tsx':
    case 'mjs':
    case 'cjs':
      return javascript({ jsx: normalized === 'jsx' || normalized === 'tsx', typescript: normalized === 'typescript' || normalized === 'ts' || normalized === 'tsx' })
    case 'json':
    case 'jsonc':
      return json()
    case 'markdown':
    case 'md':
    case 'mdx':
      return markdown()
    default:
      return []
  }
}

function readOnlyExtensions(readOnly: boolean | undefined): Extension {
  const isReadOnly = readOnly === true
  return [
    EditorState.readOnly.of(isReadOnly),
    EditorView.editable.of(!isReadOnly),
  ]
}

function contentAttributes(ariaLabel: string | undefined): Extension {
  return EditorView.contentAttributes.of({
    'aria-label': ariaLabel?.trim() || 'File editor',
  })
}

export function CodeMirrorFileEditor({
  value,
  language,
  wordWrap,
  readOnly,
  ariaLabel,
  onChange,
  onFocusedChange,
  onSaveShortcut,
}: CodeMirrorFileEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartment = useMemo(() => new Compartment(), [])
  const readOnlyCompartment = useMemo(() => new Compartment(), [])
  const wrapCompartment = useMemo(() => new Compartment(), [])
  const contentAttributesCompartment = useMemo(() => new Compartment(), [])
  const onChangeRef = useRef(onChange)
  const onFocusedChangeRef = useRef(onFocusedChange)
  const onSaveShortcutRef = useRef(onSaveShortcut)
  const readOnlyRef = useRef(readOnly === true)
  const syncingExternalValueRef = useRef(false)
  const initialConfigRef = useRef({ value, language, readOnly, wordWrap, ariaLabel })

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onFocusedChangeRef.current = onFocusedChange
  }, [onFocusedChange])

  useEffect(() => {
    onSaveShortcutRef.current = onSaveShortcut
  }, [onSaveShortcut])

  useEffect(() => {
    readOnlyRef.current = readOnly === true
  }, [readOnly])

  useEffect(() => {
    const parent = containerRef.current
    if (!parent) {
      return undefined
    }

    const saveKeymap = Prec.high(keymap.of([{
      key: 'Mod-s',
      preventDefault: true,
      run: () => {
        if (!readOnlyRef.current) {
          onSaveShortcutRef.current?.()
        }
        return true
      },
    }]))

    const initialConfig = initialConfigRef.current
    const state = EditorState.create({
      doc: initialConfig.value,
      extensions: [
        lineNumbers(),
        foldGutter(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        crosshairCursor(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        saveKeymap,
        keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap]),
        languageCompartment.of(languageExtension(initialConfig.language)),
        readOnlyCompartment.of(readOnlyExtensions(initialConfig.readOnly)),
        wrapCompartment.of(initialConfig.wordWrap ? EditorView.lineWrapping : []),
        contentAttributesCompartment.of(contentAttributes(initialConfig.ariaLabel)),
        editorTheme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !syncingExternalValueRef.current) {
            onChangeRef.current(update.state.doc.toString())
          }
        }),
        EditorView.domEventHandlers({
          focus: () => {
            onFocusedChangeRef.current?.(true)
          },
          blur: () => {
            onFocusedChangeRef.current?.(false)
          },
        }),
      ],
    })

    const view = new EditorView({ state, parent })
    viewRef.current = view

    return () => {
      view.destroy()
      if (viewRef.current === view) {
        viewRef.current = null
      }
    }
  }, [contentAttributesCompartment, languageCompartment, readOnlyCompartment, wrapCompartment])

  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === value) {
      return
    }

    syncingExternalValueRef.current = true
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    })
    syncingExternalValueRef.current = false
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (!view) {
      return
    }

    view.dispatch({
      effects: languageCompartment.reconfigure(languageExtension(language)),
    })
  }, [language, languageCompartment])

  useEffect(() => {
    const view = viewRef.current
    if (!view) {
      return
    }

    view.dispatch({
      effects: readOnlyCompartment.reconfigure(readOnlyExtensions(readOnly)),
    })
  }, [readOnly, readOnlyCompartment])

  useEffect(() => {
    const view = viewRef.current
    if (!view) {
      return
    }

    view.dispatch({
      effects: wrapCompartment.reconfigure(wordWrap ? EditorView.lineWrapping : []),
    })
  }, [wordWrap, wrapCompartment])

  useEffect(() => {
    const view = viewRef.current
    if (!view) {
      return
    }

    view.dispatch({
      effects: contentAttributesCompartment.reconfigure(contentAttributes(ariaLabel)),
    })
  }, [ariaLabel, contentAttributesCompartment])

  return <div ref={containerRef} className="h-full min-h-0 w-full overflow-hidden" data-testid="codemirror-file-editor" />
}
