import { useCallback, useEffect, useMemo, useState } from 'react'
import { useHelpContext } from '@/components/help/help-hooks'
import { HelpTooltip } from '@/components/help/HelpTooltip'
import { Check, Code, RotateCcw, Terminal } from 'lucide-react'
import { OnboardingCallout } from '@/components/chat/cortex/OnboardingCallout'
import { useOnboardingState } from '@/hooks/use-onboarding-state'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  readSidebarModelIconsPref,
  readSidebarProviderUsagePref,
  storeSidebarModelIconsPref,
  storeSidebarProviderUsagePref,
} from '@/lib/sidebar-prefs'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { SettingsSection, SettingsWithCTA } from './settings-row'
import { isElectron, type SleepBlockerStatus } from '@/lib/electron-bridge'
import {
  EDITOR_LABELS,
  readStoredEditorPreference,
  storeEditorPreference,
  type EditorPreference,
} from '@/lib/editor-preference'
import {
  fetchCortexAutoReviewSettings,
  updateCortexAutoReviewSettings,
} from '@/components/settings/cortex-auto-review-api'
import {
  fetchModelCacheVisualizationEnabled,
  setModelCacheVisualizationEnabledApi,
} from '@/components/settings/model-cache-visualization-api'
import {
  fetchAvailableShells,
  updateTerminalShellSettings,
  type AvailableShellsResponse,
  type TerminalShellSettings,
} from '@/components/settings/terminal-shell-api'
import {
  MANAGER_REASONING_LEVELS,
  type CompactionSettings,
  type CortexAutoReviewSettings,
  type GetCompactionSettingsResponse,
  type ManagerReasoningLevel,
  type ModelPresetInfo,
} from '@forge/protocol'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { fetchModelPresets } from '@/lib/model-preset'
import { fetchCompactionSettings, updateCompactionSettings } from '@/components/settings/compaction-settings-api'
import { PROVIDER_LABELS, REASONING_LEVEL_LABELS } from '@/components/settings/specialists/types'
import type { SettingsBackendTarget } from './settings-target'
import type { SettingsApiClient } from './settings-api-client'

interface SettingsGeneralProps {
  wsUrl: string
  /** When provided, the component uses target-aware API routing. */
  target?: SettingsBackendTarget
  /** When provided, used for all backend requests instead of raw wsUrl. */
  apiClient?: SettingsApiClient
}

interface CompactionModelOption {
  key: string
  provider: string
  providerLabel: string
  modelId: string
  label: string
  defaultReasoningLevel: ManagerReasoningLevel
  supportedReasoningLevels: ManagerReasoningLevel[]
  isCurrentUnavailable?: boolean
}

function getCompactionModelKey(model: { provider: string; modelId: string }): string {
  return `${model.provider}::${model.modelId}`
}

function parseCompactionModelKey(value: string): { provider: string; modelId: string } | null {
  const splitIndex = value.indexOf('::')
  if (splitIndex <= 0 || splitIndex === value.length - 2) {
    return null
  }

  return {
    provider: value.slice(0, splitIndex),
    modelId: value.slice(splitIndex + 2),
  }
}

function buildCompactionModelOptions(presets: ModelPresetInfo[]): CompactionModelOption[] {
  const options: CompactionModelOption[] = []
  for (const preset of presets) {
    const providerLabel = PROVIDER_LABELS[preset.provider] ?? preset.provider
    options.push({
      key: getCompactionModelKey({ provider: preset.provider, modelId: preset.modelId }),
      provider: preset.provider,
      providerLabel,
      modelId: preset.modelId,
      label: preset.displayName,
      defaultReasoningLevel: preset.defaultReasoningLevel,
      supportedReasoningLevels: preset.supportedReasoningLevels,
    })

    for (const variant of preset.variants ?? []) {
      options.push({
        key: getCompactionModelKey({ provider: preset.provider, modelId: variant.modelId }),
        provider: preset.provider,
        providerLabel,
        modelId: variant.modelId,
        label: variant.label,
        defaultReasoningLevel: preset.defaultReasoningLevel,
        supportedReasoningLevels: preset.supportedReasoningLevels,
      })
    }
  }
  return options
}

