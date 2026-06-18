import type { Stats } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type {
  SessionAuditCursor,
  SessionAuditEntry,
  SessionAuditEntryCategory,
  SessionAuditEntryDetailRequest,
  SessionAuditEntryDetailResponse,
  SessionAuditManifest,
  SessionAuditOrder,
  SessionAuditPageRequest,
  SessionAuditPageResponse,
  SessionAuditScope,
  SessionAuditSourceKind,
  SessionAuditWorkerSummary,
} from '@forge/protocol'
import type { AgentDescriptor, SwarmConfig } from '../types.js'
import { getSessionDir, getSessionFilePath, getWorkerSessionFilePath, getWorkersDir, sanitizePathSegment } from '../storage/data-paths.js'
import { CONVERSATION_ENTRY_TYPE } from './conversation-timeline.js'
import { isCanonicalWorkerTranscriptFileName } from './worker-transcript-files.js'

const SESSION_AUDIT_ENTRY_CATEGORY_VALUES = [
  'session_header',
  'conversation_message',
  'agent_message',
  'manager_tool_call',
  'worker_tool_call',
  'runtime_log',
  'choice_request',
  'work_plan_created',
  'model_cache_observation',
  'custom',
  'unknown',
  'malformed',
] as const satisfies readonly SessionAuditEntryCategory[]

const DEFAULT_AUDIT_LIMIT = 100
const MAX_AUDIT_LIMIT = 500
const DEFAULT_SCAN_LINE_MULTIPLIER = 20
const MAX_SCAN_LINES = 10_000
const MAX_SCAN_BYTES = 4 * 1024 * 1024
const RAW_PREVIEW_MAX_BYTES = 16 * 1024
const TEXT_PREVIEW_MAX_CHARS = 500
const MAX_PARSE_LINE_BYTES = 1024 * 1024
export const SESSION_AUDIT_DETAIL_MAX_BYTES = 8 * 1024 * 1024
const SESSION_SOURCE_ID = 'session'
const SESSION_RELATIVE_PATH = 'session.jsonl'

export class SessionAuditError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message)
    this.name = 'SessionAuditError'
  }
}

export interface SessionAuditServiceHost {
  getConfig(): SwarmConfig
  getAgent(agentId: string): AgentDescriptor | undefined
  listAgents?(): AgentDescriptor[]
  listWorkersForSession?(sessionAgentId: string): AgentDescriptor[]
}

interface ResolvedAuditSource {
  sessionAgentId: string
  sourceId: string
  sourceKind: SessionAuditSourceKind
  scope: SessionAuditScope
  sourceLabel: string
  absolutePath: string
  relativePath: string
  sessionDir: string
}

interface JsonlLineRecord {
  lineBytes: Buffer
  rawBytes: number
  byteOffset: number
  nextByteOffset: number
  lineNumber?: number
}

interface ReadJsonlPageOptions {
  filePath: string
  startOffset: number
  startLineNumber?: number
  order: SessionAuditOrder
  limit: number
  categories?: ReadonlySet<SessionAuditEntryCategory>
  types?: ReadonlySet<string>
  source: ResolvedAuditSource
}

interface ReadJsonlPageResult {
  items: SessionAuditEntry[]
  nextOffset: number
  nextLineNumber?: number
  sourceBytes: number
  scannedLines: number
  scannedBytes: number
  scanLimited: boolean
  reachedEof: boolean
}

export class SessionAuditService {
  constructor(private readonly host: SessionAuditServiceHost) {}

  async getSessionAuditEntryDetail(
    sessionAgentId: string,
    request: SessionAuditEntryDetailRequest,
  ): Promise<SessionAuditEntryDetailResponse> {
    const normalizedSessionAgentId = normalizeRequiredId(sessionAgentId, 'sessionAgentId')
    const byteOffset = normalizeOffset(request.byteOffset)
    const expectedNextByteOffset = request.nextByteOffset === undefined
      ? undefined
      : normalizeOffset(request.nextByteOffset)
    if (expectedNextByteOffset !== undefined && expectedNextByteOffset <= byteOffset) {
      throw new SessionAuditError('nextByteOffset must be greater than byteOffset', 400)
    }
    const source = await this.resolveAuditSource(normalizedSessionAgentId, request.scope ?? 'session', request.workerId, request.sourceKind)
    const line = await readJsonlLineDetail({
      filePath: source.absolutePath,
      byteOffset,
      expectedNextByteOffset,
      maxBytes: SESSION_AUDIT_DETAIL_MAX_BYTES,
    })
    if (!line) {
      throw new SessionAuditError('Audit row not found at the requested byte offset', 404)
    }

    const rawText = line.lineBytes.toString('utf8')
    let formattedJson: string | undefined
    let parseError: string | undefined
    if (!line.truncated) {
      try {
        formattedJson = JSON.stringify(JSON.parse(rawText), null, 2)
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error)
      }
    } else {
      parseError = `Row exceeds the ${SESSION_AUDIT_DETAIL_MAX_BYTES} byte detail cap`
    }

