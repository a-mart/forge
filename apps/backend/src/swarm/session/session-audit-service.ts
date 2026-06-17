import { open, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type {
  SessionAuditCursor,
  SessionAuditEntry,
  SessionAuditEntryCategory,
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

  async getSessionAuditPage(sessionAgentId: string, request: SessionAuditPageRequest = {}): Promise<SessionAuditPageResponse> {
    const normalizedSessionAgentId = normalizeRequiredId(sessionAgentId, 'sessionAgentId')
    const order = parseOrder(request.order)
    if (order !== 'asc') {
      throw new SessionAuditError('Session audit currently supports order=asc only', 400)
    }

    const scope = parseScope(request.scope ?? 'session')
    if (scope === 'session' && request.workerId) {
      throw new SessionAuditError('workerId is only valid for worker audit scope', 400)
    }

    if (request.sourceKind) {
      const expectedSourceKind: SessionAuditSourceKind = scope === 'session' ? 'canonical_session_jsonl' : 'canonical_worker_jsonl'
      if (request.sourceKind !== expectedSourceKind) {
        throw new SessionAuditError('Audit sourceKind does not match the requested source', 400)
      }
    }

    const limit = clampLimit(request.limit)
    const categories = normalizeCategories(request.categories)
    const types = normalizeStringSet(request.types)
    const sessionSource = this.resolveSessionSource(normalizedSessionAgentId)
    const source = scope === 'session'
      ? sessionSource
      : await this.resolveWorkerSource(sessionSource, request.workerId)
    const cursor = request.cursor ? decodeCursor(request.cursor) : undefined
    if (cursor) {
      validateCursor(cursor, {
        sessionAgentId: normalizedSessionAgentId,
        scope,
        sourceId: source.sourceId,
        order,
      })
    }

    const manifest = await this.buildManifest(normalizedSessionAgentId, sessionSource.sessionDir, sessionSource.absolutePath)
    const startOffset = cursor?.offset ?? normalizeOffset(request.offset)
    const readResult = await readJsonlPage({
      filePath: source.absolutePath,
      startOffset,
      startLineNumber: cursor?.lineNumber ?? (startOffset === 0 ? 1 : undefined),
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

  private resolveSessionSource(sessionAgentId: string): ResolvedAuditSource {
    const descriptor = this.host.getAgent(sessionAgentId)
    if (!descriptor || descriptor.role !== 'manager') {
      throw new SessionAuditError('Unknown manager session', 404)
    }

    const dataDir = this.host.getConfig().paths.dataDir
    const profileId = descriptor.profileId ?? descriptor.agentId
    const sessionDir = resolve(getSessionDir(dataDir, profileId, descriptor.agentId))
    const sessionFile = resolve(getSessionFilePath(dataDir, profileId, descriptor.agentId))
    assertPathInside(sessionFile, sessionDir, 'Session audit file is outside the selected session directory')

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
    const workerFile = resolve(getWorkerSessionFilePath(dataDir, profileId, sessionSource.sessionAgentId, safeWorkerId))
    assertPathInside(workerFile, workersDir, 'Worker audit file is outside the selected workers directory')

    const fileExists = await stat(workerFile).then(() => true).catch((error: unknown) => {
      if (isNodeErrorCode(error, 'ENOENT')) {
        return false
      }
      throw error
    })
    if (!descriptor && !fileExists) {
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

    const summaries = await Promise.all([...workerIds].sort().map(async (workerId) => {
      const safeWorkerId = sanitizeAuditPathSegment(workerId, 'workerId')
      const relativePath = join('workers', `${safeWorkerId}.jsonl`)
      const filePath = resolve(workersDir, `${safeWorkerId}.jsonl`)
      assertPathInside(filePath, workersDir, 'Worker audit file is outside the selected workers directory')
      const descriptor = descriptorWorkers.get(workerId)
      const fileStat = await stat(filePath).catch((error: unknown) => {
        if (isNodeErrorCode(error, 'ENOENT')) {
          return undefined
        }
        throw error
      })
      return {
        workerId,
        displayName: descriptor?.displayName,
        status: descriptor?.status,
        relativePath,
        bytes: fileStat?.size,
        updatedAt: descriptor?.updatedAt ?? fileStat?.mtime.toISOString(),
      } satisfies SessionAuditWorkerSummary
    }))

    return summaries
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

export function decodeSessionAuditCursor(raw: string): SessionAuditCursor {
  return decodeCursor(raw)
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
  return stat(filePath).then((stats) => stats.size).catch((error: unknown) => {
    if (isNodeErrorCode(error, 'ENOENT')) {
      return undefined
    }
    throw error
  })
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

export const sessionAuditTestInternals = {
  DEFAULT_AUDIT_LIMIT,
  MAX_AUDIT_LIMIT,
  RAW_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_CHARS,
}
