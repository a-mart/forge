import type { ManagerProfile } from '@forge/protocol'
import { SkillsViewer } from './skills/SkillsViewer'

/* ------------------------------------------------------------------ */
/*  Skills settings tab — delegates to the SkillsViewer               */
/* ------------------------------------------------------------------ */

interface SettingsSkillsProps {
  wsUrl: string
  profiles: ManagerProfile[]
}

export function SettingsSkills({ wsUrl, profiles }: SettingsSkillsProps) {
  return <SkillsViewer wsUrl={wsUrl} profiles={profiles} />
}
