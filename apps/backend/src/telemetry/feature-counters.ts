import { access, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readPlaywrightDashboardEnvOverride } from '../config.js'
import {
  getAgentsStoreFilePath,
  getCortexAutoReviewSettingsPath,
  getGlobalSlashCommandsPath,
  getProfileIntegrationsDir,
  getProfilePiExtensionsDir,
  getProfilePiSkillsDir,
  getProfileReferenceDir,
  getProfileScheduleFilePath,
  getProfileSlashCommandsPath,
  getSessionMetaPath,
  getSessionTerminalsDir,
  getSessionsDir,
  getSharedIntegrationsDir,
  getSharedMobileDevicesPath,
  getSharedPlaywrightDashboardSettingsPath,
} from '../swarm/data-paths.js'
import { PINNED_MESSAGES_FILE_NAME } from '../swarm/message-pins.js'
import { parseSpecialistFile } from '../swarm/specialists/specialist-registry.js'
import { getProfileSpecialistsDir, getSharedSpecialistsDir } from '../swarm/specialists/specialist-paths.js'
import type { SwarmConfig } from '../swarm/types.js'
import type { FeatureAdoptionData } from './telemetry-payload.js'

interface SpecialistCounts {
  persistedCount: number
  customCount: number
  enabledCount: number
}

interface MobileDeviceCounts {
  registeredCount: number
  enabledCount: number
}

export async function collectFeatureAdoption(
  dataDir: string,
  profileIds: string[],
  config: SwarmConfig,
): Promise<FeatureAdoptionData> {
  const rootDir = config.paths?.rootDir
  const [
    specialistCounts,
    terminalsActive,
    pinnedMessagesUsed,
    scheduledTasksCount,
    telegramConfigured,
    playwrightEnabled,
    forkedSessionsCount,
    projectAgentsCount,
    extensionsLoaded,
    extensionsDiscoveredCount,
    skillsConfigured,
    skillsDiscoveredCount,
    referenceDocsCount,
    slashCommandsCount,
    cortexAutoReviewEnabled,
    mobileDeviceCounts,
  ] = await Promise.all([
    collectSpecialistCounts(dataDir, profileIds),
    countTerminals(dataDir, profileIds),
    countPinnedSessions(dataDir, profileIds),
    countScheduledTasks(dataDir, profileIds),
    isTelegramConfigured(dataDir, profileIds),
    isPlaywrightEnabled(dataDir),
    countForkedSessions(dataDir, profileIds),
    countProjectAgents(dataDir),
    countExtensions(dataDir, profileIds),
    countExtensions(dataDir, profileIds, rootDir),
    countSkills(dataDir, profileIds),
    countSkills(dataDir, profileIds, rootDir),
    countReferenceDocs(dataDir, profileIds),
    countSlashCommands(dataDir, profileIds),
    isCortexAutoReviewEnabled(dataDir),
    countMobileDevices(dataDir),
  ])

  return {
    specialistsConfigured: specialistCounts.persistedCount,
    specialistsPersistedCount: specialistCounts.persistedCount,
    specialistsCustomCount: specialistCounts.customCount,
    specialistsEnabledCount: specialistCounts.enabledCount,
    terminalsActive,
    pinnedMessagesUsed,
    scheduledTasksCount,
    telegramConfigured,
    playwrightEnabled,
    forkedSessionsCount,
    projectAgentsCount,
    projectAgentsPersistedCount: projectAgentsCount,
    extensionsLoaded,
    extensionsDiscoveredCount,
    skillsConfigured,
    skillsDiscoveredCount,
    referenceDocsCount,
    slashCommandsCount,
    cortexAutoReviewEnabled,
    mobileDevicesRegistered: mobileDeviceCounts.registeredCount,
    mobileDevicesEnabledCount: mobileDeviceCounts.enabledCount,
  }
}

async function collectSpecialistCounts(dataDir: string, profileIds: string[]): Promise<SpecialistCounts> {
  try {
    let persistedCount = 0
    let customCount = 0
    let enabledCount = 0

    const directories = [getSharedSpecialistsDir(dataDir), ...profileIds.map((profileId) => getProfileSpecialistsDir(dataDir, profileId))]

    for (const directoryPath of directories) {
      const entries = await readDirEntries(directoryPath)
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
          continue
        }

        const parsed = await parseSpecialistFile(join(directoryPath, entry.name))
        if (!parsed) {
          continue
        }

        persistedCount += 1
        if (!parsed.frontmatter.builtin) {
          customCount += 1
        }
        if (parsed.frontmatter.enabled) {
          enabledCount += 1
        }
      }
    }

    return {
      persistedCount,
      customCount,
      enabledCount,
    }
  } catch {
    return {
      persistedCount: 0,
      customCount: 0,
      enabledCount: 0,
    }
  }
}