    return {
      sessionAgentId: normalizedSessionAgentId,
      scope: source.scope,
      sourceId: source.sourceId,
      sourceKind: source.sourceKind,
      relativePath: source.relativePath,
      byteOffset: line.byteOffset,
      nextByteOffset: line.nextByteOffset,
      rawBytes: line.rawBytes,
      rawText,
      truncated: line.truncated,
      maxBytes: SESSION_AUDIT_DETAIL_MAX_BYTES,
      parseError,
      formattedJson,
    }
  }

  async getSessionAuditPage(sessionAgentId: string, request: SessionAuditPageRequest = {}): Promise<SessionAuditPageResponse> {
    const normalizedSessionAgentId = normalizeRequiredId(sessionAgentId, 'sessionAgentId')
    const order = parseOrder(request.order)
    const scope = parseScope(request.scope ?? 'session')
    const limit = clampLimit(request.limit)
    const categories = normalizeCategories(request.categories)
    const types = normalizeStringSet(request.types)
    const source = await this.resolveAuditSource(
      normalizedSessionAgentId,
      scope,
      request.workerId,
      request.sourceKind,
    )
    const cursor = request.cursor ? decodeCursor(request.cursor) : undefined
    if (cursor) {
      validateCursor(cursor, {
        sessionAgentId: normalizedSessionAgentId,
        scope,
        sourceId: source.sourceId,
        order,
      })
    }

    const sessionSource = await this.resolveSessionSource(normalizedSessionAgentId)
    const manifest = await this.buildManifest(normalizedSessionAgentId, sessionSource.sessionDir, sessionSource.absolutePath)
    const sourceStats = await lstat(source.absolutePath).catch((error: unknown) => {
      if (isNodeErrorCode(error, 'ENOENT')) {
        return undefined
      }
      throw error
    })
    const sourceBytes = sourceStats?.isFile() ? sourceStats.size : 0
    const startOffset = cursor?.offset ?? (request.offset === undefined && order === 'desc' ? sourceBytes : normalizeOffset(request.offset))
    const readResult = await readJsonlPage({
      filePath: source.absolutePath,
      startOffset,
      startLineNumber: cursor?.lineNumber ?? (startOffset === 0 ? 1 : undefined),
      order,
      limit,
      categories,
      types,
      source,
    })

    const hasMore = !readResult.reachedEof
    const nextCursor = hasMore
      ? encodeCursor({
          v: 1,
          sessionAgentId: normalizedSessionAgentId,
          scope,
          sourceId: source.sourceId,
          offset: readResult.nextOffset,
          lineNumber: readResult.nextLineNumber,
          order,
        })
      : undefined

    return {
      sessionAgentId: normalizedSessionAgentId,
      manifest,
      scope,
      sourceId: source.sourceId,
      sourceKind: source.sourceKind,
      order,
      limit,
      categories: categories ? [...categories] : undefined,
      types: types ? [...types] : undefined,
      items: readResult.items,
      page: {
        startOffset,
        endOffset: readResult.nextOffset,
        sourceBytes: readResult.sourceBytes,
        scannedLines: readResult.scannedLines,
        scannedBytes: readResult.scannedBytes,
        returnedItems: readResult.items.length,
        scanLimited: readResult.scanLimited,
      },
      nextCursor,
      hasMore,
    }
  }

  private async resolveAuditSource(
    sessionAgentId: string,
    scope: SessionAuditScope,
    workerId: string | undefined,
    sourceKind: SessionAuditSourceKind | undefined,
  ): Promise<ResolvedAuditSource> {
    if (scope === 'session' && workerId) {
      throw new SessionAuditError('workerId is only valid for worker audit scope', 400)
    }
    if (sourceKind) {
      const expectedSourceKind: SessionAuditSourceKind = scope === 'session' ? 'canonical_session_jsonl' : 'canonical_worker_jsonl'
      if (sourceKind !== expectedSourceKind) {
        throw new SessionAuditError('Audit sourceKind does not match the requested source', 400)
      }
    }

    const sessionSource = await this.resolveSessionSource(sessionAgentId)
    return scope === 'session' ? sessionSource : await this.resolveWorkerSource(sessionSource, workerId)
  }

  private async resolveSessionSource(sessionAgentId: string): Promise<ResolvedAuditSource> {
    const descriptor = this.host.getAgent(sessionAgentId)
    if (!descriptor || descriptor.role !== 'manager') {
      throw new SessionAuditError('Unknown manager session', 404)
    }

    const dataDir = this.host.getConfig().paths.dataDir
    const profileId = descriptor.profileId ?? descriptor.agentId
    const sessionDir = resolve(getSessionDir(dataDir, profileId, descriptor.agentId))
    const sessionFile = resolve(getSessionFilePath(dataDir, profileId, descriptor.agentId))
    assertPathInside(sessionFile, sessionDir, 'Session audit file is outside the selected session directory')
    const sessionDirState = await readAuditDirectoryState(sessionDir)
    if (sessionDirState.rejected) {
      throw new SessionAuditError('Unknown session audit source', 404)
    }
    const sessionFileState = await readAuditFileState(sessionFile, {
      parentRealPath: sessionDirState.realPath,
      outsideMessage: 'Session audit file is outside the selected session directory',
    })
    if (sessionFileState.rejected) {
      throw new SessionAuditError('Unknown session audit source', 404)
    }

    return {
      sessionAgentId,
      sourceId: SESSION_SOURCE_ID,
      sourceKind: 'canonical_session_jsonl',
      scope: 'session',
      sourceLabel: 'Canonical session JSONL',
      absolutePath: sessionFile,
      relativePath: SESSION_RELATIVE_PATH,
      sessionDir,
    }
  }

  private async resolveWorkerSource(sessionSource: ResolvedAuditSource, workerId: string | undefined): Promise<ResolvedAuditSource> {
    const normalizedWorkerId = normalizeRequiredId(workerId, 'workerId')
    const safeWorkerId = sanitizeAuditPathSegment(normalizedWorkerId, 'workerId')
    const descriptor = this.findWorkerDescriptorForSession(sessionSource.sessionAgentId, normalizedWorkerId)
    const dataDir = this.host.getConfig().paths.dataDir
    const sessionDescriptor = this.host.getAgent(sessionSource.sessionAgentId)
    const profileId = sessionDescriptor?.profileId ?? sessionSource.sessionAgentId
    const workersDir = resolve(getWorkersDir(dataDir, profileId, sessionSource.sessionAgentId))
    assertPathInside(workersDir, sessionSource.sessionDir, 'Workers directory is outside the selected session directory')
    const workersDirState = await readAuditDirectoryState(workersDir)
    if (workersDirState.rejected) {
      throw new SessionAuditError('Unknown worker audit source', 404)
    }
    const sessionDirState = await readAuditDirectoryState(sessionSource.sessionDir)
    if (sessionDirState.rejected) {
      throw new SessionAuditError('Unknown worker audit source', 404)
    }
    if (workersDirState.realPath && sessionDirState.realPath) {
      assertPathInside(workersDirState.realPath, sessionDirState.realPath, 'Workers directory is outside the selected session directory')
    }
    const workerFile = resolve(getWorkerSessionFilePath(dataDir, profileId, sessionSource.sessionAgentId, safeWorkerId))
    assertPathInside(workerFile, workersDir, 'Worker audit file is outside the selected workers directory')

    const fileStats = await readWorkerAuditFileStats(workerFile, workersDirState.realPath, sessionDirState.realPath)
    if (fileStats.rejected || (!descriptor && !fileStats.stats)) {
      throw new SessionAuditError('Unknown worker audit source', 404)
    }

    return {
      sessionAgentId: sessionSource.sessionAgentId,
      sourceId: normalizedWorkerId,
      sourceKind: 'canonical_worker_jsonl',
      scope: 'worker',
      sourceLabel: descriptor?.displayName ? `Worker transcript: ${descriptor.displayName}` : `Worker transcript: ${normalizedWorkerId}`,
      absolutePath: workerFile,
      relativePath: join('workers', `${safeWorkerId}.jsonl`),
      sessionDir: sessionSource.sessionDir,
    }
  }

  private findWorkerDescriptorForSession(sessionAgentId: string, workerId: string): AgentDescriptor | undefined {
    const direct = this.host.getAgent(workerId)
    if (direct?.role === 'worker' && direct.managerId === sessionAgentId) {
      return direct
    }
    return this.listWorkerDescriptorsForSession(sessionAgentId).get(workerId)
  }

  private listWorkerDescriptorsForSession(sessionAgentId: string): Map<string, AgentDescriptor> {
    const descriptorWorkers = new Map<string, AgentDescriptor>()
    for (const worker of this.host.listWorkersForSession?.(sessionAgentId) ?? []) {
      if (worker.role === 'worker' && worker.managerId === sessionAgentId) {
        descriptorWorkers.set(worker.agentId, worker)
      }
    }
    if (descriptorWorkers.size === 0) {
      for (const agent of this.host.listAgents?.() ?? []) {
        if (agent.role === 'worker' && agent.managerId === sessionAgentId) {
          descriptorWorkers.set(agent.agentId, agent)
        }
      }
    }
    return descriptorWorkers
  }

  private async buildManifest(sessionAgentId: string, sessionDir: string, sessionFile: string): Promise<SessionAuditManifest> {
    const [sessionBytes, workers] = await Promise.all([
      readFileSize(sessionFile),
      this.listWorkerSummaries(sessionAgentId, sessionDir),
    ])

    return {
      sessionAgentId,
      sessionRelativePath: SESSION_RELATIVE_PATH,
      sessionBytes,
      workers,
    }
  }

  private async listWorkerSummaries(sessionAgentId: string, sessionDir: string): Promise<SessionAuditWorkerSummary[]> {
    const descriptorWorkers = this.listWorkerDescriptorsForSession(sessionAgentId)

    const dataDir = this.host.getConfig().paths.dataDir
    const sessionDescriptor = this.host.getAgent(sessionAgentId)
    const profileId = sessionDescriptor?.profileId ?? sessionAgentId
    const workersDir = resolve(getWorkersDir(dataDir, profileId, sessionAgentId))
    assertPathInside(workersDir, sessionDir, 'Workers directory is outside the selected session directory')
    const workersDirState = await readAuditDirectoryState(workersDir)
    if (workersDirState.rejected) {
      return []
    }
    if (workersDirState.missing) {
      return [...descriptorWorkers.values()].sort((a, b) => a.agentId.localeCompare(b.agentId)).map((descriptor) => ({
        workerId: descriptor.agentId,
        displayName: descriptor.displayName,
        status: descriptor.status,
        descriptorPresent: true,
        relativePath: join('workers', `${sanitizeAuditPathSegment(descriptor.agentId, 'workerId')}.jsonl`),
        updatedAt: descriptor.updatedAt,
      } satisfies SessionAuditWorkerSummary))
    }
    const sessionDirState = await readAuditDirectoryState(sessionDir)
    if (sessionDirState.rejected) {
      return []
    }
    if (workersDirState.realPath && sessionDirState.realPath) {
      assertPathInside(workersDirState.realPath, sessionDirState.realPath, 'Workers directory is outside the selected session directory')
    }

    const workerIds = new Set(descriptorWorkers.keys())
    const files = await readdir(workersDir).catch((error: unknown) => {
      if (isNodeErrorCode(error, 'ENOENT')) {
        return [] as string[]
      }
      throw error
    })
    for (const fileName of files) {
      if (isCanonicalWorkerTranscriptFileName(fileName)) {
        const workerId = fileName.slice(0, -'.jsonl'.length)
        if (isSafeAuditPathSegment(workerId)) {
          workerIds.add(workerId)
        }
      }
    }

    const summaries: Array<SessionAuditWorkerSummary | undefined> = await Promise.all([...workerIds].sort().map(async (workerId) => {
      const safeWorkerId = sanitizeAuditPathSegment(workerId, 'workerId')
      const relativePath = join('workers', `${safeWorkerId}.jsonl`)
      const filePath = resolve(workersDir, `${safeWorkerId}.jsonl`)
      assertPathInside(filePath, workersDir, 'Worker audit file is outside the selected workers directory')
      const descriptor = descriptorWorkers.get(workerId)
      const fileStat = await readWorkerAuditFileStats(filePath, workersDirState.realPath, sessionDirState.realPath)
      if (fileStat.rejected) {
        return undefined
      }
      return {
        workerId,
        displayName: descriptor?.displayName,
        status: descriptor?.status,
        descriptorPresent: Boolean(descriptor),
        relativePath,
        bytes: fileStat.stats?.size,
        updatedAt: descriptor?.updatedAt ?? fileStat.stats?.mtime.toISOString(),
      } satisfies SessionAuditWorkerSummary
    }))

    return summaries.filter((summary): summary is SessionAuditWorkerSummary => Boolean(summary))
  }
}

