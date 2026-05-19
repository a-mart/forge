import type { ManagerProfile } from '@forge/protocol'
import type { SettingsSessionContext } from './session-context'
import { SkillsViewer } from './skills/SkillsViewer'
import type { SettingsApiClient } from './settings-api-client'

/* ------------------------------------------------------------------ */
/*  Skills settings tab — delegates to the SkillsViewer               */
/* ------------------------------------------------------------------ */

interface SettingsSkillsProps {
  wsUrl: string
  apiClient?: SettingsApiClient
  profiles: ManagerProfile[]
  previewSession?: SettingsSessionContext | null
  changeKey?: number
  initialImportUrl?: string
  onInitialImportUrlConsumed?: () => void
}

export function SettingsSkills({
  wsUrl,
  apiClient,
  profiles,
  previewSession,
  changeKey,
  initialImportUrl,
  onInitialImportUrlConsumed,
}: SettingsSkillsProps) {
  return (
    <SkillsViewer
      wsUrl={wsUrl}
      apiClient={apiClient}
      profiles={profiles}
      previewSession={previewSession}
      changeKey={changeKey}
      initialImportUrl={initialImportUrl}
      onInitialImportUrlConsumed={onInitialImportUrlConsumed}
    />
  )
}