async function countTerminals(dataDir: string, profileIds: string[]): Promise<number> {
  try {
    let count = 0

    for (const profileId of profileIds) {
      count += await countDirectories(getSessionTerminalsDir(dataDir, profileId, profileId))
    }

    return count
  } catch {
    return 0
  }
}

async function countPinnedSessions(dataDir: string, profileIds: string[]): Promise<number> {
  try {
    let count = 0

    for (const profileId of profileIds) {
      const sessionEntries = await readDirEntries(getSessionsDir(dataDir, profileId))
      for (const entry of sessionEntries) {
        if (!entry.isDirectory()) {
          continue
        }

        const pinnedPath = join(getSessionsDir(dataDir, profileId), entry.name, PINNED_MESSAGES_FILE_NAME)
        if (await hasPinnedMessages(pinnedPath)) {
          count += 1
        }
      }
    }

    return count
  } catch {
    return 0
  }
}

async function countScheduledTasks(dataDir: string, profileIds: string[]): Promise<number> {
  try {
    let count = 0

    for (const profileId of profileIds) {
      count += await countArrayEntriesInFile(getProfileScheduleFilePath(dataDir, profileId), 'schedules')
    }

    return count
  } catch {
    return 0
  }
}

async function isTelegramConfigured(dataDir: string, profileIds: string[]): Promise<boolean> {
  try {
    if (await isTelegramEnabled(join(getSharedIntegrationsDir(dataDir), 'telegram.json'))) {
      return true
    }

    for (const profileId of profileIds) {
      if (await isTelegramEnabled(join(getProfileIntegrationsDir(dataDir, profileId), 'telegram.json'))) {
        return true
      }
    }

    return false
  } catch {
    return false
  }
}

async function countExtensions(dataDir: string, profileIds: string[], rootDir?: string): Promise<number> {
  try {
    let count = 0

    count += await countSupportedExtensions(join(dataDir, 'agent', 'extensions'))
    count += await countSupportedExtensions(join(dataDir, 'agent', 'manager', 'extensions'))

    for (const profileId of profileIds) {
      count += await countSupportedExtensions(getProfilePiExtensionsDir(dataDir, profileId))
    }

    if (typeof rootDir === 'string' && rootDir.trim().length > 0) {
      count += await countSupportedExtensions(join(rootDir, '.pi', 'extensions'))
    }

    return count
  } catch {
    return 0
  }
}

async function countSkills(dataDir: string, profileIds: string[], rootDir?: string): Promise<number> {
  try {
    let count = 0

    count += await countSkillDirectories(join(dataDir, 'skills'))
    count += await countSkillDirectories(join(dataDir, 'agent', 'skills'))
    count += await countSkillDirectories(join(dataDir, 'agent', 'manager', 'skills'))

    for (const profileId of profileIds) {
      count += await countSkillDirectories(getProfilePiSkillsDir(dataDir, profileId))
    }

    if (typeof rootDir === 'string' && rootDir.trim().length > 0) {
      count += await countSkillDirectories(join(rootDir, '.swarm', 'skills'))
    }

    return count
  } catch {
    return 0
  }
}

async function countProjectAgents(dataDir: string): Promise<number> {
  try {
    const parsed = await readJsonFile(getAgentsStoreFilePath(dataDir))
    if (!isRecord(parsed) || !Array.isArray(parsed.agents)) {
      return 0
    }

    return parsed.agents.filter(
      (agent) => isRecord(agent) && agent.role === 'manager' && agent.projectAgent !== undefined && agent.projectAgent !== null,
    ).length
  } catch {
    return 0
  }
}

async function isPlaywrightEnabled(dataDir: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      return false
    }

    const envOverride = readPlaywrightDashboardEnvOverride()
    if (envOverride !== undefined) {
      return envOverride
    }

    const parsed = await readJsonFile(getSharedPlaywrightDashboardSettingsPath(dataDir))
    return isRecord(parsed) && parsed.enabled === true
  } catch {
    return false
  }
}