interface JsonlLineAtOffset {
  lineBytes: Buffer
  rawBytes: number
  byteOffset: number
  nextByteOffset: number
  truncated: boolean
}

interface ReadJsonlLineDetailOptions {
  filePath: string
  byteOffset: number
  maxBytes: number
  expectedNextByteOffset?: number
}

async function readJsonlLineDetail(options: ReadJsonlLineDetailOptions): Promise<JsonlLineAtOffset | undefined> {
  const fileHandle = await open(options.filePath, 'r').catch((error: unknown) => {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return undefined
    }
    throw error
  })
  if (!fileHandle) {
    return undefined
  }

  try {
    const sourceBytes = (await fileHandle.stat()).size
    if (options.byteOffset >= sourceBytes) {
      return undefined
    }

    await assertJsonlLineStart(fileHandle, options.byteOffset, sourceBytes)

    if (options.expectedNextByteOffset !== undefined) {
      await validateExpectedNextByteOffset(
        fileHandle,
        options.byteOffset,
        options.expectedNextByteOffset,
        sourceBytes,
      )
      const spanLength = options.expectedNextByteOffset - options.byteOffset
      let contentLength = spanLength
      if (spanLength > 0) {
        const boundaryByte = Buffer.alloc(1)
        const boundaryResult = await fileHandle.read(boundaryByte, 0, 1, options.expectedNextByteOffset - 1)
        if (boundaryResult.bytesRead === 1 && boundaryByte[0] === 0x0a) {
          contentLength = spanLength - 1
        }
      }
      const readLength = Math.min(contentLength, options.maxBytes)
      const buffer = Buffer.alloc(readLength)
      const result = await fileHandle.read(buffer, 0, readLength, options.byteOffset)
      if (result.bytesRead <= 0) {
        return undefined
      }
      const truncated = contentLength > options.maxBytes
      const lineBytes = stripTrailingCarriageReturn(buffer.subarray(0, result.bytesRead))
      return {
        lineBytes,
        rawBytes: contentLength,
        byteOffset: options.byteOffset,
        nextByteOffset: truncated ? options.byteOffset + result.bytesRead : options.expectedNextByteOffset,
        truncated,
      }
    }

    return await scanJsonlLineDetail(fileHandle, options.byteOffset, sourceBytes, options.maxBytes)
  } finally {
    await fileHandle.close()
  }
}

async function assertJsonlLineStart(
  fileHandle: Awaited<ReturnType<typeof open>>,
  byteOffset: number,
  sourceBytes: number,
): Promise<void> {
  if (byteOffset === 0) {
    return
  }
  const previousByte = Buffer.alloc(1)
  const result = await fileHandle.read(previousByte, 0, 1, byteOffset - 1)
  if (result.bytesRead !== 1 || previousByte[0] !== 0x0a) {
    throw new SessionAuditError('byteOffset is not at a JSONL line boundary', 400)
  }
  if (byteOffset >= sourceBytes) {
    throw new SessionAuditError('Audit row not found at the requested byte offset', 404)
  }
}

async function validateExpectedNextByteOffset(
  fileHandle: Awaited<ReturnType<typeof open>>,
  byteOffset: number,
  expectedNextByteOffset: number,
  sourceBytes: number,
): Promise<void> {
  if (expectedNextByteOffset > sourceBytes) {
    throw new SessionAuditError('nextByteOffset is outside the audit source', 400)
  }
  const lineLength = expectedNextByteOffset - byteOffset
  if (lineLength <= 0) {
    throw new SessionAuditError('nextByteOffset must be greater than byteOffset', 400)
  }
  if (expectedNextByteOffset === sourceBytes) {
    return
  }
  const boundaryByte = Buffer.alloc(1)
  const boundaryResult = await fileHandle.read(boundaryByte, 0, 1, expectedNextByteOffset - 1)
  if (boundaryResult.bytesRead !== 1 || boundaryByte[0] !== 0x0a) {
    throw new SessionAuditError('nextByteOffset is not at a JSONL line boundary', 400)
  }
}

