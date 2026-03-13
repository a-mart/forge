import { useState } from 'react'
import { SettingsLayout, type SettingsTab } from '@/components/settings/SettingsLayout'
import { SettingsGeneral } from '@/components/settings/SettingsGeneral'
import { SettingsNotifications } from '@/components/settings/SettingsNotifications'
import { SettingsAuth } from '@/components/settings/SettingsAuth'
import { SettingsIntegrations } from '@/components/settings/SettingsIntegrations'
import { SettingsSkills } from '@/components/settings/SettingsSkills'
import { SettingsPrompts } from '@/components/settings/SettingsPrompts'
import { SettingsSlashCommands } from '@/components/settings/SettingsSlashCommands'
import type { AgentDescriptor, ManagerProfile, PlaywrightDiscoverySettings, PlaywrightDiscoverySnapshot, SlackStatusEvent, TelegramStatusEvent } from '@middleman/protocol'

interface SettingsPanelProps {
  wsUrl: string
  managers: AgentDescriptor[]
  profiles: ManagerProfile[]
  slackStatus?: SlackStatusEvent | null
  telegramStatus?: TelegramStatusEvent | null
  promptChangeKey: number
  onBack?: () => void
  onPlaywrightSnapshotUpdate?: (snapshot: PlaywrightDiscoverySnapshot) => void
  onPlaywrightSettingsLoaded?: (settings: PlaywrightDiscoverySettings) => void
}

export function SettingsPanel({
  wsUrl,
  managers,
  profiles,
  slackStatus,
  telegramStatus,
  promptChangeKey,
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
          slackStatus={slackStatus}
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
      {activeTab === 'slash-commands' && (
        <SettingsSlashCommands
          wsUrl={wsUrl}
          managers={managers}
          profiles={profiles}
        />
      )}
    </SettingsLayout>
  )
}
