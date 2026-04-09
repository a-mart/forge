/* ------------------------------------------------------------------ */
/*  Preferred editor (VS Code / Cursor) — persisted in localStorage   */
/* ------------------------------------------------------------------ */

export type EditorPreference = 'vscode-insiders' | 'vscode' | 'cursor'

const EDITOR_STORAGE_KEY = 'forge-preferred-editor'

const VALID_EDITORS: EditorPreference[] = ['vscode-insiders', 'vscode', 'cursor']

export const EDITOR_LABELS: Record<EditorPreference, string> = {
  'vscode-insiders': 'VS Code Insiders',
  vscode: 'VS Code',
  cursor: 'Cursor',
}

export const EDITOR_URL_SCHEMES: Record<EditorPreference, string> = {
  'vscode-insiders': 'vscode-insiders',
  vscode: 'vscode',
  cursor: 'cursor',
}

function isEditorPreference(value: unknown): value is EditorPreference {
  return typeof value === 'string' && VALID_EDITORS.includes(value as EditorPreference)
}

export function readStoredEditorPreference(): EditorPreference {
  if (typeof window === 'undefined') {
    return 'vscode-insiders'
  }

  try {
    const stored = window.localStorage.getItem(EDITOR_STORAGE_KEY)
    return isEditorPreference(stored) ? stored : 'vscode-insiders'
  } catch {
    return 'vscode-insiders'
  }
}

export function storeEditorPreference(preference: EditorPreference): void {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(EDITOR_STORAGE_KEY, preference)
  } catch {
    // Ignore localStorage write failures in restricted environments.
  }
}
