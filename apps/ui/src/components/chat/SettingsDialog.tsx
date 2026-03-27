import { useState } from 'react'
import { SettingsLayout, type SettingsTab } from '@/components/settings/SettingsLayout'
import { SettingsGeneral } from '@/components/settings/SettingsGeneral'
import { SettingsNotifications } from '@/components/settings/SettingsNotifications'
import { SettingsAuth } from '@/components/settings/SettingsAuth'
import { SettingsIntegrations } from '@/components/settings/SettingsIntegrations'
import { SettingsSkills } from '@/components/settings/SettingsSkills'
import { SettingsPrompts } from '@/components/settings/SettingsPrompts'
import { SettingsSpecialists } from '@/components/settings/SettingsSpecialists'
import { SettingsSlashCommands } from '@/components/settings/SettingsSlashCommands'
import { SettingsExtensions } from '@/components/settings/SettingsExtensions'
import { SettingsAbout } from '@/components/settings/SettingsAbout'
import type { AgentDescriptor, ManagerProfile, PlaywrightDiscoverySettings, PlaywrightDiscoverySnapshot, TelegramStatusEvent } from '@forge/protocol'

interface SettingsPanelProps {
  wsUrl: string
  managers: AgentDescriptor[]
  profiles: ManagerProfile[]
  telegramStatus?: TelegramStatusEvent | null
  promptChangeKey: number
  specialistChangeKey: number
  onBack?: () => void
  onPlaywrightSnapshotUpdate?: (snapshot: PlaywrightDiscoverySnapshot) => void
  onPlaywrightSettingsLoaded?: (settings: PlaywrightDiscoverySettings) => void
}

export function SettingsPanel({
  wsUrl,
  managers,
  profiles,
  telegramStatus,
  promptChangeKey,
  specialistChangeKey,
  onBack,
  onPlaywrightSnapshotUpdate,
  onPlaywrightSettingsLoaded,
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')

  return (
    <SettingsLayout activeTab={activeTab} onTabChange={setActiveTab} onBack={onBack}>
      {activeTab === 'general' && <SettingsGeneral wsUrl={wsUrl} onPlaywrightSnapshotUpdate={onPlaywrightSnapshotUpdate} onPlaywrightSettingsLoaded={onPlaywrightSettingsLoaded} />}
      {activeTab === 'notifications' && <SettingsNotifications managers={managers} />}
      {activeTab === 'auth' && <SettingsAuth wsUrl={wsUrl} />}
      {activeTab === 'integrations' && (
        <SettingsIntegrations
          wsUrl={wsUrl}
          managers={managers}
          telegramStatus={telegramStatus}
        />
      )}
      {activeTab === 'skills' && <SettingsSkills wsUrl={wsUrl} />}
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
        />
      )}
      {activeTab === 'slash-commands' && (
        <SettingsSlashCommands
          wsUrl={wsUrl}
        />
      )}
      {activeTab === 'extensions' && <SettingsExtensions wsUrl={wsUrl} />}
      {activeTab === 'about' && <SettingsAbout />}
    </SettingsLayout>
  )
}
