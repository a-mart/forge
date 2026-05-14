import type { ManagerProfile } from '@forge/protocol'
import { SkillsViewer } from './skills/SkillsViewer'
import type { SettingsApiClient } from './settings-api-client'

/* ------------------------------------------------------------------ */
/*  Skills settings tab — delegates to the SkillsViewer               */
/* ------------------------------------------------------------------ */

interface SettingsSkillsProps {
  wsUrl: string
  apiClient?: SettingsApiClient
  profiles: ManagerProfile[]
  changeKey?: number
  initialImportUrl?: string
}

export function SettingsSkills({ wsUrl, apiClient, profiles, changeKey, initialImportUrl }: SettingsSkillsProps) {
  return <SkillsViewer wsUrl={wsUrl} apiClient={apiClient} profiles={profiles} changeKey={changeKey} initialImportUrl={initialImportUrl} />
}
