import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  BROWSER_AUTOMATION_OPERATIONS,
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
  isConversationMessageSource,
  isUserVisibleAssistantConversationMessage,
  SESSION_AUDIT_ENTRY_CATEGORIES,
  WS_REQUEST_CONTRACT_TYPES,
  WS_REQUEST_CONTRACTS,
} from '../index.js'
import type {
  AgentDescriptor,
  ConversationMessageEvent,
  ExternalThreadMessageContext,
  ExternalThreadInfo,
  CliCapabilities,
  CliRunResult,
  CliSessionCompactionResult,
  CliWsCommand,
  ClientCommand,
  CollaborationBootstrapEvent,
  CollaborationChannel,
  CollaborationCategory,
  CollaborationServerEvent,
  ForgeModelCatalog,
  ManagerProfile,
  MessageChannel,
  ResolvedSpecialistDefinition,
  ServerEvent,
  SessionAuditPageResponse,
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
  'browser_host_register',
  'browser_host_hydrate',
  'browser_host_focus',
  'browser_host_response',
  'browser_host_state_report',
  'browser_panel_reveal_acknowledge',
  'browser_tab_open',
  'browser_tab_activate',
  'browser_tab_close',
  'browser_tab_resize',
  'browser_recording_start',
  'browser_recording_stop',
  'api_proxy',
  'kill_agent',
  'stop_all_agents',
  'create_manager',
  'create_repository_project',
  'cancel_repository_project_creation',
  'delete_manager',
  'update_profile_default_model',
  'update_manager_model',
  'update_manager_cwd',
  'update_session_model',
  'create_session',
  'stop_session',
  'resume_session',
  'hydrate_archive_last_used',
  'archive_session',
  'restore_session',
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
  'get_project_agent_sharing',
  'set_project_agent_sharing',
  'get_project_agent_external_directory',
  'fork_session',
  'clear_session',
  'pin_message',
  'clear_all_pins',
  'merge_session_memory',
  'get_session_workers',
  'list_directories',
  'validate_directory',
  'create_directory',
  'pick_directory',
  'rename_profile',
  'archive_profile',
  'restore_profile',
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
  'browser_host_register',
  'browser_host_hydrate',
  'browser_host_state_report',
  'browser_panel_reveal_acknowledge',
  'browser_tab_open',
  'browser_tab_activate',
  'browser_tab_close',
  'browser_tab_resize',
  'browser_recording_start',
  'browser_recording_stop',
  'api_proxy',
  'stop_all_agents',
  'hydrate_archive_last_used',
  'create_manager',
  'create_repository_project',
  'cancel_repository_project_creation',
  'delete_manager',
  'update_profile_default_model',
  'update_manager_model',
  'update_manager_cwd',
  'update_session_model',
  'create_session',
  'stop_session',
  'resume_session',
  'archive_session',
  'restore_session',
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
  'get_project_agent_sharing',
  'set_project_agent_sharing',
  'get_project_agent_external_directory',
  'fork_session',
  'clear_session',
  'merge_session_memory',
  'get_session_workers',
  'list_directories',
  'validate_directory',
  'create_directory',
  'pick_directory',
  'rename_profile',
  'archive_profile',
  'restore_profile',
  'reorder_profiles',
  'mark_unread',
  'mark_all_read',
] as const satisfies readonly RequestIdCommandType[]

const model = { provider: 'openai-codex', modelId: 'gpt-5.4', thinkingLevel: 'xhigh' }
const now = '2026-05-05T00:00:00.000Z'

const cliCapabilities = {
  protocolVersion: 1,
  minCliVersion: '0.1.0',
  available: true,
  runtimeTarget: 'builder',
  features: {
    bearerAuth: true,
    headlessWs: true,
    cliSourceContext: true,
    cliSessionMetadata: true,
    choiceOwnerLookup: true,
    activeToolSnapshot: true,
    projectAgentRunTarget: true,
    sessionTranscript: true,
    sessionCompaction: true,
    builderRuntimeOnly: true,
  },
} satisfies CliCapabilities

