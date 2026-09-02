import {
  MANAGER_MODEL_PRESETS,
  MANAGER_REASONING_LEVELS,
  type AgentSessionPurpose,
  type BrowserHostLifecycleResponse,
  type BrowserHostRegistration,
  type BrowserHostSessionStateReport,
  type BrowserViewportSetting,
  type BuilderTimelineChannelView,
  type ChoiceAnswer,
  type CodexElicitationDecision,
  type CodexElicitationPersistScope,
  type ClientCommand,
  type ConversationAttachment,
  type ConversationReplyTargetInput,
  type DeliveryMode,
  type ManagerExactModelSelection,
  type ManagerModelPreset,
  type ManagerPosture,
  type ManagerReasoningLevel,
  type SessionProjectAgentInput,
  type SessionModelUpdateMode,
  type SessionGoalControlAction,
} from '@forge/protocol'

export const RECONNECTING_SOCKET_ERROR = 'WebSocket is disconnected. Reconnecting...'
const DISCONNECTED_SOCKET_ERROR = 'WebSocket is disconnected.'

export function isSocketOpen(socket: WebSocket | null): socket is WebSocket {
  return Boolean(socket && socket.readyState === WebSocket.OPEN)
}

function requireTrimmedValue(value: string, errorMessage: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(errorMessage)
  }

  return trimmed
}

export function assertReconnectableSocket(socket: WebSocket | null): asserts socket is WebSocket {
  if (!isSocketOpen(socket)) {
    throw new Error(RECONNECTING_SOCKET_ERROR)
  }
}

export function assertConnectedSocket(socket: WebSocket | null): asserts socket is WebSocket {
  if (!isSocketOpen(socket)) {
    throw new Error(DISCONNECTED_SOCKET_ERROR)
  }
}

export function buildSubscribeCommand(
  agentId: string | null | undefined,
  conversationView: BuilderTimelineChannelView,
  subscriptionId: string,
): ClientCommand {
  return {
    type: 'subscribe',
    agentId: agentId ?? undefined,
    conversationPaging: true,
    conversationView,
    subscriptionId,
  }
}

export function buildBrowserHostRegisterCommand(requestId: string, registration: BrowserHostRegistration): ClientCommand {
  return { type: 'browser_host_register', requestId, registration }
}

export function buildBrowserHostHydrateCommand(requestId: string, hostId: string, hostGeneration: number): ClientCommand {
  return { type: 'browser_host_hydrate', requestId, hostId, hostGeneration }
}

export function buildBrowserHostFocusCommand(hostId: string, hostGeneration: number, focused: boolean): ClientCommand {
  return { type: 'browser_host_focus', hostId, hostGeneration, focused }
}

export function buildBrowserHostResponseCommand(response: Extract<ClientCommand, { type: 'browser_host_response' }>['response']): ClientCommand {
  return { type: 'browser_host_response', response }
}

export function buildBrowserHostLifecycleResponseCommand(response: BrowserHostLifecycleResponse): ClientCommand {
  return { type: 'browser_host_lifecycle_response', response }
}

export function buildBrowserHostStateReportCommand(
  requestId: string,
  hostId: string,
  hostGeneration: number,
  sessions: BrowserHostSessionStateReport[],
): ClientCommand {
  return { type: 'browser_host_state_report', requestId, hostId, hostGeneration, sessions }
}

export function buildBrowserPanelRevealAcknowledgeCommand(options: {
  requestId: string
  hostId: string
  hostGeneration: number
  sessionAgentId: string
  profileId: string
  tabId: string
  sequence: number
}): ClientCommand {
  return { type: 'browser_panel_reveal_acknowledge', ...options }
}

export function buildBrowserTabOpenCommand(
  sessionAgentId: string,
  profileId: string,
  requestId: string,
  options?: { url?: string; activate?: boolean },
): ClientCommand {
  return { type: 'browser_tab_open', requestId, sessionAgentId, profileId, ...options }
}