async function scanJsonlLineDetail(
  fileHandle: Awaited<ReturnType<typeof open>>,
  byteOffset: number,
  sourceBytes: number,
  maxBytes: number,
): Promise<JsonlLineAtOffset | undefined> {
  const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1))
  let readOffset = byteOffset
  const lineChunks: Buffer[] = []
  let lineBufferedBytes = 0
  let lineRawBytes = 0
  let truncated = false

  const appendLineSegment = (segment: Buffer): void => {
    if (segment.length === 0 || truncated) {
      return
    }
    lineRawBytes += segment.length
    if (lineBufferedBytes >= maxBytes) {
      truncated = true
      return
    }
    const remainingBufferedBytes = maxBytes - lineBufferedBytes
    const retained = segment.subarray(0, Math.min(segment.length, remainingBufferedBytes))
    lineChunks.push(Buffer.from(retained))
    lineBufferedBytes += retained.length
    if (segment.length > retained.length) {
      truncated = true
    }
  }

  while (readOffset < sourceBytes) {
    const chunkStartOffset = readOffset
    const readLength = Math.min(buffer.length, sourceBytes - readOffset)
    const result = await fileHandle.read(buffer, 0, readLength, readOffset)
    if (result.bytesRead <= 0) {
      break
    }

    readOffset += result.bytesRead
    const chunk = buffer.subarray(0, result.bytesRead)
    const segmentStart = 0
    while (segmentStart < chunk.length) {
      const newlineIndex = chunk.indexOf(0x0a, segmentStart)
      if (newlineIndex < 0) {
        appendLineSegment(chunk.subarray(segmentStart))
        break
      }

      appendLineSegment(chunk.subarray(segmentStart, newlineIndex))
      const nextByteOffset = chunkStartOffset + newlineIndex + 1
      return {
        lineBytes: stripTrailingCarriageReturn(Buffer.concat(lineChunks, lineBufferedBytes)),
        rawBytes: lineRawBytes,
        byteOffset,
        nextByteOffset,
        truncated,
      }
    }

    if (truncated) {
      return {
        lineBytes: stripTrailingCarriageReturn(Buffer.concat(lineChunks, lineBufferedBytes)),
        rawBytes: lineRawBytes,
        byteOffset,
        nextByteOffset: byteOffset + lineRawBytes,
        truncated: true,
      }
    }
  }

  if (lineRawBytes === 0) {
    return undefined
  }

  return {
    lineBytes: stripTrailingCarriageReturn(Buffer.concat(lineChunks, lineBufferedBytes)),
    rawBytes: lineRawBytes,
    byteOffset,
    nextByteOffset: sourceBytes,
    truncated: false,
  }
}

async function readJsonlPage(options: ReadJsonlPageOptions): Promise<ReadJsonlPageResult> {
  const fileHandle = await open(options.filePath, 'r').catch((error: unknown) => {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return undefined
    }
    throw error
  })

  if (!fileHandle) {
    return {
      items: [],
      nextOffset: 0,
      nextLineNumber: options.startLineNumber,
      sourceBytes: 0,
      scannedLines: 0,
      scannedBytes: 0,
      scanLimited: false,
      reachedEof: true,
    }
  }

  try {
    const sourceBytes = (await fileHandle.stat()).size
    if (options.order === 'desc') {
      return await readJsonlPageDescending(fileHandle, options, sourceBytes)
    }

    if (options.startOffset >= sourceBytes) {
      return {
        items: [],
        nextOffset: sourceBytes,
        nextLineNumber: options.startLineNumber,
        sourceBytes,
        scannedLines: 0,
        scannedBytes: 0,
        scanLimited: false,
        reachedEof: true,
      }
    }

    const maxScanLines = Math.min(MAX_SCAN_LINES, Math.max(options.limit, options.limit * DEFAULT_SCAN_LINE_MULTIPLIER))
    const buffer = Buffer.alloc(64 * 1024)
    let readOffset = options.startOffset
    let lineStartOffset = options.startOffset
    let lineNumber = options.startLineNumber
    let lineChunks: Buffer[] = []
    let lineBufferedBytes = 0
    let lineRawBytes = 0
    let scannedLines = 0
    let scannedBytes = 0
    const items: SessionAuditEntry[] = []

    const appendLineSegment = (segment: Buffer): void => {
      if (segment.length === 0) {
        return
      }
      lineRawBytes += segment.length
      if (lineBufferedBytes >= MAX_PARSE_LINE_BYTES) {
        return
      }
      const remainingBufferedBytes = MAX_PARSE_LINE_BYTES - lineBufferedBytes
      const retained = segment.subarray(0, Math.min(segment.length, remainingBufferedBytes))
      lineChunks.push(Buffer.from(retained))
      lineBufferedBytes += retained.length
    }

    const processLine = (nextByteOffset: number): boolean => {
      const record: JsonlLineRecord = {
        lineBytes: stripTrailingCarriageReturn(Buffer.concat(lineChunks, lineBufferedBytes)),
        rawBytes: lineRawBytes,
        byteOffset: lineStartOffset,
        nextByteOffset,
        lineNumber,
      }
      scannedLines += 1
      scannedBytes += nextByteOffset - lineStartOffset
      const item = buildAuditEntry(record, options.source)
      lineStartOffset = nextByteOffset
      lineNumber = lineNumber === undefined ? undefined : lineNumber + 1
      lineChunks = []
      lineBufferedBytes = 0
      lineRawBytes = 0

      if (matchesFilters(item, options.categories, options.types)) {
        items.push(item)
      }

      return items.length >= options.limit || scannedLines >= maxScanLines || scannedBytes >= MAX_SCAN_BYTES
    }

    while (readOffset < sourceBytes) {
      const chunkStartOffset = readOffset
      const readLength = Math.min(buffer.length, sourceBytes - readOffset)
      const result = await fileHandle.read(buffer, 0, readLength, readOffset)
      if (result.bytesRead <= 0) {
        break
      }

      readOffset += result.bytesRead
      const chunk = buffer.subarray(0, result.bytesRead)
      let segmentStart = 0
      while (segmentStart < chunk.length) {
        const newlineIndex = chunk.indexOf(0x0a, segmentStart)
        if (newlineIndex < 0) {
          appendLineSegment(chunk.subarray(segmentStart))
          break
        }

        appendLineSegment(chunk.subarray(segmentStart, newlineIndex))
        const nextByteOffset = chunkStartOffset + newlineIndex + 1
        const shouldStop = processLine(nextByteOffset)
        segmentStart = newlineIndex + 1
        if (shouldStop) {
          return {
            items,
            nextOffset: lineStartOffset,
            nextLineNumber: lineNumber,
            sourceBytes,
            scannedLines,
            scannedBytes,
            scanLimited: items.length < options.limit && (scannedLines >= maxScanLines || scannedBytes >= MAX_SCAN_BYTES),
            reachedEof: lineStartOffset >= sourceBytes,
          }
        }
      }
    }

    if (lineRawBytes > 0) {
      const shouldStop = processLine(sourceBytes)
      if (shouldStop) {
        return {
          items,
          nextOffset: lineStartOffset,
          nextLineNumber: lineNumber,
          sourceBytes,
          scannedLines,
          scannedBytes,
          scanLimited: items.length < options.limit && (scannedLines >= maxScanLines || scannedBytes >= MAX_SCAN_BYTES),
          reachedEof: lineStartOffset >= sourceBytes,
        }
      }
    }

    return {
      items,
      nextOffset: sourceBytes,
      nextLineNumber: lineNumber,
      sourceBytes,
      scannedLines,
      scannedBytes,
      scanLimited: false,
      reachedEof: true,
    }
  } finally {
    await fileHandle.close()
  }
}

