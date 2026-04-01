import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ManagerWsState } from './ws-state'
import {
  readNotificationStore,
  handleUnreadNotification,
  removeCustomSound,
  type NotificationStore,
} from './notification-service'

// ── Mocks ──

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
  }
})()

Object.defineProperty(globalThis, 'window', {
  value: { localStorage: localStorageMock },
  writable: true,
})

// Mock document.hasFocus — default to not focused (so sounds can play)
Object.defineProperty(globalThis, 'document', {
  value: { hasFocus: () => false },
  writable: true,
})

// Track Audio play calls
const audioPlayCalls: { url: string; volume: number }[] = []
const mockAudioInstances = new Map<string, { volume: number; currentTime: number; play: () => Promise<void>; preload: string }>()

vi.stubGlobal('Audio', class MockAudio {
  url: string
  volume = 1
  currentTime = 0
  preload = ''

  constructor(url: string) {
    this.url = url
    mockAudioInstances.set(url, this as unknown as { volume: number; currentTime: number; play: () => Promise<void>; preload: string })
  }

  play() {
    audioPlayCalls.push({ url: this.url, volume: this.volume })
    return Promise.resolve()
  }
})

// ── Helpers ──

function makeState(overrides: Partial<ManagerWsState> = {}): ManagerWsState {
  return {
    connected: true,
    targetAgentId: null,
    subscribedAgentId: null,
    messages: [],
    activityMessages: [],
    pendingChoiceIds: new Set(),
    agents: [],
    loadedSessionIds: new Set(),
    profiles: [],
    statuses: {},
    lastError: null,
    lastSuccess: null,
    telegramStatus: null,
    playwrightSnapshot: null,
    playwrightSettings: null,
    unreadCounts: {},
    terminals: [],
    ...overrides,
  } as ManagerWsState
}

function makeLegacyStore(overrides: Partial<{
  globalEnabled: boolean
  defaults: Record<string, unknown>
  agents: Record<string, Record<string, unknown>>
  customSounds: unknown[]
}> = {}): string {
  return JSON.stringify({
    globalEnabled: true,
    defaults: {
      unreadSound: { enabled: true, soundId: 'notification' },
      allDoneSound: { enabled: true, soundId: 'complete' },
      volume: 0.7,
      ...overrides.defaults,
    },
    agents: overrides.agents ?? {},
    customSounds: overrides.customSounds ?? [],
  })
}

const STORAGE_KEY = 'swarm-notifications'

// ── Tests ──

