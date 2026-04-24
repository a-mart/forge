import {
  MANAGER_MODEL_PRESETS,
  MANAGER_REASONING_LEVELS,
  type AgentSessionPurpose,
  type ChoiceAnswer,
  type ClientCommand,
  type ConversationAttachment,
  type DeliveryMode,
  type ManagerExactModelSelection,
  type ManagerModelPreset,
  type ManagerReasoningLevel,
  type ProjectAgentCapability,
  type SessionModelUpdateMode,
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

export function buildSubscribeCommand(agentId?: string | null): ClientCommand {
  return {
    type: 'subscribe',
    agentId: agentId ?? undefined,
  }
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

export function buildUserMessageCommand(input: {
  text: string
  agentId: string
  delivery?: DeliveryMode
  attachments?: ConversationAttachment[]
}): ClientCommand {
  return {
    type: 'user_message',
    text: input.text,
    attachments: input.attachments && input.attachments.length > 0 ? input.attachments : undefined,
    agentId: input.agentId,
    delivery: input.delivery,
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
  input: { name: string; cwd: string; model?: ManagerModelPreset; modelSelection?: ManagerExactModelSelection },
  requestId: string,
): ClientCommand {
  const name = requireTrimmedValue(input.name, 'Manager name is required.')
  const cwd = requireTrimmedValue(input.cwd, 'Manager working directory is required.')

  if (input.modelSelection) {
    if (!input.modelSelection.provider.trim() || !input.modelSelection.modelId.trim()) {
      throw new Error('Model selection requires both provider and modelId.')
    }
    return {
      type: 'create_manager',
      name,
      cwd,
      modelSelection: input.modelSelection,
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
    label: opts?.label,
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

export function buildSessionActionCommand(
  type: 'stop_session' | 'resume_session' | 'delete_session' | 'clear_session',
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
  projectAgent: { whenToUse: string; systemPrompt?: string; handle?: string; capabilities?: ProjectAgentCapability[] } | null,
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
