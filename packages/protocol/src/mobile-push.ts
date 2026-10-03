/**
 * Mobile Expo push registration and device-delivery contracts.
 *
 * `originId` is a client-stable per-registration identity. Servers persist it
 * with the device record and echo it on that device's deliveries. They must not
 * invent a global sender origin or put credential-bearing URLs in push data.
 */

export const MOBILE_PUSH_DATA_VERSION = 1 as const
export const MOBILE_PUSH_ORIGIN_ID_MAX_CODE_POINTS = 256
export const MOBILE_PUSH_ANDROID_CHANNEL_ID = 'agent-updates'

export const MOBILE_PUSH_PLATFORMS = ['ios', 'android', 'unknown'] as const
export type MobilePushPlatform = (typeof MOBILE_PUSH_PLATFORMS)[number]

/**
 * Current servers push only `attention` (a session newly entered Needs you;
 * `eventId` is its attentionId). The other types remain for older servers.
 */
export const MOBILE_PUSH_NOTIFICATION_TYPES = [
  'attention',
  'unread',
  'choice_request',
  'agent_status',
  'error',
  'test',
] as const
export type MobilePushNotificationType = (typeof MOBILE_PUSH_NOTIFICATION_TYPES)[number]

export const MOBILE_PUSH_NOTIFICATION_REASONS = ['message', 'choice_request'] as const
export type MobilePushNotificationReason = (typeof MOBILE_PUSH_NOTIFICATION_REASONS)[number]

export interface MobilePushRegisterRequest {
  token: string
  platform: MobilePushPlatform
  deviceName?: string
  enabled?: boolean
  /** Client-stable origin identity for this registration. Echoed on later device deliveries. */
  originId?: string
}

export interface MobilePushUnregisterRequest {
  token: string
}

export interface MobilePushDevice {
  token: string
  platform: MobilePushPlatform
  deviceName: string
  registeredAt: string
  enabled: boolean
  /** Present when the client supplied a stable origin at registration. */
  originId?: string
  updatedAt?: string
  disabledAt?: string
  disabledReason?: string
}

/**
 * Expo `data` payload. Additive fields may be absent on legacy records; clients
 * must fail closed when origin routing is ambiguous.
 */
export interface MobilePushData {
  v: typeof MOBILE_PUSH_DATA_VERSION
  type: MobilePushNotificationType
  reason?: MobilePushNotificationReason
  agentId: string
  sessionAgentId?: string
  profileId?: string
  route?: string
  originId?: string
  eventId?: string
}
