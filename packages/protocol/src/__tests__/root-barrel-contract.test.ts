import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  CATALOG_FAMILY_IDS,
  FORGE_MODEL_CATALOG,
  getCatalogFamily,
  getCatalogModel,
  getCatalogProvider,
  getCreateManagerFamilies,
  getSpecialistFamilies,
  inferCatalogFamily,
  getWsRequestContract,
  isCatalogModelId,
  WS_REQUEST_CONTRACT_TYPES,
  WS_REQUEST_CONTRACTS,
} from '../index.js'
import type {
  AgentDescriptor,
  ClientCommand,
  CollaborationBootstrapEvent,
  CollaborationChannel,
  CollaborationCategory,
  CollaborationServerEvent,
  ForgeModelCatalog,
  ManagerProfile,
  ResolvedSpecialistDefinition,
  ServerEvent,
  TerminalDescriptor,
  TerminalMeta,
} from '../index.js'

type ClientCommandType = ClientCommand['type']

const ALL_CLIENT_COMMAND_TYPES = [
  'subscribe',
  'user_message',
  'collab_bootstrap',
  'collab_subscribe_channel',
  'collab_unsubscribe_channel',
  'collab_user_message',
  'collab_mark_channel_read',
  'collab_choice_response',
  'collab_choice_cancel',
  'collab_pin_message',
  'api_proxy',
  'kill_agent',
  'stop_all_agents',
  'create_manager',
  'delete_manager',
  'update_profile_default_model',
  'update_manager_model',
  'update_manager_cwd',
  'update_session_model',
  'create_session',
  'stop_session',
  'resume_session',
  'delete_session',
  'rename_session',
  'pin_session',
  'set_session_project_agent',
  'get_project_agent_config',
  'list_project_agent_references',
  'get_project_agent_reference',
  'set_project_agent_reference',
  'delete_project_agent_reference',
  'request_project_agent_recommendations',
  'fork_session',
  'clear_session',
  'pin_message',
  'clear_all_pins',
  'merge_session_memory',
  'get_session_workers',
  'list_directories',
  'validate_directory',
  'pick_directory',
  'rename_profile',
  'reorder_profiles',
  'choice_response',
  'choice_cancel',
  'mark_unread',
  'mark_all_read',
  'ping',
] as const satisfies readonly ClientCommandType[]

type RequestIdCommand = Extract<ClientCommand, { requestId?: string } | { requestId: string }>
type RequestIdCommandType = RequestIdCommand['type']

const REQUEST_ID_COMMAND_TYPES = [
  'api_proxy',
  'stop_all_agents',
  'create_manager',
  'delete_manager',
  'update_profile_default_model',
  'update_manager_model',
  'update_manager_cwd',
  'update_session_model',
  'create_session',
  'stop_session',
  'resume_session',
  'delete_session',
  'rename_session',
  'pin_session',
  'set_session_project_agent',
  'get_project_agent_config',
  'list_project_agent_references',
  'get_project_agent_reference',
  'set_project_agent_reference',
  'delete_project_agent_reference',
  'request_project_agent_recommendations',
  'fork_session',
  'clear_session',
  'merge_session_memory',
  'get_session_workers',
  'list_directories',
  'validate_directory',
  'pick_directory',
  'rename_profile',
  'reorder_profiles',
  'mark_unread',
  'mark_all_read',
] as const satisfies readonly RequestIdCommandType[]

const model = { provider: 'openai-codex', modelId: 'gpt-5.4', thinkingLevel: 'xhigh' }
const now = '2026-05-05T00:00:00.000Z'

const profile = {
  profileId: 'profile-1',
  displayName: 'Profile',
  defaultSessionAgentId: 'agent-1',
  defaultModel: model,
  createdAt: now,
  updatedAt: now,
} satisfies ManagerProfile

const agent = {
  agentId: 'agent-1',
  managerId: 'agent-1',
  displayName: 'Agent',
  role: 'manager',
  status: 'idle',
  createdAt: now,
  updatedAt: now,
  cwd: '/tmp',
  model,
  sessionFile: '/tmp/session.jsonl',
  profileId: profile.profileId,
} satisfies AgentDescriptor