async function readJsonlPageDescending(
  fileHandle: Awaited<ReturnType<typeof open>>,
  options: ReadJsonlPageOptions,
  sourceBytes: number,
): Promise<ReadJsonlPageResult> {
  const startOffset = Math.min(Math.max(options.startOffset, 0), sourceBytes)
  if (startOffset <= 0 || sourceBytes === 0) {
    return {
      items: [],
      nextOffset: 0,
      nextLineNumber: undefined,
      sourceBytes,
      scannedLines: 0,
      scannedBytes: 0,
      scanLimited: false,
      reachedEof: true,
    }
  }

  const maxScanLines = Math.min(MAX_SCAN_LINES, Math.max(options.limit, options.limit * DEFAULT_SCAN_LINE_MULTIPLIER))
  const readLength = Math.min(MAX_SCAN_BYTES, startOffset)
  const windowStart = startOffset - readLength
  const buffer = Buffer.alloc(readLength)
  const result = await fileHandle.read(buffer, 0, readLength, windowStart)
  const chunk = buffer.subarray(0, result.bytesRead)
  const records: JsonlLineRecord[] = []
  let lineStart = windowStart
  let segmentStart = 0

  if (windowStart > 0) {
    const firstNewlineIndex = chunk.indexOf(0x0a)
    if (firstNewlineIndex < 0) {
      return {
        items: [],
        nextOffset: windowStart,
        nextLineNumber: undefined,
        sourceBytes,
        scannedLines: 0,
        scannedBytes: result.bytesRead,
        scanLimited: true,
        reachedEof: false,
      }
    }
    segmentStart = firstNewlineIndex + 1
    lineStart = windowStart + segmentStart
  }

  while (segmentStart < chunk.length) {
    const newlineIndex = chunk.indexOf(0x0a, segmentStart)
    if (newlineIndex < 0) {
      break
    }

    const lineBytes = stripTrailingCarriageReturn(Buffer.from(chunk.subarray(segmentStart, newlineIndex)))
    const nextByteOffset = windowStart + newlineIndex + 1
    records.push({
      lineBytes,
      rawBytes: newlineIndex - segmentStart,
      byteOffset: lineStart,
      nextByteOffset,
    })

    segmentStart = newlineIndex + 1
    lineStart = windowStart + segmentStart
  }

  if (segmentStart < chunk.length) {
    records.push({
      lineBytes: stripTrailingCarriageReturn(Buffer.from(chunk.subarray(segmentStart))),
      rawBytes: chunk.length - segmentStart,
      byteOffset: lineStart,
      nextByteOffset: startOffset,
    })
  }

  const items: SessionAuditEntry[] = []
  let scannedLines = 0
  let scannedBytes = 0
  let nextOffset = startOffset

  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    nextOffset = record.byteOffset
    scannedLines += 1
    scannedBytes += record.nextByteOffset - record.byteOffset
    const item = buildAuditEntry(record, options.source)
    if (matchesFilters(item, options.categories, options.types)) {
      items.push(item)
    }

    if (items.length >= options.limit || scannedLines >= maxScanLines || scannedBytes >= MAX_SCAN_BYTES) {
      return {
        items,
        nextOffset,
        nextLineNumber: undefined,
        sourceBytes,
        scannedLines,
        scannedBytes,
        scanLimited: items.length < options.limit && (scannedLines >= maxScanLines || scannedBytes >= MAX_SCAN_BYTES),
        reachedEof: nextOffset <= 0,
      }
    }
  }

  return {
    items,
    nextOffset: records[0]?.byteOffset ?? windowStart,
    nextLineNumber: undefined,
    sourceBytes,
    scannedLines,
    scannedBytes,
    scanLimited: records.length === 0 && windowStart > 0,
    reachedEof: (records[0]?.byteOffset ?? windowStart) <= 0,
  }
}