export function buildBrowserTabActivateCommand(sessionAgentId: string, tabId: string, requestId: string): ClientCommand {
  return { type: 'browser_tab_activate', requestId, sessionAgentId, tabId }
}

export function buildBrowserTabCloseCommand(sessionAgentId: string, tabId: string, requestId: string): ClientCommand {
  return { type: 'browser_tab_close', requestId, sessionAgentId, tabId }
}

export function buildBrowserTabResizeCommand(
  sessionAgentId: string,
  tabId: string,
  viewport: BrowserViewportSetting,
  requestId: string,
): ClientCommand {
  return { type: 'browser_tab_resize', requestId, sessionAgentId, tabId, viewport }
}

export function buildBrowserRecordingStartCommand(sessionAgentId: string, tabId: string, requestId: string): ClientCommand {
  return { type: 'browser_recording_start', requestId, sessionAgentId, tabId }
}

export function buildBrowserRecordingStopCommand(sessionAgentId: string, tabId: string, recordingId: string, requestId: string): ClientCommand {
  return { type: 'browser_recording_stop', requestId, sessionAgentId, tabId, recordingId }
}

export function buildRestartRecoveryActionCommand(
  type: 'resume_restart_recovery' | 'dismiss_restart_recovery',
): ClientCommand {
  return { type }
}

export function buildSessionGoalControlCommand(
  agentId: string,
  action: SessionGoalControlAction,
): ClientCommand {
  return { type: 'session_goal_control', agentId, ...action }
}

export function buildMarkUnreadCommand(agentId: string): ClientCommand {
  return {
    type: 'mark_unread',
    agentId,
  }
}

export function buildMarkAllReadCommand(profileId: string): ClientCommand {
  return {
    type: 'mark_all_read',
    profileId,
  }
}

export function buildDismissSessionAttentionCommand(
  attentionIds: string[],
  requestId: string,
): ClientCommand {
  return {
    type: 'dismiss_session_attention',
    attentionIds,
    requestId,
  }
}

export function buildUserMessageCommand(input: {
  text: string
  agentId: string
  delivery?: DeliveryMode
  attachments?: ConversationAttachment[]
  replyTo?: ConversationReplyTargetInput
  clientRequestId?: string
}): ClientCommand {
  return {
    type: 'user_message',
    text: input.text,
    attachments: input.attachments && input.attachments.length > 0 ? input.attachments : undefined,
    replyTo: input.replyTo,
    agentId: input.agentId,
    delivery: input.delivery,
    clientRequestId: input.clientRequestId,
  }
}

export function buildChoiceResponseCommand(
  agentId: string,
  choiceId: string,
  answers: ChoiceAnswer[],
): ClientCommand {
  return {
    type: 'choice_response',
    agentId,
    choiceId,
    answers,
  }
}

export function buildChoiceCancelCommand(agentId: string, choiceId: string): ClientCommand {
  return {
    type: 'choice_cancel',
    agentId,
    choiceId,
  }
}

export function buildCodexElicitationResponseCommand(
  agentId: string,
  elicitationId: string,
  decision: CodexElicitationDecision,
  values?: Record<string, unknown>,
  persistScope?: CodexElicitationPersistScope,
): ClientCommand {
  return { type: 'codex_elicitation_response', agentId, elicitationId, decision, values, persistScope }
}

export function buildPinMessageCommand(
  agentId: string,
  messageId: string,
  pinned: boolean,
): ClientCommand {
  return {
    type: 'pin_message',
    agentId,
    messageId,
    pinned,
  }
}

export function buildClearAllPinsCommand(agentId: string): ClientCommand {
  return {
    type: 'clear_all_pins',
    agentId,
  }
}

export function buildKillAgentCommand(agentId: string): ClientCommand {
  return {
    type: 'kill_agent',
    agentId,
  }
}

export function buildReorderProfilesCommand(profileIds: string[]): ClientCommand {
  return {
    type: 'reorder_profiles',
    profileIds,
  }
}

export function buildStopAllAgentsCommand(managerId: string, requestId: string): ClientCommand {
  return {
    type: 'stop_all_agents',
    managerId,
    requestId,
  }
}

