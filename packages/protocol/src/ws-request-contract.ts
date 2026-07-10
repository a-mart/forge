import type { ClientCommand } from './client-commands.js'
import type { ServerEvent } from './server-events.js'

export type WsRequestIdPolicy = {
  ui: 'required'
  wire: 'optional'
}

export type WsRequestContract<
  CommandType extends Extract<ClientCommand['type'], string> = Extract<ClientCommand['type'], string>,
  SuccessEventType extends Extract<ServerEvent['type'], string> = Extract<ServerEvent['type'], string>,
> = {
  commandType: CommandType
  resultFamily: string
  requestId: WsRequestIdPolicy
  successEvents: readonly SuccessEventType[]
  errorCodeFragments: readonly string[]
}

type ContractCommandType = Extract<
  ClientCommand['type'],
  | 'list_directories'
  | 'validate_directory'
  | 'create_directory'
  | 'pick_directory'
  | 'get_session_workers'
  | 'rename_profile'
  | 'archive_profile'
  | 'restore_profile'
  | 'rename_session'
  | 'pin_session'
  | 'update_session_model'
  | 'fork_session'
  | 'merge_session_memory'
  | 'update_profile_default_model'
  | 'update_manager_model'
  | 'update_manager_cwd'
  | 'stop_all_agents'
  | 'create_manager'
  | 'delete_manager'
  | 'create_session'
  | 'stop_session'
  | 'resume_session'
  | 'hydrate_archive_last_used'
  | 'archive_session'
  | 'restore_session'
  | 'delete_session'
  | 'clear_session'
  | 'set_session_project_agent'
  | 'get_project_agent_config'
  | 'list_project_agent_references'
  | 'get_project_agent_reference'
  | 'set_project_agent_reference'
  | 'delete_project_agent_reference'
  | 'request_project_agent_recommendations'
  | 'get_project_agent_sharing'
  | 'set_project_agent_sharing'
  | 'get_project_agent_external_directory'
>
type ContractSuccessEventType = Extract<
  ServerEvent['type'],
  | 'directories_listed'
  | 'directory_validated'
  | 'directory_created'
  | 'directory_picked'
  | 'session_workers_snapshot'
  | 'profile_renamed'
  | 'profile_archived'
  | 'profile_restored'
  | 'session_renamed'
  | 'session_pinned'
  | 'session_model_updated'
  | 'session_forked'
  | 'session_memory_merged'
  | 'profile_default_model_updated'
  | 'manager_model_updated'
  | 'manager_cwd_updated'
  | 'stop_all_agents_result'
  | 'manager_created'
  | 'manager_deleted'
  | 'session_created'
  | 'session_stopped'
  | 'session_resumed'
  | 'archive_last_used_hydrated'
  | 'session_archived'
  | 'session_restored'
  | 'session_deleted'
  | 'session_cleared'
  | 'session_project_agent_updated'
  | 'project_agent_config'
  | 'project_agent_references'
  | 'project_agent_reference'
  | 'project_agent_reference_saved'
  | 'project_agent_reference_deleted'
  | 'project_agent_recommendations'
  | 'project_agent_sharing'
  | 'project_agent_sharing_updated'
  | 'project_agent_external_directory'
>

