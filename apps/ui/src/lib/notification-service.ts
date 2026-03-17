import type { ManagerWsState } from './ws-state'

// ── Types ──

export interface SoundOption {
  id: string
  name: string
  /** URL path (for built-in) or data-URL (for custom uploads) */
  url: string
  builtIn: boolean
}

export interface AgentNotificationPrefs {
  unreadSound: { enabled: boolean; soundId: string }
  allDoneSound: { enabled: boolean; soundId: string }
  volume: number // 0–1
}

export interface CustomSound {
  id: string
  name: string
  dataUrl: string
}

export interface NotificationStore {
  agents: Record<string, AgentNotificationPrefs>
  customSounds: CustomSound[]
  globalEnabled: boolean
}

// ── Constants ──

const STORAGE_KEY = 'swarm-notifications'

const DEBOUNCE_MS = 2_000

export const BUILT_IN_SOUNDS: SoundOption[] = [
  { id: 'notification', name: 'Default Notification', url: '/sounds/notification.mp3', builtIn: true },
  { id: 'complete', name: 'Default Complete', url: '/sounds/complete.mp3', builtIn: true },
]

const DEFAULT_AGENT_PREFS: AgentNotificationPrefs = {
  unreadSound: { enabled: false, soundId: 'notification' },
  allDoneSound: { enabled: false, soundId: 'complete' },
  volume: 0.7,
}

const DEFAULT_STORE: NotificationStore = {
  agents: {},
  customSounds: [],
  globalEnabled: true,
}

// ── Storage ──

export function readNotificationStore(): NotificationStore {
  if (typeof window === 'undefined') return { ...DEFAULT_STORE }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_STORE }
    const parsed = JSON.parse(raw)
    return {
      agents: parsed.agents && typeof parsed.agents === 'object' ? parsed.agents : {},
      customSounds: Array.isArray(parsed.customSounds) ? parsed.customSounds : [],
      globalEnabled: typeof parsed.globalEnabled === 'boolean' ? parsed.globalEnabled : true,
    }
  } catch {
    return { ...DEFAULT_STORE }
  }
}

export function writeNotificationStore(store: NotificationStore): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Ignore write failures (storage full, restricted env, etc.)
  }
}

export function getAgentPrefs(store: NotificationStore, agentId: string): AgentNotificationPrefs {
  return store.agents[agentId] ?? { ...DEFAULT_AGENT_PREFS }
}

export function setAgentPrefs(
  store: NotificationStore,
  agentId: string,
  prefs: AgentNotificationPrefs,
): NotificationStore {
  return {
    ...store,
    agents: { ...store.agents, [agentId]: prefs },
  }
}

// ── Sound resolution ──

export function getAllSoundOptions(store: NotificationStore): SoundOption[] {
  const custom: SoundOption[] = store.customSounds.map((s) => ({
    id: s.id,
    name: s.name,
    url: s.dataUrl,
    builtIn: false,
  }))
  return [...BUILT_IN_SOUNDS, ...custom]
}

function resolveSoundUrl(soundId: string, store: NotificationStore): string | null {
  const builtIn = BUILT_IN_SOUNDS.find((s) => s.id === soundId)
  if (builtIn) return builtIn.url
  const custom = store.customSounds.find((s) => s.id === soundId)
  if (custom) return custom.dataUrl
  return null
}

// ── Audio playback ──

const audioCache = new Map<string, HTMLAudioElement>()

function getOrCreateAudio(url: string): HTMLAudioElement {
  let audio = audioCache.get(url)
  if (!audio) {
    audio = new Audio(url)
    audio.preload = 'auto'
    audioCache.set(url, audio)
  }
  return audio
}

/**
 * Pre-load built-in sounds so they're ready to play instantly.
 * Call once on app startup.
 */
export function preloadBuiltInSounds(): void {
  for (const sound of BUILT_IN_SOUNDS) {
    getOrCreateAudio(sound.url)
  }
}

function playSound(url: string, volume: number): void {
  try {
    const audio = getOrCreateAudio(url)
    audio.volume = Math.max(0, Math.min(1, volume))
    audio.currentTime = 0
    audio.play().catch(() => {
      // Swallow autoplay / user-gesture errors gracefully.
    })
  } catch {
    // Non-blocking: never let audio errors disrupt app flow.
  }
}

/**
 * Play a sound by its id for a preview/test.
 */
export function previewSound(soundId: string, store: NotificationStore, volume?: number): void {
  const url = resolveSoundUrl(soundId, store)
  if (!url) return
  playSound(url, volume ?? 0.7)
}

// ── Debounce tracking ──

const lastPlayedAt: Record<string, number> = {}

function canPlay(key: string): boolean {
  const now = Date.now()
  const last = lastPlayedAt[key]
  if (last && now - last < DEBOUNCE_MS) return false
  lastPlayedAt[key] = now
  return true
}

// ── Deferred completion tracking ──

/**
 * Tracks agents that have a pending all-done evaluation.
 * When a `speak_to_user` fires while the manager is still streaming,
 * we record the agent here and defer the all-done decision until the
 * manager transitions to idle.
 */
const pendingCompletionCheck = new Map<string, number>() // agentId → timestamp

// ── Trigger checks ──

function hasStreamingWorkers(managerAgentId: string, state: ManagerWsState): boolean {
  const hasLoadedStreamingWorker = state.agents.some((agent) => {
    if (agent.role !== 'worker' || agent.managerId !== managerAgentId) return false
    const liveStatus = state.statuses[agent.agentId]?.status ?? agent.status
    return liveStatus === 'streaming'
  })

  if (hasLoadedStreamingWorker) {
    return true
  }

  const manager = state.agents.find((agent) => agent.role === 'manager' && agent.agentId === managerAgentId)
  return (manager?.activeWorkerCount ?? 0) > 0
}

