import type { HelpArticle } from '../help-types'

import conceptsWorkingPlansContent from './articles/concepts/concepts-working-plans.md?raw'
import conceptsGoalsContent from './articles/concepts/concepts-goals.md?raw'
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

const conceptsWorkingPlans: HelpArticle = {
  id: 'concepts-working-plans',
  title: 'Working Plans',
  category: 'concepts',
  summary: 'How managers expose a concise, current checklist for substantial work.',
  content: conceptsWorkingPlansContent,
  keywords: [
    'working plan',
    'update plan',
    'plan',
    'coordination',
    'session',
    'progress',
  ],
  relatedIds: ['concepts-goals', 'concepts-multi-agent', 'concepts-sessions', 'chat-overview'],
  contextKeys: ['chat.main'],
}

const conceptsGoals: HelpArticle = {
  id: 'concepts-goals',
  title: 'Session Goals',
  category: 'concepts',
  summary: 'How a manager keeps pursuing one explicit outcome across turns and working plans.',
  content: conceptsGoalsContent,
  keywords: [
    'goal',
    'pursuing goal',
    'token budget',
    'pause goal',
    'resume goal',
    'autonomous',
    'continuation',
    'session',
  ],
  relatedIds: ['concepts-working-plans', 'concepts-sessions', 'concepts-multi-agent'],
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
  contextKeys: ['chat.main'],
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
  title: 'Worker Delegation',
  category: 'concepts',
  summary: 'Manager posture, behavior modes, delegation rosters, custom specialists, and worker fallback routing.',
  content: conceptsSpecialistsContent,
  keywords: [
    'specialist',
    'delegation',
    'behavior mode',
    'execution route',
    'delegation roster',
    'manager posture',
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
  conceptsGoals,
  conceptsWorkingPlans,
  conceptsMemory,
  conceptsPromptResolution,
  conceptsSpecialists,
  conceptsSessions,
  conceptsProjectAgents,
]