export function buildCreateManagerCommand(
  input: { name: string; cwd: string; model?: ManagerModelPreset; modelSelection?: ManagerExactModelSelection; reasoningLevel?: ManagerReasoningLevel },
  requestId: string,
): ClientCommand {
  const name = requireTrimmedValue(input.name, 'Manager name is required.')
  const cwd = requireTrimmedValue(input.cwd, 'Manager working directory is required.')

  if (input.reasoningLevel && !MANAGER_REASONING_LEVELS.includes(input.reasoningLevel)) {
    throw new Error('Invalid reasoning level.')
  }

  if (input.modelSelection) {
    if (!input.modelSelection.provider.trim() || !input.modelSelection.modelId.trim()) {
      throw new Error('Model selection requires both provider and modelId.')
    }
    return {
      type: 'create_manager',
      name,
      cwd,
      modelSelection: input.modelSelection,
      reasoningLevel: input.reasoningLevel,
      requestId,
    }
  }

  if (!input.model || !MANAGER_MODEL_PRESETS.includes(input.model)) {
    throw new Error('Manager model is required.')
  }

  return {
    type: 'create_manager',
    name,
    cwd,
    model: input.model,
    reasoningLevel: input.reasoningLevel,
    requestId,
  }
}

export function buildCreateRepositoryProjectCommand(
  input: {
    name: string
    repositoryUrl: string
    repositoryBasePath: string
    repositoryFolder: string
    modelSelection: ManagerExactModelSelection
    reasoningLevel?: ManagerReasoningLevel
  },
  requestId: string,
): ClientCommand {
  const name = requireTrimmedValue(input.name, 'Project name is required.')
  const repositoryUrl = requireTrimmedValue(input.repositoryUrl, 'Repository URL is required.')
  const repositoryBasePath = requireTrimmedValue(input.repositoryBasePath, 'Repository base path is required.')
  const repositoryFolder = requireTrimmedValue(input.repositoryFolder, 'Repository folder is required.')

  if (!input.modelSelection.provider.trim() || !input.modelSelection.modelId.trim()) {
    throw new Error('Model selection requires both provider and modelId.')
  }
  if (input.reasoningLevel && !MANAGER_REASONING_LEVELS.includes(input.reasoningLevel)) {
    throw new Error('Invalid reasoning level.')
  }

  return {
    type: 'create_repository_project',
    name,
    repositoryUrl,
    repositoryBasePath,
    repositoryFolder,
    modelSelection: input.modelSelection,
    reasoningLevel: input.reasoningLevel,
    requestId,
  }
}

export function buildCancelRepositoryProjectCreationCommand(
  operationRequestId: string,
  requestId: string,
): ClientCommand {
  return {
    type: 'cancel_repository_project_creation',
    operationRequestId: requireTrimmedValue(operationRequestId, 'Operation request id is required.'),
    requestId,
  }
}

export function buildDeleteManagerCommand(managerId: string, requestId: string): ClientCommand {
  return {
    type: 'delete_manager',
    managerId: requireTrimmedValue(managerId, 'Manager id is required.'),
    requestId,
  }
}

export function buildUpdateProfileDefaultModelCommand(
  profileId: string,
  model: ManagerModelPreset | undefined,
  reasoningLevel: ManagerReasoningLevel | undefined,
  requestId: string,
  modelSelection?: ManagerExactModelSelection,
): ClientCommand {
  const trimmed = requireTrimmedValue(profileId, 'Profile id is required.')

  if (reasoningLevel && !MANAGER_REASONING_LEVELS.includes(reasoningLevel)) {
    throw new Error('Invalid reasoning level.')
  }

  if (modelSelection) {
    if (!modelSelection.provider.trim() || !modelSelection.modelId.trim()) {
      throw new Error('Model selection requires both provider and modelId.')
    }
    return {
      type: 'update_profile_default_model',
      profileId: trimmed,
      modelSelection,
      reasoningLevel,
      requestId,
    }
  }

  if (!model || !MANAGER_MODEL_PRESETS.includes(model)) {
    throw new Error('Invalid model preset.')
  }

  return {
    type: 'update_profile_default_model',
    profileId: trimmed,
    model,
    reasoningLevel,
    requestId,
  }
}

