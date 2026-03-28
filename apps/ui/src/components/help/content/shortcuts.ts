import type { ShortcutDef } from '../help-types'

export const SHORTCUTS: ShortcutDef[] = [
  {
    id: 'sidebar-focus-search',
    keys: 'Ctrl+K',
    keysMac: '⌘+K',
    label: 'Focus sidebar search',
    group: 'Navigation',
    scope: 'global',
  },
  {
    id: 'chat-toggle-diff-viewer',
    keys: 'Ctrl+Shift+D',
    keysMac: '⌘+Shift+D',
    label: 'Toggle diff viewer',
    group: 'Chat',
    scope: 'chat',
  },
  {
    id: 'chat-toggle-file-browser',
    keys: 'Ctrl+Shift+E',
    keysMac: '⌘+Shift+E',
    label: 'Toggle file browser',
    group: 'Chat',
    scope: 'chat',
  },
  {
    id: 'terminal-toggle-panel',
    keys: 'Ctrl+`',
    keysMac: '⌘+`',
    label: 'Toggle terminal panel',
    group: 'Terminal',
    scope: 'terminal',
  },
  {
    id: 'terminal-new-terminal',
    keys: 'Ctrl+Shift+`',
    keysMac: '⌘+Shift+`',
    label: 'Create new terminal',
    group: 'Terminal',
    scope: 'terminal',
  },
  {
    id: 'terminal-select-previous',
    keys: 'Alt+Shift+[',
    keysMac: '⌥+Shift+[',
    label: 'Select previous terminal',
    group: 'Terminal',
    scope: 'terminal',
  },
  {
    id: 'terminal-select-next',
    keys: 'Alt+Shift+]',
    keysMac: '⌥+Shift+]',
    label: 'Select next terminal',
    group: 'Terminal',
    scope: 'terminal',
  },
  {
    id: 'help-toggle-drawer',
    keys: 'Ctrl+/',
    keysMac: '⌘+/',
    label: 'Open or close contextual help',
    group: 'Help',
    scope: 'global',
  },
  {
    id: 'help-toggle-shortcuts',
    keys: '?',
    label: 'Toggle shortcut overlay when not typing',
    group: 'Help',
    scope: 'global',
  },
]

export function getShortcutDefinitions(): ShortcutDef[] {
  return [...SHORTCUTS]
}
