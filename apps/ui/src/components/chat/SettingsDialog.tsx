import { useEffect, useMemo, useState } from 'react'
import { SettingsLayout } from '@/components/settings/SettingsLayout'
import type { SettingsTab } from '@/components/settings/settings-target'
import type { SettingsBackendTarget } from '@/components/settings/settings-target'
import { createBuilderSettingsTarget } from '@/components/settings/settings-target'
import { createSettingsApiClient, type SettingsApiClient } from '@/components/settings/settings-api-client'
import { SettingsGeneral } from '@/components/settings/SettingsGeneral'
import { SettingsNotifications } from '@/components/settings/SettingsNotifications'
import { SettingsAuth } from '@/components/settings/SettingsAuth'
import { SettingsIntegrations } from '@/components/settings/SettingsIntegrations'
import { SettingsModels } from '@/components/settings/SettingsModels'
import { SettingsSkills } from '@/components/settings/SettingsSkills'
import { SettingsPrompts } from '@/components/settings/SettingsPrompts'
import { SettingsSpecialists } from '@/components/settings/SettingsSpecialists'
import { SettingsSlashCommands } from '@/components/settings/SettingsSlashCommands'
import { SettingsExtensions } from '@/components/settings/SettingsExtensions'
import { SettingsAbout } from '@/components/settings/SettingsAbout'
import { SettingsCollaboration } from '@/components/settings/SettingsCollaboration'
import type { AgentDescriptor, ManagerProfile, PlaywrightDiscoverySettings, PlaywrightDiscoverySnapshot, TelegramStatusEvent } from '@forge/protocol'

interface SettingsPanelProps {
  wsUrl: string
  managers: AgentDescriptor[]
  profiles: ManagerProfile[]
  telegramStatus?: TelegramStatusEvent | null
  promptChangeKey: number
  specialistChangeKey: number
  modelConfigChangeKey: number
  onBack?: () => void
  onPlaywrightSnapshotUpdate?: (snapshot: PlaywrightDiscoverySnapshot) => void
  onPlaywrightSettingsLoaded?: (settings: PlaywrightDiscoverySettings) => void
  /** Optional target for target-aware Settings shell. When omitted, Builder target is created from wsUrl. */
  target?: SettingsBackendTarget
}

export function SettingsPanel({
  wsUrl,
  managers,
  profiles,
  telegramStatus,
  promptChangeKey,
  specialistChangeKey,
  modelConfigChangeKey,
  onBack,
  onPlaywrightSnapshotUpdate,
  onPlaywrightSettingsLoaded,
  target: externalTarget,
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')

  // Resolve target: external (from collab) or auto-create Builder target from wsUrl
  const target = useMemo<SettingsBackendTarget>(
    () => externalTarget ?? createBuilderSettingsTarget(wsUrl),
    [externalTarget, wsUrl],
  )

  // Create API client from resolved target
  const apiClient = useMemo<SettingsApiClient>(
    () => createSettingsApiClient(target),
    [target],
  )

  const availableTabs = target.availableTabs
  const targetLabel = target.label

  // Reset active tab when it becomes unavailable after target change
  useEffect(() => {
    if (availableTabs && !availableTabs.includes(activeTab)) {
      setActiveTab(availableTabs[0] ?? 'general')
    }
  }, [availableTabs, activeTab])

  return (
    <SettingsLayout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onBack={onBack}
      contentWidthClassName={activeTab === 'skills' ? 'max-w-full' : undefined}
      availableTabs={availableTabs}
      targetLabel={targetLabel}
    >
      {activeTab === 'general' && <SettingsGeneral wsUrl={wsUrl} target={target} apiClient={apiClient} onPlaywrightSnapshotUpdate={onPlaywrightSnapshotUpdate} onPlaywrightSettingsLoaded={onPlaywrightSettingsLoaded} />}
      {activeTab === 'notifications' && <SettingsNotifications managers={managers} />}
      {activeTab === 'auth' && <SettingsAuth wsUrl={wsUrl} target={target} apiClient={apiClient} />}
      {activeTab === 'models' && <SettingsModels wsUrl={wsUrl} apiClient={apiClient} modelConfigChangeKey={modelConfigChangeKey} />}
      {activeTab === 'integrations' && (
        <SettingsIntegrations
          wsUrl={wsUrl}
          managers={managers}
          telegramStatus={telegramStatus}
        />
      )}
      {activeTab === 'skills' && <SettingsSkills wsUrl={wsUrl} profiles={profiles} />}
      {activeTab === 'prompts' && (
        <SettingsPrompts
          wsUrl={wsUrl}
          profiles={profiles}
          promptChangeKey={promptChangeKey}
        />
      )}
      {activeTab === 'specialists' && (
        <SettingsSpecialists
          wsUrl={wsUrl}
          profiles={profiles}
          specialistChangeKey={specialistChangeKey}
          modelConfigChangeKey={modelConfigChangeKey}
        />
      )}
      {activeTab === 'slash-commands' && (
        <SettingsSlashCommands
          wsUrl={wsUrl}
          apiClient={apiClient}
        />
      )}
      {activeTab === 'extensions' && <SettingsExtensions wsUrl={wsUrl} />}
      {activeTab === 'collaboration' && <SettingsCollaboration wsUrl={wsUrl} />}
      {activeTab === 'about' && <SettingsAbout wsUrl={wsUrl} />}
    </SettingsLayout>
  )
}
