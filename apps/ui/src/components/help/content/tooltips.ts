import type { HelpTooltipContent } from '../help-types'

export const helpTooltips: HelpTooltipContent[] = [
  {
    id: 'settings.theme',
    text: 'Adjust Appearance with Light, Dark, or System mode, plus templates, custom colors, and font choices. Draft changes and click Apply to save local renderer settings; System follows your OS preference.',
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
