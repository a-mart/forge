export type TerminalLifecycleState =
  | 'running'
  | 'exited'
  | 'restoring'
  | 'restore_failed'

export type TerminalCloseReason =
  | 'user_closed'
  | 'session_deleted'
  | 'manager_deleted'
  | 'shutdown'
  | 'orphan_cleanup'

export interface TerminalDescriptor {
  terminalId: string
  sessionAgentId: string
  profileId: string
  name: string
  shell: string
  cwd: string
  cols: number
  rows: number
  state: TerminalLifecycleState
  pid: number | null
  exitCode: number | null
  exitSignal: number | null
  recoveredFromPersistence: boolean
  createdAt: string
  updatedAt: string
}

/** Durable on-disk metadata contract */
export interface TerminalMeta {
  version: 1
  terminalId: string
  sessionAgentId: string
  profileId: string
  name: string
  shell: string
  shellArgs: string[]
  cwd: string
  cols: number
  rows: number
  state: TerminalLifecycleState
  pid: number | null
  exitCode: number | null
  exitSignal: number | null
  checkpointSeq: number
  nextSeq: number
  recoveredFromPersistence: boolean
  createdAt: string
  updatedAt: string
}

export interface TerminalCreateRequest {
  sessionAgentId: string
  name?: string
  shell?: string
  shellArgs?: string[]
  cwd?: string
  cols?: number
  rows?: number
}

export interface TerminalCreateResponse {
  terminal: TerminalDescriptor
  ticket: string
  ticketExpiresAt: string
}

export interface TerminalListResponse {
  terminals: TerminalDescriptor[]
}

export interface TerminalRenameRequest {
  sessionAgentId: string
  name: string
}

export interface TerminalRenameResponse {
  terminal: TerminalDescriptor
}

export interface TerminalResizeRequest {
  sessionAgentId: string
  cols: number
  rows: number
}

export interface TerminalResizeResponse {
  terminal: TerminalDescriptor
}

export interface TerminalDeleteRequest {
  sessionAgentId: string
}

export interface TerminalIssueTicketRequest {
  sessionAgentId: string
}

export interface TerminalIssueTicketResponse {
  ticket: string
  ticketExpiresAt: string
}

export type TerminalDefaultShellSource = 'settings' | 'env' | 'default'

export interface AvailableTerminalShell {
  path: string
  name: string
  available: boolean
}

export interface TerminalSettings {
  defaultShell: string | null
  persistedDefaultShell: string | null
  source: TerminalDefaultShellSource
}

export interface GetAvailableTerminalShellsResponse {
  shells: AvailableTerminalShell[]
  settings: TerminalSettings
}

export interface GetTerminalSettingsResponse {
  settings: TerminalSettings
}

export interface UpdateTerminalSettingsRequest {
  defaultShell?: string | null
}

export interface UpdateTerminalSettingsResponse {
  ok: true
  settings: TerminalSettings
}

export interface TerminalCreatedEvent {
  type: 'terminal_created'
  sessionAgentId: string
  terminal: TerminalDescriptor
}

export interface TerminalUpdatedEvent {
  type: 'terminal_updated'
  sessionAgentId: string
  terminal: TerminalDescriptor
}

export interface TerminalClosedEvent {
  type: 'terminal_closed'
  sessionAgentId: string
  terminalId: string
  reason: TerminalCloseReason
}

export interface TerminalsSnapshotEvent {
  type: 'terminals_snapshot'
  sessionAgentId: string
  terminals: TerminalDescriptor[]
}

export type TerminalWsClientControlMessage =
  | { channel: 'control'; type: 'resize'; cols: number; rows: number }
  | { channel: 'control'; type: 'ping' }

export type TerminalWsServerControlMessage =
  | {
      channel: 'control'
      type: 'ready'
      terminalId: string
      sessionAgentId: string
      cols: number
      rows: number
      state: TerminalLifecycleState
      recoveredFromPersistence: boolean
    }
  | { channel: 'control'; type: 'pong' }
  | {
      channel: 'control'
      type: 'exit'
      exitCode: number | null
      exitSignal: number | null
    }
  | {
      channel: 'control'
      type: 'closed'
      reason: TerminalCloseReason
    }
  | {
      channel: 'control'
      type: 'error'
      code: string
      message: string
    }