const cliCommand = {
  type: 'subscribe_headless',
  requestId: 'request-cli-0',
  agentId: 'agent-1',
} satisfies CliWsCommand

const cliRunResult = {
  status: 'success',
  sessionAgentId: 'agent-1',
  profileId: 'profile-1',
  projectAgentHandle: null,
  finalMessage: 'Done',
  blocked: null,
  timedOut: false,
  durationMs: 100,
} satisfies CliRunResult

const cliCompactionResult = {
  action: 'smart_compact',
  sessionAgentId: 'agent-1',
  profileId: 'profile-1',
  outcome: 'not_reduced',
  compacted: false,
  reason: 'runtime_aborted',
  customInstructionsProvided: false,
  completedAt: now,
} satisfies CliSessionCompactionResult

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

const auditPage = {
  sessionAgentId: agent.agentId,
  manifest: {
    sessionAgentId: agent.agentId,
    sessionRelativePath: 'session.jsonl',
    sessionBytes: 100,
    workers: [],
  },
  scope: 'session',
  sourceId: 'session',
  sourceKind: 'canonical_session_jsonl',
  order: 'asc',
  limit: 100,
  items: [],
  page: {
    startOffset: 0,
    endOffset: 0,
    sourceBytes: 100,
    scannedLines: 0,
    scannedBytes: 0,
    returnedItems: 0,
    scanLimited: false,
  },
  hasMore: false,
} satisfies SessionAuditPageResponse

const codexExternalThread = {
  type: 'codex_app_server',
  persisted: true,
  createdByMention: true,
  threadId: 'codex-thread-1',
} satisfies ExternalThreadInfo

const codexSidecar = {
  agentId: 'agent-1--codex',
  managerId: agent.agentId,
  displayName: 'Codex',
  role: 'worker',
  status: 'idle',
  createdAt: now,
  updatedAt: now,
  cwd: agent.cwd,
  model: {
    provider: 'codex-app-server',
    modelId: 'app-server',
    thinkingLevel: 'none',
  },
  sessionFile: '/tmp/workers/agent-1--codex.jsonl',
  profileId: profile.profileId,
  externalThread: codexExternalThread,
} satisfies AgentDescriptor

const codexParentCardContext = {
  type: 'codex_app_server',
  sidecarAgentId: codexSidecar.agentId,
  requestId: 'req-1',
  turnCorrelationId: 'turn-1',
  status: 'sent',
  promptPreview: 'hello',
  excludeFromModelContext: true,
} satisfies ExternalThreadMessageContext

