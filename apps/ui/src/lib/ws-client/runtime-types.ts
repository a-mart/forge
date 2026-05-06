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
const UPDATE_SESSION_MODEL_CONTRACT = getWsRequestContract('update_session_model')
const FORK_SESSION_CONTRACT = getWsRequestContract('fork_session')
const UPDATE_PROFILE_DEFAULT_MODEL_CONTRACT = getWsRequestContract('update_profile_default_model')
const UPDATE_MANAGER_MODEL_CONTRACT = getWsRequestContract('update_manager_model')
const UPDATE_MANAGER_CWD_CONTRACT = getWsRequestContract('update_manager_cwd')
const CREATE_SESSION_CONTRACT = getWsRequestContract('create_session')
const CLEAR_SESSION_CONTRACT = getWsRequestContract('clear_session')
const SET_SESSION_PROJECT_AGENT_CONTRACT = getWsRequestContract('set_session_project_agent')
const GET_PROJECT_AGENT_CONFIG_CONTRACT = getWsRequestContract('get_project_agent_config')
const LIST_PROJECT_AGENT_REFERENCES_CONTRACT = getWsRequestContract('list_project_agent_references')
const GET_PROJECT_AGENT_REFERENCE_CONTRACT = getWsRequestContract('get_project_agent_reference')
const SET_PROJECT_AGENT_REFERENCE_CONTRACT = getWsRequestContract('set_project_agent_reference')
const DELETE_PROJECT_AGENT_REFERENCE_CONTRACT = getWsRequestContract('delete_project_agent_reference')
const STOP_SESSION_CONTRACT = getWsRequestContract('stop_session')
const RESUME_SESSION_CONTRACT = getWsRequestContract('resume_session')
const DELETE_SESSION_CONTRACT = getWsRequestContract('delete_session')
const LEGACY_POSITION_CONTRACT_TYPES = new Set<string>([
  RENAME_PROFILE_CONTRACT.commandType,
  RENAME_SESSION_CONTRACT.commandType,
  PIN_SESSION_CONTRACT.commandType,
  UPDATE_SESSION_MODEL_CONTRACT.commandType,
  FORK_SESSION_CONTRACT.commandType,
  UPDATE_PROFILE_DEFAULT_MODEL_CONTRACT.commandType,
  UPDATE_MANAGER_MODEL_CONTRACT.commandType,
  UPDATE_MANAGER_CWD_CONTRACT.commandType,
  CREATE_SESSION_CONTRACT.commandType,
  CLEAR_SESSION_CONTRACT.commandType,
  SET_SESSION_PROJECT_AGENT_CONTRACT.commandType,
  GET_PROJECT_AGENT_CONFIG_CONTRACT.commandType,
  LIST_PROJECT_AGENT_REFERENCES_CONTRACT.commandType,
  GET_PROJECT_AGENT_REFERENCE_CONTRACT.commandType,
  SET_PROJECT_AGENT_REFERENCE_CONTRACT.commandType,
  DELETE_PROJECT_AGENT_REFERENCE_CONTRACT.commandType,
  STOP_SESSION_CONTRACT.commandType,
  RESUME_SESSION_CONTRACT.commandType,
  DELETE_SESSION_CONTRACT.commandType,
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
const UPDATE_SESSION_MODEL_ERROR_HINTS = UPDATE_SESSION_MODEL_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: UPDATE_SESSION_MODEL_CONTRACT.commandType,
  codeFragment,
}))
const FORK_SESSION_ERROR_HINTS = FORK_SESSION_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: FORK_SESSION_CONTRACT.commandType,
  codeFragment,
}))
const UPDATE_PROFILE_DEFAULT_MODEL_ERROR_HINTS = UPDATE_PROFILE_DEFAULT_MODEL_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: UPDATE_PROFILE_DEFAULT_MODEL_CONTRACT.commandType,
  codeFragment,
}))
const UPDATE_MANAGER_MODEL_ERROR_HINTS = UPDATE_MANAGER_MODEL_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: UPDATE_MANAGER_MODEL_CONTRACT.commandType,
  codeFragment,
}))
const UPDATE_MANAGER_CWD_ERROR_HINTS = UPDATE_MANAGER_CWD_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: UPDATE_MANAGER_CWD_CONTRACT.commandType,
  codeFragment,
}))
const CREATE_SESSION_ERROR_HINTS = CREATE_SESSION_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: CREATE_SESSION_CONTRACT.commandType,
  codeFragment,
}))
const CLEAR_SESSION_ERROR_HINTS = CLEAR_SESSION_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: CLEAR_SESSION_CONTRACT.commandType,
  codeFragment,
}))
const SET_SESSION_PROJECT_AGENT_ERROR_HINTS = SET_SESSION_PROJECT_AGENT_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: SET_SESSION_PROJECT_AGENT_CONTRACT.commandType,
  codeFragment,
}))
const GET_PROJECT_AGENT_CONFIG_ERROR_HINTS = GET_PROJECT_AGENT_CONFIG_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: GET_PROJECT_AGENT_CONFIG_CONTRACT.commandType,
  codeFragment,
}))
const LIST_PROJECT_AGENT_REFERENCES_ERROR_HINTS = LIST_PROJECT_AGENT_REFERENCES_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: LIST_PROJECT_AGENT_REFERENCES_CONTRACT.commandType,
  codeFragment,
}))
const GET_PROJECT_AGENT_REFERENCE_ERROR_HINTS = GET_PROJECT_AGENT_REFERENCE_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: GET_PROJECT_AGENT_REFERENCE_CONTRACT.commandType,
  codeFragment,
}))
const SET_PROJECT_AGENT_REFERENCE_ERROR_HINTS = SET_PROJECT_AGENT_REFERENCE_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: SET_PROJECT_AGENT_REFERENCE_CONTRACT.commandType,
  codeFragment,
}))
const DELETE_PROJECT_AGENT_REFERENCE_ERROR_HINTS = DELETE_PROJECT_AGENT_REFERENCE_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: DELETE_PROJECT_AGENT_REFERENCE_CONTRACT.commandType,
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
const DELETE_SESSION_ERROR_HINTS = DELETE_SESSION_CONTRACT.errorCodeFragments.map((codeFragment) => ({
  requestType: DELETE_SESSION_CONTRACT.commandType,
  codeFragment,
}))