function buildAuditEntry(record: JsonlLineRecord, source: ResolvedAuditSource): SessionAuditEntry {
  const rawPreview = truncateUtf8(record.lineBytes.subarray(0, RAW_PREVIEW_MAX_BYTES).toString('utf8'), RAW_PREVIEW_MAX_BYTES)
  const rawPreviewTruncated = rawPreview.truncated || record.rawBytes > RAW_PREVIEW_MAX_BYTES
  const base = {
    id: `${source.sourceKind}:${source.sourceId}:${record.byteOffset}`,
    scope: source.scope,
    sourceId: source.sourceId,
    sourceLabel: source.sourceLabel,
    sourceKind: source.sourceKind,
    relativePath: source.relativePath,
    ordinal: record.lineNumber,
    lineNumber: record.lineNumber,
    byteOffset: record.byteOffset,
    nextByteOffset: record.nextByteOffset,
    rawPreview: rawPreview.text,
    rawPreviewTruncated,
    rawBytes: record.rawBytes,
  }

  if (record.rawBytes > MAX_PARSE_LINE_BYTES) {
    return {
      ...base,
      category: 'unknown',
      renderable: false,
      hiddenReason: 'payload_truncated',
      title: 'Oversized JSONL row',
      summary: 'JSONL row exceeds the audit parser byte cap',
      preview: rawPreview.text,
      previewTruncated: rawPreview.truncated,
      parseError: `Line exceeds ${MAX_PARSE_LINE_BYTES} byte parser cap`,
    }
  }

  const lineText = record.lineBytes.toString('utf8')
  let wrapper: Record<string, unknown>
  try {
    const parsed = JSON.parse(lineText) as unknown
    if (!isRecord(parsed)) {
      throw new Error('JSONL row is not an object')
    }
    wrapper = parsed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ...base,
      category: 'malformed',
      renderable: false,
      hiddenReason: 'malformed',
      title: 'Malformed JSONL row',
      summary: `Malformed JSONL line: ${message}`,
      preview: rawPreview.text,
      previewTruncated: rawPreview.truncated,
      parseError: message,
    }
  }

  const wrapperType = stringValue(wrapper.type)
  const customType = stringValue(wrapper.customType)
  const wrapperId = stringValue(wrapper.id)
  const parentId = nullableStringValue(wrapper.parentId)
  const wrapperTimestamp = stringValue(wrapper.timestamp)

  if (wrapperType === 'session') {
    const cwd = stringValue(wrapper.cwd)
    const preview = truncateText(cwd ? `cwd: ${cwd}` : rawPreview.text)
    return {
      ...base,
      wrapperId,
      parentId,
      wrapperTimestamp,
      wrapperType,
      category: 'session_header',
      renderable: true,
      title: 'Session header',
      summary: cwd ? `Session header for ${cwd}` : 'Session header',
      preview: preview.text,
      previewTruncated: preview.truncated,
    }
  }

  if (wrapperType === 'custom' && customType === CONVERSATION_ENTRY_TYPE) {
    const data = wrapper.data
    if (!isRecord(data)) {
      return {
        ...base,
        wrapperId,
        parentId,
        wrapperTimestamp,
        wrapperType,
        customType,
        category: 'malformed',
        renderable: false,
        hiddenReason: 'malformed',
        title: 'Malformed conversation entry',
        summary: 'Conversation entry wrapper has missing or invalid data',
        preview: rawPreview.text,
        previewTruncated: rawPreview.truncated,
        parseError: 'Conversation entry wrapper has missing or invalid data',
      }
    }

    const conversationType = stringValue(data.type)
    const classified = classifyConversationEntry(data)
    const preview = truncateText(extractConversationPreview(data) || rawPreview.text)
    return {
      ...base,
      wrapperId,
      parentId,
      wrapperTimestamp,
      entryTimestamp: stringValue(data.timestamp),
      wrapperType,
      customType,
      conversationType,
      category: classified.category,
      agentId: stringValue(data.agentId),
      actorAgentId: stringValue(data.actorAgentId),
      fromAgentId: stringValue(data.fromAgentId),
      toAgentId: stringValue(data.toAgentId),
      toolName: stringValue(data.toolName),
      toolCallId: stringValue(data.toolCallId),
      toolKind: stringValue(data.kind),
      role: stringValue(data.role),
      conversationSource: stringValue(data.source),
      renderable: classified.renderable,
      hiddenReason: classified.hiddenReason,
      title: classified.title,
      summary: buildConversationSummary(data, classified.title, preview.text),
      preview: preview.text,
      previewTruncated: preview.truncated,
    }
  }

  if (wrapperType === 'custom') {
    const preview = truncateText(rawPreview.text)
    return {
      ...base,
      wrapperId,
      parentId,
      wrapperTimestamp,
      wrapperType,
      customType,
      category: 'custom',
      renderable: false,
      hiddenReason: 'raw_only',
      title: customType ? `Custom row: ${customType}` : 'Custom row',
      summary: customType ? `Custom row (${customType})` : 'Custom row',
      preview: preview.text,
      previewTruncated: preview.truncated || rawPreview.truncated,
    }
  }

  const nativeProviderMessage = classifyNativeProviderMessage(wrapper)
  if (nativeProviderMessage) {
    const preview = truncateText(nativeProviderMessage.preview)
    return {
      ...base,
      wrapperId,
      parentId,
      wrapperTimestamp,
      wrapperType,
      customType,
      entryTimestamp: nativeProviderMessage.entryTimestamp ?? wrapperTimestamp,
      category: 'runtime_log',
      toolName: nativeProviderMessage.toolName,
      toolCallId: nativeProviderMessage.toolCallId,
      toolKind: nativeProviderMessage.toolKind,
      role: nativeProviderMessage.role,
      renderable: true,
      hiddenReason: 'normal_view_hidden',
      title: nativeProviderMessage.title,
      summary: nativeProviderMessage.summary,
      preview: preview.text,
      previewTruncated: preview.truncated,
    }
  }

  const preview = truncateText(rawPreview.text)
  return {
    ...base,
    wrapperId,
    parentId,
    wrapperTimestamp,
    wrapperType,
    customType,
    category: 'unknown',
    renderable: false,
    hiddenReason: 'raw_only',
    title: wrapperType ? `Unknown row: ${wrapperType}` : 'Unknown row',
    summary: wrapperType ? `Unknown JSONL wrapper type: ${wrapperType}` : 'Unknown JSONL row',
    preview: preview.text,
    previewTruncated: preview.truncated || rawPreview.truncated,
  }
}

function classifyConversationEntry(entry: Record<string, unknown>): {
  category: SessionAuditEntryCategory
  renderable: boolean
  hiddenReason?: SessionAuditEntry['hiddenReason']
  title: string
} {
  const type = stringValue(entry.type)
  switch (type) {
    case 'conversation_message':
      return { category: 'conversation_message', renderable: true, title: 'Conversation message' }
    case 'agent_message':
      return { category: 'agent_message', renderable: true, title: 'Agent message' }
    case 'agent_tool_call': {
      const agentId = stringValue(entry.agentId)
      const actorAgentId = stringValue(entry.actorAgentId)
      if (agentId && actorAgentId && agentId === actorAgentId) {
        return { category: 'manager_tool_call', renderable: true, title: 'Manager tool call' }
      }
      return {
        category: 'worker_tool_call',
        renderable: true,
        hiddenReason: 'normal_view_hidden',
        title: 'Worker tool call',
      }
    }
    case 'conversation_log':
      return {
        category: 'runtime_log',
        renderable: true,
        hiddenReason: 'normal_view_hidden',
        title: 'Runtime log',
      }
    case 'choice_request':
      return { category: 'choice_request', renderable: true, title: 'Choice request' }
    case 'work_plan_created':
      return { category: 'work_plan_created', renderable: true, title: 'Work plan created' }
    case 'model_cache_observation':
      return { category: 'model_cache_observation', renderable: true, title: 'Model cache observation' }
    default:
      return {
        category: 'unknown',
        renderable: false,
        hiddenReason: 'raw_only',
        title: type ? `Unknown conversation entry: ${type}` : 'Unknown conversation entry',
      }
  }
}

function buildConversationSummary(entry: Record<string, unknown>, title: string, preview: string): string {
  const type = stringValue(entry.type)
  if (type === 'conversation_message') {
    const role = stringValue(entry.role) || 'message'
    return `${role}: ${preview}`
  }
  if (type === 'agent_message') {
    const from = stringValue(entry.fromAgentId) || 'user'
    const to = stringValue(entry.toAgentId) || 'agent'
    return `${from} -> ${to}: ${preview}`
  }
  if (type === 'agent_tool_call') {
    const actor = stringValue(entry.actorAgentId) || stringValue(entry.agentId) || 'agent'
    const kind = stringValue(entry.kind) || 'tool'
    const toolName = stringValue(entry.toolName) || 'tool'
    return `${actor} ${kind} ${toolName}: ${preview}`
  }
  if (type === 'conversation_log') {
    const kind = stringValue(entry.kind) || 'log'
    const toolName = stringValue(entry.toolName)
    return `${kind}${toolName ? ` ${toolName}` : ''}: ${preview}`
  }
  return preview ? `${title}: ${preview}` : title
}

function extractConversationPreview(entry: Record<string, unknown>): string {
  const text = stringValue(entry.text)
  if (text) {
    return text
  }
  const questions = entry.questions
  if (Array.isArray(questions)) {
    return `${questions.length} question${questions.length === 1 ? '' : 's'}`
  }
  const plan = entry.plan
  if (isRecord(plan)) {
    return stringValue(plan.title) ?? stringValue(plan.summary) ?? ''
  }
  return ''
}

interface NativeProviderMessageClassification {
  role: string
  title: string
  summary: string
  preview: string
  toolName?: string
  toolCallId?: string
  toolKind?: string
  entryTimestamp?: string
}

interface NativeProviderContentSummary {
  kind: 'text' | 'system' | 'toolCall' | 'toolResult' | 'thinking'
  text?: string
  toolName?: string
  toolCallId?: string
  toolKind?: string
  contentItemCount?: number
  textCharCount?: number
  hiddenContentItemCount?: number
}

const NATIVE_PROVIDER_MESSAGE_ROLES = new Set(['user', 'assistant', 'system', 'toolResult'])
const NATIVE_PROVIDER_TOOL_CALL_TYPES = new Set(['toolCall', 'tool_call', 'functionCall', 'function_call'])
const NATIVE_PROVIDER_TOOL_RESULT_TYPES = new Set(['toolResult', 'tool_result', 'functionResult', 'function_result'])
const NATIVE_PROVIDER_THINKING_TYPES = new Set(['thinking'])

