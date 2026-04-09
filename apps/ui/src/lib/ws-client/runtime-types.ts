import type { AgentDescriptor, ConversationEntry } from '@forge/protocol'
import type { AgentActivityEntry } from '../ws-state'
import type { WsRequestErrorHint, WsRequestType } from './types'

export const INITIAL_CONNECT_DELAY_MS = 50
export const RECONNECT_MS = 1200
export const REQUEST_TIMEOUT_MS = 300_000
export const SESSION_WORKERS_REFETCH_DEBOUNCE_MS = 250
// Keep client-side activity retention aligned with backend history retention.
export const MAX_CLIENT_CONVERSATION_HISTORY = 2000

export const WS_REQUEST_TYPES: WsRequestType[] = [
  'create_manager',
  'delete_manager',
  'update_manager_model',
  'update_manager_cwd',
  'stop_all_agents',
  'create_session',
  'stop_session',
  'resume_session',
  'delete_session',
  'clear_session',
  'rename_session',
  'pin_session',
  'rename_profile',
  'fork_session',
  'merge_session_memory',
  'set_session_project_agent',
  'get_project_agent_config',
  'list_project_agent_references',
  'get_project_agent_reference',
  'set_project_agent_reference',
  'delete_project_agent_reference',
  'request_project_agent_recommendations',
  'get_session_workers',
  'list_directories',
  'validate_directory',
  'pick_directory',
]

export const WS_REQUEST_ERROR_HINTS: WsRequestErrorHint[] = [
  { requestType: 'create_manager', codeFragment: 'create_manager' },
  { requestType: 'delete_manager', codeFragment: 'delete_manager' },
  { requestType: 'update_manager_model', codeFragment: 'update_manager_model' },
  { requestType: 'update_manager_cwd', codeFragment: 'update_manager_cwd' },
  { requestType: 'stop_all_agents', codeFragment: 'stop_all_agents' },
  { requestType: 'create_session', codeFragment: 'create_session' },
  { requestType: 'stop_session', codeFragment: 'stop_session' },
  { requestType: 'resume_session', codeFragment: 'resume_session' },
  { requestType: 'delete_session', codeFragment: 'delete_session' },
  { requestType: 'clear_session', codeFragment: 'clear_session' },
  { requestType: 'rename_session', codeFragment: 'rename_session' },
  { requestType: 'pin_session', codeFragment: 'pin_session' },
  { requestType: 'rename_profile', codeFragment: 'rename_profile' },
  { requestType: 'fork_session', codeFragment: 'fork_session' },
  { requestType: 'merge_session_memory', codeFragment: 'merge_session_memory' },
  { requestType: 'set_session_project_agent', codeFragment: 'set_session_project_agent' },
  { requestType: 'get_project_agent_config', codeFragment: 'project_agent_config' },
  { requestType: 'list_project_agent_references', codeFragment: 'project_agent_references' },
  { requestType: 'get_project_agent_reference', codeFragment: 'project_agent_reference' },
  { requestType: 'set_project_agent_reference', codeFragment: 'project_agent_reference_saved' },
  { requestType: 'delete_project_agent_reference', codeFragment: 'project_agent_reference_deleted' },
  { requestType: 'request_project_agent_recommendations', codeFragment: 'project_agent_recommendations' },
  { requestType: 'get_session_workers', codeFragment: 'get_session_workers' },
  { requestType: 'list_directories', codeFragment: 'list_directories' },
  { requestType: 'validate_directory', codeFragment: 'validate_directory' },
  { requestType: 'pick_directory', codeFragment: 'pick_directory' },
]

export function isManagerAgent(agent: AgentDescriptor): boolean {
  return agent.role === 'manager'
}

export function isWorkerAgent(agent: AgentDescriptor): boolean {
  return agent.role === 'worker'
}

export function isAgentActivityEntry(entry: ConversationEntry): entry is AgentActivityEntry {
  return entry.type === 'agent_message' || entry.type === 'agent_tool_call'
}