export const WS_REQUEST_TYPES: WsRequestType[] = uniqueRequestTypes([
  'create_manager',
  'delete_manager',
  UPDATE_PROFILE_DEFAULT_MODEL_CONTRACT.commandType,
  UPDATE_MANAGER_MODEL_CONTRACT.commandType,
  UPDATE_MANAGER_CWD_CONTRACT.commandType,
  'stop_all_agents',
  CREATE_SESSION_CONTRACT.commandType,
  STOP_SESSION_CONTRACT.commandType,
  RESUME_SESSION_CONTRACT.commandType,
  DELETE_SESSION_CONTRACT.commandType,
  CLEAR_SESSION_CONTRACT.commandType,
  RENAME_SESSION_CONTRACT.commandType,
  PIN_SESSION_CONTRACT.commandType,
  UPDATE_SESSION_MODEL_CONTRACT.commandType,
  RENAME_PROFILE_CONTRACT.commandType,
  FORK_SESSION_CONTRACT.commandType,
  'merge_session_memory',
  SET_SESSION_PROJECT_AGENT_CONTRACT.commandType,
  GET_PROJECT_AGENT_CONFIG_CONTRACT.commandType,
  LIST_PROJECT_AGENT_REFERENCES_CONTRACT.commandType,
  GET_PROJECT_AGENT_REFERENCE_CONTRACT.commandType,
  SET_PROJECT_AGENT_REFERENCE_CONTRACT.commandType,
  DELETE_PROJECT_AGENT_REFERENCE_CONTRACT.commandType,
  'request_project_agent_recommendations',
  ...NON_LEGACY_POSITION_CONTRACTS.map((contract) => contract.commandType),
])

export const WS_REQUEST_ERROR_HINTS: WsRequestErrorHint[] = uniqueErrorHints([
  { requestType: 'create_manager', codeFragment: 'create_manager' },
  { requestType: 'delete_manager', codeFragment: 'delete_manager' },
  ...UPDATE_PROFILE_DEFAULT_MODEL_ERROR_HINTS,
  ...UPDATE_MANAGER_MODEL_ERROR_HINTS,
  ...UPDATE_MANAGER_CWD_ERROR_HINTS,
  { requestType: 'stop_all_agents', codeFragment: 'stop_all_agents' },
  ...CREATE_SESSION_ERROR_HINTS,
  ...STOP_SESSION_ERROR_HINTS,
  ...RESUME_SESSION_ERROR_HINTS,
  ...DELETE_SESSION_ERROR_HINTS,
  ...CLEAR_SESSION_ERROR_HINTS,
  ...RENAME_SESSION_ERROR_HINTS,
  ...PIN_SESSION_ERROR_HINTS,
  ...UPDATE_SESSION_MODEL_ERROR_HINTS,
  ...RENAME_PROFILE_ERROR_HINTS,
  ...FORK_SESSION_ERROR_HINTS,
  { requestType: 'merge_session_memory', codeFragment: 'merge_session_memory' },
  ...SET_SESSION_PROJECT_AGENT_ERROR_HINTS,
  ...GET_PROJECT_AGENT_CONFIG_ERROR_HINTS,
  ...LIST_PROJECT_AGENT_REFERENCES_ERROR_HINTS,
  ...SET_PROJECT_AGENT_REFERENCE_ERROR_HINTS,
  ...DELETE_PROJECT_AGENT_REFERENCE_ERROR_HINTS,
  ...GET_PROJECT_AGENT_REFERENCE_ERROR_HINTS,
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
