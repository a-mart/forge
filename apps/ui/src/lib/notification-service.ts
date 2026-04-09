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
  questionSound: { enabled: boolean; soundId: string }
  volume: number // 0–1
}

export interface CustomSound {
  id: string
  name: string
  dataUrl: string
}

export interface NotificationStore {
  globalEnabled: boolean
  defaults: AgentNotificationPrefs
  agents: Record<string, AgentNotificationPrefs>
  customSounds: CustomSound[]
  mutedAgents?: string[]
}

// ── Constants ──

const STORAGE_KEY = 'swarm-notifications'
const MUTE_CHANGE_EVENT = 'forge-mute-change'

const DEBOUNCE_MS = 2_000

const BUILT_IN_SOUNDS: SoundOption[] = [
  { id: 'notification', name: 'Default Notification', url: '/sounds/notification.mp3', builtIn: true },
  { id: 'complete', name: 'Default Complete', url: '/sounds/complete.mp3', builtIn: true },
  { id: 'question', name: 'Agent Has a Question', url: '/sounds/question.mp3', builtIn: true },
]

const DEFAULT_AGENT_PREFS: AgentNotificationPrefs = {
  unreadSound: { enabled: false, soundId: 'notification' },
  allDoneSound: { enabled: false, soundId: 'complete' },
  questionSound: { enabled: true, soundId: 'question' },
  volume: 0.7,
}

const DEFAULT_AGENT_PREFS_DISABLED: AgentNotificationPrefs = {
  unreadSound: { enabled: false, soundId: 'notification' },
  allDoneSound: { enabled: false, soundId: 'complete' },
  questionSound: { enabled: false, soundId: 'question' },
  volume: 0.7,
}

const DEFAULT_STORE: NotificationStore = {
  globalEnabled: true,
  defaults: { ...DEFAULT_AGENT_PREFS },
  agents: {},
  customSounds: [],
  mutedAgents: [],
}

// ── Mute state (runtime cache) ──

let mutedAgentsCache: Set<string> | null = null

function loadMutedAgents(): Set<string> {
  if (mutedAgentsCache) return mutedAgentsCache
  const store = readNotificationStore()
  mutedAgentsCache = new Set(store.mutedAgents ?? [])
  return mutedAgentsCache
}

function persistMutedAgents(muted: Set<string>): void {
  mutedAgentsCache = muted
  const store = readNotificationStore()
  store.mutedAgents = [...muted]
  writeNotificationStoreRaw(store)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(MUTE_CHANGE_EVENT))
  }
}

function isMuted(agentId: string): boolean {
  return loadMutedAgents().has(agentId)
}

export function toggleMute(agentId: string): void {
  const muted = new Set(loadMutedAgents())
  if (muted.has(agentId)) {
    muted.delete(agentId)
  } else {
    muted.add(agentId)
  }
  persistMutedAgents(muted)
}

export function getMutedAgents(): Set<string> {
  return new Set(loadMutedAgents())
}

export function setMutedAgents(agentIds: Set<string>): void {
  persistMutedAgents(new Set(agentIds))
}

/** Remove a single agent from the muted set (e.g. on session deletion). */
export function removeMutedAgent(agentId: string): void {
  const muted = new Set(loadMutedAgents())
  if (muted.delete(agentId)) {
    persistMutedAgents(muted)
  }
}

/** Bulk-remove multiple agents from the muted set (e.g. on manager deletion). */
export function removeMutedAgents(agentIds: string[]): void {
  const muted = new Set(loadMutedAgents())
  let changed = false
  for (const id of agentIds) {
    if (muted.delete(id)) changed = true
  }
  if (changed) {
    persistMutedAgents(muted)
  }
}

export { MUTE_CHANGE_EVENT }

// Invalidate mute cache on cross-tab storage changes
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      mutedAgentsCache = null
    }
  })
}

// ── Storage ──

