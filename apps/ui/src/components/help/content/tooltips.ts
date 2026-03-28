import type { HelpTooltipContent } from '../help-types'

export const helpTooltips: HelpTooltipContent[] = [
  {
    id: 'settings.theme',
    text: 'Switch between Light, Dark, or System theme. System follows your OS preference.',
    articleId: 'settings-theme',
    contextKey: 'settings.general',
  },
  {
    id: 'settings.cortex-auto-review',
    text: 'Cortex periodically reviews sessions and updates knowledge. Only sessions with new activity are checked.',
    articleId: 'cortex-overview',
    contextKey: 'settings.general',
  },
]