export function buildUpdateProjectDelegationDefaultsCommand(
  profileId: string,
  updates: {
    managerPosture?: ManagerPosture | null
    delegationRosterId?: string | null
  },
  requestId: string,
): ClientCommand {
  if (
    !Object.prototype.hasOwnProperty.call(updates, 'managerPosture')
    && !Object.prototype.hasOwnProperty.call(updates, 'delegationRosterId')
  ) {
    throw new Error('A posture or roster update is required.')
  }
  return {
    type: 'update_project_delegation_defaults',
    profileId: requireTrimmedValue(profileId, 'Profile id is required.'),
    ...(Object.prototype.hasOwnProperty.call(updates, 'managerPosture')
      ? { managerPosture: updates.managerPosture }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(updates, 'delegationRosterId')
      ? {
          delegationRosterId: updates.delegationRosterId === null
            ? null
            : requireTrimmedValue(
                updates.delegationRosterId ?? '',
                'Roster id is required.',
              ),
        }
      : {}),
    requestId,
  }
}

export function buildUpdateManagerModelCommand(
  managerId: string,
  model: ManagerModelPreset | undefined,
  reasoningLevel: ManagerReasoningLevel | undefined,
  requestId: string,
  modelSelection?: ManagerExactModelSelection,
): ClientCommand {
  const trimmed = requireTrimmedValue(managerId, 'Manager id is required.')

  if (reasoningLevel && !MANAGER_REASONING_LEVELS.includes(reasoningLevel)) {
    throw new Error('Invalid reasoning level.')
  }

  if (modelSelection) {
    if (!modelSelection.provider.trim() || !modelSelection.modelId.trim()) {
      throw new Error('Model selection requires both provider and modelId.')
    }
    return {
      type: 'update_manager_model',
      managerId: trimmed,
      modelSelection,
      reasoningLevel,
      requestId,
    }
  }

  if (!model || !MANAGER_MODEL_PRESETS.includes(model)) {
    throw new Error('Invalid model preset.')
  }

  return {
    type: 'update_manager_model',
    managerId: trimmed,
    model,
    reasoningLevel,
    requestId,
  }
}

export function buildUpdateManagerCwdCommand(
  managerId: string,
  cwd: string,
  requestId: string,
): ClientCommand {
  return {
    type: 'update_manager_cwd',
    managerId: requireTrimmedValue(managerId, 'Manager id is required.'),
    cwd: requireTrimmedValue(cwd, 'Working directory is required.'),
    requestId,
  }
}

export function buildListDirectoriesCommand(path: string | undefined, requestId: string): ClientCommand {
  return {
    type: 'list_directories',
    path: path?.trim() || undefined,
    requestId,
  }
}

export function buildValidateDirectoryCommand(path: string, requestId: string): ClientCommand {
  return {
    type: 'validate_directory',
    path: requireTrimmedValue(path, 'Directory path is required.'),
    requestId,
  }
}

export function buildCreateDirectoryCommand(
  parentPath: string,
  name: string,
  requestId: string,
): ClientCommand {
  return {
    type: 'create_directory',
    parentPath: requireTrimmedValue(parentPath, 'Parent directory is required.'),
    name: requireTrimmedValue(name, 'Folder name is required.'),
    requestId,
  }
}

export function buildPickDirectoryCommand(defaultPath: string | undefined, requestId: string): ClientCommand {
  return {
    type: 'pick_directory',
    defaultPath: defaultPath?.trim() || undefined,
    requestId,
  }
}

export function buildCreateSessionCommand(
  profileId: string,
  name: string | undefined,
  opts: { sessionPurpose?: AgentSessionPurpose; label?: string } | undefined,
  requestId: string,
): ClientCommand {
  return {
    type: 'create_session',
    profileId: requireTrimmedValue(profileId, 'Profile id is required.'),
    name: name?.trim() || undefined,
    label: opts?.label?.trim() || undefined,
    sessionPurpose: opts?.sessionPurpose,
    requestId,
  }
}

