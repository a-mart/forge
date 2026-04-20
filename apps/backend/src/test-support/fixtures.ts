import { SessionManager } from '@mariozechner/pi-coding-agent'
import { join } from 'node:path'
import type { ConversationMessageEvent } from '../swarm/types.js'
import type { AgentDescriptor, AgentModelDescriptor } from '../swarm/types.js'

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

const DEFAULT_TIMESTAMP = '2026-01-01T00:00:00.000Z'
const DEFAULT_MODEL: AgentModelDescriptor = {
  provider: 'openai-codex',
  modelId: 'gpt-5.3-codex',
  thinkingLevel: 'medium',
}

export function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })

  return { promise, resolve, reject }
}

export interface AgentDescriptorFixtureOptions extends Partial<AgentDescriptor> {
  agentId: string
  role?: AgentDescriptor['role']
  rootDir?: string
  sessionFile?: string
}

export function createAgentDescriptor(options: AgentDescriptorFixtureOptions): AgentDescriptor {
  const {
    agentId,
    role = 'manager',
    rootDir = '/tmp/project',
    sessionFile = join(rootDir, 'sessions', `${agentId}.jsonl`),
    ...overrides
  } = options

  const defaultManagerId = role === 'manager' ? agentId : 'manager'

  return {
    agentId,
    displayName: agentId,
    role,
    managerId: defaultManagerId,
    status: 'idle',
    createdAt: DEFAULT_TIMESTAMP,
    updatedAt: DEFAULT_TIMESTAMP,
    cwd: rootDir,
    model: { ...DEFAULT_MODEL },
    sessionFile,
    ...overrides,
  }
}

export function createManagerDescriptor(rootDir: string, overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  const agentId = overrides.agentId ?? overrides.managerId ?? 'manager'
  return createAgentDescriptor({
    agentId,
    role: 'manager',
    managerId: overrides.managerId ?? agentId,
    displayName: overrides.displayName ?? 'Manager',
    rootDir,
    sessionFile: overrides.sessionFile ?? join(rootDir, 'sessions', `${agentId}.jsonl`),
    ...overrides,
  })
}

export function createWorkerDescriptor(
  rootDir: string,
  managerId = 'manager',
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  const agentId = overrides.agentId ?? 'worker-1'
  return createAgentDescriptor({
    agentId,
    role: 'worker',
    managerId,
    displayName: overrides.displayName ?? agentId,
    rootDir,
    sessionFile: overrides.sessionFile ?? join(rootDir, 'sessions', `${agentId}.jsonl`),
    ...overrides,
  })
}

export interface AppendSessionConversationMessageOptions {
  role?: ConversationMessageEvent['role']
  source?: ConversationMessageEvent['source']
  timestamp?: string
  transcriptText?: string
}

export function appendSessionConversationMessage(
  sessionFile: string,
  agentId: string,
  text: string,
  options: AppendSessionConversationMessageOptions = {},
): void {
  const role = options.role ?? 'assistant'
  const source = options.source ?? 'speak_to_user'
  const timestamp = options.timestamp ?? DEFAULT_TIMESTAMP
  const transcriptText = options.transcriptText ?? 'seed'
  const sessionManager = SessionManager.open(sessionFile)

  sessionManager.appendMessage({
    role,
    content: [{ type: 'text', text: transcriptText }],
  } as never)
  sessionManager.appendCustomEntry('swarm_conversation_entry', {
    type: 'conversation_message',
    agentId,
    role,
    text,
    timestamp,
    source,
  } satisfies ConversationMessageEvent)
}
