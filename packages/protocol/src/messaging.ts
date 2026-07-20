export type DeliveryMode = 'auto' | 'followUp' | 'steer'
export type AcceptedDeliveryMode = 'prompt' | 'followUp' | 'steer'

export type MessageChannel = 'web' | 'cli'
/** Backend-only persistence compatibility for records written before channel retirement. */
export type PersistedMessageChannel = MessageChannel | 'telegram'

export interface MessageSourceContext {
  channel: PersistedMessageChannel
  channelId?: string
  userId?: string
  messageId?: string
  threadTs?: string
  integrationProfileId?: string
  channelType?: 'dm' | 'channel' | 'group' | 'mpim'
  teamId?: string
}

export interface MessageTargetContext {
  channel: 'web'
  channelId?: string
  userId?: string
  threadTs?: string
  integrationProfileId?: string
}

/** True only for historical rows from the retired external channel. */
export function isRetiredMessageSource(sourceContext: MessageSourceContext | undefined): boolean {
  return sourceContext?.channel === 'telegram'
}