function buildCurrentCompactionOption(settings: CompactionSettings): CompactionModelOption {
  return {
    key: getCompactionModelKey(settings.model),
    provider: settings.model.provider,
    providerLabel: PROVIDER_LABELS[settings.model.provider] ?? settings.model.provider,
    modelId: settings.model.modelId,
    label: settings.model.modelId,
    defaultReasoningLevel: settings.reasoningLevel,
    supportedReasoningLevels: [...MANAGER_REASONING_LEVELS],
    isCurrentUnavailable: true,
  }
}

function formatCompactionTimeoutLabel(minutes: number): string {
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

function buildCompactionAvailabilityWarning(view: GetCompactionSettingsResponse | null): string | null {
  if (!view) return null

  if (!view.availability.providerConfigured) {
    return 'The configured compaction provider is not available right now. Automatic compaction will fail until you authenticate that provider or choose another model.'
  }

  if (!view.availability.modelValid) {
    return 'The configured compaction model is not currently available. Choose another model to keep automatic compaction working.'
  }

  if (!view.availability.reasoningSupported) {
    return 'The configured reasoning level is not supported by this compaction model. Choose a different reasoning level or model.'
  }

  return null
}

export function SettingsGeneral({ wsUrl, target, apiClient }: SettingsGeneralProps) {
  useHelpContext('settings.general')

  const isCollab = target?.kind === 'collab'
  const isBuilder = !isCollab

  // Use apiClient for onboarding when available, fall back to wsUrl
  const onboardingSource = apiClient ?? wsUrl
  const {
    onboardingState,
    isMutating: isSavingOnboarding,
    error: onboardingError,
    savePreferences,
  } = useOnboardingState(onboardingSource)
  const [onboardingSuccess, setOnboardingSuccess] = useState<string | null>(null)
  const [sidebarModelIcons, setSidebarModelIcons] = useState(() => readSidebarModelIconsPref())
  const [sidebarProviderUsage, setSidebarProviderUsage] = useState(() => readSidebarProviderUsagePref())
  const [editorPreference, setEditorPreference] = useState<EditorPreference>(() =>
    readStoredEditorPreference(),
  )
  const [cortexSettings, setCortexSettings] = useState<CortexAutoReviewSettings | null>(null)
  const [cortexError, setCortexError] = useState<string | null>(null)
  const [cortexUpdating, setCortexUpdating] = useState(false)
  const [cortexLoadFailed, setCortexLoadFailed] = useState(false)
  const [cortexDisabled, setCortexDisabled] = useState(false)

  const [modelCacheVisualizationEnabled, setModelCacheVisualizationEnabled] = useState(false)
  const [modelCacheVisualizationLoading, setModelCacheVisualizationLoading] = useState(true)
  const [modelCacheVisualizationUpdating, setModelCacheVisualizationUpdating] = useState(false)
  const [modelCacheVisualizationError, setModelCacheVisualizationError] = useState<string | null>(null)

  // Terminal shell settings — Builder-only
  const [terminalShells, setTerminalShells] = useState<AvailableShellsResponse | null>(null)
  const [terminalSettings, setTerminalSettings] = useState<TerminalShellSettings | null>(null)
  const [terminalError, setTerminalError] = useState<string | null>(null)
  const [terminalLoadFailed, setTerminalLoadFailed] = useState(false)
  const [terminalUpdating, setTerminalUpdating] = useState(false)
  const [terminalSuccess, setTerminalSuccess] = useState(false)

  // Compaction settings — Builder-only
  const [compactionView, setCompactionView] = useState<GetCompactionSettingsResponse | null>(null)
  const [compactionDraft, setCompactionDraft] = useState<CompactionSettings | null>(null)
  const [compactionModelPresets, setCompactionModelPresets] = useState<ModelPresetInfo[]>([])
  const [compactionError, setCompactionError] = useState<string | null>(null)
  const [compactionLoadFailed, setCompactionLoadFailed] = useState(false)
  const [compactionUpdating, setCompactionUpdating] = useState(false)
  const [compactionSuccess, setCompactionSuccess] = useState(false)

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

  // Fetch terminal shell settings on mount — Builder-only
  useEffect(() => {
    if (isCollab) return // Terminal settings are not available in Collab target
    setTerminalLoadFailed(false)
    void fetchAvailableShells(wsUrl)
      .then((data) => {
        setTerminalShells(data)
        setTerminalSettings(data.settings)
        setTerminalLoadFailed(false)
      })
      .catch((err) => {
        setTerminalLoadFailed(true)
        setTerminalError(err instanceof Error ? err.message : 'Could not load terminal settings')
      })
  }, [wsUrl, isCollab])

  const handleTerminalShellChange = useCallback(
    (value: string) => {
      if (terminalUpdating) return
      const shellPath = value === '__system_default__' ? null : value
      setTerminalUpdating(true)
      setTerminalError(null)
      setTerminalSuccess(false)

      void updateTerminalShellSettings(wsUrl, shellPath)
        .then((settings) => {
          setTerminalSettings(settings)
          setTerminalSuccess(true)
          setTimeout(() => setTerminalSuccess(false), 2000)
        })
        .catch((err) => {
          setTerminalError(err instanceof Error ? err.message : 'Failed to update terminal shell')
        })
        .finally(() => {
          setTerminalUpdating(false)
        })
    },
    [wsUrl, terminalUpdating],
  )

  const compactionSource = apiClient ?? wsUrl

  const loadCompactionSettings = useCallback(async () => {
    if (!isBuilder) return

    setCompactionLoadFailed(false)
    setCompactionError(null)
    const [view, presets] = await Promise.all([
      fetchCompactionSettings(compactionSource),
      fetchModelPresets(compactionSource).catch(() => [] as ModelPresetInfo[]),
    ])
    setCompactionView(view)
    setCompactionDraft(view.settings)
    setCompactionModelPresets(presets)
    setCompactionLoadFailed(false)
  }, [compactionSource, isBuilder])

  useEffect(() => {
    if (!isBuilder) return
    void loadCompactionSettings().catch((err) => {
      setCompactionLoadFailed(true)
      setCompactionError(err instanceof Error ? err.message : 'Could not load compaction settings')
    })
  }, [isBuilder, loadCompactionSettings])

  const compactionModelOptions = useMemo(() => {
    const options = buildCompactionModelOptions(compactionModelPresets)
    if (compactionDraft && !options.some((option) => option.key === getCompactionModelKey(compactionDraft.model))) {
      options.unshift(buildCurrentCompactionOption(compactionDraft))
    }
    return options
  }, [compactionDraft, compactionModelPresets])

  const compactionModelGroups = useMemo(() => {
    const groups = new Map<string, { provider: string; providerLabel: string; options: CompactionModelOption[] }>()
    for (const option of compactionModelOptions) {
      const existing = groups.get(option.provider)
      if (existing) {
        existing.options.push(option)
      } else {
        groups.set(option.provider, {
          provider: option.provider,
          providerLabel: option.providerLabel,
          options: [option],
        })
      }
    }
    return Array.from(groups.values())
  }, [compactionModelOptions])

  const selectedCompactionModel = useMemo(
    () => compactionDraft
      ? compactionModelOptions.find((option) => option.key === getCompactionModelKey(compactionDraft.model))
      : undefined,
    [compactionDraft, compactionModelOptions],
  )

  const availableCompactionReasoningLevels = useMemo(
    () => selectedCompactionModel?.supportedReasoningLevels ?? [...MANAGER_REASONING_LEVELS],
    [selectedCompactionModel],
  )

  useEffect(() => {
    if (!compactionDraft) return
    if (availableCompactionReasoningLevels.includes(compactionDraft.reasoningLevel)) return
    setCompactionDraft({
      ...compactionDraft,
      reasoningLevel: selectedCompactionModel?.defaultReasoningLevel ?? availableCompactionReasoningLevels[0] ?? 'low',
    })
  }, [availableCompactionReasoningLevels, compactionDraft, selectedCompactionModel])

  const compactionTimeoutMinuteOptions = useMemo(() => {
    const values = new Set<number>()
    if (compactionView) {
      const minMinutes = Math.max(1, Math.round(compactionView.constraints.timeoutMs.min / 60_000))
      const maxMinutes = Math.max(minMinutes, Math.round(compactionView.constraints.timeoutMs.max / 60_000))
      for (let minutes = minMinutes; minutes <= maxMinutes; minutes += 1) {
        values.add(minutes)
      }
    }
    if (compactionDraft) {
      values.add(Math.max(1, Math.round(compactionDraft.timeoutMs / 60_000)))
    }
    return Array.from(values).sort((a, b) => a - b)
  }, [compactionDraft, compactionView])

  const compactionWarning = useMemo(
    () => buildCompactionAvailabilityWarning(compactionView),
    [compactionView],
  )

  const hasCompactionChanges = useMemo(() => {
    if (!compactionView || !compactionDraft) return false
    return (
      compactionDraft.model.provider !== compactionView.settings.model.provider
      || compactionDraft.model.modelId !== compactionView.settings.model.modelId
      || compactionDraft.reasoningLevel !== compactionView.settings.reasoningLevel
      || compactionDraft.timeoutMs !== compactionView.settings.timeoutMs
    )
  }, [compactionDraft, compactionView])

  const handleCompactionModelChange = useCallback((value: string) => {
    const nextModel = parseCompactionModelKey(value)
    if (!nextModel) return
    const selectedOption = compactionModelOptions.find((option) => option.key === value)
    setCompactionDraft((current) => current
      ? {
          ...current,
          model: nextModel,
          reasoningLevel: selectedOption?.defaultReasoningLevel ?? current.reasoningLevel,
        }
      : current)
  }, [compactionModelOptions])

  const handleCompactionReasoningChange = useCallback((value: string) => {
    setCompactionDraft((current) => current
      ? { ...current, reasoningLevel: value as ManagerReasoningLevel }
      : current)
  }, [])

  const handleCompactionTimeoutChange = useCallback((value: string) => {
    const minutes = Number.parseInt(value, 10)
    if (Number.isNaN(minutes)) return
    setCompactionDraft((current) => current
      ? { ...current, timeoutMs: minutes * 60_000 }
      : current)
  }, [])

  const handleCompactionReset = useCallback(() => {
    if (!compactionView) return
    setCompactionDraft(compactionView.settings)
    setCompactionError(null)
    setCompactionSuccess(false)
  }, [compactionView])

  const handleCompactionSave = useCallback(() => {
    if (!compactionDraft) return
    setCompactionUpdating(true)
    setCompactionError(null)
    setCompactionSuccess(false)

    void updateCompactionSettings(compactionSource, {
      model: compactionDraft.model,
      reasoningLevel: compactionDraft.reasoningLevel,
      timeoutMs: compactionDraft.timeoutMs,
    })
      .then((response) => {
        setCompactionView((current) => current
          ? {
              ...current,
              settings: response.settings,
              availability: response.availability,
            }
          : current)
        setCompactionDraft(response.settings)
        setCompactionSuccess(true)
        setTimeout(() => setCompactionSuccess(false), 2000)
      })
      .catch((err) => {
        setCompactionError(err instanceof Error ? err.message : 'Failed to update compaction settings')
      })
      .finally(() => {
        setCompactionUpdating(false)
      })
  }, [compactionDraft, compactionSource])

  // Use apiClient or wsUrl for Cortex auto-review settings
  const cortexSource = apiClient ?? wsUrl

  // Fetch Cortex auto-review settings on mount
  useEffect(() => {
    setCortexLoadFailed(false)
    setCortexDisabled(false)
    void fetchCortexAutoReviewSettings(cortexSource)
      .then((response) => {
        setCortexSettings(response.settings)
        setCortexDisabled(response.cortexDisabled === true)
        setCortexLoadFailed(false)
      })
      .catch((err) => {
        setCortexLoadFailed(true)
        setCortexError(err instanceof Error ? err.message : 'Could not load Cortex settings')
      })
  }, [cortexSource])

  const modelCacheVisualizationSource = apiClient ?? wsUrl

  useEffect(() => {
    if (!isBuilder) return
    let cancelled = false
    setModelCacheVisualizationLoading(true)
    setModelCacheVisualizationError(null)
    void fetchModelCacheVisualizationEnabled(modelCacheVisualizationSource)
      .then((enabled) => {
        if (!cancelled) setModelCacheVisualizationEnabled(enabled)
      })
      .catch((err) => {
        if (!cancelled) {
          setModelCacheVisualizationError(
            err instanceof Error ? err.message : 'Could not load prompt cache visualization setting',
          )
        }
      })
      .finally(() => {
        if (!cancelled) setModelCacheVisualizationLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isBuilder, modelCacheVisualizationSource])

  const handleModelCacheVisualizationToggle = useCallback(
    (checked: boolean) => {
      if (modelCacheVisualizationUpdating) return
      setModelCacheVisualizationUpdating(true)
      setModelCacheVisualizationError(null)
      void setModelCacheVisualizationEnabledApi(modelCacheVisualizationSource, checked)
        .then(() => {
          setModelCacheVisualizationEnabled(checked)
        })
        .catch((err) => {
          setModelCacheVisualizationError(
            err instanceof Error ? err.message : 'Failed to update prompt cache visualization setting',
          )
        })
        .finally(() => {
          setModelCacheVisualizationUpdating(false)
        })
    },
    [modelCacheVisualizationSource, modelCacheVisualizationUpdating],
  )

  const handleCortexToggle = useCallback(
    (enabled: boolean) => {
      if (cortexUpdating) return
      setCortexUpdating(true)
      setCortexError(null)

      void updateCortexAutoReviewSettings(cortexSource, { enabled })
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
    [cortexSource, cortexUpdating],
  )

  const handleCortexIntervalChange = useCallback(
    (intervalMinutes: number) => {
      if (cortexUpdating) return
      setCortexUpdating(true)
      setCortexError(null)

      void updateCortexAutoReviewSettings(cortexSource, { intervalMinutes })
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
    [cortexSource, cortexUpdating],
  )

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

  // Reboot confirmation state — collab targets require explicit confirmation
  const [showRebootConfirm, setShowRebootConfirm] = useState(false)

  // Reboot handler — uses apiClient for target-aware routing
  const executeReboot = useCallback(() => {
    if (apiClient) {
      void apiClient.fetch('/api/reboot', { method: 'POST' }).catch(() => {})
    } else {
      const endpoint = resolveApiEndpoint(wsUrl, '/api/reboot')
      void fetch(endpoint, { method: 'POST' }).catch(() => {})
    }
  }, [apiClient, wsUrl])

  const handleReboot = useCallback(() => {
    if (isCollab) {
      setShowRebootConfirm(true)
    } else {
      executeReboot()
    }
  }, [isCollab, executeReboot])

  return (
    <div className="flex flex-col gap-8">
      {/* Editor — local-only (Builder) */}
      {isBuilder && (
        <SettingsSection
          label="Editor"
          description="Customize local editor integration"
        >
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
      )}

      {isBuilder && (
        <SettingsSection
          label="Prompt Cache Visualization"
          description="Show a compact prompt-cache indicator in manager chat headers for OpenAI/Codex Pi sessions when provider-reported cached input token counts are available."
        >
          <div className="flex items-center gap-3">
            <Switch
              id="model-cache-visualization-enabled-toggle"
              checked={modelCacheVisualizationEnabled}
              disabled={modelCacheVisualizationLoading || modelCacheVisualizationUpdating}
              onCheckedChange={handleModelCacheVisualizationToggle}
              aria-label="Enable prompt cache visualization"
            />
            <Label htmlFor="model-cache-visualization-enabled-toggle" className="text-sm font-medium">
              Enable prompt cache visualization
            </Label>
            {modelCacheVisualizationUpdating ? (
              <span className="text-xs text-muted-foreground">Saving…</span>
            ) : null}
          </div>
          {!modelCacheVisualizationEnabled && !modelCacheVisualizationLoading ? (
            <p className="mt-2 text-xs italic text-muted-foreground/70">
              Prompt cache visualization is off by default. While disabled, Forge does not collect new cache
              observations and hides the header indicator. Observations from earlier enabled periods may appear
              after you turn this on and load session history; Forge does not report guaranteed miss or drop causes.
            </p>
          ) : null}
          {modelCacheVisualizationError ? (
            <p className="mt-2 text-xs text-destructive">{modelCacheVisualizationError}</p>
          ) : null}
        </SettingsSection>
      )}

      {/* Sleep Prevention — Electron-only, Builder-only */}
      {isBuilder && (
        <SettingsSection
          label="Compaction"
          description="Choose the model, reasoning level, and timeout Forge uses for automatic and smart Pi compaction."
        >
          {!compactionView || !compactionDraft ? (
            <div className="text-sm text-muted-foreground">
              {compactionError ?? 'Loading compaction settings…'}
              {compactionLoadFailed ? (
                <button
                  type="button"
                  onClick={() => {
                    void loadCompactionSettings().catch((err) => {
                      setCompactionLoadFailed(true)
                      setCompactionError(err instanceof Error ? err.message : 'Could not load compaction settings')
                    })
                  }}
                  className="ml-2 text-primary underline hover:no-underline"
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : (
            <>
              <SettingsWithCTA
                label="Compaction model"
                description="Model used for Forge-owned automatic compaction and Smart compact summaries."
              >
                <div className="flex flex-col items-end gap-1.5">
                  <div className="flex items-center gap-2">
                    {compactionSuccess ? (
                      <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                        <Check className="size-3" />
                        Saved
                      </span>
                    ) : null}
                    <Select
                      value={getCompactionModelKey(compactionDraft.model)}
                      onValueChange={handleCompactionModelChange}
                      disabled={compactionUpdating}
                    >
                      <SelectTrigger className="w-full sm:w-72" aria-label="Compaction model">
                        <SelectValue placeholder="Select model" />
                      </SelectTrigger>
                      <SelectContent>
                        {compactionModelGroups.map((group) => (
                          <SelectGroup key={group.provider}>
                            <SelectLabel className="text-xs text-muted-foreground">{group.providerLabel}</SelectLabel>
                            {group.options.map((option) => (
                              <SelectItem key={option.key} value={option.key}>
                                {option.label}{option.isCurrentUnavailable ? ' (current setting)' : ''}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {selectedCompactionModel?.isCurrentUnavailable ? (
                    <span className="text-[10px] text-muted-foreground">
                      Current setting is preserved here so you can switch away from it.
                    </span>
                  ) : null}
                </div>
              </SettingsWithCTA>

              <SettingsWithCTA
                label="Compaction reasoning"
                description="Reasoning level used when Forge asks the compaction model to summarize older context."
              >
                <Select
                  value={compactionDraft.reasoningLevel}
                  onValueChange={handleCompactionReasoningChange}
                  disabled={compactionUpdating}
                >
                  <SelectTrigger className="w-full sm:w-48" aria-label="Compaction reasoning level">
                    <SelectValue placeholder="Select reasoning level" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableCompactionReasoningLevels.map((level) => (
                      <SelectItem key={level} value={level}>
                        {REASONING_LEVEL_LABELS[level] ?? level}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsWithCTA>

              <SettingsWithCTA
                label="Compaction timeout"
                description="How long Forge waits before automatic compaction is treated as timed out."
              >
                <Select
                  value={String(Math.max(1, Math.round(compactionDraft.timeoutMs / 60_000)))}
                  onValueChange={handleCompactionTimeoutChange}
                  disabled={compactionUpdating}
                >
                  <SelectTrigger className="w-full sm:w-48" aria-label="Compaction timeout">
                    <SelectValue placeholder="Select timeout" />
                  </SelectTrigger>
                  <SelectContent>
                    {compactionTimeoutMinuteOptions.map((minutes) => (
                      <SelectItem key={minutes} value={String(minutes)}>
                        {formatCompactionTimeoutLabel(minutes)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsWithCTA>

              {compactionWarning ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
                  {compactionWarning}
                </div>
              ) : null}

              {compactionError && !compactionLoadFailed ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {compactionError}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
                <p className="text-xs text-muted-foreground">
                  Defaults: {compactionView.defaults.model.modelId} · {REASONING_LEVEL_LABELS[compactionView.defaults.reasoningLevel] ?? compactionView.defaults.reasoningLevel} · {formatCompactionTimeoutLabel(Math.round(compactionView.defaults.timeoutMs / 60_000))}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleCompactionReset}
                    disabled={!hasCompactionChanges || compactionUpdating}
                  >
                    <RotateCcw className="size-4" />
                    Reset
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleCompactionSave}
                    disabled={!hasCompactionChanges || compactionUpdating}
                  >
                    Save
                  </Button>
                </div>
              </div>
            </>
          )}
        </SettingsSection>
      )}

      {isBuilder && inElectron && (
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

      {!cortexDisabled && (
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
                        void fetchCortexAutoReviewSettings(cortexSource)
                          .then((response) => {
                            setCortexSettings(response.settings)
                            setCortexDisabled(response.cortexDisabled === true)
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
      )}

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

      {/* Sidebar — local-only (Builder) */}
      {isBuilder && (
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

          <SettingsWithCTA
            label="Show provider usage"
            description="Display provider usage limits above the sidebar footer"
          >
            <Switch
              checked={sidebarProviderUsage}
              onCheckedChange={(checked) => {
                setSidebarProviderUsage(checked)
                storeSidebarProviderUsagePref(checked)
              }}
            />
          </SettingsWithCTA>
        </SettingsSection>
      )}

      {/* Terminal — Builder-only; hidden entirely for Collab target */}
      {isBuilder && (
        <SettingsSection
          label="Terminal"
          description="Configure the integrated terminal"
        >
          <SettingsWithCTA
            label="Default Shell"
            description={
              terminalSettings?.source === 'env' ? (
                <>
                  <span>Shell used when opening new terminals.</span>
                  <br />
                  <span className="text-amber-600 dark:text-amber-400">
                    Currently set via <code className="text-[10px]">FORGE_TERMINAL_DEFAULT_SHELL</code> environment variable.
                  </span>
                </>
              ) : (
                'Shell used when opening new terminals'
              )
            }
          >
            <div className="flex flex-col items-end gap-1.5">
              <div className="flex items-center gap-2">
                {terminalSuccess && (
                  <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                    <Check className="size-3" />
                    Saved
                  </span>
                )}
                <Select
                  value={terminalSettings?.persistedDefaultShell ?? '__system_default__'}
                  onValueChange={handleTerminalShellChange}
                  disabled={
                    !terminalShells ||
                    terminalSettings?.source === 'env' ||
                    terminalUpdating
                  }
                >
                  <SelectTrigger className="w-full sm:w-64">
                    <SelectValue placeholder="Loading shells…">
                      {terminalSettings?.persistedDefaultShell
                        ? (() => {
                            const shell = terminalShells?.shells.find(
                              (s) => s.path === terminalSettings.persistedDefaultShell,
                            )
                            return shell ? (
                              <span className="inline-flex items-center gap-2">
                                <Terminal className="size-3.5" />
                                {shell.name}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-2">
                                <Terminal className="size-3.5" />
                                {terminalSettings.persistedDefaultShell}
                              </span>
                            )
                          })()
                        : (
                          <span className="inline-flex items-center gap-2">
                            <Terminal className="size-3.5" />
                            System Default
                          </span>
                        )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__system_default__">
                      <span className="inline-flex items-center gap-2">
                        <Terminal className="size-3.5" />
                        System Default
                      </span>
                    </SelectItem>
                    {terminalShells?.shells
                      .filter((s) => s.available)
                      .map((shell) => (
                        <SelectItem key={shell.path} value={shell.path}>
                          <span className="inline-flex items-center gap-2">
                            <Terminal className="size-3.5" />
                            {shell.name}
                            <span className="text-muted-foreground text-[10px]">— {shell.path}</span>
                          </span>
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              {terminalError ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-destructive">{terminalError}</span>
                  {terminalLoadFailed ? (
                    <button
                      type="button"
                      onClick={() => {
                        setTerminalError(null)
                        setTerminalLoadFailed(false)
                        void fetchAvailableShells(wsUrl)
                          .then((data) => {
                            setTerminalShells(data)
                            setTerminalSettings(data.settings)
                            setTerminalLoadFailed(false)
                          })
                          .catch((err) => {
                            setTerminalLoadFailed(true)
                            setTerminalError(
                              err instanceof Error ? err.message : 'Could not load terminal settings',
                            )
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
      )}

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
            onClick={handleReboot}
          >
            <RotateCcw className="size-3.5 mr-1.5" />
            Reboot
          </Button>
        </SettingsWithCTA>
      </SettingsSection>

      {/* Confirmation dialog for collab-targeted reboot */}
      <AlertDialog open={showRebootConfirm} onOpenChange={setShowRebootConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reboot remote backend?</AlertDialogTitle>
            <AlertDialogDescription>
              This will restart the connected Collab backend and all its agents. Any active sessions on the remote server will be interrupted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={executeReboot}>Reboot</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
