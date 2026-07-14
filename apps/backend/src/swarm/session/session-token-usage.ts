import { join } from 'node:path'
import type { TokenUsageTotals } from '@forge/protocol'
import { parseCursorSdkUsageCustomEntry } from '../../utils/cursor-sdk-usage-records.js'
import {
  extractUsage,
  isRecord,
  listFileNames,
  scanJsonlFile,
  toTimestampMs,
} from '../../stats/stats-shared.js'
import { getSessionFilePath, getWorkersDir } from '../storage/data-paths.js'

export interface TokenUsageEvent {
  timestampMs: number
  usage: TokenUsageTotals
}

export interface WorkerTokenUsageEvent extends TokenUsageEvent {
  workerId: string
}

export interface TokenUsageScanResult<T extends TokenUsageEvent> {
  events: T[]
  missingTimestampCount: number
}

export async function scanManagerTokenUsage(input: {
  dataDir: string
  profileId: string
  sessionAgentId: string
  startAt: string
  endAt: string
}): Promise<TokenUsageScanResult<TokenUsageEvent>> {
  return scanTokenUsageFile(
    getSessionFilePath(input.dataDir, input.profileId, input.sessionAgentId),
    input.startAt,
    input.endAt,
  )
}

export async function scanWorkerTokenUsage(input: {
  dataDir: string
  profileId: string
  sessionAgentId: string
  startAt: string
  endAt: string
}): Promise<TokenUsageScanResult<WorkerTokenUsageEvent>> {
  const workersDir = getWorkersDir(input.dataDir, input.profileId, input.sessionAgentId)
  const fileNames = (await listFileNames(workersDir)).filter(
    (name) => name.endsWith('.jsonl') && !name.endsWith('.conversation.jsonl'),
  )
  const result: TokenUsageScanResult<WorkerTokenUsageEvent> = {
    events: [],
    missingTimestampCount: 0,
  }
  for (const fileName of fileNames) {
    const workerId = fileName.slice(0, -'.jsonl'.length)
    const scan = await scanTokenUsageFile(join(workersDir, fileName), input.startAt, input.endAt)
    result.missingTimestampCount += scan.missingTimestampCount
    result.events.push(...scan.events.map((event) => ({ ...event, workerId })))
  }
  return result
}

export async function scanSessionTokenUsage(input: {
  dataDir: string
  profileId: string
  sessionAgentId: string
  startAt: string
  endAt: string
}): Promise<{
  managerUsage: TokenUsageTotals
  workerUsage: TokenUsageTotals
  totalUsage: TokenUsageTotals
  missingTimestampCount: number
}> {
  const [manager, workers] = await Promise.all([
    scanManagerTokenUsage(input),
    scanWorkerTokenUsage(input),
  ])
  const managerUsage = sumTokenUsage(manager.events.map((event) => event.usage))
  const workerUsage = sumTokenUsage(workers.events.map((event) => event.usage))
  return {
    managerUsage,
    workerUsage,
    totalUsage: addTokenUsage(managerUsage, workerUsage),
    missingTimestampCount: manager.missingTimestampCount + workers.missingTimestampCount,
  }
}

export function emptyTokenUsage(): TokenUsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

export function addTokenUsage(left: TokenUsageTotals, right: TokenUsageTotals): TokenUsageTotals {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    total: left.total + right.total,
  }
}

export function sumTokenUsage(values: TokenUsageTotals[]): TokenUsageTotals {
  return values.reduce(addTokenUsage, emptyTokenUsage())
}

async function scanTokenUsageFile(
  filePath: string,
  startAt: string,
  endAt: string,
): Promise<TokenUsageScanResult<TokenUsageEvent>> {
  const startMs = Date.parse(startAt)
  const endMs = Date.parse(endAt)
  const result: TokenUsageScanResult<TokenUsageEvent> = { events: [], missingTimestampCount: 0 }

  await scanJsonlFile(filePath, (entry) => {
    if (isRecord(entry) && entry.type === 'message' && isRecord(entry.message)) {
      const usage = extractUsage(entry.message.usage)
      if (!usage) return
      const timestampMs = toTimestampMs(entry.timestamp) ?? toTimestampMs(entry.message.timestamp)
      if (timestampMs === null) {
        result.missingTimestampCount += 1
        return
      }
      if (timestampMs >= startMs && timestampMs <= endMs) {
        result.events.push({ timestampMs, usage: { ...usage } })
      }
      return
    }

    const cursor = parseCursorSdkUsageCustomEntry(entry)
    if (!cursor) return
    const timestampMs = toTimestampMs(cursor.timestamp) ?? toTimestampMs(cursor.capturedAt)
    if (timestampMs === null) {
      result.missingTimestampCount += 1
      return
    }
    if (timestampMs >= startMs && timestampMs <= endMs) {
      result.events.push({ timestampMs, usage: { ...cursor.usage } })
    }
  })

  return result
}
