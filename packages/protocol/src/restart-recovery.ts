export interface RestartRecoveryReport {
  deliveryId: string
  fromAgentId: string
  toAgentId: string
  turnId?: string
  assignmentId?: string
}

export interface RestartRecoverySnapshot {
  bootId: string
  createdAt: string
  interruptedManagers: string[]
  interruptedWorkers: string[]
  undeliveredReports: RestartRecoveryReport[]
  dismissedAt?: string
  resumedAt?: string
}

export interface RestartRecoverySnapshotEvent {
  type: 'restart_recovery_snapshot'
  snapshot: RestartRecoverySnapshot | null
  requestId?: string
}