const codexParentCard = {
  type: 'conversation_message',
  agentId: agent.agentId,
  role: 'system',
  text: 'Sent to Codex',
  timestamp: now,
  source: 'system',
  externalThreadContext: codexParentCardContext,
} satisfies ConversationMessageEvent

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
    type: 'headless_ready',
    serverTime: now,
    capabilities: cliCapabilities,
    subscribed: { agentId: agent.agentId },
    targetAgent: agent,
    profile,
    pendingChoices: [],
    workers: [],
    activeTools: [],
    status: { agentId: agent.agentId, status: 'idle', pendingCount: 0 },
  },
  { type: 'session_active_tools_snapshot', sessionAgentId: agent.agentId, activeTools: [], requestId: 'request-cli-1' },
  { type: 'cli_request_success', requestId: 'request-cli-2', commandType: 'subscribe_headless' },
  {
    type: 'cli_request_error',
    requestId: 'request-cli-3',
    commandType: 'cli_send_message',
    code: 'bad_request',
    message: 'Bad request',
  },
  {
    type: 'collab_bootstrap',
    currentUser: { userId: 'user-1', email: 'user@example.com', name: 'User', role: 'admin', disabled: false },
    workspace: null,
    categories: [category],
    channels: [{ ...channel, readState: { channelId: channel.channelId, lastReadMessageSeq: 0, unreadCount: 0 } }],
  },
  { type: 'conversation_message', agentId: agent.agentId, role: 'assistant', text: 'hello', timestamp: now, source: 'speak_to_user' },
  { type: 'conversation_message', agentId: agent.agentId, role: 'assistant', text: 'hello', timestamp: now, source: 'assistant_output' },
  { type: 'agent_status', agentId: agent.agentId, status: 'idle', pendingCount: 0 },
  { type: 'profiles_snapshot', profiles: [profile] },
  { type: 'unread_notification', agentId: agent.agentId, reason: 'message', sessionAgentId: agent.agentId },
  { type: 'manager_created', manager: agent, requestId: 'request-1' },
  {
    type: 'repository_project_creation_progress',
    requestId: 'request-repo-1',
    stage: 'cloning',
    percent: 40,
  },
  {
    type: 'repository_project_created',
    manager: agent,
    repositoryPath: '/tmp/repo',
    requestId: 'request-repo-1',
  },
  { type: 'repository_project_creation_cancelled', requestId: 'request-repo-2' },
  {
    type: 'repository_project_creation_cancel_result',
    requestId: 'request-repo-3',
    operationRequestId: 'request-repo-2',
    accepted: true,
    tooLate: false,
  },
  { type: 'manager_deleted', managerId: agent.agentId, terminatedWorkerIds: [], requestId: 'request-2' },
  { type: 'session_created', profile, sessionAgent: agent, requestId: 'request-2' },
  { type: 'archive_last_used_hydrated', scannedSessionCount: 1, hydratedSessionCount: 1, requestId: 'request-hydrate-archive-last-used' },
  { type: 'session_archived', agentId: agent.agentId, profileId: profile.profileId, archivedAt: now, requestId: 'request-archive-session' },
  { type: 'session_restored', agentId: agent.agentId, profileId: profile.profileId, openAgentId: agent.agentId, requestId: 'request-restore-session' },
  { type: 'profile_archived', profileId: profile.profileId, archivedAt: now, requestId: 'request-archive-profile' },
  { type: 'profile_restored', profileId: profile.profileId, openAgentId: agent.agentId, requestId: 'request-restore-profile' },
  { type: 'session_project_agent_updated', agentId: agent.agentId, profileId: profile.profileId, projectAgent: null },
  { type: 'session_workers_snapshot', sessionAgentId: agent.agentId, workers: [], requestId: 'request-3' },
  {
    type: 'session_plan_snapshot',
    sessionAgentId: agent.agentId,
    profileId: profile.profileId,
    revision: 1,
    updatedAt: now,
    plan: [{ step: 'Verify representative event', status: 'in_progress' }],
    requestId: 'request-plan-snapshot',
  },
  {
    type: 'plan_summary',
    id: 'plan-summary-1',
    agentId: agent.agentId,
    timestamp: now,
    revision: 1,
    updatedAt: now,
    plan: [{ step: 'Verify representative event', status: 'completed' }],
  },
  { type: 'directories_listed', path: '/tmp', directories: [], requestId: 'request-4' },
  { type: 'directory_created', path: '/tmp/folder', parentPath: '/tmp', name: 'folder', requestId: 'request-4b' },
  { type: 'prompt_changed', category: 'archetype', promptId: 'default', layer: 'builtin', action: 'saved' },
  { type: 'terminal_created', sessionAgentId: agent.agentId, terminal },
  { type: 'specialist_roster_changed', profileId: profile.profileId, specialistIds: [], updatedAt: now },
  { type: 'model_cache_visualization_settings_changed', enabled: false, updatedAt: now },
  { type: 'model_config_changed', updatedAt: now },
  { type: 'api_proxy_response', requestId: 'request-4', status: 200, body: '{}' },
  { type: 'message_pinned', agentId: agent.agentId, messageId: 'message-1', pinned: true, timestamp: now },
  { type: 'error', code: 'bad_request', message: 'Bad request', requestId: 'request-5' },
] as const satisfies readonly ServerEvent[]