const terminal = {
  terminalId: 'terminal-1',
  sessionAgentId: agent.agentId,
  profileId: profile.profileId,
  name: 'Terminal',
  shell: '/bin/zsh',
  cwd: '/tmp',
  cols: 80,
  rows: 24,
  state: 'running',
  pid: 123,
  exitCode: null,
  exitSignal: null,
  recoveredFromPersistence: false,
  createdAt: now,
  updatedAt: now,
} satisfies TerminalDescriptor

const channel = {
  channelId: 'channel-1',
  workspaceId: 'workspace-1',
  sessionAgentId: agent.agentId,
  name: 'General',
  slug: 'general',
  aiEnabled: true,
  activeSelectedSpecialistHandles: [],
  position: 0,
  archived: false,
  lastMessageSeq: 0,
  createdAt: now,
  updatedAt: now,
} satisfies CollaborationChannel

const category = {
  categoryId: 'category-1',
  workspaceId: 'workspace-1',
  name: 'Category',
  defaultSelectedSpecialistHandles: [],
  position: 0,
  createdAt: now,
  updatedAt: now,
} satisfies CollaborationCategory

const serverEventsByLeafModule = [
  { type: 'ready', serverTime: now, subscribedAgentId: agent.agentId },
  {
    type: 'collab_bootstrap',
    currentUser: { userId: 'user-1', email: 'user@example.com', name: 'User', role: 'admin', disabled: false },
    workspace: null,
    categories: [category],
    channels: [{ ...channel, readState: { channelId: channel.channelId, lastReadMessageSeq: 0, unreadCount: 0 } }],
  },
  { type: 'conversation_message', agentId: agent.agentId, role: 'assistant', text: 'hello', timestamp: now, source: 'speak_to_user' },
  { type: 'agent_status', agentId: agent.agentId, status: 'idle', pendingCount: 0 },
  { type: 'profiles_snapshot', profiles: [profile] },
  { type: 'unread_notification', agentId: agent.agentId, reason: 'message', sessionAgentId: agent.agentId },
  { type: 'manager_created', manager: agent, requestId: 'request-1' },
  { type: 'session_created', profile, sessionAgent: agent, requestId: 'request-2' },
  { type: 'session_project_agent_updated', agentId: agent.agentId, profileId: profile.profileId, projectAgent: null },
  { type: 'session_workers_snapshot', sessionAgentId: agent.agentId, workers: [], requestId: 'request-3' },
  { type: 'directories_listed', path: '/tmp', directories: [], requestId: 'request-4' },
  { type: 'telegram_status', state: 'disabled', enabled: false, updatedAt: now },
  {
    type: 'playwright_discovery_settings_updated',
    settings: {
      enabled: false,
      effectiveEnabled: false,
      source: 'default',
      envOverride: null,
      scanRoots: [],
      pollIntervalMs: 1_000,
      socketProbeTimeoutMs: 100,
      staleSessionThresholdMs: 1_000,
      updatedAt: now,
    },
  },
  { type: 'prompt_changed', category: 'archetype', promptId: 'default', layer: 'builtin', action: 'saved' },
  { type: 'terminal_created', sessionAgentId: agent.agentId, terminal },
  { type: 'specialist_roster_changed', profileId: profile.profileId, specialistIds: [], updatedAt: now },
  { type: 'model_config_changed', updatedAt: now },
  { type: 'api_proxy_response', requestId: 'request-4', status: 200, body: '{}' },
  { type: 'message_pinned', agentId: agent.agentId, messageId: 'message-1', pinned: true, timestamp: now },
  { type: 'error', code: 'bad_request', message: 'Bad request', requestId: 'request-5' },
] as const satisfies readonly ServerEvent[]