describe('notification-service', () => {
  beforeEach(() => {
    localStorageMock.clear()
    audioPlayCalls.length = 0
    mockAudioInstances.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Migration tests ──

  describe('readNotificationStore migration', () => {
    it('adds questionSound to defaults when missing', () => {
      localStorageMock.setItem(STORAGE_KEY, makeLegacyStore())
      const store = readNotificationStore()
      expect(store.defaults.questionSound).toEqual({ enabled: true, soundId: 'question' })
    })

    it('adds questionSound to per-agent prefs when missing', () => {
      localStorageMock.setItem(STORAGE_KEY, makeLegacyStore({
        agents: {
          'profile-1': {
            unreadSound: { enabled: true, soundId: 'notification' },
            allDoneSound: { enabled: false, soundId: 'complete' },
            volume: 0.5,
          },
        },
      }))

      const store = readNotificationStore()
      expect(store.agents['profile-1'].questionSound).toEqual({ enabled: true, soundId: 'question' })
    })

    it('preserves existing questionSound when already present', () => {
      const fullStore: NotificationStore = {
        globalEnabled: true,
        defaults: {
          unreadSound: { enabled: true, soundId: 'notification' },
          allDoneSound: { enabled: true, soundId: 'complete' },
          questionSound: { enabled: false, soundId: 'custom-123' },
          volume: 0.7,
        },
        agents: {},
        customSounds: [],
      }
      localStorageMock.setItem(STORAGE_KEY, JSON.stringify(fullStore))
      const store = readNotificationStore()
      expect(store.defaults.questionSound).toEqual({ enabled: false, soundId: 'custom-123' })
    })

    it('persists migrated store back to localStorage', () => {
      localStorageMock.setItem(STORAGE_KEY, makeLegacyStore())
      readNotificationStore()
      // Should have been written back
      const writtenCalls = localStorageMock.setItem.mock.calls.filter(
        (call: [string, string]) => call[0] === STORAGE_KEY,
      )
      expect(writtenCalls.length).toBeGreaterThan(0)
      const persisted = JSON.parse(writtenCalls[writtenCalls.length - 1][1])
      expect(persisted.defaults.questionSound).toEqual({ enabled: true, soundId: 'question' })
    })

    it('returns default store when no data exists', () => {
      const store = readNotificationStore()
      expect(store.defaults.questionSound).toEqual({ enabled: true, soundId: 'question' })
    })
  })

  // ── handleUnreadNotification tests ──

  describe('handleUnreadNotification', () => {
    function setupStore(overrides: Partial<NotificationStore> = {}): void {
      const store: NotificationStore = {
        globalEnabled: true,
        defaults: {
          unreadSound: { enabled: true, soundId: 'notification' },
          allDoneSound: { enabled: true, soundId: 'complete' },
          questionSound: { enabled: true, soundId: 'question' },
          volume: 0.7,
        },
        agents: {},
        customSounds: [],
        ...overrides,
      }
      localStorageMock.setItem(STORAGE_KEY, JSON.stringify(store))
    }

    it('plays question sound for choice_request when enabled', () => {
      setupStore()
      const state = makeState({
        agents: [
          { agentId: 'mgr-1', role: 'manager', profileId: 'profile-1', status: 'idle' } as never,
        ],
        statuses: { 'mgr-1': { status: 'idle', pendingCount: 0 } },
      })

      handleUnreadNotification('mgr-1', state, 'choice_request')

      expect(audioPlayCalls).toHaveLength(1)
      expect(audioPlayCalls[0].url).toBe('/sounds/question.mp3')
    })

    it('plays unread (not all-done) for choice_request when question sound disabled', () => {
      setupStore({
        defaults: {
          unreadSound: { enabled: true, soundId: 'notification' },
          allDoneSound: { enabled: true, soundId: 'complete' },
          questionSound: { enabled: false, soundId: 'question' },
          volume: 0.7,
        },
      })
      const state = makeState({
        agents: [
          { agentId: 'mgr-1', role: 'manager', profileId: 'profile-1', status: 'idle' } as never,
        ],
        statuses: { 'mgr-1': { status: 'idle', pendingCount: 0 } },
      })

      handleUnreadNotification('mgr-1', state, 'choice_request')

      // Should play unread, NOT all-done
      expect(audioPlayCalls).toHaveLength(1)
      expect(audioPlayCalls[0].url).toBe('/sounds/notification.mp3')
    })

    it('does not play all-done for choice_request even when manager is idle', () => {
      setupStore({
        defaults: {
          unreadSound: { enabled: false, soundId: 'notification' },
          allDoneSound: { enabled: true, soundId: 'complete' },
          questionSound: { enabled: false, soundId: 'question' },
          volume: 0.7,
        },
      })
      const state = makeState({
        agents: [
          { agentId: 'mgr-1', role: 'manager', profileId: 'profile-1', status: 'idle' } as never,
        ],
        statuses: { 'mgr-1': { status: 'idle', pendingCount: 0 } },
      })

      handleUnreadNotification('mgr-1', state, 'choice_request')

      // Both question and unread disabled — nothing should play, including all-done
      expect(audioPlayCalls).toHaveLength(0)
    })

    it('preserves legacy behavior for message reason (undefined)', () => {
      setupStore()
      const state = makeState({
        agents: [
          { agentId: 'mgr-1', role: 'manager', profileId: 'profile-1', status: 'idle' } as never,
        ],
        statuses: { 'mgr-1': { status: 'idle', pendingCount: 0 } },
      })

      // No reason (legacy) — should enter normal classification, all-done first if idle
      handleUnreadNotification('mgr-1', state)

      // With manager idle and no workers, all-done should play (it takes priority)
      expect(audioPlayCalls).toHaveLength(1)
      expect(audioPlayCalls[0].url).toBe('/sounds/complete.mp3')
    })

    it('preserves legacy behavior for message reason (explicit message)', () => {
      setupStore()
      const state = makeState({
        agents: [
          { agentId: 'mgr-msg', role: 'manager', profileId: 'profile-msg', status: 'streaming' } as never,
        ],
        statuses: { 'mgr-msg': { status: 'streaming', pendingCount: 0 } },
      })

      // Explicit 'message' — same as legacy, defers all-done when streaming
      handleUnreadNotification('mgr-msg', state, 'message')

      // Manager is streaming — should play unread now, defer all-done
      expect(audioPlayCalls).toHaveLength(1)
      expect(audioPlayCalls[0].url).toBe('/sounds/notification.mp3')
    })

    it('resolves prefs via sessionAgentId for worker-originated events', () => {
      setupStore({
        agents: {
          'profile-worker': {
            unreadSound: { enabled: true, soundId: 'notification' },
            allDoneSound: { enabled: true, soundId: 'complete' },
            questionSound: { enabled: false, soundId: 'question' },
            volume: 0.7,
          },
        },
      })
      const state = makeState({
        agents: [
          { agentId: 'mgr-w', role: 'manager', profileId: 'profile-worker', status: 'streaming' } as never,
          { agentId: 'worker-w1', role: 'worker', managerId: 'mgr-w', status: 'streaming' } as never,
        ],
        statuses: {
          'mgr-w': { status: 'streaming', pendingCount: 0 },
          'worker-w1': { status: 'streaming', pendingCount: 0 },
        },
      })

      // Worker-originated choice_request — sessionAgentId resolves to manager's profile
      handleUnreadNotification('worker-w1', state, 'choice_request', 'mgr-w')

      // question is disabled for profile-worker, should play unread
      expect(audioPlayCalls).toHaveLength(1)
      expect(audioPlayCalls[0].url).toBe('/sounds/notification.mp3')
    })

    it('plays no sound when global notifications are disabled', () => {
      setupStore({ globalEnabled: false })
      const state = makeState({
        agents: [
          { agentId: 'mgr-1', role: 'manager', profileId: 'profile-1', status: 'idle' } as never,
        ],
      })

      handleUnreadNotification('mgr-1', state, 'choice_request')
      expect(audioPlayCalls).toHaveLength(0)
    })
  })

  // ── removeCustomSound tests ──

  describe('removeCustomSound', () => {
    it('resets questionSound.soundId when custom sound is removed', () => {
      const store: NotificationStore = {
        globalEnabled: true,
        defaults: {
          unreadSound: { enabled: true, soundId: 'notification' },
          allDoneSound: { enabled: true, soundId: 'complete' },
          questionSound: { enabled: true, soundId: 'custom-abc' },
          volume: 0.7,
        },
        agents: {
          'profile-1': {
            unreadSound: { enabled: true, soundId: 'notification' },
            allDoneSound: { enabled: true, soundId: 'complete' },
            questionSound: { enabled: true, soundId: 'custom-abc' },
            volume: 0.7,
          },
        },
        customSounds: [{ id: 'custom-abc', name: 'My Sound', dataUrl: 'data:audio/mp3;base64,...' }],
      }

      const updated = removeCustomSound(store, 'custom-abc')

      expect(updated.defaults.questionSound.soundId).toBe('question')
      expect(updated.agents['profile-1'].questionSound.soundId).toBe('question')
      expect(updated.customSounds).toHaveLength(0)
    })

    it('does not reset questionSound when a different custom sound is removed', () => {
      const store: NotificationStore = {
        globalEnabled: true,
        defaults: {
          unreadSound: { enabled: true, soundId: 'notification' },
          allDoneSound: { enabled: true, soundId: 'complete' },
          questionSound: { enabled: true, soundId: 'question' },
          volume: 0.7,
        },
        agents: {},
        customSounds: [{ id: 'custom-xyz', name: 'Other', dataUrl: 'data:audio/mp3;base64,...' }],
      }

      const updated = removeCustomSound(store, 'custom-xyz')

      expect(updated.defaults.questionSound.soundId).toBe('question')
    })
  })
})
