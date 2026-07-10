import type { HelpArticle } from '../help-types'

import conceptsActiveWorkPlansContent from './articles/concepts/concepts-active-work-plans.md?raw'
import conceptsMemoryContent from './articles/concepts/concepts-memory.md?raw'
import conceptsMultiAgentContent from './articles/concepts/concepts-multi-agent.md?raw'
import conceptsProjectAgentsContent from './articles/concepts/concepts-project-agents.md?raw'
import conceptsPromptResolutionContent from './articles/concepts/concepts-prompt-resolution.md?raw'
import conceptsSessionsContent from './articles/concepts/concepts-sessions.md?raw'
import conceptsSpecialistsContent from './articles/concepts/concepts-specialists.md?raw'

const conceptsMultiAgent: HelpArticle = {
  id: 'concepts-multi-agent',
  title: 'Multi-Agent Architecture',
  category: 'concepts',
  summary: 'How managers and workers coordinate to handle complex tasks.',
  content: conceptsMultiAgentContent,
  keywords: [
    'manager',
    'worker',
    'agent',
    'multi-agent',
    'orchestration',
    'parallel',
    'spawn',
    'routing',
  ],
  relatedIds: ['concepts-specialists', 'concepts-sessions'],
  contextKeys: ['chat.workers', 'chat.main'],
}

const conceptsActiveWorkPlans: HelpArticle = {
  id: 'concepts-active-work-plans',
  title: 'Active Work Plans',
  category: 'concepts',
  summary: 'Current parked status and compatibility behavior for historical Work Plan receipts.',
  content: conceptsActiveWorkPlansContent,
  keywords: [
    'active work',
    'work plan',
    'task plan',
    'plan',
    'coordination',
    'session',
    'progress',
  ],
  relatedIds: ['concepts-multi-agent', 'concepts-sessions', 'chat-overview'],
  contextKeys: ['chat.main'],
}

const conceptsMemory: HelpArticle = {
  id: 'concepts-memory',
  title: 'Memory System',
  category: 'concepts',
  summary: 'How session memory, profile memory, legacy common knowledge, and Knowledge v2 prompt sources differ.',
  content: conceptsMemoryContent,
  keywords: [
    'memory',
    'profile memory',
    'session memory',
    'common knowledge',
    'knowledge v2',
    'index',
    'context',
    'remember',
    'persistence',
    'cortex',
  ],
  relatedIds: ['concepts-sessions', 'cortex-overview', 'cortex-knowledge'],
  contextKeys: ['chat.main', 'cortex.knowledge'],
}

const conceptsPromptResolution: HelpArticle = {
  id: 'concepts-prompt-resolution',
  title: 'Prompt System',
  category: 'concepts',
  summary: 'How Forge resolves system prompts through three layers: profile, repo, and builtin defaults.',
  content: conceptsPromptResolutionContent,
  keywords: [
    'prompt',
    'system prompt',
    'resolution',
    'archetype',
    'override',
    'profile prompt',
    'repo prompt',
    'builtin',
    'template',
  ],
  relatedIds: ['settings-prompts', 'chat-system-prompt'],
  contextKeys: ['settings.prompts', 'chat.system-prompt'],
}

const conceptsSpecialists: HelpArticle = {
  id: 'concepts-specialists',
  title: 'Specialist Workers',
  category: 'concepts',
  summary: 'Named worker templates with dedicated models, prompts, and routing rules.',
  content: conceptsSpecialistsContent,
  keywords: [
    'specialist',
    'worker',
    'routing',
    'model',
    'template',
    'named worker',
    'fallback',
    'prompt',
  ],
  relatedIds: ['concepts-multi-agent', 'settings-specialists'],
  contextKeys: ['settings.specialists', 'chat.workers'],
}

const conceptsSessions: HelpArticle = {
  id: 'concepts-sessions',
  title: 'Sessions and Profiles',
  category: 'concepts',
  summary: 'How profiles group settings and memory, and how sessions track individual conversations.',
  content: conceptsSessionsContent,
  keywords: [
    'session',
    'profile',
    'conversation',
    'fork',
    'lifecycle',
    'config',
    'inheritance',
    'memory',
    'idle',
    'running',
  ],
  relatedIds: ['concepts-memory', 'concepts-multi-agent', 'chat-fork-session'],
  contextKeys: ['chat.sidebar', 'chat.main'],
}

const conceptsProjectAgents: HelpArticle = {
  id: 'concepts-project-agents',
  title: 'Project Agents',
  category: 'concepts',
  summary: 'Promoted sessions that become discoverable, persistent agents for cross-session collaboration.',
  content: conceptsProjectAgentsContent,
  keywords: [
    'project agent',
    'promotion',
    'handle',
    '@mention',
    'discovery',
    'cross-session',
    'messaging',
    'agent creator',
    'specialist',
    'async',
  ],
  relatedIds: ['concepts-sessions', 'concepts-multi-agent', 'chat-project-agents'],
  contextKeys: ['chat.sidebar', 'chat.main'],
}

export const conceptsArticles: HelpArticle[] = [
  conceptsMultiAgent,
  conceptsActiveWorkPlans,
  conceptsMemory,
  conceptsPromptResolution,
  conceptsSpecialists,
  conceptsSessions,
  conceptsProjectAgents,
]