export function readNotificationStore(): NotificationStore {
  if (typeof window === 'undefined') return { ...DEFAULT_STORE }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_STORE }
    const parsed = JSON.parse(raw)
    const store: NotificationStore = {
      globalEnabled: typeof parsed.globalEnabled === 'boolean' ? parsed.globalEnabled : true,
      defaults: parsed.defaults && typeof parsed.defaults === 'object'
        ? parsed.defaults
        : { ...DEFAULT_AGENT_PREFS },
      agents: parsed.agents && typeof parsed.agents === 'object' ? parsed.agents : {},
      customSounds: Array.isArray(parsed.customSounds) ? parsed.customSounds : [],
      mutedAgents: Array.isArray(parsed.mutedAgents) ? parsed.mutedAgents : [],
    }
    // Migration: persist defaults field if it was missing in stored data
    let needsPersist = !parsed.defaults
    // Migration: add questionSound to defaults if missing
    if (!store.defaults.questionSound) {
      store.defaults = {
        ...store.defaults,
        questionSound: { enabled: true, soundId: 'question' },
      }
      needsPersist = true
    }
    // Migration: add questionSound to existing agent prefs that lack it
    for (const [agentId, prefs] of Object.entries(store.agents)) {
      if (!(prefs as AgentNotificationPrefs).questionSound) {
        store.agents[agentId] = {
          ...prefs,
          questionSound: { enabled: true, soundId: 'question' },
        }
        needsPersist = true
      }
    }
    if (needsPersist) {
      writeNotificationStore(store)
    }
    return store
  } catch {
    return { ...DEFAULT_STORE }
  }
}

/**
 * Write the notification store, preserving the current mutedAgents from
 * localStorage. This prevents callers that snapshot the store once (e.g.
 * SettingsNotifications) from accidentally overwriting mute changes made
 * elsewhere. Mute state should be modified exclusively via the dedicated
 * mute APIs (toggleMute, setMutedAgents, removeMutedAgent, etc.).
 */
export function writeNotificationStore(store: NotificationStore): void {
  if (typeof window === 'undefined') return
  try {
    // Re-read the current mutedAgents so we don't clobber concurrent changes
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        const current = JSON.parse(raw)
        if (Array.isArray(current.mutedAgents)) {
          store = { ...store, mutedAgents: current.mutedAgents }
        }
      } catch {
        // Ignore parse errors — write the full store as-is
      }
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Ignore write failures (storage full, restricted env, etc.)
  }
}

