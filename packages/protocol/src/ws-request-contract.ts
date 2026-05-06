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
  | 'pick_directory'
  | 'get_session_workers'
  | 'rename_profile'
  | 'rename_session'
  | 'pin_session'
  | 'update_session_model'
  | 'fork_session'
  | 'update_profile_default_model'
  | 'update_manager_model'
  | 'update_manager_cwd'
  | 'create_session'
  | 'stop_session'
  | 'resume_session'
  | 'delete_session'
  | 'clear_session'
  | 'get_project_agent_config'
  | 'list_project_agent_references'
  | 'get_project_agent_reference'
  | 'set_project_agent_reference'
  | 'delete_project_agent_reference'
>
type ContractSuccessEventType = Extract<
  ServerEvent['type'],
  | 'directories_listed'
  | 'directory_validated'
  | 'directory_picked'
  | 'session_workers_snapshot'
  | 'profile_renamed'
  | 'session_renamed'
  | 'session_pinned'
  | 'session_model_updated'
  | 'session_forked'
  | 'profile_default_model_updated'
  | 'manager_model_updated'
  | 'manager_cwd_updated'
  | 'session_created'
  | 'session_stopped'
  | 'session_resumed'
  | 'session_deleted'
  | 'session_cleared'
  | 'project_agent_config'
  | 'project_agent_references'
  | 'project_agent_reference'
  | 'project_agent_reference_saved'
  | 'project_agent_reference_deleted'
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
