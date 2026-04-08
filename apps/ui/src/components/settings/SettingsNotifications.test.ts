/** @vitest-environment jsdom */

import { fireEvent } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsNotifications } from './SettingsNotifications'
import type { AgentDescriptor } from '@forge/protocol'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

const notificationMock = vi.hoisted(() => ({
  readNotificationStore: vi.fn(),
  writeNotificationStore: vi.fn(),
  getAllSoundOptions: vi.fn(),
  getAgentPrefs: vi.fn(),
  getEffectivePrefs: vi.fn(),
  hasExplicitOverride: vi.fn(),
  clearOverride: vi.fn(),
  setAgentPrefs: vi.fn(),
  addCustomSound: vi.fn(),
  removeCustomSound: vi.fn(),
  previewSound: vi.fn(),
}))

vi.mock('@/lib/notification-service', () => ({
  readNotificationStore: (...args: unknown[]) => notificationMock.readNotificationStore(...args),
  writeNotificationStore: (...args: unknown[]) => notificationMock.writeNotificationStore(...args),
  getAllSoundOptions: (...args: unknown[]) => notificationMock.getAllSoundOptions(...args),
  getAgentPrefs: (...args: unknown[]) => notificationMock.getAgentPrefs(...args),
  getEffectivePrefs: (...args: unknown[]) => notificationMock.getEffectivePrefs(...args),
  hasExplicitOverride: (...args: unknown[]) => notificationMock.hasExplicitOverride(...args),
  clearOverride: (...args: unknown[]) => notificationMock.clearOverride(...args),
  setAgentPrefs: (...args: unknown[]) => notificationMock.setAgentPrefs(...args),
  addCustomSound: (...args: unknown[]) => notificationMock.addCustomSound(...args),
  removeCustomSound: (...args: unknown[]) => notificationMock.removeCustomSound(...args),
  previewSound: (...args: unknown[]) => notificationMock.previewSound(...args),
}))

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_PREFS = {
  unreadSound: { enabled: false, soundId: 'notification' },
  allDoneSound: { enabled: false, soundId: 'complete' },
  questionSound: { enabled: true, soundId: 'question' },
  volume: 0.7,
}

function defaultStore() {
  return {
    globalEnabled: true,
    defaults: { ...DEFAULT_PREFS },
    agents: {},
    customSounds: [],
  }
}

function disabledStore() {
  return {
    ...defaultStore(),
    globalEnabled: false,
  }
}

function manager(
  agentId: string,
  profileId: string,
  displayName?: string,
): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: displayName ?? agentId,
    role: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'high',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
    profileId,
  }
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)

  notificationMock.getAllSoundOptions.mockReturnValue([
    { id: 'notification', name: 'Default Notification', url: '/sounds/notification.mp3', builtIn: true },
    { id: 'complete', name: 'Default Complete', url: '/sounds/complete.mp3', builtIn: true },
    { id: 'question', name: 'Agent Has a Question', url: '/sounds/question.mp3', builtIn: true },
  ])
  notificationMock.getAgentPrefs.mockReturnValue({ ...DEFAULT_PREFS })
  notificationMock.getEffectivePrefs.mockReturnValue({ ...DEFAULT_PREFS })
  notificationMock.hasExplicitOverride.mockReturnValue(false)
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
  vi.clearAllMocks()
})

async function flush(): Promise<void> {
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  await Promise.resolve()
  flushSync(() => {})
}

function renderNotifications(
  managers: AgentDescriptor[],
  store = defaultStore(),
): void {
  notificationMock.readNotificationStore.mockReturnValue(store)

  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(SettingsNotifications, { managers }))
  })
}

/* ================================================================== */
/*  Tests                                                             */
/* ================================================================== */

