import { getWsRequestContract, WS_REQUEST_CONTRACTS } from '@forge/protocol'
import type { AgentDescriptor, ConversationEntry } from '@forge/protocol'
import type { AgentActivityEntry } from '../ws-state'
import type { WsRequestErrorHint, WsRequestType } from './types'

export const INITIAL_CONNECT_DELAY_MS = 50
export const RECONNECT_MS = 1200
export const REQUEST_TIMEOUT_MS = 300_000
export const SESSION_WORKERS_REFETCH_DEBOUNCE_MS = 250
// Keep client-side activity retention aligned with backend history retention.
export const MAX_CLIENT_CONVERSATION_HISTORY = 2000

function uniqueRequestTypes(requestTypes: readonly WsRequestType[]): WsRequestType[] {
  return [...new Set(requestTypes)]
}

function uniqueErrorHints(errorHints: readonly WsRequestErrorHint[]): WsRequestErrorHint[] {
  const seen = new Set<string>()
  return errorHints.filter((hint) => {
    const key = `${hint.requestType}:${hint.codeFragment}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

const RENAME_PROFILE_CONTRACT = getWsRequestContract('rename_profile')
const RENAME_SESSION_CONTRACT = getWsRequestContract('rename_session')
const PIN_SESSION_CONTRACT = getWsRequestContract('pin_session')
const UPDATE_MANAGER_CWD_CONTRACT = getWsRequestContract('update_manager_cwd')
const CLEAR_SESSION_CONTRACT = getWsRequestContract('clear_session')
const STOP_SESSION_CONTRACT = getWsRequestContract('stop_session')
const RESUME_SESSION_CONTRACT = getWsRequestContract('resume_session')
const LEGACY_POSITION_CONTRACT_TYPES = new Set<string>([
  RENAME_PROFILE_CONTRACT.commandType,
  RENAME_SESSION_CONTRACT.commandType,
  PIN_SESSION_CONTRACT.commandType,
  UPDATE_MANAGER_CWD_CONTRACT.commandType,
  CLEAR_SESSION_CONTRACT.commandType,
  STOP_SESSION_CONTRACT.commandType,
  RESUME_SESSION_CONTRACT.commandType,
])
const NON_LEGACY_POSITION_CONTRACTS = WS_REQUEST_CONTRACTS.filter(
  (contract) => !LEGACY_POSITION_CONTRACT_TYPES.has(contract.commandType),
)
const RENAME_PROFILE_ERROR_HINTS = RENAME_PROFILE_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: RENAME_PROFILE_CONTRACT.commandType,
  codeFragment,
}))
const RENAME_SESSION_ERROR_HINTS = RENAME_SESSION_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: RENAME_SESSION_CONTRACT.commandType,
  codeFragment,
}))
const PIN_SESSION_ERROR_HINTS = PIN_SESSION_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: PIN_SESSION_CONTRACT.commandType,
  codeFragment,
}))
const UPDATE_MANAGER_CWD_ERROR_HINTS = UPDATE_MANAGER_CWD_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: UPDATE_MANAGER_CWD_CONTRACT.commandType,
  codeFragment,
}))
const CLEAR_SESSION_ERROR_HINTS = CLEAR_SESSION_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: CLEAR_SESSION_CONTRACT.commandType,
  codeFragment,
}))
const STOP_SESSION_ERROR_HINTS = STOP_SESSION_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: STOP_SESSION_CONTRACT.commandType,
  codeFragment,
}))
const RESUME_SESSION_ERROR_HINTS = RESUME_SESSION_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: RESUME_SESSION_CONTRACT.commandType,
  codeFragment,
}))

export const WS_REQUEST_TYPES: WsRequestType[] = uniqueRequestTypes([
  'create_manager',
  'delete_manager',
  'update_profile_default_model',
  'update_manager_model',
  UPDATE_MANAGER_CWD_CONTRACT.commandType,
  'stop_all_agents',
  'create_session',
  STOP_SESSION_CONTRACT.commandType,
  RESUME_SESSION_CONTRACT.commandType,
  'delete_session',
  CLEAR_SESSION_CONTRACT.commandType,
  RENAME_SESSION_CONTRACT.commandType,
  PIN_SESSION_CONTRACT.commandType,
  'update_session_model',
  RENAME_PROFILE_CONTRACT.commandType,
  'fork_session',
  'merge_session_memory',
  'set_session_project_agent',
  'get_project_agent_config',
  'list_project_agent_references',
  'get_project_agent_reference',
  'set_project_agent_reference',
  'delete_project_agent_reference',
  'request_project_agent_recommendations',
  ...NON_LEGACY_POSITION_CONTRACTS.map((contract) => contract.commandType),
])

export const WS_REQUEST_ERROR_HINTS: WsRequestErrorHint[] = uniqueErrorHints([
  { requestType: 'create_manager', codeFragment: 'create_manager' },
  { requestType: 'delete_manager', codeFragment: 'delete_manager' },
  { requestType: 'update_profile_default_model', codeFragment: 'update_profile_default_model' },
  { requestType: 'update_manager_model', codeFragment: 'update_manager_model' },
  ...UPDATE_MANAGER_CWD_ERROR_HINTS,
  { requestType: 'stop_all_agents', codeFragment: 'stop_all_agents' },
  { requestType: 'create_session', codeFragment: 'create_session' },
  ...STOP_SESSION_ERROR_HINTS,
  ...RESUME_SESSION_ERROR_HINTS,
  { requestType: 'delete_session', codeFragment: 'delete_session' },
  ...CLEAR_SESSION_ERROR_HINTS,
  ...RENAME_SESSION_ERROR_HINTS,
  ...PIN_SESSION_ERROR_HINTS,
  { requestType: 'update_session_model', codeFragment: 'update_session_model' },
  ...RENAME_PROFILE_ERROR_HINTS,
  { requestType: 'fork_session', codeFragment: 'fork_session' },
  { requestType: 'merge_session_memory', codeFragment: 'merge_session_memory' },
  { requestType: 'set_session_project_agent', codeFragment: 'set_session_project_agent' },
  { requestType: 'get_project_agent_config', codeFragment: 'project_agent_config' },
  { requestType: 'list_project_agent_references', codeFragment: 'project_agent_references' },
  { requestType: 'get_project_agent_reference', codeFragment: 'project_agent_reference' },
  { requestType: 'set_project_agent_reference', codeFragment: 'project_agent_reference_saved' },
  { requestType: 'delete_project_agent_reference', codeFragment: 'project_agent_reference_deleted' },
  { requestType: 'request_project_agent_recommendations', codeFragment: 'project_agent_recommendations' },
  ...NON_LEGACY_POSITION_CONTRACTS.flatMap((contract) =>
    contract.errorCodeFragments.map((codeFragment) => ({ requestType: contract.commandType, codeFragment })),
  ),
])

export function isManagerAgent(agent: AgentDescriptor): boolean {
  return agent.role === 'manager'
}

export function isWorkerAgent(agent: AgentDescriptor): boolean {
  return agent.role === 'worker'
}

export function isAgentActivityEntry(entry: ConversationEntry): entry is AgentActivityEntry {
  return entry.type === 'agent_message' || entry.type === 'agent_tool_call'
}
