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
    text: 'While Knowledge v2 is on, Cortex can consolidate existing entries on a daily schedule. It does not review transcripts or create entries.',
    articleId: 'cortex-auto-review',
    contextKey: 'settings.general',
  },
]