function isManagerStreaming(agentId: string, state: ManagerWsState): boolean {
  const liveStatus = state.statuses[agentId]?.status
  if (liveStatus) return liveStatus === 'streaming'
  const agent = state.agents.find((a) => a.agentId === agentId)
  return agent?.status === 'streaming'
}

export function shouldPlayUnread(
  prefsKey: string,
  agentId: string,
  state: ManagerWsState,
  store: NotificationStore,
): boolean {
  if (!store.globalEnabled) return false
  // Don't play for the currently viewed agent if the user is actively looking at it
  if (agentId === state.targetAgentId && document.hasFocus()) return false
  const prefs = getAgentPrefs(store, prefsKey)
  return prefs.unreadSound.enabled
}

export function shouldPlayAllDone(
  prefsKey: string,
  agentId: string,
  state: ManagerWsState,
  store: NotificationStore,
): boolean {
  if (!store.globalEnabled) return false
  // Don't play for the currently viewed agent if the user is actively looking at it
  if (agentId === state.targetAgentId && document.hasFocus()) return false
  const prefs = getAgentPrefs(store, prefsKey)
  if (!prefs.allDoneSound.enabled) return false
  // Hard safety guard: never classify as all-done while the manager itself is streaming.
  // speak_to_user is a tool call that fires mid-turn; workers may not be spawned yet.
  if (isManagerStreaming(agentId, state)) return false
  return !hasStreamingWorkers(agentId, state)
}

// ── Public API: play notification sounds ──

export function playUnread(prefsKey: string, store: NotificationStore): void {
  if (!canPlay(`unread:${prefsKey}`)) return
  const prefs = getAgentPrefs(store, prefsKey)
  const url = resolveSoundUrl(prefs.unreadSound.soundId, store)
  if (!url) return
  playSound(url, prefs.volume)
}

export function playAllDone(prefsKey: string, store: NotificationStore): void {
  if (!canPlay(`allDone:${prefsKey}`)) return
  const prefs = getAgentPrefs(store, prefsKey)
  const url = resolveSoundUrl(prefs.allDoneSound.soundId, store)
  if (!url) return
  playSound(url, prefs.volume)
}

/**
 * Main entry point — called from ws-client on `unread_notification`.
 *
 * Uses deferred classification to avoid false-positive "all done" sounds:
 * - If the manager is still streaming (mid-turn), the all-done decision is
 *   deferred until the manager goes idle. Only the unread sound plays now.
 * - If the manager is already idle (e.g. replayed history), classify immediately.
 */
export function handleUnreadNotification(
  agentId: string,
  state: ManagerWsState,
): void {
  const store = readNotificationStore()
  if (!store.globalEnabled) return

  // Resolve profileId-based prefs key (settings UI saves prefs keyed by profileId)
  const agent = state.agents.find((a) => a.agentId === agentId)
  const prefsKey = agent?.profileId ?? agentId

  if (isManagerStreaming(agentId, state)) {
    // Manager is mid-turn — defer the all-done decision until idle transition.
    // Record this agent as having a pending completion candidate.
    pendingCompletionCheck.set(agentId, Date.now())

    // Still play the lower-priority unread sound immediately for awareness.
    if (shouldPlayUnread(prefsKey, agentId, state, store)) {
      playUnread(prefsKey, store)
    }
    return
  }

  // Manager is already idle — classify immediately.
  // "All done" takes priority — it's the higher-importance sound.
  if (shouldPlayAllDone(prefsKey, agentId, state, store)) {
    playAllDone(prefsKey, store)
    return
  }

  // Fall back to the generic unread sound
  if (shouldPlayUnread(prefsKey, agentId, state, store)) {
    playUnread(prefsKey, store)
  }
}

/**
 * Called from ws-client when a manager transitions from `streaming` → `idle`.
 * Evaluates whether a deferred all-done sound should play now.
 */
export function handleManagerIdleTransition(
  agentId: string,
  state: ManagerWsState,
): void {
  // Only process if there's a pending completion candidate for this agent.
  if (!pendingCompletionCheck.has(agentId)) return
  pendingCompletionCheck.delete(agentId)

  const store = readNotificationStore()
  if (!store.globalEnabled) return

  const agent = state.agents.find((a) => a.agentId === agentId)
  const prefsKey = agent?.profileId ?? agentId

  // Now that the manager is idle, evaluate the deferred all-done check.
  // shouldPlayAllDone will verify no streaming workers remain.
  if (shouldPlayAllDone(prefsKey, agentId, state, store)) {
    playAllDone(prefsKey, store)
  }
  // No else — the unread sound already played at notification time.
}

// ── Custom sound management ──

export function addCustomSound(
  store: NotificationStore,
  name: string,
  dataUrl: string,
): NotificationStore {
  const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return {
    ...store,
    customSounds: [...store.customSounds, { id, name, dataUrl }],
  }
}

export function removeCustomSound(
  store: NotificationStore,
  soundId: string,
): NotificationStore {
  return {
    ...store,
    customSounds: store.customSounds.filter((s) => s.id !== soundId),
    // Also clear any agent prefs that reference this sound
    agents: Object.fromEntries(
      Object.entries(store.agents).map(([agentId, prefs]) => {
        let updated = prefs
        if (prefs.unreadSound.soundId === soundId) {
          updated = { ...updated, unreadSound: { ...updated.unreadSound, soundId: 'notification' } }
        }
        if (prefs.allDoneSound.soundId === soundId) {
          updated = { ...updated, allDoneSound: { ...updated.allDoneSound, soundId: 'complete' } }
        }
        return [agentId, updated]
      }),
    ),
  }
}