async function countForkedSessions(dataDir: string, profileIds: string[]): Promise<number> {
  try {
    let count = 0

    for (const profileId of profileIds) {
      const sessionEntries = await readDirEntries(getSessionsDir(dataDir, profileId))
      for (const entry of sessionEntries) {
        if (!entry.isDirectory()) {
          continue
        }

        const meta = await readJsonFile(getSessionMetaPath(dataDir, profileId, entry.name))
        if (isRecord(meta) && meta.forkedFrom !== undefined) {
          count += 1
        }
      }
    }

    return count
  } catch {
    return 0
  }
}

async function countReferenceDocs(dataDir: string, profileIds: string[]): Promise<number> {
  try {
    let count = 0

    for (const profileId of profileIds) {
      count += await countFiles(getProfileReferenceDir(dataDir, profileId))
    }

    return count
  } catch {
    return 0
  }
}

async function countSlashCommands(dataDir: string, profileIds: string[]): Promise<number> {
  try {
    let count = await countArrayEntriesInFile(getGlobalSlashCommandsPath(dataDir), 'commands')

    for (const profileId of profileIds) {
      count += await countArrayEntriesInFile(getProfileSlashCommandsPath(dataDir, profileId), 'commands')
    }

    return count
  } catch {
    return 0
  }
}

async function isCortexAutoReviewEnabled(dataDir: string): Promise<boolean> {
  try {
    const parsed = await readJsonFile(getCortexAutoReviewSettingsPath(dataDir))
    return isRecord(parsed) && parsed.enabled === true
  } catch {
    return false
  }
}

async function countMobileDevices(dataDir: string): Promise<MobileDeviceCounts> {
  try {
    const parsed = await readJsonFile(getSharedMobileDevicesPath(dataDir))
    if (!isRecord(parsed) || !Array.isArray(parsed.devices)) {
      return { registeredCount: 0, enabledCount: 0 }
    }

    const devices = parsed.devices.filter(isRecord)
    return {
      registeredCount: devices.length,
      enabledCount: devices.filter((device) => device.enabled === true).length,
    }
  } catch {
    return { registeredCount: 0, enabledCount: 0 }
  }
}

async function countFiles(dirPath: string): Promise<number> {
  const entries = await readDirEntries(dirPath)
  return entries.filter((entry) => entry.isFile()).length
}

async function countDirectories(dirPath: string): Promise<number> {
  const entries = await readDirEntries(dirPath)
  return entries.filter((entry) => entry.isDirectory()).length
}

async function countSkillDirectories(dirPath: string): Promise<number> {
  const entries = await readDirEntries(dirPath)
  let count = 0

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    if (await fileExists(join(dirPath, entry.name, 'SKILL.md'))) {
      count += 1
    }
  }

  return count
}

async function countSupportedExtensions(dirPath: string): Promise<number> {
  const entries = await readDirEntries(dirPath)
  let count = 0

  for (const entry of entries) {
    if (entry.isFile() && isSupportedExtensionFile(entry.name)) {
      count += 1
      continue
    }

    if (!entry.isDirectory()) {
      continue
    }

    if (
      (await fileExists(join(dirPath, entry.name, 'index.ts'))) ||
      (await fileExists(join(dirPath, entry.name, 'index.js')))
    ) {
      count += 1
    }
  }

  return count
}

async function hasPinnedMessages(filePath: string): Promise<boolean> {
  const parsed = await readJsonFile(filePath)
  if (!isRecord(parsed) || !isRecord(parsed.pins)) {
    return false
  }

  return Object.keys(parsed.pins).length > 0
}

async function isTelegramEnabled(filePath: string): Promise<boolean> {
  const parsed = await readJsonFile(filePath)
  return (
    isRecord(parsed) &&
    parsed.enabled === true &&
    typeof parsed.botToken === 'string' &&
    parsed.botToken.trim().length > 0
  )
}

async function countArrayEntriesInFile(filePath: string, fieldName: string): Promise<number> {
  const parsed = await readJsonFile(filePath)
  if (!isRecord(parsed)) {
    return 0
  }

  const value = parsed[fieldName]
  return Array.isArray(value) ? value.length : 0
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

async function readDirEntries(dirPath: string) {
  try {
    return await readdir(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
}

async function fileExists(pathValue: string): Promise<boolean> {
  try {
    await access(pathValue)
    return true
  } catch {
    return false
  }
}

function isSupportedExtensionFile(fileName: string): boolean {
  const normalized = fileName.toLowerCase()
  return normalized.endsWith('.ts') || normalized.endsWith('.js')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
