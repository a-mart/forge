import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Chrome,
  Globe,
  Loader2,
  RefreshCw,
  Save,
  Search,
  TestTube2,
  Trash2,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SettingsSection } from './settings-row'
import type {
  ChromeCdpConfig,
  ChromeCdpStatus,
  ChromeCdpProfile,
  ChromeCdpPreviewTab,
} from './settings-types'
import {
  fetchChromeCdpSettings,
  updateChromeCdpSettings,
  testChromeCdpConnection,
  fetchChromeCdpProfiles,
  fetchChromeCdpPreview,
  toErrorMessage,
} from './settings-api'

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface SettingsChromeCdpProps {
  wsUrl: string
  onConfigChanged?: () => void
}

interface DraftConfig {
  contextId: string | null
  urlAllow: string[]
  urlBlock: string[]
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function truncateUrl(url: string, maxLen = 60): string {
  if (url.length <= maxLen) return url
  return url.slice(0, maxLen - 1) + '…'
}

function truncateContextId(contextId: string, maxLen = 16): string {
  if (contextId.length <= maxLen) return contextId
  return contextId.slice(0, maxLen) + '…'
}

function draftToPartialConfig(draft: DraftConfig): Partial<ChromeCdpConfig> {
  return {
    contextId: draft.contextId,
    urlAllow: draft.urlAllow,
    urlBlock: draft.urlBlock,
  }
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                    */
/* ------------------------------------------------------------------ */

function ConnectionBadge({ status }: { status: ChromeCdpStatus | null }) {
  if (!status) {
    return (
      <Badge variant="outline" className="border-border/50 bg-muted/50 text-muted-foreground">
        Unknown
      </Badge>
    )
  }
  if (status.connected) {
    return (
      <Badge
        variant="outline"
        className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      >
        <span className="size-1.5 rounded-full bg-emerald-500" />
        Connected
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="gap-1.5 border-destructive/30 bg-destructive/10 text-destructive"
    >
      <span className="size-1.5 rounded-full bg-destructive" />
      Not connected
    </Badge>
  )
}

function FeedbackBanner({ error, success }: { error: string | null; success: string | null }) {
  return (
    <>
      {error ? (
        <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
          <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
          <p className="text-xs text-destructive">{error}</p>
        </div>
      ) : null}
      {success ? (
        <div className="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
          <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <p className="text-xs text-emerald-600 dark:text-emerald-400">{success}</p>
        </div>
      ) : null}
    </>
  )
}

function PatternChips({
  patterns,
  onRemove,
}: {
  patterns: string[]
  onRemove: (index: number) => void
}) {
  if (patterns.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {patterns.map((pattern, i) => (
        <Badge
          key={`${pattern}-${i}`}
          variant="secondary"
          className="gap-1 pl-2 pr-1 py-0.5 text-xs font-mono"
        >
          {pattern}
          <button
            type="button"
            onClick={() => onRemove(i)}
            className="ml-0.5 rounded-sm p-0.5 hover:bg-muted-foreground/20 transition-colors"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
    </div>
  )
}

function PatternInput({
  label,
  description,
  patterns,
  onChange,
  placeholder,
}: {
  label: string
  description: string
  patterns: string[]
  onChange: (next: string[]) => void
  placeholder: string
}) {
  const [inputValue, setInputValue] = useState('')

  const addPattern = () => {
    const trimmed = inputValue.trim()
    if (!trimmed) return
    if (patterns.includes(trimmed)) {
      setInputValue('')
      return
    }
    onChange([...patterns, trimmed])
    setInputValue('')
  }

  const removePattern = (index: number) => {
    onChange(patterns.filter((_, i) => i !== index))
  }

  return (
    <div className="space-y-2">
      <div>
        <Label className="text-xs font-medium">{label}</Label>
        <p className="text-[11px] text-muted-foreground">{description}</p>
      </div>
      <PatternChips patterns={patterns} onRemove={removePattern} />
      <div className="flex items-center gap-2">
        <Input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addPattern()
            }
          }}
          placeholder={placeholder}
          className="flex-1 font-mono text-xs"
          spellCheck={false}
          autoComplete="off"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addPattern}
          disabled={!inputValue.trim()}
        >
          Add
        </Button>
      </div>
    </div>
  )
}

function ProfileCard({
  profile,
  isSelected,
  onSelect,
}: {
  profile: ChromeCdpProfile
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-md border p-3 text-left transition-colors ${
        isSelected
          ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
          : 'border-border/70 bg-card/50 hover:bg-card/80'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold font-mono">
          {truncateContextId(profile.contextId)}
        </span>
        {profile.isDefault && (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            Default
          </Badge>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {profile.tabCount} tab{profile.tabCount !== 1 ? 's' : ''}
        </span>
      </div>
      {profile.sampleUrls.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {profile.sampleUrls.slice(0, 3).map((url, i) => (
            <p key={i} className="text-[11px] text-muted-foreground truncate">
              {url}
            </p>
          ))}
          {profile.sampleUrls.length > 3 && (
            <p className="text-[11px] text-muted-foreground/60">
              … and {profile.sampleUrls.length - 3} more
            </p>
          )}
        </div>
      )}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/*  Main component                                                    */
/* ------------------------------------------------------------------ */

export function SettingsChromeCdp({ wsUrl, onConfigChanged }: SettingsChromeCdpProps) {
  /* ---------- State ---------- */

  // Connection & config
  const [status, setStatus] = useState<ChromeCdpStatus | null>(null)
  const [savedConfig, setSavedConfig] = useState<ChromeCdpConfig | null>(null)
  const [draft, setDraft] = useState<DraftConfig>({
    contextId: null,
    urlAllow: [],
    urlBlock: [],
  })
  const [isLoadingInit, setIsLoadingInit] = useState(true)

  // Connection test
  const [isTesting, setIsTesting] = useState(false)

  // Profiles
  const [profiles, setProfiles] = useState<ChromeCdpProfile[]>([])
  const [isDiscoveringProfiles, setIsDiscoveringProfiles] = useState(false)
  const [, setProfilesDiscovered] = useState(false)

  // Preview
  const [previewTabs, setPreviewTabs] = useState<ChromeCdpPreviewTab[]>([])
  const [previewTotalFiltered, setPreviewTotalFiltered] = useState(0)
  const [previewTotalUnfiltered, setPreviewTotalUnfiltered] = useState(0)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const previewAbortRef = useRef<AbortController | null>(null)

  // Save/clear
  const [isSaving, setIsSaving] = useState(false)
  const [isClearing, setIsClearing] = useState(false)

  // Feedback
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* ---------- Feedback auto-dismiss ---------- */

  const showSuccess = useCallback((msg: string) => {
    setSuccess(msg)
    setError(null)
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current)
    feedbackTimerRef.current = setTimeout(() => setSuccess(null), 4000)
  }, [])

  const showError = useCallback((msg: string) => {
    setError(msg)
    setSuccess(null)
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current)
    feedbackTimerRef.current = setTimeout(() => setError(null), 8000)
  }, [])

  /* ---------- Initial load ---------- */

  const loadSettings = useCallback(async () => {
    setIsLoadingInit(true)
    try {
      const result = await fetchChromeCdpSettings(wsUrl)
      setStatus(result.status)
      setSavedConfig(result.config)
      setDraft({
        contextId: result.config.contextId,
        urlAllow: [...result.config.urlAllow],
        urlBlock: [...result.config.urlBlock],
      })
    } catch (err) {
      showError(toErrorMessage(err))
    } finally {
      setIsLoadingInit(false)
    }
  }, [wsUrl, showError])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  /* ---------- Preview with debounce + abort ---------- */

  const triggerPreview = useCallback(
    async (config: DraftConfig) => {
      previewAbortRef.current?.abort()
      const controller = new AbortController()
      previewAbortRef.current = controller

      setIsLoadingPreview(true)
      setPreviewError(null)

      try {
        const result = await fetchChromeCdpPreview(
          wsUrl,
          draftToPartialConfig(config),
          controller.signal,
        )
        if (!controller.signal.aborted) {
          setPreviewTabs(result.tabs)
          setPreviewTotalFiltered(result.totalFiltered)
          setPreviewTotalUnfiltered(result.totalUnfiltered)
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setPreviewError(toErrorMessage(err))
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingPreview(false)
        }
      }
    },
    [wsUrl],
  )

  // Debounced preview on draft changes (only when connected)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!status?.connected) return

    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void triggerPreview(draft)
    }, 500)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [draft, status?.connected, triggerPreview])

  // Cleanup abort on unmount
  useEffect(() => {
    return () => {
      previewAbortRef.current?.abort()
    }
  }, [])

  /* ---------- Handlers ---------- */

  const handleTestConnection = async () => {
    setIsTesting(true)
    setError(null)
    setSuccess(null)
    try {
      const result = await testChromeCdpConnection(wsUrl)
      setStatus(result)
      if (result.connected) {
        const parts: string[] = ['Connected']
        if (result.port) parts.push(`on port ${result.port}`)
        if (result.tabCount !== undefined) parts.push(`· ${result.tabCount} tab${result.tabCount !== 1 ? 's' : ''}`)
        showSuccess(parts.join(' '))
      } else {
        showError(result.error ?? 'Could not connect to Chrome DevTools Protocol.')
      }
    } catch (err) {
      showError(toErrorMessage(err))
    } finally {
      setIsTesting(false)
    }
  }

  const handleDiscoverProfiles = async () => {
    setIsDiscoveringProfiles(true)
    setError(null)
    try {
      const result = await fetchChromeCdpProfiles(wsUrl)
      setProfiles(result)
      setProfilesDiscovered(true)
      if (result.length === 0) {
        showError('No Chrome profiles found. Is Chrome running with --remote-debugging-port?')
      }
    } catch (err) {
      showError(toErrorMessage(err))
    } finally {
      setIsDiscoveringProfiles(false)
    }
  }

  const handleSelectProfile = (contextId: string | null) => {
    setDraft((prev) => ({ ...prev, contextId }))
  }

  const handleSave = async () => {
    setIsSaving(true)
    setError(null)
    setSuccess(null)
    try {
      await updateChromeCdpSettings(wsUrl, draftToPartialConfig(draft))
      setSavedConfig({
        contextId: draft.contextId,
        urlAllow: [...draft.urlAllow],
        urlBlock: [...draft.urlBlock],
      })
      showSuccess('Chrome CDP configuration saved.')
      onConfigChanged?.()
    } catch (err) {
      showError(toErrorMessage(err))
    } finally {
      setIsSaving(false)
    }
  }

  const handleClear = async () => {
    setIsClearing(true)
    setError(null)
    setSuccess(null)
    try {
      await updateChromeCdpSettings(wsUrl, {
        contextId: null,
        urlAllow: [],
        urlBlock: [],
      })
      const emptyDraft: DraftConfig = { contextId: null, urlAllow: [], urlBlock: [] }
      setDraft(emptyDraft)
      setSavedConfig({ contextId: null, urlAllow: [], urlBlock: [] })
      showSuccess('Chrome CDP configuration cleared.')
      onConfigChanged?.()
    } catch (err) {
      showError(toErrorMessage(err))
    } finally {
      setIsClearing(false)
    }
  }

  /* ---------- Derived ---------- */

  const hasFilters = draft.contextId !== null || draft.urlAllow.length > 0 || draft.urlBlock.length > 0
  const hasDraftChanges =
    savedConfig !== null &&
    (draft.contextId !== savedConfig.contextId ||
      JSON.stringify(draft.urlAllow) !== JSON.stringify(savedConfig.urlAllow) ||
      JSON.stringify(draft.urlBlock) !== JSON.stringify(savedConfig.urlBlock))

  /* ---------- Loading state ---------- */

  if (isLoadingInit) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  /* ---------- Render ---------- */

  return (
    <div className="flex flex-col gap-6">
      {/* Section 1: Connection Status */}
      <SettingsSection
        label="Connection"
        description="Chrome DevTools Protocol connection status"
        cta={<ConnectionBadge status={status} />}
      >
        <FeedbackBanner error={error} success={success} />

        {status?.connected ? (
          <div className="rounded-md border border-border/70 bg-card/50 p-3 space-y-1.5">
            <div className="flex items-center gap-2">
              <Chrome className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">Chrome</span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {status.port && (
                <>
                  <span>Port</span>
                  <span className="font-mono">{status.port}</span>
                </>
              )}
              {status.version && (
                <>
                  <span>Version</span>
                  <span className="font-mono">{status.version}</span>
                </>
              )}
              {status.browser && (
                <>
                  <span>Browser</span>
                  <span className="font-mono truncate">{status.browser}</span>
                </>
              )}
              {status.tabCount !== undefined && (
                <>
                  <span>Tabs</span>
                  <span className="font-mono">{status.tabCount}</span>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-border p-4 text-center space-y-2">
            <Globe className="mx-auto size-6 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              {status?.error ?? 'Chrome DevTools Protocol is not available.'}
            </p>
            <p className="text-[11px] text-muted-foreground/60">
              Launch Chrome with{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[10px] font-mono">
                --remote-debugging-port=9222
              </code>{' '}
              or enable it at{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[10px] font-mono">
                chrome://inspect
              </code>
            </p>
          </div>
        )}

        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleTestConnection()}
            disabled={isTesting}
            className="gap-1.5"
          >
            {isTesting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <TestTube2 className="size-3.5" />
            )}
            {isTesting ? 'Testing…' : 'Test Connection'}
          </Button>
        </div>
      </SettingsSection>

      {/* Section 2: Profile Selector */}
      <SettingsSection
        label="Chrome Profile"
        description="Restrict agent access to tabs in a specific Chrome profile"
      >
        {/* No filter option */}
        <button
          type="button"
          onClick={() => handleSelectProfile(null)}
          className={`w-full rounded-md border p-3 text-left transition-colors ${
            draft.contextId === null
              ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
              : 'border-border/70 bg-card/50 hover:bg-card/80'
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold">All profiles</span>
            <span className="text-[11px] text-muted-foreground">No profile filter</span>
          </div>
        </button>

        {/* Discovered profiles */}
        {profiles.length > 0 && (
          <div className="space-y-2">
            {profiles.map((profile) => (
              <ProfileCard
                key={profile.contextId}
                profile={profile}
                isSelected={draft.contextId === profile.contextId}
                onSelect={() => handleSelectProfile(profile.contextId)}
              />
            ))}
          </div>
        )}

        {/* Manual context ID entry (if set but not in discovered list) */}
        {draft.contextId !== null &&
          profiles.length > 0 &&
          !profiles.some((p) => p.contextId === draft.contextId) && (
            <div className="rounded-md border border-primary bg-primary/5 ring-1 ring-primary/20 p-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold font-mono">
                  {truncateContextId(draft.contextId)}
                </span>
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  Custom
                </Badge>
              </div>
            </div>
          )}

        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleDiscoverProfiles()}
            disabled={isDiscoveringProfiles}
            className="gap-1.5"
          >
            {isDiscoveringProfiles ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Search className="size-3.5" />
            )}
            {isDiscoveringProfiles ? 'Discovering…' : 'Discover Profiles'}
          </Button>
        </div>


      </SettingsSection>

      {/* Section 3: URL Filters */}
      <SettingsSection
        label="URL Filters"
        description={
          <>
            Control which tabs are visible to agents. Allow list is applied first, then block
            list. Use <code className="rounded bg-muted px-1 py-0.5 text-[10px] font-mono">*</code>{' '}
            as wildcard.
          </>
        }
      >
        <PatternInput
          label="Allowed URLs"
          description="Only matching URLs are visible. Leave empty to allow all."
          patterns={draft.urlAllow}
          onChange={(next) => setDraft((prev) => ({ ...prev, urlAllow: next }))}
          placeholder="e.g. *github.com* or localhost:*"
        />

        <PatternInput
          label="Blocked URLs"
          description="Matching URLs are hidden, even if they match the allow list."
          patterns={draft.urlBlock}
          onChange={(next) => setDraft((prev) => ({ ...prev, urlBlock: next }))}
          placeholder="e.g. *mail.google* or *bank*"
        />
      </SettingsSection>

      {/* Section 4: Live Preview */}
      <SettingsSection
        label="Tab Preview"
        description="Tabs visible to agents with current filter configuration"
        cta={
          status?.connected ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void triggerPreview(draft)}
              disabled={isLoadingPreview}
              className="gap-1.5 text-xs"
            >
              {isLoadingPreview ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RefreshCw className="size-3" />
              )}
              Refresh
            </Button>
          ) : undefined
        }
      >
        {!status?.connected ? (
          <p className="text-[11px] text-muted-foreground/60">
            Connect to Chrome to see a live tab preview.
          </p>
        ) : previewError ? (
          <div className="flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
            <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
            <p className="text-xs text-destructive">{previewError}</p>
          </div>
        ) : isLoadingPreview && previewTabs.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Summary line */}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {!hasFilters ? (
                <span>No filters configured — all tabs visible to agents</span>
              ) : (
                <span>
                  Showing{' '}
                  <span className="font-semibold text-foreground">
                    {previewTotalUnfiltered - previewTotalFiltered}
                  </span>{' '}
                  of{' '}
                  <span className="font-semibold text-foreground">
                    {previewTotalUnfiltered}
                  </span>{' '}
                  tabs
                  {previewTotalFiltered > 0 && (
                    <span className="text-muted-foreground/60">
                      {' '}
                      ({previewTotalFiltered} filtered out)
                    </span>
                  )}
                </span>
              )}
              {isLoadingPreview && (
                <Loader2 className="size-3 animate-spin text-muted-foreground/50" />
              )}
            </div>

            {/* Tab list */}
            {previewTabs.length > 0 && (
              <ScrollArea className="max-h-80 overflow-hidden rounded-md border border-border/60">
                <div className="divide-y divide-border/40">
                  {previewTabs.map((tab) => (
                    <div key={tab.targetId} className="px-2.5 py-1.5">
                      <p className="text-[11px] font-medium text-foreground truncate leading-tight">
                        {tab.title || '(untitled)'}
                      </p>
                      <p className="text-[10px] text-muted-foreground font-mono truncate leading-tight">
                        {truncateUrl(tab.url, 80)}
                      </p>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}

            {previewTabs.length === 0 && hasFilters && !isLoadingPreview && (
              <div className="rounded-md border border-dashed border-border p-4 text-center">
                <p className="text-xs text-muted-foreground">
                  No tabs match the current filter configuration.
                </p>
              </div>
            )}
          </>
        )}
      </SettingsSection>

      {/* Section 5: Actions */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleClear()}
          disabled={isClearing || isSaving || (!hasFilters && savedConfig?.contextId === null)}
          className="gap-1.5"
        >
          {isClearing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Trash2 className="size-3.5" />
          )}
          {isClearing ? 'Clearing…' : 'Clear All'}
        </Button>

        <Button
          type="button"
          size="sm"
          onClick={() => void handleSave()}
          disabled={isSaving || isClearing}
          className="gap-1.5"
        >
          {isSaving ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Save className="size-3.5" />
          )}
          {isSaving ? 'Saving…' : 'Save Configuration'}
        </Button>
      </div>

      {hasDraftChanges && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400 text-right -mt-4">
          You have unsaved changes.
        </p>
      )}
    </div>
  )
}
