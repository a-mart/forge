import { useCallback, useEffect, useState } from 'react'
import { Monitor, Moon, RotateCcw, Sun } from 'lucide-react'
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
import { SettingsSection, SettingsWithCTA } from './settings-row'
import {
  applyThemePreference,
  readStoredThemePreference,
  type ThemePreference,
} from '@/lib/theme'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import {
  fetchPlaywrightSettings,
  updatePlaywrightSettings,
} from '@/components/playwright/playwright-api'
import type { PlaywrightDiscoverySettings } from '@forge/protocol'

interface SettingsGeneralProps {
  wsUrl: string
  onPlaywrightSnapshotUpdate?: (snapshot: import('@forge/protocol').PlaywrightDiscoverySnapshot) => void
  onPlaywrightSettingsLoaded?: (settings: PlaywrightDiscoverySettings) => void
}

export function SettingsGeneral({ wsUrl, onPlaywrightSnapshotUpdate, onPlaywrightSettingsLoaded }: SettingsGeneralProps) {
  const {
    onboardingState,
    isMutating: isSavingOnboarding,
    error: onboardingError,
    savePreferences,
  } = useOnboardingState(wsUrl)
  const [onboardingSuccess, setOnboardingSuccess] = useState<string | null>(null)
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    readStoredThemePreference(),
  )
  const [playwrightSettings, setPlaywrightSettings] = useState<PlaywrightDiscoverySettings | null>(null)
  const [playwrightError, setPlaywrightError] = useState<string | null>(null)
  const [playwrightUpdating, setPlaywrightUpdating] = useState(false)

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

  const handleThemePreferenceChange = useCallback((nextPreference: ThemePreference) => {
    setThemePreference(nextPreference)
    applyThemePreference(nextPreference)
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