const requestIdCommands = [
  { type: 'browser_host_register', requestId: 'browser-register-request-1', registration: { hostId: 'host-1', clientInstanceId: 'renderer-1', registeredAt: now, capabilities: { supportedOperations: BROWSER_AUTOMATION_OPERATIONS, electronVersion: '1', chromiumVersion: '1', playwrightVersion: '1', maxResponseBytes: 1024, supportsSandboxedWebviews: true, supportsCapturePage: true, supportsRecording: true } } },
  { type: 'browser_host_hydrate', requestId: 'browser-hydrate-request-1', hostId: 'host-1', hostGeneration: 1 },
  { type: 'browser_host_state_report', requestId: 'browser-state-request-1', hostId: 'host-1', hostGeneration: 1, sessions: [] },
  { type: 'browser_panel_reveal_acknowledge', requestId: 'browser-reveal-request-1', hostId: 'host-1', hostGeneration: 1, sessionAgentId: agent.agentId, profileId: profile.profileId, tabId: 'tab-1', sequence: 1 },
  { type: 'browser_tab_open', requestId: 'browser-request-1', sessionAgentId: agent.agentId, profileId: profile.profileId },
  { type: 'browser_tab_activate', requestId: 'browser-request-2', sessionAgentId: agent.agentId, tabId: 'tab-1' },
  { type: 'browser_tab_close', requestId: 'browser-request-3', sessionAgentId: agent.agentId, tabId: 'tab-1' },
  { type: 'browser_tab_resize', requestId: 'browser-request-4', sessionAgentId: agent.agentId, tabId: 'tab-1', viewport: { mode: 'fill' } },
  { type: 'browser_recording_start', requestId: 'browser-request-5', sessionAgentId: agent.agentId, tabId: 'tab-1' },
  { type: 'browser_recording_stop', requestId: 'browser-request-6', sessionAgentId: agent.agentId, tabId: 'tab-1', recordingId: 'recording-1' },
  { type: 'api_proxy', requestId: 'request-1', method: 'GET', path: '/api/test' },
  { type: 'stop_all_agents', managerId: agent.agentId, requestId: 'request-2' },
  { type: 'hydrate_archive_last_used', requestId: 'request-hydrate-archive-last-used' },
  { type: 'create_manager', name: 'Manager', cwd: '/tmp', model: 'pi-5.4', requestId: 'request-3' },
  {
    type: 'create_repository_project',
    name: 'Cloned',
    repositoryUrl: 'https://github.com/org/repo.git',
    repositoryBasePath: '/tmp',
    repositoryFolder: 'repo',
    modelSelection: { provider: 'openai-codex', modelId: 'gpt-5.4' },
    requestId: 'request-3b',
  },
  {
    type: 'cancel_repository_project_creation',
    operationRequestId: 'request-3b',
    requestId: 'request-3c',
  },
  { type: 'delete_manager', managerId: agent.agentId, requestId: 'request-4' },
  { type: 'update_profile_default_model', profileId: profile.profileId, model: 'pi-5.4', requestId: 'request-5' },
  { type: 'update_manager_model', managerId: agent.agentId, model: 'pi-5.4', requestId: 'request-6' },
  { type: 'update_manager_cwd', managerId: agent.agentId, cwd: '/tmp', requestId: 'request-7' },
  { type: 'update_session_model', sessionAgentId: agent.agentId, mode: 'inherit', requestId: 'request-8' },
  { type: 'create_session', profileId: profile.profileId, requestId: 'request-9' },
  { type: 'stop_session', agentId: agent.agentId, requestId: 'request-10' },
  { type: 'resume_session', agentId: agent.agentId, requestId: 'request-11' },
  { type: 'archive_session', agentId: agent.agentId, requestId: 'request-archive-session' },
  { type: 'restore_session', agentId: agent.agentId, requestId: 'request-restore-session' },
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
  { type: 'get_project_agent_sharing', agentId: agent.agentId, requestId: 'request-21a' },
  { type: 'set_project_agent_sharing', agentId: agent.agentId, targetProfileIds: [profile.profileId], requestId: 'request-21b' },
  { type: 'get_project_agent_external_directory', requestId: 'request-21c' },
  { type: 'fork_session', sourceAgentId: agent.agentId, requestId: 'request-22' },
  { type: 'clear_session', agentId: agent.agentId, requestId: 'request-23' },
  { type: 'merge_session_memory', agentId: agent.agentId, requestId: 'request-24' },
  { type: 'get_session_workers', sessionAgentId: agent.agentId, requestId: 'request-25' },
  { type: 'list_directories', path: '/tmp', requestId: 'request-26' },
  { type: 'validate_directory', path: '/tmp', requestId: 'request-27' },
  { type: 'create_directory', parentPath: '/tmp', name: 'folder', requestId: 'request-27b' },
  { type: 'pick_directory', defaultPath: '/tmp', requestId: 'request-28' },
  { type: 'rename_profile', profileId: profile.profileId, displayName: 'Renamed', requestId: 'request-29' },
  { type: 'archive_profile', profileId: profile.profileId, requestId: 'request-archive-profile' },
  { type: 'restore_profile', profileId: profile.profileId, requestId: 'request-restore-profile' },
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
    expect(isConversationMessageSource('assistant_output')).toBe(true)
    expect(isUserVisibleAssistantConversationMessage({
      type: 'conversation_message',
      agentId: agent.agentId,
      role: 'assistant',
      text: 'projected',
      timestamp: now,
      source: 'assistant_output',
    })).toBe(true)
  })

  it('exports minimal WebSocket request contracts from the root barrel', () => {
    expect(WS_REQUEST_CONTRACT_TYPES).toEqual([
      'browser_host_register',
      'browser_host_hydrate',
      'browser_panel_reveal_acknowledge',
      'browser_host_state_report',
      'browser_recording_start',
      'browser_recording_stop',
      'browser_tab_open',
      'browser_tab_activate',
      'browser_tab_close',
      'browser_tab_resize',
      'list_directories',
      'validate_directory',
      'create_directory',
      'pick_directory',
      'get_session_workers',
      'get_conversation_page',
      'rename_profile',
      'archive_profile',
      'restore_profile',
      'rename_session',
      'pin_session',
      'update_session_model',
      'fork_session',
      'merge_session_memory',
      'update_profile_default_model',
      'update_manager_model',
      'update_manager_cwd',
      'stop_all_agents',
      'create_manager',
      'create_repository_project',
      'cancel_repository_project_creation',
      'delete_manager',
      'create_session',
      'stop_session',
      'resume_session',
      'hydrate_archive_last_used',
      'archive_session',
      'restore_session',
      'delete_session',
      'clear_session',
      'set_session_project_agent',
      'get_project_agent_config',
      'list_project_agent_references',
      'get_project_agent_reference',
      'set_project_agent_reference',
      'delete_project_agent_reference',
      'request_project_agent_recommendations',
      'get_project_agent_sharing',
      'set_project_agent_sharing',
      'get_project_agent_external_directory',
    ])
    expect(WS_REQUEST_CONTRACTS.map((contract) => contract.commandType)).toEqual(WS_REQUEST_CONTRACT_TYPES)
    expect(WS_REQUEST_CONTRACTS.every((contract) => contract.requestId.ui === 'required')).toBe(true)
    expect(
      WS_REQUEST_CONTRACTS.every((contract) =>
        contract.commandType === 'create_repository_project' ||
        contract.commandType === 'get_conversation_page' ||
        contract.commandType.startsWith('browser_')
          ? contract.requestId.wire === 'required'
          : contract.requestId.wire === 'optional',
      ),
    ).toBe(true)
    expect(getWsRequestContract('create_repository_project')).toMatchObject({
      requestId: { ui: 'required', wire: 'required' },
    })
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
    expect(getWsRequestContract('get_conversation_page')).toMatchObject({
      commandType: 'get_conversation_page',
      resultFamily: 'conversation_page',
      requestId: { ui: 'required', wire: 'required' },
      successEvents: ['conversation_page'],
      errorCodeFragments: ['get_conversation_page'],
    })
    expect(getWsRequestContract('rename_profile')).toMatchObject({
      commandType: 'rename_profile',
      resultFamily: 'profile_rename',
      successEvents: ['profile_renamed'],
      errorCodeFragments: ['rename_profile'],
    })
    expect(getWsRequestContract('archive_profile')).toMatchObject({
      commandType: 'archive_profile',
      resultFamily: 'archive_profile_result',
      successEvents: ['profile_archived'],
      errorCodeFragments: ['archive_profile'],
    })
    expect(getWsRequestContract('restore_profile')).toMatchObject({
      commandType: 'restore_profile',
      resultFamily: 'restore_profile_result',
      successEvents: ['profile_restored'],
      errorCodeFragments: ['restore_profile'],
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
    expect(getWsRequestContract('merge_session_memory')).toMatchObject({
      commandType: 'merge_session_memory',
      resultFamily: 'session_memory_merge',
      successEvents: ['session_memory_merged'],
      errorCodeFragments: ['merge_session_memory'],
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
    expect(getWsRequestContract('stop_all_agents')).toMatchObject({
      commandType: 'stop_all_agents',
      resultFamily: 'stop_all_agents',
      successEvents: ['stop_all_agents_result'],
      errorCodeFragments: ['stop_all_agents'],
    })
    expect(getWsRequestContract('create_manager')).toMatchObject({
      commandType: 'create_manager',
      resultFamily: 'manager_create',
      successEvents: ['manager_created'],
      errorCodeFragments: ['create_manager'],
    })
    expect(getWsRequestContract('delete_manager')).toMatchObject({
      commandType: 'delete_manager',
      resultFamily: 'manager_delete',
      successEvents: ['manager_deleted'],
      errorCodeFragments: ['delete_manager'],
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
    expect(getWsRequestContract('archive_session')).toMatchObject({
      commandType: 'archive_session',
      resultFamily: 'archive_session_result',
      successEvents: ['session_archived'],
      errorCodeFragments: ['archive_session', 'ARCHIVE_DEFAULT_SESSION_NOT_ALLOWED'],
    })
    expect(getWsRequestContract('restore_session')).toMatchObject({
      commandType: 'restore_session',
      resultFamily: 'restore_session_result',
      successEvents: ['session_restored'],
      errorCodeFragments: ['restore_session', 'ARCHIVE_RESTORE_PARENT_PROJECT_REQUIRED'],
    })
    expect(getWsRequestContract('delete_session')).toMatchObject({
      commandType: 'delete_session',
      resultFamily: 'session_delete',
      successEvents: ['session_deleted'],
      errorCodeFragments: ['delete_session'],
    })
    expect(getWsRequestContract('set_session_project_agent')).toMatchObject({
      commandType: 'set_session_project_agent',
      resultFamily: 'session_project_agent_update',
      successEvents: ['session_project_agent_updated'],
      errorCodeFragments: ['set_session_project_agent'],
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
    expect(getWsRequestContract('set_project_agent_reference')).toMatchObject({
      commandType: 'set_project_agent_reference',
      resultFamily: 'project_agent_reference_save',
      successEvents: ['project_agent_reference_saved'],
      errorCodeFragments: ['set_project_agent_reference'],
    })
    expect(getWsRequestContract('delete_project_agent_reference')).toMatchObject({
      commandType: 'delete_project_agent_reference',
      resultFamily: 'project_agent_reference_delete',
      successEvents: ['project_agent_reference_deleted'],
      errorCodeFragments: ['delete_project_agent_reference'],
    })
    expect(getWsRequestContract('request_project_agent_recommendations')).toMatchObject({
      commandType: 'request_project_agent_recommendations',
      resultFamily: 'project_agent_recommendations',
      successEvents: ['project_agent_recommendations'],
      errorCodeFragments: ['project_agent_recommendations'],
    })
  })

  it('exports representative collaboration, terminal, and specialist contracts from the root barrel', () => {
    const collabEvent: CollaborationBootstrapEvent = serverEventsByLeafModule[5]
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
    expect(codexSidecar.externalThread?.threadId).toBe('codex-thread-1')
    expect(codexParentCard.externalThreadContext?.excludeFromModelContext).toBe(true)
  })

  it('exports session audit protocol contracts from the root barrel', () => {
    expect(SESSION_AUDIT_ENTRY_CATEGORIES).toContain('malformed')
    expect(auditPage.sourceKind).toBe('canonical_session_jsonl')
  })

  it('exports CLI protocol contracts from the root barrel', () => {
    const channel: MessageChannel = 'cli'

    expect(channel).toBe('cli')
    expect(cliCapabilities.features.headlessWs).toBe(true)
    expect(cliCapabilities.features.sessionCompaction).toBe(true)
    expect(cliCommand.type).toBe('subscribe_headless')
    expect(cliRunResult.status).toBe('success')
    expect(cliCompactionResult.outcome).toBe('not_reduced')
  })

  it('pins current ClientCommand discriminator coverage', () => {
    expectTypeOf<Exclude<ClientCommandType, (typeof ALL_CLIENT_COMMAND_TYPES)[number]>>().toEqualTypeOf<never>()
    expectTypeOf<Exclude<(typeof ALL_CLIENT_COMMAND_TYPES)[number], ClientCommandType>>().toEqualTypeOf<never>()

    expect(ALL_CLIENT_COMMAND_TYPES).toHaveLength(71)
    expect(new Set(ALL_CLIENT_COMMAND_TYPES).size).toBe(ALL_CLIENT_COMMAND_TYPES.length)
    expect(ALL_CLIENT_COMMAND_TYPES).toContain('collab_user_message')
    expect(ALL_CLIENT_COMMAND_TYPES).toContain('api_proxy')
    expect(ALL_CLIENT_COMMAND_TYPES).toContain('mark_all_read')
  })

  it('pins request-id-bearing ClientCommand variants and proves requestId payloads are accepted', () => {
    expectTypeOf<Exclude<RequestIdCommandType, (typeof REQUEST_ID_COMMAND_TYPES)[number]>>().toEqualTypeOf<never>()
    expectTypeOf<Exclude<(typeof REQUEST_ID_COMMAND_TYPES)[number], RequestIdCommandType>>().toEqualTypeOf<never>()

    expect(REQUEST_ID_COMMAND_TYPES).toHaveLength(53)
    expect(new Set(REQUEST_ID_COMMAND_TYPES).size).toBe(REQUEST_ID_COMMAND_TYPES.length)
    expect(requestIdCommands.map((command) => command.type)).toEqual(REQUEST_ID_COMMAND_TYPES)
    expect(requestIdCommands.every((command) => typeof command.requestId === 'string')).toBe(true)
  })

  it('keeps representative leaf-module events assignable to ServerEvent', () => {
    expect(serverEventsByLeafModule.map((event) => event.type)).toEqual([
      'ready',
      'headless_ready',
      'session_active_tools_snapshot',
      'cli_request_success',
      'cli_request_error',
      'collab_bootstrap',
      'conversation_message',
      'conversation_message',
      'agent_status',
      'profiles_snapshot',
      'unread_notification',
      'manager_created',
      'repository_project_creation_progress',
      'repository_project_created',
      'repository_project_creation_cancelled',
      'repository_project_creation_cancel_result',
      'manager_deleted',
      'session_created',
      'archive_last_used_hydrated',
      'session_archived',
      'session_restored',
      'profile_archived',
      'profile_restored',
      'session_project_agent_updated',
      'session_workers_snapshot',
      'session_plan_snapshot',
      'plan_summary',
      'directories_listed',
      'directory_created',
      'prompt_changed',
      'terminal_created',
      'specialist_roster_changed',
      'model_cache_visualization_settings_changed',
      'model_config_changed',
      'api_proxy_response',
      'message_pinned',
      'error',
    ])
  })
})