export function buildUpdateSessionModelCommand(
  sessionAgentId: string,
  mode: SessionModelUpdateMode,
  model: ManagerModelPreset | undefined,
  reasoningLevel: ManagerReasoningLevel | undefined,
  requestId: string,
  modelSelection?: ManagerExactModelSelection,
): ClientCommand {
  const trimmed = requireTrimmedValue(sessionAgentId, 'Session agent id is required.')

  if (mode === 'override') {
    if (reasoningLevel && !MANAGER_REASONING_LEVELS.includes(reasoningLevel)) {
      throw new Error('Invalid reasoning level.')
    }

    if (modelSelection) {
      if (!modelSelection.provider.trim() || !modelSelection.modelId.trim()) {
        throw new Error('Model selection requires both provider and modelId.')
      }
      return {
        type: 'update_session_model',
        sessionAgentId: trimmed,
        mode,
        modelSelection,
        reasoningLevel,
        requestId,
      }
    }

    if (!model || !MANAGER_MODEL_PRESETS.includes(model)) {
      throw new Error('Invalid model preset.')
    }

    return {
      type: 'update_session_model',
      sessionAgentId: trimmed,
      mode,
      model,
      reasoningLevel,
      requestId,
    }
  }

  if (mode !== 'inherit') {
    throw new Error('Invalid session model mode.')
  }

  return {
    type: 'update_session_model',
    sessionAgentId: trimmed,
    mode,
    requestId,
  }
}

export function buildUpdateSessionDelegationCommand(
  sessionAgentId: string,
  updates: {
    managerPosture?: { mode: 'inherit' } | {
      mode: 'override'
      value: ManagerPosture
    }
    delegationRoster?: { mode: 'inherit' } | {
      mode: 'override'
      rosterId: string
    }
  },
  requestId: string,
): ClientCommand {
  if (!updates.managerPosture && !updates.delegationRoster) {
    throw new Error('A posture or roster update is required.')
  }
  return {
    type: 'update_session_delegation',
    sessionAgentId: requireTrimmedValue(sessionAgentId, 'Session agent id is required.'),
    ...(updates.managerPosture ? { managerPosture: updates.managerPosture } : {}),
    ...(updates.delegationRoster
      ? {
          delegationRoster: updates.delegationRoster.mode === 'inherit'
            ? updates.delegationRoster
            : {
                mode: 'override',
                rosterId: requireTrimmedValue(
                  updates.delegationRoster.rosterId,
                  'Roster id is required.',
                ),
              },
        }
      : {}),
    requestId,
  }
}

export function buildSessionActionCommand(
  type: 'stop_session' | 'resume_session' | 'archive_session' | 'restore_session' | 'delete_session' | 'clear_session',
  agentId: string,
  requestId: string,
): ClientCommand {
  return {
    type,
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    requestId,
  }
}

export function buildRenameSessionCommand(
  agentId: string,
  label: string,
  requestId: string,
): ClientCommand {
  return {
    type: 'rename_session',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    label: requireTrimmedValue(label, 'Session label is required.'),
    requestId,
  }
}

export function buildPinSessionCommand(
  agentId: string,
  pinned: boolean,
  requestId: string,
): ClientCommand {
  return {
    type: 'pin_session',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    pinned,
    requestId,
  }
}

export function buildHydrateArchiveLastUsedCommand(requestId: string): ClientCommand {
  return {
    type: 'hydrate_archive_last_used',
    requestId,
  }
}

export function buildProfileArchiveActionCommand(
  type: 'archive_profile' | 'restore_profile',
  profileId: string,
  requestId: string,
): ClientCommand {
  return {
    type,
    profileId: requireTrimmedValue(profileId, 'Profile id is required.'),
    requestId,
  }
}

