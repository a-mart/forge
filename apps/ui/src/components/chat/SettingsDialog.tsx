import { useCallback, useEffect, useMemo, useState } from 'react'
import { SettingsLayout } from '@/components/settings/SettingsLayout'
import type { SettingsTab } from '@/components/settings/settings-target'
import type { SettingsBackendTarget } from '@/components/settings/settings-target'
import { createBuilderSettingsTarget } from '@/components/settings/settings-target'
import { createSettingsApiClient, type SettingsApiClient } from '@/components/settings/settings-api-client'
import { SettingsGeneral } from '@/components/settings/SettingsGeneral'
import { SettingsGitMonitoring } from '@/components/settings/SettingsGitMonitoring'
import { SettingsAppearance } from '@/components/settings/SettingsAppearance'
import { SettingsNotifications } from '@/components/settings/SettingsNotifications'
import { SettingsAuth } from '@/components/settings/SettingsAuth'
import { SettingsSecrets } from '@/components/settings/SettingsSecrets'
import { SettingsModels } from '@/components/settings/SettingsModels'
import { SettingsSkills } from '@/components/settings/SettingsSkills'
import { SettingsPrompts } from '@/components/settings/SettingsPrompts'
import { SettingsSpecialists } from '@/components/settings/SettingsSpecialists'
import { SettingsProjectResources } from '@/components/settings/SettingsProjectResources'
import { SettingsProjectSettings, type ProjectSettingsActions } from '@/components/settings/SettingsProjectSettings'
import { SettingsSlashCommands } from '@/components/settings/SettingsSlashCommands'
import { SettingsExtensions } from '@/components/settings/SettingsExtensions'
import { SettingsExternalChrome } from '@/components/settings/SettingsExternalChrome'
import { SettingsAbout } from '@/components/settings/SettingsAbout'
import { SettingsCliAccess } from '@/components/settings/SettingsCliAccess'
import { SettingsStreamDeck } from '@/components/settings/SettingsStreamDeck'
import { SettingsObservability } from '@/components/settings/SettingsObservability'
import { SettingsCollaboration } from '@/components/settings/SettingsCollaboration'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'

function getSettingsContentWidthClassName(activeTab: SettingsTab): string | undefined {
  if (activeTab === 'appearance') return 'max-w-6xl'
  if (activeTab === 'skills') return 'max-w-full'
  if (activeTab === 'specialists') return 'max-w-[96rem]'
  return undefined
}

interface SettingsPanelProps {
  wsUrl: string
  managers: AgentDescriptor[]
  profiles: ManagerProfile[]
  promptChangeKey: number
  specialistChangeKey: number
  modelConfigChangeKey: number
  connectionEpoch?: number
  onBack?: () => void
  /** Optional active session context for session-specific runtime prompt previews. */
  previewSession?: {
    agentId: string
    profileId: string
  } | null
  /** Exact project selected by contextual Settings navigation. */
  contextProfileId?: string
  /** Builder-only handlers used by the project-scoped settings surface. */
  projectSettingsActions?: ProjectSettingsActions
  /** Optional target for target-aware Settings shell. When omitted, Builder target is created from wsUrl. */
  target?: SettingsBackendTarget
  /**
   * Explicit runtime capability for Clone repository settings.
   * When omitted, derived after target resolution (builder enables, collab disables).
   * Explicit false disables even on Builder/direct-server shells.
   */
  repositoryCloneAvailable?: boolean
  /**
   * Optional initial tab to select when the panel mounts.
   * Used for deep-link navigation (e.g. sign-in recovery → Collaboration tab).
   * Must be a valid {@link SettingsTab} string; ignored if not in the target's
   * `availableTabs`.
   */
  initialTab?: string
  /**
   * Optional collab backend API base URL to preselect in the Collaboration
   * settings tab.  Used when the user clicks "Sign in again" from an auth
   * error on a specific collab backend to navigate directly to the right
   * backend's sign-in form.
   */
  initialCollabApiBaseUrl?: string
  /** Optional Forge skill-share URL to open in the Skills import dialog. */
  initialSkillImportUrl?: string
  /** Called after the Skills tab consumes the import URL so the bearer URL can be removed from route state. */
  onSkillImportUrlConsumed?: () => void
}