function classifyNativeProviderMessage(wrapper: Record<string, unknown>): NativeProviderMessageClassification | undefined {
  if (stringValue(wrapper.type) !== 'message') {
    return undefined
  }

  const message = wrapper.message
  if (!isRecord(message)) {
    return undefined
  }

  const role = stringValue(message.role)
  if (!role || !NATIVE_PROVIDER_MESSAGE_ROLES.has(role)) {
    return undefined
  }

  const contentSummary = summarizeNativeProviderContent(message, role)
  if (!contentSummary) {
    return undefined
  }

  const entryTimestamp = stringValue(message.timestamp) ?? stringValue(wrapper.timestamp)
  const toolName = contentSummary.toolName ?? boundedMetadataValue(message.toolName) ?? boundedMetadataValue(message.name)
  const toolCallId = contentSummary.toolCallId ?? boundedMetadataValue(message.toolCallId) ?? boundedMetadataValue(message.id)

  if (contentSummary.kind === 'toolCall') {
    const title = `Provider tool call${toolName ? `: ${toolName}` : ''}`
    const preview = buildProviderToolPreview('tool call', toolName, toolCallId, contentSummary.contentItemCount)
    return {
      role,
      entryTimestamp,
      title,
      summary: preview,
      preview,
      toolName,
      toolCallId,
      toolKind: 'tool_call',
    }
  }

  if (contentSummary.kind === 'toolResult' || role === 'toolResult') {
    const title = `Provider tool result${toolName ? `: ${toolName}` : ''}`
    const preview = buildProviderToolPreview('tool result', toolName, toolCallId, contentSummary.contentItemCount)
    return {
      role,
      entryTimestamp,
      title,
      summary: preview,
      preview,
      toolName,
      toolCallId,
      toolKind: 'tool_result',
    }
  }

  if (role === 'system' || contentSummary.kind === 'system') {
    const textCharCount = contentSummary.textCharCount ?? contentSummary.text?.length ?? 0
    const itemCount = contentSummary.contentItemCount
    const preview = `Provider system message content hidden${textCharCount > 0 ? ` (${textCharCount} text char${textCharCount === 1 ? '' : 's'}${itemCount !== undefined ? ` across ${itemCount} item${itemCount === 1 ? '' : 's'}` : ''})` : ''}`
    return {
      role,
      entryTimestamp,
      title: 'Provider system message',
      summary: preview,
      preview,
    }
  }

  if (contentSummary.kind === 'thinking') {
    const hiddenCount = contentSummary.hiddenContentItemCount ?? contentSummary.contentItemCount ?? 0
    const preview = `Provider assistant thinking hidden${hiddenCount > 0 ? ` (${hiddenCount} block${hiddenCount === 1 ? '' : 's'})` : ''}`
    return {
      role,
      entryTimestamp,
      title: 'Provider assistant thinking',
      summary: preview,
      preview,
    }
  }

  const textPreview = truncateText(contentSummary.text ?? '').text
  const title = `Provider ${role} message`
  const summary = textPreview ? `${title}: ${textPreview}` : title
  return {
    role,
    entryTimestamp,
    title,
    summary,
    preview: textPreview,
  }
}

function summarizeNativeProviderContent(message: Record<string, unknown>, role: string): NativeProviderContentSummary | undefined {
  const content = message.content
  if (typeof content === 'string') {
    if (role === 'toolResult') {
      return { kind: 'toolResult', textCharCount: content.length }
    }
    if (role === 'system') {
      return { kind: 'system', textCharCount: content.length }
    }
    return { kind: 'text', text: content, textCharCount: content.length }
  }

  if (!Array.isArray(content)) {
    return undefined
  }

  const textParts: string[] = []
  let textCharCount = 0
  let toolCall: NativeProviderContentSummary | undefined
  let toolResult: NativeProviderContentSummary | undefined
  let hiddenContentItemCount = 0

  for (const item of content) {
    if (typeof item === 'string') {
      textParts.push(item)
      textCharCount += item.length
      continue
    }
    if (!isRecord(item)) {
      return undefined
    }

    const itemType = stringValue(item.type)
    if (itemType && NATIVE_PROVIDER_THINKING_TYPES.has(itemType)) {
      hiddenContentItemCount += 1
      continue
    }

    if (itemType && NATIVE_PROVIDER_TOOL_CALL_TYPES.has(itemType)) {
      toolCall ??= {
        kind: 'toolCall',
        toolName: boundedMetadataValue(item.name) ?? boundedMetadataValue(item.toolName),
        toolCallId: boundedMetadataValue(item.toolCallId) ?? boundedMetadataValue(item.id) ?? boundedMetadataValue(item.callId),
        contentItemCount: content.length,
        hiddenContentItemCount,
      }
      continue
    }

    if (itemType && NATIVE_PROVIDER_TOOL_RESULT_TYPES.has(itemType)) {
      toolResult ??= {
        kind: 'toolResult',
        toolName: boundedMetadataValue(item.name) ?? boundedMetadataValue(item.toolName),
        toolCallId: boundedMetadataValue(item.toolCallId) ?? boundedMetadataValue(item.id) ?? boundedMetadataValue(item.callId),
        contentItemCount: content.length,
        hiddenContentItemCount,
      }
      continue
    }

    if (itemType === 'text' || (!itemType && typeof item.text === 'string')) {
      const text = stringValue(item.text) ?? ''
      textParts.push(text)
      textCharCount += text.length
      continue
    }

    return undefined
  }

  if (toolCall) {
    return { ...toolCall, hiddenContentItemCount }
  }
  if (toolResult || role === 'toolResult') {
    return toolResult ? { ...toolResult, hiddenContentItemCount } : { kind: 'toolResult', contentItemCount: content.length, textCharCount, hiddenContentItemCount }
  }
  if (role === 'system') {
    return { kind: 'system', contentItemCount: content.length, textCharCount, hiddenContentItemCount }
  }
  if (textParts.length === 0 && hiddenContentItemCount > 0) {
    return { kind: 'thinking', contentItemCount: content.length, hiddenContentItemCount }
  }
  return {
    kind: 'text',
    text: textParts.join('\n'),
    contentItemCount: content.length,
    textCharCount,
    hiddenContentItemCount,
  }
}

function buildProviderToolPreview(kind: 'tool call' | 'tool result', toolName: string | undefined, toolCallId: string | undefined, itemCount: number | undefined): string {
  const parts = [`Provider ${kind}`]
  if (toolName) {
    parts.push(toolName)
  }
  if (toolCallId) {
    parts.push(`(${toolCallId})`)
  }
  if (itemCount !== undefined && itemCount > 1) {
    parts.push(`[${itemCount} content items]`)
  }
  return parts.join(' ')
}

function boundedMetadataValue(value: unknown): string | undefined {
  const text = stringValue(value)
  if (!text) {
    return undefined
  }
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 120) {
    return normalized
  }
  return `${normalized.slice(0, 119)}…`
}

