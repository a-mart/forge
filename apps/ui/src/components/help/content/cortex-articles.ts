import type { HelpArticle } from '../help-types'

import cortexAutoReviewContent from './articles/cortex/cortex-auto-review.md?raw'
import cortexKnowledgeContent from './articles/cortex/cortex-knowledge.md?raw'
import cortexOnboardingContent from './articles/cortex/cortex-onboarding.md?raw'
import cortexOverviewContent from './articles/cortex/cortex-overview.md?raw'

export const cortexArticles: HelpArticle[] = [
  {
    id: 'cortex-overview',
    title: 'What is Cortex?',
    category: 'cortex',
    summary: 'Cortex manages durable knowledge entries, capture checks, compact indexes, and entry-only consolidation.',
    content: cortexOverviewContent,
    keywords: [
      'cortex',
      'knowledge v2',
      'knowledge',
      'capture check',
      'consolidation',
      'dashboard',
      'learning',
      'index',
    ],
    relatedIds: ['cortex-knowledge', 'cortex-auto-review', 'cortex-onboarding', 'settings-general'],
    contextKeys: ['cortex.dashboard'],
  },
  {
    id: 'cortex-knowledge',
    title: 'Knowledge management',
    category: 'cortex',
    summary: 'How global and profile-scoped Knowledge v2 entries, indexes, legacy memory, and guarded activation fit together.',
    content: cortexKnowledgeContent,
    keywords: [
      'knowledge',
      'knowledge v2',
      'global knowledge',
      'profile knowledge',
      'profile memory',
      'migration',
      'index',
      'cortex',
    ],
    relatedIds: ['cortex-overview', 'cortex-auto-review', 'settings-general'],
    contextKeys: ['cortex.dashboard'],
  },
  {
    id: 'cortex-auto-review',
    title: 'Consolidation schedule',
    category: 'cortex',
    summary: 'Cortex can consolidate existing entries on a daily schedule or on demand without mining transcripts.',
    content: cortexAutoReviewContent,
    keywords: [
      'consolidation',
      'schedule',
      'merge',
      'supersede',
      'archive',
      'index',
      'capture check',
      'cortex',
    ],
    relatedIds: ['cortex-overview', 'cortex-knowledge', 'settings-general'],
    contextKeys: ['cortex.dashboard'],
  },
  {
    id: 'cortex-onboarding',
    title: 'First-run onboarding',
    category: 'cortex',
    summary: 'On first launch, Forge captures your name, technical level, and communication preferences so managers respond naturally.',
    content: cortexOnboardingContent,
    keywords: [
      'onboarding',
      'first launch',
      'welcome',
      'preferences',
      'name',
      'technical level',
      'setup',
      'cortex',
    ],
    relatedIds: ['cortex-overview', 'cortex-knowledge', 'settings-general'],
    contextKeys: ['cortex.dashboard'],
  },
]
