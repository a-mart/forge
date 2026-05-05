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
>
type ContractSuccessEventType = Extract<
  ServerEvent['type'],
  | 'directories_listed'
  | 'directory_validated'
  | 'directory_picked'
  | 'session_workers_snapshot'
  | 'profile_renamed'
  | 'session_renamed'
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