export const WS_REQUEST_CONTRACTS = [
  {
    commandType: 'list_directories',
    resultFamily: 'directory_listing',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['directories_listed'],
    errorCodeFragments: ['list_directories'],
  },
  {
    commandType: 'validate_directory',
    resultFamily: 'directory_validation',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['directory_validated'],
    errorCodeFragments: ['validate_directory'],
  },
  {
    commandType: 'create_directory',
    resultFamily: 'directory_create',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['directory_created'],
    errorCodeFragments: ['create_directory'],
  },
  {
    commandType: 'pick_directory',
    resultFamily: 'directory_picker',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['directory_picked'],
    errorCodeFragments: ['pick_directory'],
  },
  {
    commandType: 'get_session_workers',
    resultFamily: 'session_workers',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_workers_snapshot'],
    errorCodeFragments: ['get_session_workers'],
  },
  {
    commandType: 'rename_profile',
    resultFamily: 'profile_rename',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['profile_renamed'],
    errorCodeFragments: ['rename_profile'],
  },
  {
    commandType: 'archive_profile',
    resultFamily: 'archive_profile_result',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['profile_archived'],
    errorCodeFragments: ['archive_profile'],
  },
  {
    commandType: 'restore_profile',
    resultFamily: 'restore_profile_result',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['profile_restored'],
    errorCodeFragments: ['restore_profile'],
  },
  {
    commandType: 'rename_session',
    resultFamily: 'session_rename',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_renamed'],
    errorCodeFragments: ['rename_session'],
  },
  {
    commandType: 'pin_session',
    resultFamily: 'session_pin',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_pinned'],
    errorCodeFragments: ['pin_session'],
  },
  {
    commandType: 'update_session_model',
    resultFamily: 'session_model_update',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_model_updated'],
    errorCodeFragments: ['update_session_model'],
  },
  {
    commandType: 'fork_session',
    resultFamily: 'session_fork',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_forked'],
    errorCodeFragments: ['fork_session'],
  },
  {
    commandType: 'merge_session_memory',
    resultFamily: 'session_memory_merge',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_memory_merged'],
    errorCodeFragments: ['merge_session_memory'],
  },
  {
    commandType: 'update_profile_default_model',
    resultFamily: 'profile_default_model_update',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['profile_default_model_updated'],
    errorCodeFragments: ['update_profile_default_model'],
  },
  {
    commandType: 'update_manager_model',
    resultFamily: 'manager_model_update',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['manager_model_updated'],
    errorCodeFragments: ['update_manager_model'],
  },
  {
    commandType: 'update_manager_cwd',
    resultFamily: 'manager_cwd_update',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['manager_cwd_updated'],
    errorCodeFragments: ['update_manager_cwd'],
  },
  {
    commandType: 'stop_all_agents',
    resultFamily: 'stop_all_agents',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['stop_all_agents_result'],
    errorCodeFragments: ['stop_all_agents'],
  },
  {
    commandType: 'create_manager',
    resultFamily: 'manager_create',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['manager_created'],
    errorCodeFragments: ['create_manager'],
  },
  {
    commandType: 'delete_manager',
    resultFamily: 'manager_delete',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['manager_deleted'],
    errorCodeFragments: ['delete_manager'],
  },
  {
    commandType: 'create_session',
    resultFamily: 'session_create',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_created'],
    errorCodeFragments: ['create_session'],
  },
  {
    commandType: 'stop_session',
    resultFamily: 'session_stop',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_stopped'],
    errorCodeFragments: ['stop_session'],
  },
  {
    commandType: 'resume_session',
    resultFamily: 'session_resume',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_resumed'],
    errorCodeFragments: ['resume_session'],
  },
  {
    commandType: 'hydrate_archive_last_used',
    resultFamily: 'archive_last_used_hydration',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['archive_last_used_hydrated'],
    errorCodeFragments: ['hydrate_archive_last_used'],
  },
  {
    commandType: 'archive_session',
    resultFamily: 'archive_session_result',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_archived'],
    errorCodeFragments: [
      'archive_session',
      'ARCHIVE_DEFAULT_SESSION_NOT_ALLOWED',
    ],
  },
  {
    commandType: 'restore_session',
    resultFamily: 'restore_session_result',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_restored'],
    errorCodeFragments: [
      'restore_session',
      'ARCHIVE_RESTORE_PARENT_PROJECT_REQUIRED',
    ],
  },
  {
    commandType: 'delete_session',
    resultFamily: 'session_delete',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_deleted'],
    errorCodeFragments: ['delete_session'],
  },
  {
    commandType: 'clear_session',
    resultFamily: 'session_clear',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_cleared'],
    errorCodeFragments: ['clear_session'],
  },
  {
    commandType: 'set_session_project_agent',
    resultFamily: 'session_project_agent_update',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['session_project_agent_updated'],
    errorCodeFragments: ['set_session_project_agent'],
  },
  {
    commandType: 'get_project_agent_config',
    resultFamily: 'project_agent_config',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['project_agent_config'],
    errorCodeFragments: ['project_agent_config'],
  },
  {
    commandType: 'list_project_agent_references',
    resultFamily: 'project_agent_references',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['project_agent_references'],
    errorCodeFragments: ['project_agent_references'],
  },
  {
    commandType: 'get_project_agent_reference',
    resultFamily: 'project_agent_reference',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['project_agent_reference'],
    errorCodeFragments: ['project_agent_reference'],
  },
  {
    commandType: 'set_project_agent_reference',
    resultFamily: 'project_agent_reference_save',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['project_agent_reference_saved'],
    errorCodeFragments: ['set_project_agent_reference'],
  },
  {
    commandType: 'delete_project_agent_reference',
    resultFamily: 'project_agent_reference_delete',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['project_agent_reference_deleted'],
    errorCodeFragments: ['delete_project_agent_reference'],
  },
  {
    commandType: 'request_project_agent_recommendations',
    resultFamily: 'project_agent_recommendations',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['project_agent_recommendations'],
    errorCodeFragments: ['project_agent_recommendations'],
  },
  {
    commandType: 'get_project_agent_sharing',
    resultFamily: 'project_agent_sharing',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['project_agent_sharing'],
    errorCodeFragments: ['project_agent_sharing'],
  },
  {
    commandType: 'set_project_agent_sharing',
    resultFamily: 'project_agent_sharing_update',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['project_agent_sharing_updated'],
    errorCodeFragments: ['set_project_agent_sharing'],
  },
  {
    commandType: 'get_project_agent_external_directory',
    resultFamily: 'project_agent_external_directory',
    requestId: { ui: 'required', wire: 'optional' },
    successEvents: ['project_agent_external_directory'],
    errorCodeFragments: ['project_agent_external_directory'],
  },
] as const satisfies readonly WsRequestContract<ContractCommandType, ContractSuccessEventType>[]

export type WsRequestContractType = (typeof WS_REQUEST_CONTRACTS)[number]['commandType']

export const WS_REQUEST_CONTRACT_TYPES = WS_REQUEST_CONTRACTS.map((contract) => contract.commandType)

export function getWsRequestContract(commandType: WsRequestContractType): (typeof WS_REQUEST_CONTRACTS)[number] {
  const contract = WS_REQUEST_CONTRACTS.find((candidate) => candidate.commandType === commandType)
  if (!contract) {
    throw new Error(`Unknown WebSocket request contract: ${commandType}`)
  }
  return contract
}

export function getWsRequestErrorCodeFragments(commandType: WsRequestContractType): readonly string[] {
  return getWsRequestContract(commandType).errorCodeFragments
}
