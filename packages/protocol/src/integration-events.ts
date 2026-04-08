export type TelegramConnectionState =
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'

export interface TelegramStatusEvent {
  type: 'telegram_status'
  managerId?: string
  integrationProfileId?: string
  state: TelegramConnectionState
  enabled: boolean
  updatedAt: string
  message?: string
  botId?: string
  botUsername?: string
}