function matchesFilters(
  item: SessionAuditEntry,
  categories: ReadonlySet<SessionAuditEntryCategory> | undefined,
  types: ReadonlySet<string> | undefined,
): boolean {
  if (categories && !categories.has(item.category)) {
    return false
  }
  if (types) {
    const values = [item.wrapperType, item.customType, item.conversationType].filter((value): value is string => Boolean(value))
    if (!values.some((value) => types.has(value))) {
      return false
    }
  }
  return true
}

function encodeCursor(cursor: SessionAuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(raw: string): SessionAuditCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (!isRecord(parsed) || parsed.v !== 1) {
      throw new Error('Unsupported cursor version')
    }
    const offset = numberValue(parsed.offset)
    if (offset === undefined || !Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('Invalid cursor offset')
    }
    const lineNumber = numberValue(parsed.lineNumber)
    if (lineNumber !== undefined && (!Number.isSafeInteger(lineNumber) || lineNumber < 1)) {
      throw new Error('Invalid cursor line number')
    }
    return {
      v: 1,
      sessionAgentId: normalizeRequiredId(stringValue(parsed.sessionAgentId), 'cursor.sessionAgentId'),
      scope: parseScope(stringValue(parsed.scope)),
      sourceId: normalizeRequiredId(stringValue(parsed.sourceId), 'cursor.sourceId'),
      offset,
      lineNumber,
      order: parseOrder(stringValue(parsed.order)),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new SessionAuditError(`Invalid audit cursor: ${message}`, 400)
  }
}

function validateCursor(cursor: SessionAuditCursor, expected: Pick<SessionAuditCursor, 'sessionAgentId' | 'scope' | 'sourceId' | 'order'>): void {
  if (
    cursor.sessionAgentId !== expected.sessionAgentId ||
    cursor.scope !== expected.scope ||
    cursor.sourceId !== expected.sourceId ||
    cursor.order !== expected.order
  ) {
    throw new SessionAuditError('Audit cursor does not match the requested source', 400)
  }
}

function normalizeCategories(categories: readonly SessionAuditEntryCategory[] | undefined): Set<SessionAuditEntryCategory> | undefined {
  if (!categories || categories.length === 0) {
    return undefined
  }
  const allowed = new Set<string>(SESSION_AUDIT_ENTRY_CATEGORY_VALUES)
  const normalized = new Set<SessionAuditEntryCategory>()
  for (const category of categories) {
    if (!allowed.has(category)) {
      throw new SessionAuditError(`Unsupported audit category: ${category}`, 400)
    }
    normalized.add(category)
  }
  return normalized
}

function normalizeStringSet(values: readonly string[] | undefined): Set<string> | undefined {
  if (!values || values.length === 0) {
    return undefined
  }
  const normalized = new Set<string>()
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed.length > 0) {
      normalized.add(trimmed)
    }
  }
  return normalized.size > 0 ? normalized : undefined
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_AUDIT_LIMIT
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new SessionAuditError('Audit limit must be a positive integer', 400)
  }
  return Math.min(limit, MAX_AUDIT_LIMIT)
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined) {
    return 0
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new SessionAuditError('Audit offset must be a non-negative integer', 400)
  }
  return offset
}

function parseScope(value: string | undefined): SessionAuditScope {
  if (value === 'session' || value === 'worker') {
    return value
  }
  throw new SessionAuditError('Unsupported audit scope', 400)
}

function parseOrder(value: string | undefined): SessionAuditOrder {
  if (value === undefined || value === '' || value === 'asc') {
    return 'asc'
  }
  if (value === 'desc') {
    return 'desc'
  }
  throw new SessionAuditError('Unsupported audit order', 400)
}

function normalizeRequiredId(value: string | undefined, field: string): string {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) {
    throw new SessionAuditError(`Missing ${field}`, 400)
  }
  return trimmed
}

function sanitizeAuditPathSegment(value: string, field: string): string {
  try {
    return sanitizePathSegment(value)
  } catch {
    throw new SessionAuditError(`Invalid ${field}`, 400)
  }
}

function isSafeAuditPathSegment(value: string): boolean {
  try {
    sanitizePathSegment(value)
    return true
  } catch {
    return false
  }
}

function assertPathInside(targetPath: string, parentPath: string, message: string): void {
  const resolvedTarget = resolve(targetPath)
  const resolvedParent = resolve(parentPath)
  const relativePath = relative(resolvedParent, resolvedTarget)
  if (relativePath.startsWith('..') || relativePath === '..' || resolve(resolvedParent, relativePath) !== resolvedTarget) {
    throw new SessionAuditError(message, 400)
  }
}

function stripTrailingCarriageReturn(buffer: Buffer): Buffer {
  if (buffer.length > 0 && buffer[buffer.length - 1] === 0x0d) {
    return buffer.subarray(0, buffer.length - 1)
  }
  return buffer
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= maxBytes) {
    return { text, truncated: false }
  }
  const ellipsis = '…'
  const contentBudget = Math.max(0, maxBytes - Buffer.byteLength(ellipsis, 'utf8'))
  let end = Math.min(text.length, contentBudget)
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > contentBudget) {
    end -= 1
  }
  return { text: `${text.slice(0, end)}${ellipsis}`, truncated: true }
}

function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= TEXT_PREVIEW_MAX_CHARS) {
    return { text, truncated: false }
  }
  return { text: `${text.slice(0, TEXT_PREVIEW_MAX_CHARS)}…`, truncated: true }
}

async function readFileSize(filePath: string): Promise<number | undefined> {
  const fileState = await readAuditFileState(filePath)
  return fileState.rejected ? undefined : fileState.stats?.size
}

async function readWorkerAuditFileStats(
  filePath: string,
  workersDirRealPath: string | undefined,
  sessionDirRealPath: string | undefined,
): Promise<AuditFileState> {
  const fileState = await readAuditFileState(filePath, {
    parentRealPath: workersDirRealPath,
    outsideMessage: 'Worker audit file is outside the selected workers directory',
  })
  if (fileState.rejected || !fileState.realPath || !sessionDirRealPath) {
    return fileState
  }
  assertPathInside(fileState.realPath, sessionDirRealPath, 'Worker audit file is outside the selected session directory')
  return fileState
}

interface AuditDirectoryState {
  realPath?: string
  missing: boolean
  rejected: boolean
}

interface AuditFileState {
  stats?: Stats
  realPath?: string
  rejected: boolean
}

async function readAuditDirectoryState(dirPath: string): Promise<AuditDirectoryState> {
  const dirStats = await lstat(dirPath).catch((error: unknown) => {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return undefined
    }
    throw error
  })
  if (!dirStats) {
    return { missing: true, rejected: false }
  }
  if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) {
    return { missing: false, rejected: true }
  }
  return { realPath: await realpath(dirPath), missing: false, rejected: false }
}

async function readAuditFileState(
  filePath: string,
  containment?: { parentRealPath?: string; outsideMessage: string },
): Promise<AuditFileState> {
  const fileStats = await lstat(filePath).catch((error: unknown) => {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return undefined
    }
    throw error
  })
  if (!fileStats) {
    return { rejected: false }
  }
  if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
    return { rejected: true }
  }
  const fileRealPath = await realpath(filePath)
  if (containment?.parentRealPath) {
    assertPathInside(fileRealPath, containment.parentRealPath, containment.outsideMessage)
  }
  return { stats: fileStats, realPath: fileRealPath, rejected: false }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function nullableStringValue(value: unknown): string | null | undefined {
  if (value === null) {
    return null
  }
  return stringValue(value)
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}
