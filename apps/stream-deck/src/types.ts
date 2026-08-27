import type {
  StreamDeckActionRequest,
  StreamDeckActionResponse,
  StreamDeckSessionSummary,
  StreamDeckSnapshot,
  StreamDeckPairingClaimResponse,
  StreamDeckPairingRequestCreated,
} from '@forge/protocol'

export type {
  StreamDeckActionRequest,
  StreamDeckActionResponse,
  StreamDeckPairingClaimResponse,
  StreamDeckPairingRequestCreated,
  StreamDeckSessionSummary,
  StreamDeckSnapshot,
}

export interface ForgeGlobalSettings {
  [key: string]: string | number | boolean | undefined
  baseUrl?: string
  accessToken?: string
  apiKey?: string
  pollIntervalMs?: number
  deviceId?: string
  pairingRequestId?: string
  pairingCode?: string
  pairingExpiresAt?: string
}

export interface ForgeActionSettings {
  [key: string]: string | number | boolean | undefined
  slot?: number
  targetAgentId?: string
  targetProfileId?: string
  targetMode?: 'attention' | 'slot' | 'fixed'
  view?: 'chat' | 'git' | 'browser' | 'terminal' | 'stats' | 'tokens'
  prompt?: string
  label?: string
  control?: 'toggle' | 'compact' | 'mark_read'
}

export type ForgeActionKind =
  | 'pulse'
  | 'session'
  | 'attention'
  | 'workers'
  | 'context'
  | 'stats'
  | 'view'
  | 'mission'
  | 'control'
  | 'new-session'

export interface VisibleForgeAction {
  id: string
  kind: ForgeActionKind
  action: {
    setImage(image?: string): Promise<void>
    showAlert(): Promise<void>
    showOk(): Promise<void>
  }
  settings: ForgeActionSettings
}
