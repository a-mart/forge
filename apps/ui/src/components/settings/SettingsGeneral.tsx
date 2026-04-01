import { useCallback, useEffect, useState } from 'react'
import { useHelpContext } from '@/components/help/help-hooks'
import { HelpTooltip } from '@/components/help/HelpTooltip'
import { Code, Monitor, Moon, RotateCcw, Sun } from 'lucide-react'
import { OnboardingCallout } from '@/components/chat/cortex/OnboardingCallout'
import { useOnboardingState } from '@/hooks/use-onboarding-state'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { readSidebarModelIconsPref, storeSidebarModelIconsPref } from '@/lib/sidebar-prefs'
import { SettingsSection, SettingsWithCTA } from './settings-row'
import { isElectron, type SleepBlockerStatus } from '@/lib/electron-bridge'
import {
  applyThemePreference,
  readStoredThemePreference,
  type ThemePreference,
} from '@/lib/theme'
import {
  EDITOR_LABELS,
  readStoredEditorPreference,
  storeEditorPreference,
  type EditorPreference,
} from '@/lib/editor-preference'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import {
  fetchPlaywrightSettings,
  updatePlaywrightSettings,
} from '@/components/playwright/playwright-api'
import {
  fetchCortexAutoReviewSettings,
  updateCortexAutoReviewSettings,
} from '@/components/settings/cortex-auto-review-api'
import type { PlaywrightDiscoverySettings, CortexAutoReviewSettings } from '@forge/protocol'

interface SettingsGeneralProps {
  wsUrl: string
  onPlaywrightSnapshotUpdate?: (snapshot: import('@forge/protocol').PlaywrightDiscoverySnapshot) => void
  onPlaywrightSettingsLoaded?: (settings: PlaywrightDiscoverySettings) => void
}