export function buildRenameProfileCommand(
  profileId: string,
  displayName: string,
  requestId: string,
): ClientCommand {
  return {
    type: 'rename_profile',
    profileId: requireTrimmedValue(profileId, 'Profile id is required.'),
    displayName: requireTrimmedValue(displayName, 'Profile display name is required.'),
    requestId,
  }
}

export function buildForkSessionCommand(
  sourceAgentId: string,
  label: string | undefined,
  fromMessageId: string | undefined,
  requestId: string,
): ClientCommand {
  return {
    type: 'fork_session',
    sourceAgentId: requireTrimmedValue(sourceAgentId, 'Source agent id is required.'),
    label: label?.trim() || undefined,
    fromMessageId: fromMessageId?.trim() || undefined,
    requestId,
  }
}

export function buildSetSessionProjectAgentCommand(
  agentId: string,
  projectAgent: SessionProjectAgentInput | null,
  requestId: string,
): ClientCommand {
  return {
    type: 'set_session_project_agent',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    projectAgent,
    requestId,
  }
}

export function buildGetProjectAgentConfigCommand(agentId: string, requestId: string): ClientCommand {
  return {
    type: 'get_project_agent_config',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    requestId,
  }
}

export function buildListProjectAgentReferencesCommand(
  agentId: string,
  requestId: string,
): ClientCommand {
  return {
    type: 'list_project_agent_references',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    requestId,
  }
}

export function buildGetProjectAgentReferenceCommand(
  agentId: string,
  fileName: string,
  requestId: string,
): ClientCommand {
  return {
    type: 'get_project_agent_reference',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    fileName: requireTrimmedValue(fileName, 'File name is required.'),
    requestId,
  }
}

export function buildSetProjectAgentReferenceCommand(
  agentId: string,
  fileName: string,
  content: string,
  requestId: string,
): ClientCommand {
  return {
    type: 'set_project_agent_reference',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    fileName: requireTrimmedValue(fileName, 'File name is required.'),
    content,
    requestId,
  }
}

export function buildDeleteProjectAgentReferenceCommand(
  agentId: string,
  fileName: string,
  requestId: string,
): ClientCommand {
  return {
    type: 'delete_project_agent_reference',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    fileName: requireTrimmedValue(fileName, 'File name is required.'),
    requestId,
  }
}

export function buildRequestProjectAgentRecommendationsCommand(
  agentId: string,
  requestId: string,
): ClientCommand {
  return {
    type: 'request_project_agent_recommendations',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    requestId,
  }
}

export function buildGetProjectAgentSharingCommand(agentId: string, requestId: string): ClientCommand {
  return {
    type: 'get_project_agent_sharing',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    requestId,
  }
}

export function buildSetProjectAgentSharingCommand(
  agentId: string,
  targetProfileIds: string[],
  requestId: string,
): ClientCommand {
  return {
    type: 'set_project_agent_sharing',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    targetProfileIds,
    requestId,
  }
}

export function buildGetProjectAgentExternalDirectoryCommand(requestId: string): ClientCommand {
  return {
    type: 'get_project_agent_external_directory',
    requestId,
  }
}

export function buildMergeSessionMemoryCommand(agentId: string, requestId: string): ClientCommand {
  return {
    type: 'merge_session_memory',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    requestId,
  }
}

export function buildGetSessionWorkersCommand(
  sessionAgentId: string,
  requestId: string,
): ClientCommand {
  return {
    type: 'get_session_workers',
    sessionAgentId: requireTrimmedValue(sessionAgentId, 'Session agent id is required.'),
    requestId,
  }
}

export function buildGetConversationPageCommand(
  agentId: string,
  cursor: string,
  requestId: string,
  limit?: number,
  view?: BuilderTimelineChannelView,
): ClientCommand {
  return {
    type: 'get_conversation_page',
    agentId: requireTrimmedValue(agentId, 'Agent id is required.'),
    cursor: requireTrimmedValue(cursor, 'Conversation cursor is required.'),
    ...(limit === undefined ? {} : { limit }),
    ...(view ? { view } : {}),
    requestId,
  }
}