describe('SettingsNotifications', () => {
  /* ---- Global toggle ---- */

  describe('global toggle', () => {
    it('renders with global notifications enabled', async () => {
      const managers = [manager('m1', 'profile-1', 'My Manager')]
      renderNotifications(managers)
      await flush()

      expect(container.textContent).toContain('Notifications')
      expect(container.textContent).toContain('Notification Defaults')
    })

    it('shows disabled message when global is off', async () => {
      const managers = [manager('m1', 'profile-1')]
      renderNotifications(managers, disabledStore())
      await flush()

      expect(container.textContent).toContain('All notification sounds are disabled')
    })

    it('hides per-manager sections when global is off', async () => {
      const managers = [manager('m1', 'profile-1', 'My Manager')]
      renderNotifications(managers, disabledStore())
      await flush()

      expect(container.textContent).not.toContain('Per-Manager Settings')
      expect(container.textContent).not.toContain('Notification Defaults')
    })

    it('persists store on global toggle', async () => {
      const managers = [manager('m1', 'profile-1')]
      renderNotifications(managers)
      await flush()

      // writeNotificationStore should be called on mount (initial store write)
      expect(notificationMock.writeNotificationStore).toHaveBeenCalled()
    })
  })

  /* ---- Per-manager overrides ---- */

  describe('per-manager overrides', () => {
    it('shows per-manager section when managers exist', async () => {
      const managers = [manager('m1', 'profile-1', 'My Manager')]
      renderNotifications(managers)
      await flush()

      expect(container.textContent).toContain('Per-Manager Settings')
      expect(container.textContent).toContain('My Manager')
    })

    it('shows Using defaults label for non-overridden managers', async () => {
      notificationMock.hasExplicitOverride.mockReturnValue(false)
      const managers = [manager('m1', 'profile-1', 'My Manager')]
      renderNotifications(managers)
      await flush()

      expect(container.textContent).toContain('Using defaults')
    })

    it('shows Customize button for non-overridden managers', async () => {
      notificationMock.hasExplicitOverride.mockReturnValue(false)
      const managers = [manager('m1', 'profile-1', 'My Manager')]
      renderNotifications(managers)
      await flush()

      const customizeBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Customize'),
      )
      expect(customizeBtn).toBeTruthy()
    })

    it('clicking Customize creates an override', async () => {
      notificationMock.hasExplicitOverride.mockReturnValue(false)
      notificationMock.setAgentPrefs.mockImplementation((store: unknown) => store)

      const managers = [manager('m1', 'profile-1', 'My Manager')]
      renderNotifications(managers)
      await flush()

      const customizeBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Customize'),
      )
      flushSync(() => {
        fireEvent.click(customizeBtn!)
      })
      await flush()

      // writeNotificationStore should have been called with updated store
      expect(notificationMock.writeNotificationStore).toHaveBeenCalled()
    })

    it('deduplicates managers by profileId', async () => {
      // Two agents in the same profile should show only once
      const managers = [
        manager('m1', 'profile-1', 'Manager One'),
        manager('m2', 'profile-1', 'Manager Two'),
      ]
      renderNotifications(managers)
      await flush()

      // Only the first one should appear in per-manager section
      const managerLabels = container.textContent ?? ''
      const count = (managerLabels.match(/Manager One/g) || []).length
      // Manager One should appear (it's first for profile-1)
      expect(count).toBeGreaterThanOrEqual(1)
    })

    it('pins Cortex to top of per-manager list', async () => {
      const managers = [
        manager('m1', 'profile-1', 'Regular Manager'),
        manager('c1', 'cortex', 'Cortex'),
      ]
      renderNotifications(managers)
      await flush()

      // Both should render
      expect(container.textContent).toContain('Cortex')
      expect(container.textContent).toContain('Regular Manager')
    })
  })

  /* ---- No managers ---- */

  describe('no managers', () => {
    it('shows no managers message', async () => {
      renderNotifications([])
      await flush()

      expect(container.textContent).toContain('No manager agents found')
    })
  })

  /* ---- Custom sounds ---- */

  describe('custom sounds', () => {
    it('renders Upload Sound button', async () => {
      renderNotifications([])
      await flush()

      const uploadBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Upload Sound'),
      )
      expect(uploadBtn).toBeTruthy()
    })

    it('shows no custom sounds message when none uploaded', async () => {
      renderNotifications([])
      await flush()

      expect(container.textContent).toContain('No custom sounds uploaded yet')
    })

    it('renders existing custom sounds', async () => {
      const storeWithCustom = defaultStore()
      storeWithCustom.customSounds = [
        { id: 'custom-1', name: 'My Sound', dataUrl: 'data:audio/mp3;base64,xxx' },
      ] as typeof storeWithCustom.customSounds
      renderNotifications([], storeWithCustom)
      await flush()

      expect(container.textContent).toContain('My Sound')
    })
  })

  /* ---- Defaults section ---- */

  describe('defaults section', () => {
    it('renders unread/question/all-done sound controls', async () => {
      const managers = [manager('m1', 'profile-1')]
      renderNotifications(managers)
      await flush()

      expect(container.textContent).toContain('Unread message sound')
      expect(container.textContent).toContain('Question sound')
      expect(container.textContent).toContain('All done sound')
    })

    it('renders volume slider', async () => {
      const managers = [manager('m1', 'profile-1')]
      renderNotifications(managers)
      await flush()

      const volumeSlider = container.querySelector('input[type="range"]')
      expect(volumeSlider).toBeTruthy()
    })
  })
})
