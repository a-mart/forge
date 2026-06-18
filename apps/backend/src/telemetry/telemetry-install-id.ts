import { readFile } from 'node:fs/promises'
import { getTelemetryConfigPath } from '../swarm/data-paths.js'

export async function readPersistedTelemetryInstallId(dataDir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(getTelemetryConfigPath(dataDir), 'utf8')
    const parsed = JSON.parse(raw) as { installId?: unknown }
    return normalizeTelemetryInstallId(parsed.installId)
  } catch {
    return undefined
  }
}

function normalizeTelemetryInstallId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