const requestIdCommands = [
  { type: 'api_proxy', requestId: 'request-1', method: 'GET', path: '/api/test' },
  { type: 'stop_all_agents', managerId: agent.agentId, requestId: 'request-2' },
  { type: 'create_manager', name: 'Manager', cwd: '/tmp', model: 'pi-5.4', requestId: 'request-3' },
  { type: 'delete_manager', managerId: agent.agentId, requestId: 'request-4' },
  { type: 'update_profile_default_model', profileId: profile.profileId, model: 'pi-5.4', requestId: 'request-5' },
  { type: 'update_manager_model', managerId: agent.agentId, model: 'pi-5.4', requestId: 'request-6' },
  { type: 'update_manager_cwd', managerId: agent.agentId, cwd: '/tmp', requestId: 'request-7' },
  { type: 'update_session_model', sessionAgentId: agent.agentId, mode: 'inherit', requestId: 'request-8' },
  { type: 'create_session', profileId: profile.profileId, requestId: 'request-9' },
  { type: 'stop_session', agentId: agent.agentId, requestId: 'request-10' },
  { type: 'resume_session', agentId: agent.agentId, requestId: 'request-11' },
  { type: 'delete_session', agentId: agent.agentId, requestId: 'request-12' },
  { type: 'rename_session', agentId: agent.agentId, label: 'Renamed', requestId: 'request-13' },
  { type: 'pin_session', agentId: agent.agentId, pinned: true, requestId: 'request-14' },
  { type: 'set_session_project_agent', agentId: agent.agentId, projectAgent: null, requestId: 'request-15' },
  { type: 'get_project_agent_config', agentId: agent.agentId, requestId: 'request-16' },
  { type: 'list_project_agent_references', agentId: agent.agentId, requestId: 'request-17' },
  { type: 'get_project_agent_reference', agentId: agent.agentId, fileName: 'README.md', requestId: 'request-18' },
  { type: 'set_project_agent_reference', agentId: agent.agentId, fileName: 'README.md', content: 'docs', requestId: 'request-19' },
  { type: 'delete_project_agent_reference', agentId: agent.agentId, fileName: 'README.md', requestId: 'request-20' },
  { type: 'request_project_agent_recommendations', agentId: agent.agentId, requestId: 'request-21' },
  { type: 'fork_session', sourceAgentId: agent.agentId, requestId: 'request-22' },
  { type: 'clear_session', agentId: agent.agentId, requestId: 'request-23' },
  { type: 'merge_session_memory', agentId: agent.agentId, requestId: 'request-24' },
  { type: 'get_session_workers', sessionAgentId: agent.agentId, requestId: 'request-25' },
  { type: 'list_directories', path: '/tmp', requestId: 'request-26' },
  { type: 'validate_directory', path: '/tmp', requestId: 'request-27' },
  { type: 'pick_directory', defaultPath: '/tmp', requestId: 'request-28' },
  { type: 'rename_profile', profileId: profile.profileId, displayName: 'Renamed', requestId: 'request-29' },
  { type: 'reorder_profiles', profileIds: [profile.profileId], requestId: 'request-30' },
  { type: 'mark_unread', agentId: agent.agentId, requestId: 'request-31' },
  { type: 'mark_all_read', profileId: profile.profileId, requestId: 'request-32' },
] as const satisfies readonly RequestIdCommand[]

