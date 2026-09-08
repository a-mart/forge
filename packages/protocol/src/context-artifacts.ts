import type { SessionContextModeSnapshot } from './context-mode.js'

/** Read-only, bounded projection of the manager's canonical task-note store. */
export interface ContextArtifactFile {
  path: string
  kind: 'checkpoint' | 'working' | 'recovery'
  text: string
  revision: number
  digest: string
  bytes: number
  updatedAt: string
}

export interface SessionContextArtifacts {
  contextMode: SessionContextModeSnapshot
  revision: number
  files: ContextArtifactFile[]
}

/** Reject malformed responses before displaying session-owned text. */
export function isSessionContextArtifacts(value: unknown): value is SessionContextArtifacts {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as SessionContextArtifacts
  const mode = snapshot.contextMode
  const validMode = (candidate: unknown) => candidate === 'fresh' || candidate === 'summary'
  return !!mode && typeof mode.sessionAgentId === 'string' && typeof mode.profileId === 'string'
    && validMode(mode.projectDefault) && validMode(mode.effectiveMode)
    && (mode.appliedMode === undefined || validMode(mode.appliedMode))
    && (mode.sessionOverride === undefined || validMode(mode.sessionOverride))
    && typeof mode.freshSupported === 'boolean'
    && (mode.unsupportedReason === undefined || typeof mode.unsupportedReason === 'string')
    && Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0
    && Array.isArray(snapshot.files) && snapshot.files.length <= 64
    && new Set(snapshot.files.map(file => file?.path)).size === snapshot.files.length
    && snapshot.files.every(file => !!file && typeof file.path === 'string' && file.path.length <= 160
      && ['checkpoint', 'working', 'recovery'].includes(file.kind)
      && typeof file.text === 'string' && file.text.length <= 128 * 1024
      && Number.isSafeInteger(file.revision) && file.revision >= 1
      && Number.isSafeInteger(file.bytes) && file.bytes >= 0
      && typeof file.digest === 'string' && /^[a-f0-9]{64}$/.test(file.digest)
      && typeof file.updatedAt === 'string' && Number.isFinite(Date.parse(file.updatedAt)))
}
