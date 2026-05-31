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
    summary: 'Cortex is Forge\'s self-improvement system. It reviews sessions, manages knowledge, and keeps your preferences current.',
    content: cortexOverviewContent,
    keywords: [
      'cortex',
      'self-improvement',
      'knowledge',
      'review',
      'dashboard',
      'learning',
      'notes',
      'sessions',
    ],
    relatedIds: ['cortex-knowledge', 'cortex-auto-review', 'cortex-onboarding'],
    contextKeys: ['cortex.dashboard'],
  },
  {
    id: 'cortex-knowledge',
    title: 'Knowledge management',
    category: 'cortex',
    summary: 'Cortex maintains a shared knowledge base with common facts, preferences, and per-profile memory.',
    content: cortexKnowledgeContent,
    keywords: [
      'knowledge',
      'common knowledge',
      'profile memory',
      'memory',
      'edit',
      'preferences',
      'facts',
      'cortex',
    ],
    relatedIds: ['cortex-overview', 'cortex-auto-review'],
    contextKeys: ['cortex.dashboard', 'cortex.knowledge'],
  },
  {
    id: 'cortex-auto-review',
    title: 'Auto-review',
    category: 'cortex',
    summary: 'Cortex can automatically review sessions on a schedule, checking transcripts, memory, and feedback for changes.',
    content: cortexAutoReviewContent,
    keywords: [
      'auto-review',
      'review',
      'schedule',
      'scan',
      'drift',
      'transcript',
      'memory',
      'feedback',
      'cortex',
      'coverage',
    ],
    relatedIds: ['cortex-overview', 'cortex-knowledge'],
    contextKeys: ['cortex.review'],
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
    relatedIds: ['cortex-overview', 'cortex-knowledge'],
    contextKeys: ['cortex.dashboard'],
  },
]