/** Internal: write the store exactly as-is, including mutedAgents. */
function writeNotificationStoreRaw(store: NotificationStore): void {
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

/**
 * Resolve effective prefs for a profile, respecting the defaults cascade.
 * Cortex never inherits from defaults — it uses its own explicit prefs or disabled fallback.
 */
export function getEffectivePrefs(
  store: NotificationStore,
  prefsKey: string,
  isCortex: boolean,
): AgentNotificationPrefs {
  if (isCortex) {
    return store.agents[prefsKey] ?? { ...DEFAULT_AGENT_PREFS_DISABLED }
  }
  return store.agents[prefsKey] ?? store.defaults
}

/** Check if a profile has an explicit override (not using defaults). */
export function hasExplicitOverride(store: NotificationStore, prefsKey: string): boolean {
  return prefsKey in store.agents
}

/** Remove a profile's explicit override so it falls back to defaults. */
export function clearOverride(store: NotificationStore, prefsKey: string): NotificationStore {
  const { [prefsKey]: _, ...rest } = store.agents
  return { ...store, agents: rest }
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

function shouldPlayQuestion(
  prefsKey: string,
  agentId: string,
  state: ManagerWsState,
  store: NotificationStore,
): boolean {
  if (!store.globalEnabled) return false
  if (agentId === state.targetAgentId && document.hasFocus()) return false
  const isCortex = prefsKey === 'cortex'
  const prefs = getEffectivePrefs(store, prefsKey, isCortex)
  return prefs.questionSound.enabled
}

function shouldPlayUnread(
  prefsKey: string,
  agentId: string,
  state: ManagerWsState,
  store: NotificationStore,
): boolean {
  if (!store.globalEnabled) return false
  // Don't play for the currently viewed agent if the user is actively looking at it
  if (agentId === state.targetAgentId && document.hasFocus()) return false
  const isCortex = prefsKey === 'cortex'
  const prefs = getEffectivePrefs(store, prefsKey, isCortex)
  return prefs.unreadSound.enabled
}

function shouldPlayAllDone(
  prefsKey: string,
  agentId: string,
  state: ManagerWsState,
  store: NotificationStore,
): boolean {
  if (!store.globalEnabled) return false
  // Don't play for the currently viewed agent if the user is actively looking at it
  if (agentId === state.targetAgentId && document.hasFocus()) return false
  const isCortex = prefsKey === 'cortex'
  const prefs = getEffectivePrefs(store, prefsKey, isCortex)
  if (!prefs.allDoneSound.enabled) return false
  // Hard safety guard: never classify as all-done while the manager itself is streaming.
  // speak_to_user is a tool call that fires mid-turn; workers may not be spawned yet.
  if (isManagerStreaming(agentId, state)) return false
  return !hasStreamingWorkers(agentId, state)
}

// ── Public API: play notification sounds ──

function playUnread(prefsKey: string, store: NotificationStore): void {
  if (!canPlay(`unread:${prefsKey}`)) return
  const isCortex = prefsKey === 'cortex'
  const prefs = getEffectivePrefs(store, prefsKey, isCortex)
  const url = resolveSoundUrl(prefs.unreadSound.soundId, store)
  if (!url) return
  playSound(url, prefs.volume)
}

function playAllDone(prefsKey: string, store: NotificationStore): void {
  if (!canPlay(`allDone:${prefsKey}`)) return
  const isCortex = prefsKey === 'cortex'
  const prefs = getEffectivePrefs(store, prefsKey, isCortex)
  const url = resolveSoundUrl(prefs.allDoneSound.soundId, store)
  if (!url) return
  playSound(url, prefs.volume)
}

function playQuestion(prefsKey: string, store: NotificationStore): void {
  if (!canPlay(`question:${prefsKey}`)) return
  const isCortex = prefsKey === 'cortex'
  const prefs = getEffectivePrefs(store, prefsKey, isCortex)
  const url = resolveSoundUrl(prefs.questionSound.soundId, store)
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
  reason?: 'message' | 'choice_request',
  sessionAgentId?: string,
): void {
  const store = readNotificationStore()
  if (!store.globalEnabled) return

  // Resolve profileId-based prefs key (settings UI saves prefs keyed by profileId)
  // For worker-originated events, sessionAgentId lets us find the owning manager's profile
  const resolvedAgentId = sessionAgentId ?? agentId
  const agent = state.agents.find((a) => a.agentId === resolvedAgentId)
  const prefsKey = agent?.profileId ?? resolvedAgentId

  // Check if the session agent is muted — suppress all sounds
  if (isMuted(resolvedAgentId)) return

  // Choice-request events get their own branch — never enter the all-done path.
  if (reason === 'choice_request') {
    if (shouldPlayQuestion(prefsKey, agentId, state, store)) {
      playQuestion(prefsKey, store)
      return
    }
    // Question sound disabled — fall back to unread, but never all-done
    if (shouldPlayUnread(prefsKey, agentId, state, store)) {
      playUnread(prefsKey, store)
    }
    return
  }

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

  // Check mute state before playing deferred sound
  if (isMuted(agentId)) return

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
  // Reset defaults if they reference the removed sound
  let defaults = store.defaults
  if (defaults.unreadSound.soundId === soundId) {
    defaults = { ...defaults, unreadSound: { ...defaults.unreadSound, soundId: 'notification' } }
  }
  if (defaults.allDoneSound.soundId === soundId) {
    defaults = { ...defaults, allDoneSound: { ...defaults.allDoneSound, soundId: 'complete' } }
  }
  if (defaults.questionSound.soundId === soundId) {
    defaults = { ...defaults, questionSound: { ...defaults.questionSound, soundId: 'question' } }
  }
  return {
    ...store,
    defaults,
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
        if (prefs.questionSound.soundId === soundId) {
          updated = { ...updated, questionSound: { ...updated.questionSound, soundId: 'question' } }
        }
        return [agentId, updated]
      }),
    ),
  }
}