export function SettingsGeneral({ wsUrl, onPlaywrightSnapshotUpdate, onPlaywrightSettingsLoaded }: SettingsGeneralProps) {
  useHelpContext('settings.general')

  const {
    onboardingState,
    isMutating: isSavingOnboarding,
    error: onboardingError,
    savePreferences,
  } = useOnboardingState(wsUrl)
  const [onboardingSuccess, setOnboardingSuccess] = useState<string | null>(null)
  const [sidebarModelIcons, setSidebarModelIcons] = useState(() => readSidebarModelIconsPref())
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    readStoredThemePreference(),
  )
  const [editorPreference, setEditorPreference] = useState<EditorPreference>(() =>
    readStoredEditorPreference(),
  )
  const [playwrightSettings, setPlaywrightSettings] = useState<PlaywrightDiscoverySettings | null>(null)
  const [playwrightError, setPlaywrightError] = useState<string | null>(null)
  const [playwrightUpdating, setPlaywrightUpdating] = useState(false)

  const [cortexSettings, setCortexSettings] = useState<CortexAutoReviewSettings | null>(null)
  const [cortexError, setCortexError] = useState<string | null>(null)
  const [cortexUpdating, setCortexUpdating] = useState(false)
  const [cortexLoadFailed, setCortexLoadFailed] = useState(false)

  // Sleep blocker state (Electron-only)
  const bridge = window.electronBridge
  const inElectron = isElectron()
  const [sleepBlockerEnabled, setSleepBlockerEnabled] = useState(false)
  const [sleepBlockerGracePeriod, setSleepBlockerGracePeriod] = useState(30)
  const [sleepBlockerStatus, setSleepBlockerStatus] = useState<SleepBlockerStatus | null>(null)
  const [sleepBlockerUpdating, setSleepBlockerUpdating] = useState(false)

  // Load initial sleep blocker state
  useEffect(() => {
    if (!inElectron || !bridge?.getSleepBlockerSettings) return
    bridge.getSleepBlockerSettings().then((status) => {
      setSleepBlockerEnabled(status.enabled)
      setSleepBlockerStatus(status)
    }).catch(() => {})
  }, [inElectron, bridge])

  // Subscribe to sleep blocker status updates
  useEffect(() => {
    if (!inElectron || !bridge?.onSleepBlockerStatus) return
    const unsub = bridge.onSleepBlockerStatus((status) => {
      setSleepBlockerStatus(status)
      setSleepBlockerEnabled(status.enabled)
    })
    return unsub
  }, [inElectron, bridge])

  const handleSleepBlockerToggle = useCallback((checked: boolean) => {
    setSleepBlockerEnabled(checked)
    setSleepBlockerUpdating(true)
    bridge?.setSleepBlockerSettings?.({ enabled: checked })
      ?.then((result) => {
        if (result) setSleepBlockerStatus(result)
      })
      ?.catch(() => {})
      ?.finally(() => setSleepBlockerUpdating(false))
  }, [bridge])

  const handleSleepBlockerGracePeriodChange = useCallback((minutes: number) => {
    setSleepBlockerGracePeriod(minutes)
    setSleepBlockerUpdating(true)
    bridge?.setSleepBlockerSettings?.({ gracePeriodMinutes: minutes })
      ?.then((result) => {
        if (result) setSleepBlockerStatus(result)
      })
      ?.catch(() => {})
      ?.finally(() => setSleepBlockerUpdating(false))
  }, [bridge])

  useEffect(() => {
    setThemePreference(readStoredThemePreference())
  }, [])

  const [playwrightLoadFailed, setPlaywrightLoadFailed] = useState(false)

  // Fetch Playwright settings on mount
  useEffect(() => {
    setPlaywrightLoadFailed(false)
    void fetchPlaywrightSettings(wsUrl)
      .then((settings) => {
        setPlaywrightSettings(settings)
        setPlaywrightLoadFailed(false)
        onPlaywrightSettingsLoaded?.(settings)
      })
      .catch((err) => {
        setPlaywrightLoadFailed(true)
        setPlaywrightError(err instanceof Error ? err.message : 'Could not load Playwright settings')
      })
  }, [wsUrl, onPlaywrightSettingsLoaded])

  // Fetch Cortex auto-review settings on mount
  useEffect(() => {
    setCortexLoadFailed(false)
    void fetchCortexAutoReviewSettings(wsUrl)
      .then((settings) => {
        setCortexSettings(settings)
        setCortexLoadFailed(false)
      })
      .catch((err) => {
        setCortexLoadFailed(true)
        setCortexError(err instanceof Error ? err.message : 'Could not load Cortex settings')
      })
  }, [wsUrl])

  const handlePlaywrightToggle = useCallback(
    (enabled: boolean) => {
      if (playwrightUpdating) return
      setPlaywrightUpdating(true)
      setPlaywrightError(null)

      void updatePlaywrightSettings(wsUrl, { enabled })
        .then(({ settings, snapshot }) => {
          setPlaywrightSettings(settings)
          onPlaywrightSnapshotUpdate?.(snapshot)
        })
        .catch((err) => {
          setPlaywrightError(err instanceof Error ? err.message : 'Failed to update setting')
        })
        .finally(() => {
          setPlaywrightUpdating(false)
        })
    },
    [wsUrl, playwrightUpdating, onPlaywrightSnapshotUpdate],
  )

  const handleCortexToggle = useCallback(
    (enabled: boolean) => {
      if (cortexUpdating) return
      setCortexUpdating(true)
      setCortexError(null)

      void updateCortexAutoReviewSettings(wsUrl, { enabled })
        .then((settings) => {
          setCortexSettings(settings)
        })
        .catch((err) => {
          setCortexError(err instanceof Error ? err.message : 'Failed to update setting')
        })
        .finally(() => {
          setCortexUpdating(false)
        })
    },
    [wsUrl, cortexUpdating],
  )

  const handleCortexIntervalChange = useCallback(
    (intervalMinutes: number) => {
      if (cortexUpdating) return
      setCortexUpdating(true)
      setCortexError(null)

      void updateCortexAutoReviewSettings(wsUrl, { intervalMinutes })
        .then((settings) => {
          setCortexSettings(settings)
        })
        .catch((err) => {
          setCortexError(err instanceof Error ? err.message : 'Failed to update setting')
        })
        .finally(() => {
          setCortexUpdating(false)
        })
    },
    [wsUrl, cortexUpdating],
  )

  const handleThemePreferenceChange = useCallback((nextPreference: ThemePreference) => {
    setThemePreference(nextPreference)
    applyThemePreference(nextPreference)
  }, [])

  const handleEditorPreferenceChange = useCallback((nextPreference: EditorPreference) => {
    setEditorPreference(nextPreference)
    storeEditorPreference(nextPreference)
  }, [])

  const handleOnboardingSave = useCallback(async (input: import('@/lib/onboarding-api').SaveOnboardingPreferencesInput) => {
    const nextState = await savePreferences(input)
    if (nextState) {
      setOnboardingSuccess('Preferences saved.')
    }
  }, [savePreferences])

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        label="Appearance"
        description="Customize how the app looks"
      >
        <SettingsWithCTA
          label="Theme"
          description="Choose between light, dark, or system theme"
        >
          <HelpTooltip id="settings.theme" side="left">
          <Select
            value={themePreference}
            onValueChange={(value) => {
              if (value === 'light' || value === 'dark' || value === 'auto') {
                handleThemePreferenceChange(value)
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue placeholder="Select theme" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">
                <span className="inline-flex items-center gap-2">
                  <Sun className="size-3.5" />
                  Light
                </span>
              </SelectItem>
              <SelectItem value="dark">
                <span className="inline-flex items-center gap-2">
                  <Moon className="size-3.5" />
                  Dark
                </span>
              </SelectItem>
              <SelectItem value="auto">
                <span className="inline-flex items-center gap-2">
                  <Monitor className="size-3.5" />
                  System
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
          </HelpTooltip>
        </SettingsWithCTA>

        <SettingsWithCTA
          label="Preferred Editor"
          description="Choose which editor to open artifact files in"
        >
          <Select
            value={editorPreference}
            onValueChange={(value) => {
              if (value === 'vscode-insiders' || value === 'vscode' || value === 'cursor') {
                handleEditorPreferenceChange(value)
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue placeholder="Select editor" />
            </SelectTrigger>
            <SelectContent>
              {(Object.entries(EDITOR_LABELS) as [EditorPreference, string][]).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  <span className="inline-flex items-center gap-2">
                    <Code className="size-3.5" />
                    {label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsWithCTA>
      </SettingsSection>

      <SettingsSection
        label="Experimental Features"
        description="Enable or disable experimental features"
      >
        <SettingsWithCTA
          label="Playwright Dashboard"
          description={
            playwrightSettings?.source === 'env' ? (
              <>
                <span>Discover Playwright CLI sessions across repo roots and worktrees.</span>
                <br />
                <span className="text-amber-600 dark:text-amber-400">
                  This feature is {playwrightSettings.effectiveEnabled ? 'forced on' : 'forced off'} by the{' '}
                  <code className="text-[10px]">FORGE_PLAYWRIGHT_DASHBOARD_ENABLED</code> environment variable.
                </span>
              </>
            ) : (
              'Discover Playwright CLI sessions across repo roots and worktrees, and correlate them with Forge agents.'
            )
          }
        >
          <div className="flex flex-col items-end gap-1.5">
            <Switch
              checked={playwrightSettings?.effectiveEnabled ?? false}
              onCheckedChange={handlePlaywrightToggle}
              disabled={
                !playwrightSettings ||
                playwrightSettings.source === 'env' ||
                playwrightUpdating
              }
            />
            {playwrightError ? (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-destructive">{playwrightError}</span>
                {playwrightLoadFailed ? (
                  <button
                    type="button"
                    onClick={() => {
                      setPlaywrightError(null)
                      setPlaywrightLoadFailed(false)
                      void fetchPlaywrightSettings(wsUrl)
                        .then((s) => {
                          setPlaywrightSettings(s)
                          setPlaywrightLoadFailed(false)
                          onPlaywrightSettingsLoaded?.(s)
                        })
                        .catch((err) => {
                          setPlaywrightLoadFailed(true)
                          setPlaywrightError(err instanceof Error ? err.message : 'Could not load Playwright settings')
                        })
                    }}
                    className="text-[10px] text-primary underline hover:no-underline"
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </SettingsWithCTA>
      </SettingsSection>

      {inElectron && (
        <SettingsSection
          label="Sleep Prevention"
          description="Keep the system awake while agents are active"
        >
          <SettingsWithCTA
            label="Prevent Sleep During Activity"
            description="Automatically prevent system sleep while agents are processing. Display sleep is not affected."
          >
            <Switch
              checked={sleepBlockerEnabled}
              onCheckedChange={handleSleepBlockerToggle}
              disabled={sleepBlockerUpdating}
            />
          </SettingsWithCTA>

          {sleepBlockerEnabled && (
            <SettingsWithCTA
              label="Grace Period"
              description="How long to keep preventing sleep after all agents finish"
            >
              <Select
                value={String(sleepBlockerGracePeriod)}
                onValueChange={(value) => {
                  const minutes = parseInt(value, 10)
                  if (!isNaN(minutes)) handleSleepBlockerGracePeriodChange(minutes)
                }}
                disabled={sleepBlockerUpdating}
              >
                <SelectTrigger className="w-full sm:w-48">
                  <SelectValue placeholder="Select duration" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">No grace period</SelectItem>
                  <SelectItem value="5">5 minutes</SelectItem>
                  <SelectItem value="15">15 minutes</SelectItem>
                  <SelectItem value="30">30 minutes</SelectItem>
                  <SelectItem value="60">1 hour</SelectItem>
                  <SelectItem value="120">2 hours</SelectItem>
                </SelectContent>
              </Select>
            </SettingsWithCTA>
          )}

          {sleepBlockerStatus?.blocking && (
            <div className="flex items-center gap-2 rounded-md border border-border px-4 py-2.5">
              <div className="size-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs text-muted-foreground">
                {sleepBlockerStatus.reason}
              </span>
            </div>
          )}
        </SettingsSection>
      )}

      <SettingsSection
        label="Cortex"
        description="Cortex is the self-improvement system that reviews sessions and maintains knowledge"
      >
        <SettingsWithCTA
          label="Automatic Reviews"
          description="Cortex periodically reviews active sessions and updates knowledge, memory, and reference docs."
        >
          <div className="flex flex-col items-end gap-1.5">
            <HelpTooltip id="settings.cortex-auto-review" side="left">
            <Switch
              checked={cortexSettings?.enabled ?? false}
              onCheckedChange={handleCortexToggle}
              disabled={!cortexSettings || cortexUpdating}
            />
            </HelpTooltip>
            {cortexError ? (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-destructive">{cortexError}</span>
                {cortexLoadFailed ? (
                  <button
                    type="button"
                    onClick={() => {
                      setCortexError(null)
                      setCortexLoadFailed(false)
                      void fetchCortexAutoReviewSettings(wsUrl)
                        .then((s) => {
                          setCortexSettings(s)
                          setCortexLoadFailed(false)
                        })
                        .catch((err) => {
                          setCortexLoadFailed(true)
                          setCortexError(err instanceof Error ? err.message : 'Could not load Cortex settings')
                        })
                    }}
                    className="text-[10px] text-primary underline hover:no-underline"
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </SettingsWithCTA>

        <SettingsWithCTA
          label="Review Interval"
          description="How often Cortex checks for sessions that need review."
        >
          <Select
            value={String(cortexSettings?.intervalMinutes ?? 120)}
            onValueChange={(value) => {
              const minutes = parseInt(value, 10)
              if (!isNaN(minutes)) handleCortexIntervalChange(minutes)
            }}
            disabled={!cortexSettings?.enabled || cortexUpdating}
          >
            <SelectTrigger
              className={`w-full sm:w-48 ${!cortexSettings?.enabled ? 'opacity-50' : ''}`}
            >
              <SelectValue placeholder="Select interval" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="15">Every 15 minutes</SelectItem>
              <SelectItem value="30">Every 30 minutes</SelectItem>
              <SelectItem value="60">Every hour</SelectItem>
              <SelectItem value="120">Every 2 hours</SelectItem>
              <SelectItem value="240">Every 4 hours</SelectItem>
              <SelectItem value="480">Every 8 hours</SelectItem>
              <SelectItem value="720">Every 12 hours</SelectItem>
              <SelectItem value="1440">Every 24 hours</SelectItem>
            </SelectContent>
          </Select>
        </SettingsWithCTA>
      </SettingsSection>

      <SettingsSection
        label="Welcome Preferences"
        description="Edit the default preferences Forge shares with future managers"
      >
        <OnboardingCallout
          mode="settings"
          state={onboardingState}
          isBusy={isSavingOnboarding}
          error={onboardingError}
          success={onboardingSuccess}
          onSave={handleOnboardingSave}
        />
      </SettingsSection>

      <SettingsSection
        label="Sidebar"
        description="Customize sidebar appearance"
      >
        <SettingsWithCTA
          label="Show model icons"
          description="Display model provider icons next to manager profiles in the sidebar"
        >
          <Switch
            checked={sidebarModelIcons}
            onCheckedChange={(checked) => {
              setSidebarModelIcons(checked)
              storeSidebarModelIconsPref(checked)
            }}
          />
        </SettingsWithCTA>
      </SettingsSection>

      <SettingsSection
        label="System"
        description="Manage the Forge daemon"
      >
        <SettingsWithCTA
          label="Reboot"
          description="Restart the Forge daemon and all agents"
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const endpoint = resolveApiEndpoint(wsUrl, '/api/reboot')
              void fetch(endpoint, { method: 'POST' }).catch(() => {})
            }}
          >
            <RotateCcw className="size-3.5 mr-1.5" />
            Reboot
          </Button>
        </SettingsWithCTA>
      </SettingsSection>
    </div>
  )
}
