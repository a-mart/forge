export const ACTIVE_WORK_PLANS_SKILL_HANDLE = 'active-work-plans'

export const ACTIVE_WORK_PLANS_GUIDANCE_ENABLED = ''

export function resolveActiveWorkPlansGuidance(_enabled: boolean): string {
  return ''
}

export async function getWorkPlansEnabled(_dataDir: string): Promise<boolean> {
  return false
}

export async function setWorkPlansEnabled(_dataDir: string, _enabled: boolean): Promise<void> {
  // Active Work Plans are parked on this rollback/test branch. Preserve any
  // existing settings file but never write a new value from this runtime.
}
