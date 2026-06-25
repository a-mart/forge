import { keymap, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, lineNumbers, rectangularSelection, crosshairCursor, EditorView } from '@codemirror/view'
import { Prec, Compartment, EditorState, type Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { searchKeymap } from '@codemirror/search'
import { bracketMatching, foldGutter, indentOnInput } from '@codemirror/language'
import { useEffect, useMemo, useRef } from 'react'
import '@/styles/file-browser.css'
import { codeMirrorLanguageExtension } from './codemirror-language'
import { codeMirrorDarkThemeFacet, codeMirrorThemeExtensions, isForgeDarkModeActive } from './codemirror-theme'

export interface CodeMirrorFileEditorProps {
  value: string
  language: string | undefined
  wordWrap: boolean
  readOnly?: boolean
  ariaLabel?: string
  onChange: (next: string) => void
  onFocusedChange?: (focused: boolean) => void
  onSaveShortcut?: () => void
  initialScroll?: { top: number; left?: number }
  onScrollSnapshotChange?: (snapshot: { top: number; left: number }) => void
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
  initialScroll,
  onScrollSnapshotChange,
}: CodeMirrorFileEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartment = useMemo(() => new Compartment(), [])
  const readOnlyCompartment = useMemo(() => new Compartment(), [])
  const wrapCompartment = useMemo(() => new Compartment(), [])
  const contentAttributesCompartment = useMemo(() => new Compartment(), [])
  const themeCompartment = useMemo(() => new Compartment(), [])
  const onChangeRef = useRef(onChange)
  const onFocusedChangeRef = useRef(onFocusedChange)
  const onSaveShortcutRef = useRef(onSaveShortcut)
  const onScrollSnapshotChangeRef = useRef(onScrollSnapshotChange)
  const readOnlyRef = useRef(readOnly === true)
  const syncingExternalValueRef = useRef(false)
  const initialConfigRef = useRef({ value, language, readOnly, wordWrap, ariaLabel, initialScroll })

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
    onScrollSnapshotChangeRef.current = onScrollSnapshotChange
  }, [onScrollSnapshotChange])

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
        themeCompartment.of(codeMirrorThemeExtensions(isForgeDarkModeActive())),
        saveKeymap,
        keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap]),
        languageCompartment.of(codeMirrorLanguageExtension(initialConfig.language)),
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
    if (initialConfig.initialScroll) {
      requestAnimationFrame(() => {
        view.scrollDOM.scrollTop = initialConfig.initialScroll?.top ?? 0
        view.scrollDOM.scrollLeft = initialConfig.initialScroll?.left ?? 0
      })
    }
    const handleScroll = () => onScrollSnapshotChangeRef.current?.({
      top: view.scrollDOM.scrollTop,
      left: view.scrollDOM.scrollLeft,
    })
    view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true })

    return () => {
      handleScroll()
      view.scrollDOM.removeEventListener('scroll', handleScroll)
      view.destroy()
      if (viewRef.current === view) {
        viewRef.current = null
      }
    }
  }, [contentAttributesCompartment, languageCompartment, readOnlyCompartment, themeCompartment, wrapCompartment])

  useEffect(() => {
    const view = viewRef.current
    if (!view || typeof document === 'undefined') {
      return undefined
    }

    const root = document.documentElement
    let lastIsDark = view.state.facet(codeMirrorDarkThemeFacet)
    const applyTheme = () => {
      const nextIsDark = isForgeDarkModeActive()
      if (nextIsDark === lastIsDark) {
        return
      }
      lastIsDark = nextIsDark
      view.dispatch({
        effects: themeCompartment.reconfigure(codeMirrorThemeExtensions(nextIsDark)),
      })
    }

    applyTheme()

    if (typeof MutationObserver === 'undefined') {
      return undefined
    }

    const observer = new MutationObserver(applyTheme)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })

    return () => {
      observer.disconnect()
    }
  }, [themeCompartment])

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
      effects: languageCompartment.reconfigure(codeMirrorLanguageExtension(language)),
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

  return <div ref={containerRef} className="file-browser-code-editor h-full min-h-0 w-full overflow-hidden" data-testid="codemirror-file-editor" />
}
