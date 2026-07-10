import type { HelpArticle } from '../help-types'

import terminalManagementContent from './articles/terminals/terminal-management.md?raw'
import terminalOverviewContent from './articles/terminals/terminal-overview.md?raw'
import terminalShortcutsContent from './articles/terminals/terminal-shortcuts.md?raw'

export const terminalArticles: HelpArticle[] = [
  {
    id: 'terminal-overview',
    title: 'Integrated Terminals',
    category: 'terminals',
    summary: 'Full shell terminals inside Forge, scoped to your profile and persisted across sessions.',
    content: terminalOverviewContent,
    keywords: [
      'terminal',
      'shell',
      'pty',
      'command line',
      'console',
      'persist',
      'scrollback',
      'profile',
      'remote projects',
      'remote terminal',
      'server host',
      'terminal policy',
    ],
    relatedIds: ['settings-collaboration', 'terminal-shortcuts', 'terminal-management'],
    contextKeys: ['terminal.panel'],
  },
  {
    id: 'terminal-shortcuts',
    title: 'Terminal Keyboard Shortcuts',
    category: 'terminals',
    summary: 'Keyboard shortcuts for opening, switching, and navigating terminals.',
    content: terminalShortcutsContent,
    keywords: [
      'shortcut',
      'keyboard',
      'hotkey',
      'escape',
      'toggle',
      'switch',
      'tab',
      'focus',
      'resize',
    ],
    relatedIds: ['terminal-overview', 'terminal-management'],
    contextKeys: ['terminal.panel'],
  },
  {
    id: 'terminal-management',
    title: 'Managing Terminals',
    category: 'terminals',
    summary: 'How to create, rename, close, and organize your terminals.',
    content: terminalManagementContent,
    keywords: [
      'create',
      'new',
      'close',
      'delete',
      'rename',
      'status',
      'indicator',
      'working directory',
      'cwd',
    ],
    relatedIds: ['terminal-overview', 'terminal-shortcuts'],
    contextKeys: ['terminal.panel'],
  },
]
