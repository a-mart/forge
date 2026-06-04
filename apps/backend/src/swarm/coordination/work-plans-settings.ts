import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getWorkPlansSettingsPath } from '../data-paths.js'
import { isEnoentError } from '../swarm-manager-utils.js'

export const ACTIVE_WORK_PLANS_SKILL_HANDLE = 'active-work-plans'

export const ACTIVE_WORK_PLANS_GUIDANCE_ENABLED =
  '- For substantive multi-step or multi-worker work, use the Active Work Plans skill and `task` tool when durable visible progress would help, and use `task` when the user explicitly asks for an Active Work Plan, Work Plan, or task plan. Do not create plans for quick answers or routine one-step work. Work Plans are descriptive coordination state, not workflow execution. Task updates do not by themselves close final/blocked worker callbacks when user/peer closeout, choices, or delegation is needed. Pair plan creation with immediate delegation/execution when the next step is clear. Keep plans compact and update them only at meaningful boundaries.'

export function resolveActiveWorkPlansGuidance(enabled: boolean): string {
  return enabled ? ACTIVE_WORK_PLANS_GUIDANCE_ENABLED : ''
}

export async function getWorkPlansEnabled(dataDir: string): Promise<boolean> {
  const filePath = getWorkPlansSettingsPath(dataDir)
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as { enabled?: unknown }
    return parsed.enabled !== false
  } catch (error) {
    if (isEnoentError(error)) {
      return true
    }

    const message = error instanceof Error ? error.message : String(error)
    console.warn(
      `[work-plans-settings] Failed to load settings from ${filePath}: ${message}. Falling back to enabled=true.`,
    )
    return true
  }
}

export async function setWorkPlansEnabled(dataDir: string, enabled: boolean): Promise<void> {
  const filePath = getWorkPlansSettingsPath(dataDir)
  await mkdir(dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp-${randomUUID()}`

  try {
    await writeFile(tempPath, JSON.stringify({ enabled }, null, 2) + '\n', 'utf8')
    await rename(tempPath, filePath)
  } catch (error) {
    try {
      await unlink(tempPath)
    } catch {
      // Best-effort cleanup.
    }
    throw error
  }
}
