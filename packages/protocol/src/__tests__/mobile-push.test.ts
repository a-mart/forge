import { describe, expect, it } from 'vitest'
import {
  MOBILE_PUSH_ANDROID_CHANNEL_ID,
  MOBILE_PUSH_DATA_VERSION,
  MOBILE_PUSH_NOTIFICATION_TYPES,
  MOBILE_PUSH_ORIGIN_ID_MAX_CODE_POINTS,
  MOBILE_PUSH_PLATFORMS,
  type MobilePushData,
  type MobilePushDevice,
  type MobilePushRegisterRequest,
} from '../index.js'

describe('mobile push protocol', () => {
  it('exports additive registration and delivery contracts from the root barrel', () => {
    const request: MobilePushRegisterRequest = {
      token: 'ExpoPushToken[device]',
      platform: 'ios',
      deviceName: 'iPhone',
      originId: 'server-a',
    }
    const device: MobilePushDevice = {
      token: request.token,
      platform: request.platform,
      deviceName: 'iPhone',
      registeredAt: '2026-09-06T00:00:00.000Z',
      enabled: true,
      originId: request.originId,
    }
    const data: MobilePushData = {
      v: MOBILE_PUSH_DATA_VERSION,
      type: 'unread',
      reason: 'message',
      agentId: 'manager',
      sessionAgentId: 'manager',
      profileId: 'profile-a',
      route: '/profiles/profile-a/sessions/manager',
      originId: 'server-a',
      eventId: 'evt-1',
    }
    const legacyData: MobilePushData = {
      v: MOBILE_PUSH_DATA_VERSION,
      type: 'unread',
      agentId: 'manager',
    }

    expect(MOBILE_PUSH_DATA_VERSION).toBe(1)
    expect(MOBILE_PUSH_ANDROID_CHANNEL_ID).toBe('agent-updates')
    expect(MOBILE_PUSH_ORIGIN_ID_MAX_CODE_POINTS).toBe(256)
    expect(MOBILE_PUSH_PLATFORMS).toEqual(['ios', 'android', 'unknown'])
    expect(MOBILE_PUSH_NOTIFICATION_TYPES).toContain('unread')
    expect(device.originId).toBe('server-a')
    expect(data.originId).toBe('server-a')
    expect(legacyData.originId).toBeUndefined()
    expect(legacyData.eventId).toBeUndefined()
  })
})