describe('protocol root barrel contract', () => {
  it('exports model catalog constants and helpers from the root barrel', () => {
    const catalog: ForgeModelCatalog = FORGE_MODEL_CATALOG

    expect(catalog.providers['openai-codex']?.displayName).toBe('OpenAI Codex')
    expect(CATALOG_FAMILY_IDS).toContain('pi-5.4')
    expect(getCatalogProvider('openai-codex')?.providerId).toBe('openai-codex')
    expect(getCatalogFamily('pi-5.4')?.defaultModelId).toBe('gpt-5.4')
    expect(getCatalogModel('gpt-5.4', 'openai-codex')?.familyId).toBe('pi-5.4')
    expect(getCreateManagerFamilies().some((family) => family.familyId === 'pi-5.4')).toBe(true)
    expect(getSpecialistFamilies().some((family) => family.familyId === 'pi-opus')).toBe(true)
    expect(inferCatalogFamily('openai-codex', 'gpt-5.4')).toBe('pi-5.4')
    expect(isCatalogModelId('gpt-5.4')).toBe(true)
  })

  it('exports minimal WebSocket request contracts from the root barrel', () => {
    expect(WS_REQUEST_CONTRACT_TYPES).toEqual([
      'list_directories',
      'validate_directory',
      'pick_directory',
      'get_session_workers',
      'rename_profile',
      'rename_session',
      'pin_session',
      'update_session_model',
      'fork_session',
      'update_profile_default_model',
      'update_manager_model',
      'update_manager_cwd',
      'create_session',
      'stop_session',
      'resume_session',
      'delete_session',
      'clear_session',
      'get_project_agent_config',
      'list_project_agent_references',
      'get_project_agent_reference',
    ])
    expect(WS_REQUEST_CONTRACTS.map((contract) => contract.commandType)).toEqual(WS_REQUEST_CONTRACT_TYPES)
    expect(WS_REQUEST_CONTRACTS.every((contract) => contract.requestId.ui === 'required')).toBe(true)
    expect(WS_REQUEST_CONTRACTS.every((contract) => contract.requestId.wire === 'optional')).toBe(true)
    expect(getWsRequestContract('list_directories')).toMatchObject({
      commandType: 'list_directories',
      resultFamily: 'directory_listing',
      successEvents: ['directories_listed'],
      errorCodeFragments: ['list_directories'],
    })
    expect(getWsRequestContract('get_session_workers')).toMatchObject({
      commandType: 'get_session_workers',
      resultFamily: 'session_workers',
      successEvents: ['session_workers_snapshot'],
      errorCodeFragments: ['get_session_workers'],
    })
    expect(getWsRequestContract('rename_profile')).toMatchObject({
      commandType: 'rename_profile',
      resultFamily: 'profile_rename',
      successEvents: ['profile_renamed'],
      errorCodeFragments: ['rename_profile'],
    })
    expect(getWsRequestContract('rename_session')).toMatchObject({
      commandType: 'rename_session',
      resultFamily: 'session_rename',
      successEvents: ['session_renamed'],
      errorCodeFragments: ['rename_session'],
    })
    expect(getWsRequestContract('pin_session')).toMatchObject({
      commandType: 'pin_session',
      resultFamily: 'session_pin',
      successEvents: ['session_pinned'],
      errorCodeFragments: ['pin_session'],
    })
    expect(getWsRequestContract('update_session_model')).toMatchObject({
      commandType: 'update_session_model',
      resultFamily: 'session_model_update',
      successEvents: ['session_model_updated'],
      errorCodeFragments: ['update_session_model'],
    })
    expect(getWsRequestContract('fork_session')).toMatchObject({
      commandType: 'fork_session',
      resultFamily: 'session_fork',
      successEvents: ['session_forked'],
      errorCodeFragments: ['fork_session'],
    })
    expect(getWsRequestContract('update_profile_default_model')).toMatchObject({
      commandType: 'update_profile_default_model',
      resultFamily: 'profile_default_model_update',
      successEvents: ['profile_default_model_updated'],
      errorCodeFragments: ['update_profile_default_model'],
    })
    expect(getWsRequestContract('update_manager_model')).toMatchObject({
      commandType: 'update_manager_model',
      resultFamily: 'manager_model_update',
      successEvents: ['manager_model_updated'],
      errorCodeFragments: ['update_manager_model'],
    })
    expect(getWsRequestContract('update_manager_cwd')).toMatchObject({
      commandType: 'update_manager_cwd',
      resultFamily: 'manager_cwd_update',
      successEvents: ['manager_cwd_updated'],
      errorCodeFragments: ['update_manager_cwd'],
    })
    expect(getWsRequestContract('create_session')).toMatchObject({
      commandType: 'create_session',
      resultFamily: 'session_create',
      successEvents: ['session_created'],
      errorCodeFragments: ['create_session'],
    })
    expect(getWsRequestContract('clear_session')).toMatchObject({
      commandType: 'clear_session',
      resultFamily: 'session_clear',
      successEvents: ['session_cleared'],
      errorCodeFragments: ['clear_session'],
    })
    expect(getWsRequestContract('stop_session')).toMatchObject({
      commandType: 'stop_session',
      resultFamily: 'session_stop',
      successEvents: ['session_stopped'],
      errorCodeFragments: ['stop_session'],
    })
    expect(getWsRequestContract('resume_session')).toMatchObject({
      commandType: 'resume_session',
      resultFamily: 'session_resume',
      successEvents: ['session_resumed'],
      errorCodeFragments: ['resume_session'],
    })
    expect(getWsRequestContract('delete_session')).toMatchObject({
      commandType: 'delete_session',
      resultFamily: 'session_delete',
      successEvents: ['session_deleted'],
      errorCodeFragments: ['delete_session'],
    })
    expect(getWsRequestContract('get_project_agent_config')).toMatchObject({
      commandType: 'get_project_agent_config',
      resultFamily: 'project_agent_config',
      successEvents: ['project_agent_config'],
      errorCodeFragments: ['project_agent_config'],
    })
    expect(getWsRequestContract('list_project_agent_references')).toMatchObject({
      commandType: 'list_project_agent_references',
      resultFamily: 'project_agent_references',
      successEvents: ['project_agent_references'],
      errorCodeFragments: ['project_agent_references'],
    })
    expect(getWsRequestContract('get_project_agent_reference')).toMatchObject({
      commandType: 'get_project_agent_reference',
      resultFamily: 'project_agent_reference',
      successEvents: ['project_agent_reference'],
      errorCodeFragments: ['project_agent_reference'],
    })
  })

  it('exports representative collaboration, terminal, and specialist contracts from the root barrel', () => {
    const collabEvent: CollaborationBootstrapEvent = serverEventsByLeafModule[1]
    const collabServerEvent: CollaborationServerEvent = collabEvent
    const terminalMeta: TerminalMeta = {
      version: 1,
      ...terminal,
      shellArgs: [],
      checkpointSeq: 0,
      nextSeq: 1,
    }
    const specialist: ResolvedSpecialistDefinition = {
      specialistId: 'backend-specialist',
      displayName: 'Backend Specialist',
      color: 'blue',
      enabled: true,
      whenToUse: 'Backend work',
      modelId: 'gpt-5.4',
      provider: 'openai-codex',
      builtin: true,
      pinned: false,
      targetSpace: ['builder'],
      promptBody: 'Prompt',
      sourceKind: 'builtin',
      available: true,
      availabilityCode: 'ok',
      shadowsGlobal: false,
    }

    expect(collabServerEvent.type).toBe('collab_bootstrap')
    expect(terminalMeta.version).toBe(1)
    expect(specialist.targetSpace).toContain('builder')
  })

  it('pins current ClientCommand discriminator coverage', () => {
    expectTypeOf<Exclude<ClientCommandType, (typeof ALL_CLIENT_COMMAND_TYPES)[number]>>().toEqualTypeOf<never>()
    expectTypeOf<Exclude<(typeof ALL_CLIENT_COMMAND_TYPES)[number], ClientCommandType>>().toEqualTypeOf<never>()

    expect(ALL_CLIENT_COMMAND_TYPES).toHaveLength(48)
    expect(new Set(ALL_CLIENT_COMMAND_TYPES).size).toBe(ALL_CLIENT_COMMAND_TYPES.length)
    expect(ALL_CLIENT_COMMAND_TYPES).toContain('collab_user_message')
    expect(ALL_CLIENT_COMMAND_TYPES).toContain('api_proxy')
    expect(ALL_CLIENT_COMMAND_TYPES).toContain('mark_all_read')
  })

  it('pins request-id-bearing ClientCommand variants and proves requestId payloads are accepted', () => {
    expectTypeOf<Exclude<RequestIdCommandType, (typeof REQUEST_ID_COMMAND_TYPES)[number]>>().toEqualTypeOf<never>()
    expectTypeOf<Exclude<(typeof REQUEST_ID_COMMAND_TYPES)[number], RequestIdCommandType>>().toEqualTypeOf<never>()

    expect(REQUEST_ID_COMMAND_TYPES).toHaveLength(32)
    expect(new Set(REQUEST_ID_COMMAND_TYPES).size).toBe(REQUEST_ID_COMMAND_TYPES.length)
    expect(requestIdCommands.map((command) => command.type)).toEqual(REQUEST_ID_COMMAND_TYPES)
    expect(requestIdCommands.every((command) => typeof command.requestId === 'string')).toBe(true)
  })

  it('keeps representative leaf-module events assignable to ServerEvent', () => {
    expect(serverEventsByLeafModule.map((event) => event.type)).toEqual([
      'ready',
      'collab_bootstrap',
      'conversation_message',
      'agent_status',
      'profiles_snapshot',
      'unread_notification',
      'manager_created',
      'session_created',
      'session_project_agent_updated',
      'session_workers_snapshot',
      'directories_listed',
      'telegram_status',
      'playwright_discovery_settings_updated',
      'prompt_changed',
      'terminal_created',
      'specialist_roster_changed',
      'model_config_changed',
      'api_proxy_response',
      'message_pinned',
      'error',
    ])
  })
})
