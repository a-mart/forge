import { readFile } from 'node:fs/promises'
import type { ModelCacheVisualizationSettings } from '@forge/protocol'
import { getModelCacheVisualizationSettingsPath } from './data-paths.js'
import { isEnoentError } from './swarm-manager-utils.js'
import { writeJsonFileAtomic } from '../utils/atomic-files.js'

const DEFAULT_MODEL_CACHE_VISUALIZATION_ENABLED = false

export async function getModelCacheVisualizationEnabled(dataDir: string): Promise<boolean> {
  const filePath = getModelCacheVisualizationSettingsPath(dataDir)
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as { enabled?: unknown }
    return parsed.enabled === true
  } catch (error) {
    if (isEnoentError(error)) {
      return DEFAULT_MODEL_CACHE_VISUALIZATION_ENABLED
    }

    const message = error instanceof Error ? error.message : String(error)
    console.warn(
      `[model-cache-visualization-settings] Failed to load settings from ${filePath}: ${message}. Falling back to enabled=false.`,
    )
    return DEFAULT_MODEL_CACHE_VISUALIZATION_ENABLED
  }
}

export async function setModelCacheVisualizationEnabled(
  dataDir: string,
  enabled: boolean,
): Promise<ModelCacheVisualizationSettings> {
  const filePath = getModelCacheVisualizationSettingsPath(dataDir)
  const settings: ModelCacheVisualizationSettings = {
    enabled,
    updatedAt: new Date().toISOString(),
  }

  await writeJsonFileAtomic(filePath, settings)

  return settings
}

export async function getModelCacheVisualizationSettings(
  dataDir: string,
): Promise<ModelCacheVisualizationSettings> {
  const enabled = await getModelCacheVisualizationEnabled(dataDir)
  const filePath = getModelCacheVisualizationSettingsPath(dataDir)
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as { enabled?: unknown; updatedAt?: unknown }
    return {
      enabled,
      updatedAt:
        typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim().length > 0
          ? parsed.updatedAt
          : null,
    }
  } catch (error) {
    if (isEnoentError(error)) {
      return { enabled: DEFAULT_MODEL_CACHE_VISUALIZATION_ENABLED, updatedAt: null }
    }
    return { enabled: DEFAULT_MODEL_CACHE_VISUALIZATION_ENABLED, updatedAt: null }
  }
}
