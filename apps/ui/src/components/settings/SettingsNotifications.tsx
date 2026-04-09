import { useCallback, useEffect, useRef, useState } from 'react'
import { Bell, BellOff, Play, RotateCcw, Settings2, Trash2, Upload, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { SettingsSection, SettingsWithCTA } from './settings-row'
import {
  type AgentNotificationPrefs,
  type NotificationStore,
  getAllSoundOptions,
  getAgentPrefs,
  getEffectivePrefs,
  hasExplicitOverride,
  clearOverride,
  readNotificationStore,
  writeNotificationStore,
  setAgentPrefs,
  addCustomSound,
  removeCustomSound,
  previewSound,
} from '@/lib/notification-service'
import type { AgentDescriptor } from '@forge/protocol'

// ── Helpers ──

const ACCEPTED_AUDIO_TYPES = '.mp3,.wav,.ogg'
const MAX_UPLOAD_SIZE = 2 * 1024 * 1024 // 2 MB

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

// ── Component ──

interface SettingsNotificationsProps {
  managers: AgentDescriptor[]
}

export function SettingsNotifications({ managers }: SettingsNotificationsProps) {
  const [store, setStore] = useState<NotificationStore>(() => readNotificationStore())
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Persist whenever store changes
  useEffect(() => {
    writeNotificationStore(store)
  }, [store])

  // ── Global toggle ──

  const handleGlobalToggle = useCallback((enabled: boolean) => {
    setStore((prev) => ({ ...prev, globalEnabled: enabled }))
  }, [])

  // ── Defaults prefs ──

  const updateDefaults = useCallback(
    (updater: (prev: AgentNotificationPrefs) => AgentNotificationPrefs) => {
      setStore((prev) => ({
        ...prev,
        defaults: updater(prev.defaults),
      }))
    },
    [],
  )

  // ── Per-agent prefs ──

  const updateAgentPrefs = useCallback(
    (profileId: string, updater: (prev: AgentNotificationPrefs) => AgentNotificationPrefs) => {
      setStore((prev) => {
        const current = getAgentPrefs(prev, profileId)
        const updated = updater(current)
        return setAgentPrefs(prev, profileId, updated)
      })
    },
    [],
  )

  const handleCustomize = useCallback(
    (profileId: string) => {
      setStore((prev) => {
        // Copy current defaults into an explicit override
        if (hasExplicitOverride(prev, profileId)) return prev
        return setAgentPrefs(prev, profileId, { ...prev.defaults })
      })
    },
    [],
  )

  const handleResetToDefaults = useCallback(
    (profileId: string) => {
      setStore((prev) => clearOverride(prev, profileId))
    },
    [],
  )

  // ── Custom sounds ──

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.size > MAX_UPLOAD_SIZE) {
      alert('Sound file must be under 2 MB.')
      return
    }

    try {
      const dataUrl = await readFileAsDataUrl(file)
      const name = file.name.replace(/\.[^.]+$/, '')
      setStore((prev) => addCustomSound(prev, name, dataUrl))
    } catch {
      // Silently ignore read failures.
    }

    // Reset input so the same file can be selected again
    e.target.value = ''
  }, [])

  const handleRemoveCustomSound = useCallback((soundId: string) => {
    setStore((prev) => removeCustomSound(prev, soundId))
  }, [])

  const soundOptions = getAllSoundOptions(store)

  // Filter to session managers (role=manager with profileId)
  const managerAgents = managers.filter(
    (a) => a.role === 'manager' && a.profileId,
  )

  // Deduplicate by profileId — show one entry per profile using the default/first session
  const profileMap = new Map<string, AgentDescriptor>()
  for (const agent of managerAgents) {
    const pid = agent.profileId!
    if (!profileMap.has(pid)) {
      profileMap.set(pid, agent)
    }
  }
  const profileAgents = Array.from(profileMap.values()).sort((a, b) => {
    // Pin Cortex to the top of the per-manager list
    if (a.profileId === 'cortex') return -1
    if (b.profileId === 'cortex') return 1
    return 0
  })

  return (
    <div className="flex flex-col gap-8">
      {/* ── Global Toggle ── */}
      <SettingsSection
        label="Notifications"
        description="Configure sound alerts for agent activity"
        cta={
          <div className="flex items-center gap-2">
            {store.globalEnabled ? (
              <Bell className="size-4 text-foreground" />
            ) : (
              <BellOff className="size-4 text-muted-foreground" />
            )}
            <Switch
              checked={store.globalEnabled}
              onCheckedChange={handleGlobalToggle}
            />
          </div>
        }
      >
        {!store.globalEnabled && (
          <p className="text-sm text-muted-foreground">
            All notification sounds are disabled. Enable the toggle above to configure per-agent alerts.
          </p>
        )}

        {store.globalEnabled && profileAgents.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No manager agents found. Create a manager to configure notification sounds.
          </p>
        )}
      </SettingsSection>

      {/* ── Notification Defaults ── */}
      {store.globalEnabled && (
        <SettingsSection
          label="Notification Defaults"
          description="Applies to all managers except Cortex. Individual managers can override."
        >
          <DefaultsNotificationSection
            prefs={store.defaults}
            soundOptions={soundOptions}
            store={store}
            onUpdate={updateDefaults}
          />
        </SettingsSection>
      )}

      {/* ── Per-Manager Overrides ── */}
      {store.globalEnabled && profileAgents.length > 0 && (
        <SettingsSection
          label="Per-Manager Settings"
          description="Override defaults for individual managers"
        >
          {profileAgents.map((agent) => {
            const profileId = agent.profileId!
            const isCortex = profileId === 'cortex'
            const isOverride = hasExplicitOverride(store, profileId)

            if (isCortex) {
              return (
                <AgentNotificationSection
                  key={profileId}
                  agent={agent}
                  prefs={getEffectivePrefs(store, profileId, true)}
                  soundOptions={soundOptions}
                  store={store}
                  onUpdate={(updater) => updateAgentPrefs(profileId, updater)}
                />
              )
            }

            if (!isOverride) {
              return (
                <DefaultsProfileRow
                  key={profileId}
                  agent={agent}
                  onCustomize={() => handleCustomize(profileId)}
                />
              )
            }

            return (
              <AgentNotificationSection
                key={profileId}
                agent={agent}
                prefs={getAgentPrefs(store, profileId)}
                soundOptions={soundOptions}
                store={store}
                onUpdate={(updater) => updateAgentPrefs(profileId, updater)}
                onResetToDefaults={() => handleResetToDefaults(profileId)}
              />
            )
          })}
        </SettingsSection>
      )}

      {/* ── Custom Sounds ── */}
      <SettingsSection
        label="Custom Sounds"
        description="Upload your own notification sounds (MP3, WAV, OGG — max 2 MB)"
      >
        <div className="flex flex-col gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_AUDIO_TYPES}
            className="hidden"
            onChange={handleFileUpload}
          />
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="size-3.5 mr-1.5" />
            Upload Sound
          </Button>

          {store.customSounds.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No custom sounds uploaded yet.
            </p>
          )}

          {store.customSounds.map((sound) => (
            <div
              key={sound.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
            >
              <span className="text-sm truncate flex-1">{sound.name}</span>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => previewSound(sound.id, store)}
                  title="Preview"
                >
                  <Play className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  onClick={() => handleRemoveCustomSound(sound.id)}
                  title="Delete"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </SettingsSection>
    </div>
  )
}

// ── Per-Agent Section ──

/** Collapsed row for a profile that inherits defaults. */
function DefaultsProfileRow({
  agent,
  onCustomize,
}: {
  agent: AgentDescriptor
  onCustomize: () => void
}) {
  const displayName = agent.displayName || agent.agentId

  return (
    <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Label className="text-sm font-semibold">{displayName}</Label>
        <span className="text-xs text-muted-foreground">Using defaults</span>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        onClick={onCustomize}
      >
        <Settings2 className="size-3 mr-1.5" />
        Customize
      </Button>
    </div>
  )
}

/** Notification controls for the defaults section. Same controls, no agent header. */
function DefaultsNotificationSection({
  prefs,
  soundOptions,
  store,
  onUpdate,
}: {
  prefs: AgentNotificationPrefs
  soundOptions: ReturnType<typeof getAllSoundOptions>
  store: NotificationStore
  onUpdate: (updater: (prev: AgentNotificationPrefs) => AgentNotificationPrefs) => void
}) {
  return (
    <div className="rounded-lg border border-border/60 p-3 space-y-3">
      {/* Unread sound */}
      <SettingsWithCTA
        label="Unread message sound"
        description="Plays when a manager sends a message you haven't seen"
      >
        <div className="flex items-center gap-2">
          <Switch
            checked={prefs.unreadSound.enabled}
            onCheckedChange={(enabled) =>
              onUpdate((p) => ({
                ...p,
                unreadSound: { ...p.unreadSound, enabled },
              }))
            }
          />
          {prefs.unreadSound.enabled && (
            <SoundPicker
              value={prefs.unreadSound.soundId}
              options={soundOptions}
              store={store}
              volume={prefs.volume}
              onChange={(soundId) =>
                onUpdate((p) => ({
                  ...p,
                  unreadSound: { ...p.unreadSound, soundId },
                }))
              }
            />
          )}
        </div>
      </SettingsWithCTA>

      {/* Question sound */}
      <SettingsWithCTA
        label="Question sound"
        description="Plays when an agent asks you a question or presents choices"
      >
        <div className="flex items-center gap-2">
          <Switch
            checked={prefs.questionSound.enabled}
            onCheckedChange={(enabled) =>
              onUpdate((p) => ({
                ...p,
                questionSound: { ...p.questionSound, enabled },
              }))
            }
          />
          {prefs.questionSound.enabled && (
            <SoundPicker
              value={prefs.questionSound.soundId}
              options={soundOptions}
              store={store}
              volume={prefs.volume}
              onChange={(soundId) =>
                onUpdate((p) => ({
                  ...p,
                  questionSound: { ...p.questionSound, soundId },
                }))
              }
            />
          )}
        </div>
      </SettingsWithCTA>

      {/* All-done sound */}
      <SettingsWithCTA
        label="All done sound"
        description="Plays when a manager finishes with no workers running"
      >
        <div className="flex items-center gap-2">
          <Switch
            checked={prefs.allDoneSound.enabled}
            onCheckedChange={(enabled) =>
              onUpdate((p) => ({
                ...p,
                allDoneSound: { ...p.allDoneSound, enabled },
              }))
            }
          />
          {prefs.allDoneSound.enabled && (
            <SoundPicker
              value={prefs.allDoneSound.soundId}
              options={soundOptions}
              store={store}
              volume={prefs.volume}
              onChange={(soundId) =>
                onUpdate((p) => ({
                  ...p,
                  allDoneSound: { ...p.allDoneSound, soundId },
                }))
              }
            />
          )}
        </div>
      </SettingsWithCTA>

      <Separator className="my-1" />

      {/* Volume */}
      <SettingsWithCTA label="Volume" description="Default notification volume">
        <div className="flex items-center gap-2 w-full sm:w-48">
          <Volume2 className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(prefs.volume * 100)}
            onChange={(e) => {
              const vol = Number(e.target.value) / 100
              onUpdate((p) => ({ ...p, volume: vol }))
            }}
            className="w-full h-1.5 bg-muted rounded-full appearance-none cursor-pointer accent-primary
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5
              [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-sm
              [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:rounded-full
              [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:border-0"
          />
          <span className="text-xs text-muted-foreground w-8 text-right tabular-nums">
            {Math.round(prefs.volume * 100)}%
          </span>
        </div>
      </SettingsWithCTA>
    </div>
  )
}

function AgentNotificationSection({
  agent,
  prefs,
  soundOptions,
  store,
  onUpdate,
  onResetToDefaults,
}: {
  agent: AgentDescriptor
  prefs: AgentNotificationPrefs
  soundOptions: ReturnType<typeof getAllSoundOptions>
  store: NotificationStore
  onUpdate: (updater: (prev: AgentNotificationPrefs) => AgentNotificationPrefs) => void
  onResetToDefaults?: () => void
}) {
  const displayName = agent.displayName || agent.agentId

  return (
    <div className="rounded-lg border border-border/60 p-3 space-y-3">
      <div className="flex items-center justify-between pb-1">
        <Label className="text-sm font-semibold">{displayName}</Label>
        {onResetToDefaults && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground hover:text-foreground"
            onClick={onResetToDefaults}
          >
            <RotateCcw className="size-3 mr-1.5" />
            Reset to defaults
          </Button>
        )}
      </div>

      {/* Unread sound */}
      <SettingsWithCTA
        label="Unread message sound"
        description="Plays when this agent sends a message you haven't seen"
      >
        <div className="flex items-center gap-2">
          <Switch
            checked={prefs.unreadSound.enabled}
            onCheckedChange={(enabled) =>
              onUpdate((p) => ({
                ...p,
                unreadSound: { ...p.unreadSound, enabled },
              }))
            }
          />
          {prefs.unreadSound.enabled && (
            <SoundPicker
              value={prefs.unreadSound.soundId}
              options={soundOptions}
              store={store}
              volume={prefs.volume}
              onChange={(soundId) =>
                onUpdate((p) => ({
                  ...p,
                  unreadSound: { ...p.unreadSound, soundId },
                }))
              }
            />
          )}
        </div>
      </SettingsWithCTA>

      {/* Question sound */}
      <SettingsWithCTA
        label="Question sound"
        description="Plays when this agent asks you a question or presents choices"
      >
        <div className="flex items-center gap-2">
          <Switch
            checked={prefs.questionSound.enabled}
            onCheckedChange={(enabled) =>
              onUpdate((p) => ({
                ...p,
                questionSound: { ...p.questionSound, enabled },
              }))
            }
          />
          {prefs.questionSound.enabled && (
            <SoundPicker
              value={prefs.questionSound.soundId}
              options={soundOptions}
              store={store}
              volume={prefs.volume}
              onChange={(soundId) =>
                onUpdate((p) => ({
                  ...p,
                  questionSound: { ...p.questionSound, soundId },
                }))
              }
            />
          )}
        </div>
      </SettingsWithCTA>

      {/* All-done sound */}
      <SettingsWithCTA
        label="All done sound"
        description="Plays when this agent finishes with no workers running"
      >
        <div className="flex items-center gap-2">
          <Switch
            checked={prefs.allDoneSound.enabled}
            onCheckedChange={(enabled) =>
              onUpdate((p) => ({
                ...p,
                allDoneSound: { ...p.allDoneSound, enabled },
              }))
            }
          />
          {prefs.allDoneSound.enabled && (
            <SoundPicker
              value={prefs.allDoneSound.soundId}
              options={soundOptions}
              store={store}
              volume={prefs.volume}
              onChange={(soundId) =>
                onUpdate((p) => ({
                  ...p,
                  allDoneSound: { ...p.allDoneSound, soundId },
                }))
              }
            />
          )}
        </div>
      </SettingsWithCTA>

      <Separator className="my-1" />

      {/* Volume */}
      <SettingsWithCTA label="Volume" description="Notification volume for this agent">
        <div className="flex items-center gap-2 w-full sm:w-48">
          <Volume2 className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(prefs.volume * 100)}
            onChange={(e) => {
              const vol = Number(e.target.value) / 100
              onUpdate((p) => ({ ...p, volume: vol }))
            }}
            className="w-full h-1.5 bg-muted rounded-full appearance-none cursor-pointer accent-primary
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5
              [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-sm
              [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:rounded-full
              [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:border-0"
          />
          <span className="text-xs text-muted-foreground w-8 text-right tabular-nums">
            {Math.round(prefs.volume * 100)}%
          </span>
        </div>
      </SettingsWithCTA>
    </div>
  )
}

// ── Sound Picker ──

function SoundPicker({
  value,
  options,
  store,
  volume,
  onChange,
}: {
  value: string
  options: ReturnType<typeof getAllSoundOptions>
  store: NotificationStore
  volume: number
  onChange: (soundId: string) => void
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-36 sm:w-44 h-8 text-xs">
          <SelectValue placeholder="Select sound" />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.id} value={opt.id}>
              <span className="text-xs">{opt.name}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={() => previewSound(value, store, volume)}
        title="Preview sound"
      >
        <Play className="size-3" />
      </Button>
    </div>
  )
}
