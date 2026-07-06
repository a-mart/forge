/**
 * Shared guard for BuilderSurface global keyboard shortcuts (WP-U3 split).
 *
 * Extracted verbatim from BuilderSurface so the transcript (Ctrl+F) and
 * workspace (Ctrl+Shift+E / Ctrl+Shift+D) shortcut handlers — now in separate
 * controllers — share one definition instead of each keeping a copy.  Returns
 * `true` when a keydown originated from an editable target (input, textarea,
 * select, contentEditable, or a CodeMirror editor) and the global shortcut
 * should therefore be ignored.
 */
export function shouldIgnoreGlobalShortcutTarget(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return true
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('.cm-editor') || target.closest('.cm-content')) return true
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  )
}
