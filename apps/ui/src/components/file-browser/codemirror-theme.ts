import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Facet, type Extension } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'

export const codeMirrorDarkThemeFacet = Facet.define<boolean, boolean>({
  combine: (values) => values.at(-1) ?? false,
})

export function isForgeDarkModeActive(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

export function codeMirrorThemeExtensions(isDark: boolean): Extension {
  return isDark
    ? [codeMirrorDarkThemeFacet.of(true), oneDark]
    : [codeMirrorDarkThemeFacet.of(false), syntaxHighlighting(defaultHighlightStyle, { fallback: true })]
}
