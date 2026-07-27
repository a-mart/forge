import type { HelpArticle } from '../help-types'

import modelsCostContent from './articles/models/models-cost.md?raw'
import modelsOverviewContent from './articles/models/models-overview.md?raw'
import modelsProvidersContent from './articles/models/models-providers.md?raw'
import modelsReasoningContent from './articles/models/models-reasoning.md?raw'
import modelsRoutingContent from './articles/models/models-routing.md?raw'

const modelsOverview: HelpArticle = {
  id: 'models-overview',
  title: 'Understanding Models in Forge',
  category: 'models',
  summary: 'How Forge uses different AI models and how to pick the right one for your work.',
  content: modelsOverviewContent,
  keywords: [
    'model',
    'models',
    'select',
    'choose',
    'AI',
    'provider',
    'overview',
  ],
  relatedIds: ['models-providers', 'models-reasoning', 'models-routing'],
  contextKeys: ['settings.general', 'settings.specialists'],
}

const modelsProviders: HelpArticle = {
  id: 'models-providers',
  title: 'Provider Guide',
  category: 'models',
  summary: 'What each AI provider offers and when to use their models.',
  content: modelsProvidersContent,
  keywords: [
    'provider',
    'OpenAI',
    'Codex',
    'Anthropic',
    'Claude',
    'Grok',
    'xAI',
    'GPT',
    'GPT-5.6',
    'Sol',
    'Terra',
    'Luna',
    'Opus',
    'Sonnet',
    'Haiku',
  ],
  relatedIds: ['models-overview', 'models-cost', 'models-reasoning'],
  contextKeys: ['settings.general', 'settings.auth', 'settings.specialists'],
}

const modelsReasoning: HelpArticle = {
  id: 'models-reasoning',
  title: 'Reasoning Levels Explained',
  category: 'models',
  summary: 'What each reasoning level does and when to raise or lower it.',
  content: modelsReasoningContent,
  keywords: [
    'reasoning',
    'level',
    'none',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
    'thinking',
    'quality',
  ],
  relatedIds: ['models-overview', 'models-cost', 'models-providers'],
  contextKeys: ['settings.general', 'settings.specialists'],
}

const modelsRouting: HelpArticle = {
  id: 'models-routing',
  title: 'How Model Routing Works',
  category: 'models',
  summary: 'How session models, work mode, behavior modes, worker rosters, and fallbacks determine which model runs work.',
  content: modelsRoutingContent,
  keywords: [
    'routing',
    'specialist',
    'fallback',
    'delegation',
    'worker roster',
    'worker profile',
    'work mode',
    'manager',
    'worker',
    'spawn',
    'session model',
    'composer pill',
    'override session model',
    'use project default',
    'reasoning level',
  ],
  relatedIds: ['models-overview', 'models-providers', 'concepts-specialists', 'chat-sending'],
  contextKeys: ['settings.specialists', 'chat.workers', 'chat.main'],
}

const modelsCost: HelpArticle = {
  id: 'models-cost',
  title: 'Cost and Speed Tradeoffs',
  category: 'models',
  summary: 'Which models are fast and cheap versus slow and thorough.',
  content: modelsCostContent,
  keywords: [
    'cost',
    'speed',
    'fast',
    'cheap',
    'expensive',
    'tradeoff',
    'token',
    'latency',
    'price',
  ],
  relatedIds: ['models-overview', 'models-reasoning', 'models-routing'],
  contextKeys: ['settings.general', 'settings.specialists'],
}

export const modelsArticles: HelpArticle[] = [
  modelsOverview,
  modelsProviders,
  modelsReasoning,
  modelsRouting,
  modelsCost,
]