export function SettingsPanel({
  wsUrl,
  managers,
  profiles,
  promptChangeKey,
  specialistChangeKey,
  modelConfigChangeKey,
  connectionEpoch,
  onBack,
  previewSession,
  contextProfileId,
  projectSettingsActions,
  target: externalTarget,
  repositoryCloneAvailable,
  initialTab,
  initialCollabApiBaseUrl,
  initialSkillImportUrl,
  onSkillImportUrlConsumed,
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    if (initialTab) {
      // Validated against available tabs in the useEffect below; for the
      // initial render, trust the caller — the effect corrects mismatches.
      return initialTab as SettingsTab
    }
    return 'general'
  })

  // Resolve target: external (from collab) or auto-create Builder target from wsUrl
  const target = useMemo<SettingsBackendTarget>(
    () => externalTarget ?? createBuilderSettingsTarget(wsUrl),
    [externalTarget, wsUrl],
  )

  // Derive only after target resolution: collab always disables; explicit false
  // disables Builder/direct-server; omitted on builder enables.
  const resolvedRepositoryCloneAvailable =
    target.kind === 'collab' ? false : repositoryCloneAvailable !== false

  // Create API client from resolved target
  const apiClient = useMemo<SettingsApiClient>(
    () => createSettingsApiClient(target),
    [target],
  )

  const availableTabs = target.availableTabs
  const selectedProject = useMemo(
    () => profiles.find((profile) => profile.profileId === contextProfileId),
    [contextProfileId, profiles],
  )
  const selectedProjectManager = useMemo(() => {
    if (!contextProfileId) return undefined
    return managers.find((manager) =>
      manager.role === 'manager'
      && (
        manager.agentId === selectedProject?.defaultSessionAgentId
        || manager.profileId === contextProfileId
        || manager.agentId === contextProfileId
      ),
    )
  }, [contextProfileId, managers, selectedProject?.defaultSessionAgentId])
  // Project settings are available only on the local Builder surface. A route
  // carries the profile ID so the selected project stays stable even if the
  // sticky conversation selection belongs to another project.
  const projectSettingsRouteAvailable = target.kind === 'builder' && Boolean(contextProfileId)
  const isProjectSettings = activeTab === 'project-settings' && projectSettingsRouteAvailable
  const layoutAvailableTabs = isProjectSettings ? ['project-settings'] as SettingsTab[] : availableTabs
  const targetLabel = isProjectSettings
    ? `Project: ${selectedProject?.displayName ?? contextProfileId}`
    : target.label

  const isAvailableTab = useCallback((tab: SettingsTab) =>
    tab === 'project-settings'
      ? projectSettingsRouteAvailable
      : availableTabs.includes(tab), [availableTabs, projectSettingsRouteAvailable])

  // Sync activeTab when initialTab prop changes while panel is already mounted
  // (e.g. deep-link navigation to Collaboration tab after sign-in recovery).
  useEffect(() => {
    if (initialTab && isAvailableTab(initialTab as SettingsTab)) {
      setActiveTab(initialTab as SettingsTab)
    }
  }, [initialTab, isAvailableTab])

  // Reset active tab when it becomes unavailable after target change.
  useEffect(() => {
    if (!isAvailableTab(activeTab)) {
      setActiveTab(availableTabs[0] ?? 'general')
    }
  }, [activeTab, availableTabs, isAvailableTab])

  return (
    <SettingsLayout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onBack={onBack}
      contentWidthClassName={getSettingsContentWidthClassName(activeTab)}
      fillHeight={activeTab === 'skills'}
      availableTabs={layoutAvailableTabs}
      targetLabel={targetLabel}
      title={isProjectSettings ? 'Project Settings' : 'Settings'}
    >
      {activeTab === 'general' && (
        <SettingsGeneral
          wsUrl={wsUrl}
          target={target}
          apiClient={apiClient}
          repositoryCloneAvailable={resolvedRepositoryCloneAvailable}
        />
      )}
      {activeTab === 'git-monitoring' && target.kind === 'builder' && (
        <SettingsGitMonitoring wsUrl={wsUrl} profiles={profiles} />
      )}
      {activeTab === 'appearance' && <SettingsAppearance />}
      {activeTab === 'notifications' && <SettingsNotifications managers={managers} apiClient={apiClient} />}
      {activeTab === 'auth' && <SettingsAuth wsUrl={wsUrl} target={target} apiClient={apiClient} />}
      {activeTab === 'secrets' && target.kind === 'builder' && (
        <SettingsSecrets
          apiClient={apiClient}
          profiles={profiles}
          currentProfileId={contextProfileId ?? previewSession?.profileId}
        />
      )}
      {activeTab === 'models' && <SettingsModels wsUrl={wsUrl} apiClient={apiClient} modelConfigChangeKey={modelConfigChangeKey} />}
      {activeTab === 'skills' && (
        <SettingsSkills
          wsUrl={wsUrl}
          apiClient={apiClient}
          profiles={profiles}
          managers={managers}
          previewSession={previewSession}
          changeKey={specialistChangeKey}
          initialImportUrl={initialSkillImportUrl}
          onInitialImportUrlConsumed={onSkillImportUrlConsumed}
        />
      )}
      {activeTab === 'prompts' && (
        <SettingsPrompts
          wsUrl={wsUrl}
          apiClient={apiClient}
          profiles={profiles}
          promptChangeKey={promptChangeKey}
          previewSession={previewSession}
        />
      )}
      {activeTab === 'specialists' && (
        <SettingsSpecialists
          wsUrl={wsUrl}
          apiClient={apiClient}
          profiles={profiles}
          previewSession={previewSession}
          specialistChangeKey={specialistChangeKey}
          modelConfigChangeKey={modelConfigChangeKey}
        />
      )}
      {isProjectSettings && selectedProject ? (
        <SettingsProjectSettings
          wsUrl={wsUrl}
          profile={selectedProject}
          manager={selectedProjectManager}
          apiClient={apiClient}
          modelConfigChangeKey={modelConfigChangeKey}
          connectionEpoch={connectionEpoch}
          actions={projectSettingsActions}
        />
      ) : null}
      {isProjectSettings && !selectedProject ? (
        <div className="rounded-md border border-border bg-card/40 p-4 text-sm text-muted-foreground">
          This project is no longer available.
        </div>
      ) : null}
      {activeTab === 'project-resources' && (
        <SettingsProjectResources managers={managers} previewSession={previewSession} apiClient={apiClient} />
      )}
      {activeTab === 'slash-commands' && (
        <SettingsSlashCommands
          wsUrl={wsUrl}
          apiClient={apiClient}
        />
      )}
      {activeTab === 'extensions' && <SettingsExtensions wsUrl={wsUrl} apiClient={apiClient} />}
      {activeTab === 'external-chrome' && target.kind === 'builder' && <SettingsExternalChrome />}
      {activeTab === 'cli-access' && <SettingsCliAccess wsUrl={wsUrl} apiClient={apiClient} />}
      {activeTab === 'stream-deck' && <SettingsStreamDeck apiClient={apiClient} />}
      {activeTab === 'observability' && <SettingsObservability apiClient={apiClient} />}
      {activeTab === 'collaboration' && (
        <SettingsCollaboration
          wsUrl={wsUrl}
          initialApiBaseUrl={target.kind === 'collab' ? target.apiBaseUrl : initialCollabApiBaseUrl}
        />
      )}
      {activeTab === 'about' && <SettingsAbout wsUrl={wsUrl} apiClient={apiClient} />}
    </SettingsLayout>
  )
}
