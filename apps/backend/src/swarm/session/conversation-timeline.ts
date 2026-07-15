import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { mkdir, open as openFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ConversationEntryEvent } from "../types.js";
import { isEnoentError } from "../../utils/fs-errors.js";

export const CONVERSATION_ENTRY_TYPE = "swarm_conversation_entry";
export const SESSION_HEADER_VERSION = 3;

const FIRST_LINE_CHUNK_BYTES = 512;
const TAIL_CHUNK_BYTES = 8192;
const MAX_LEAF_HYDRATION_BYTES = 4 * 1024 * 1024;

export interface ConversationTimelineDescriptor {
  sessionFile: string;
  cwd: string;
}

export interface ConversationTimelineOptions {
  now: () => string;
  logDebug?: (message: string, details?: unknown) => void;
}

export interface AppendConversationEntryResult {
  entryId: string;
  parentId: string | null;
  headerCreated: boolean;
}

export interface ImmediateCustomEntryTimelineOptions {
  sessionFile: string;
  cwd: string;
  customType: string;
  data?: unknown;
  now?: () => string;
}

export interface ImmediateCustomEntryTimelineResult {
  sessionFile: string;
  entryId: string;
  parentId: string | null;
  headerCreated: boolean;
}

export interface CopySessionHistoryForForkOptions {
  sourceSessionFile: string;
  targetSessionFile: string;
  fromMessageId?: string;
  omittedCustomTypes?: readonly string[];
}

export class ConversationTimeline {
  private readonly lastSessionEntryIdBySessionFile = new Map<string, string>();

  constructor(private readonly options: ConversationTimelineOptions) {}

  clear(): void {
    this.lastSessionEntryIdBySessionFile.clear();
  }

  resetSession(sessionFile: string): void {
    this.lastSessionEntryIdBySessionFile.delete(sessionFile);
  }

  appendConversationEntry(
    descriptor: ConversationTimelineDescriptor,
    event: ConversationEntryEvent
  ): AppendConversationEntryResult {
    // Avoid SessionManager.open() here: opening re-reads the whole JSONL file,
    // which is unsafe for very large transcripts. Appending a well-formed JSONL
    // entry keeps this path O(1) with no full-file reads.
    const headerCreated = this.ensureSessionFileHeader(descriptor);
    if (!this.lastSessionEntryIdBySessionFile.has(descriptor.sessionFile)) {
      this.hydrateLeafEntryId(descriptor);
    }
    const parentId = this.lastSessionEntryIdBySessionFile.get(descriptor.sessionFile) ?? null;
    const entryId = generateSessionEntryId();
    event.timelineEntryId ??= entryId;
    event.timelineSequence ??= statSync(descriptor.sessionFile).size;
    assignConversationMessageIdIfMissing(event, entryId);

    appendFileSync(
      descriptor.sessionFile,
      `${JSON.stringify({
        type: "custom",
        customType: CONVERSATION_ENTRY_TYPE,
        data: event,
        id: entryId,
        parentId,
        timestamp: this.options.now()
      })}\n`,
      "utf8"
    );

    this.trackLastSessionEntryId(descriptor.sessionFile, entryId);
    return { entryId, parentId, headerCreated };
  }

  ensureSessionFileHeader(descriptor: ConversationTimelineDescriptor): boolean {
    if (hasValidSessionHeader(descriptor.sessionFile)) {
      return false;
    }

    const headerLine = buildSessionHeaderLine(descriptor.cwd, this.options.now);

    if (isMissingOrEmptySessionFile(descriptor.sessionFile)) {
      appendFileSync(descriptor.sessionFile, headerLine, "utf8");
      this.lastSessionEntryIdBySessionFile.delete(descriptor.sessionFile);
      return true;
    }

    // Existing files with invalid headers cannot be reopened by SessionManager.
    // Replace with a fresh header so subsequent appends stay recoverable.
    writeFileSync(descriptor.sessionFile, headerLine, "utf8");
    this.lastSessionEntryIdBySessionFile.delete(descriptor.sessionFile);
    return true;
  }

  hydrateLeafEntryId(descriptor: { agentId?: string; sessionFile: string }): void {
    const sessionFile = descriptor.sessionFile;

    try {
      const fileSize = statSync(sessionFile).size;
      if (fileSize <= 0) {
        this.lastSessionEntryIdBySessionFile.delete(sessionFile);
        return;
      }

      const tailInfo = readLastLineInfo(sessionFile, fileSize, MAX_LEAF_HYDRATION_BYTES);
      const lastLine = tailInfo.lastLine;
      const parsedLastLine = lastLine ? parseJsonLine(lastLine, sessionFile) : undefined;
      this.trackLastSessionEntryId(sessionFile, extractParentId(parsedLastLine) ?? undefined);
    } catch (error) {
      if (isEnoentError(error)) {
        this.lastSessionEntryIdBySessionFile.delete(sessionFile);
        return;
      }

      this.options.logDebug?.("history:hydrate_leaf:error", {
        agentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  getLastSessionEntryId(sessionFile: string): string | undefined {
    return this.lastSessionEntryIdBySessionFile.get(sessionFile);
  }

  trackLastSessionEntryId(sessionFile: string, entryId: string | undefined): void {
    if (typeof entryId !== "string" || entryId.trim().length === 0) {
      this.lastSessionEntryIdBySessionFile.delete(sessionFile);
      return;
    }

    this.lastSessionEntryIdBySessionFile.set(sessionFile, entryId);
  }

}

export async function copySessionHistoryForFork(options: CopySessionHistoryForForkOptions): Promise<void> {
  await mkdir(dirname(options.targetSessionFile), { recursive: true });

  const sourceHandle = await openFile(options.sourceSessionFile, "r").catch((error: unknown) => {
    if (isEnoentError(error)) {
      return undefined;
    }
    throw error;
  });

  if (!sourceHandle) {
    if (options.fromMessageId) {
      throw new Error("Message not found in session history");
    }

    await writeFile(options.targetSessionFile, "", "utf8");
    return;
  }

  const omittedCustomTypes = new Set(options.omittedCustomTypes ?? []);
  const droppedEntryParentIdMap = new Map<string, string | null>();
  const targetHandle = await openFile(options.targetSessionFile, "w");
  let foundForkPoint = !options.fromMessageId;

  try {
    for await (const line of sourceHandle.readLines()) {
      const reachedForkPoint =
        options.fromMessageId !== undefined && isForkTargetConversationEntryLine(line, options.fromMessageId);
      const forkLine = buildForkSessionHistoryLine(line, omittedCustomTypes, droppedEntryParentIdMap);

      if (forkLine !== undefined) {
        await targetHandle.write(`${forkLine}\n`);
      }

      if (reachedForkPoint) {
        foundForkPoint = true;
        break;
      }
    }
  } finally {
    await Promise.allSettled([sourceHandle.close(), targetHandle.close()]);
  }

  if (!foundForkPoint) {
    throw new Error("Message not found in session history");
  }
}

export async function collectConversationMessageIdsFromSessionFile(sessionFile: string): Promise<Set<string>> {
  const messageIds = new Set<string>();

  const handle = await openFile(sessionFile, "r").catch((error: unknown) => {
    if (isEnoentError(error)) {
      return undefined;
    }
    throw error;
  });

  if (!handle) {
    return messageIds;
  }

  try {
    for await (const line of handle.readLines()) {
      const conversationEntry = parseConversationMessageEntryLine(line);
      if (!conversationEntry?.id) {
        continue;
      }

      messageIds.add(conversationEntry.id);
    }
  } finally {
    await handle.close();
  }

  return messageIds;
}

export function parseConversationMessageEntryLine(line: string): { id?: string } | undefined {
  const trimmedLine = line.trim();
  if (trimmedLine.length === 0) {
    return undefined;
  }

  let parsedEntry: unknown;
  try {
    parsedEntry = JSON.parse(trimmedLine);
  } catch {
    return undefined;
  }

  if (!isRecordLike(parsedEntry)) {
    return undefined;
  }

  if (parsedEntry.type !== "custom" || parsedEntry.customType !== CONVERSATION_ENTRY_TYPE) {
    return undefined;
  }

  if (isRecordLike(parsedEntry.data)) {
    const dataId = parsedEntry.data.id;
    if (typeof dataId === "string" && dataId.trim().length > 0) {
      return { id: dataId };
    }
  }

  if (typeof parsedEntry.id === "string" && parsedEntry.id.trim().length > 0) {
    return { id: parsedEntry.id };
  }

  return undefined;
}

function buildForkSessionHistoryLine(
  line: string,
  omittedCustomTypes: ReadonlySet<string>,
  droppedEntryParentIdMap: Map<string, string | null>
): string | undefined {
  const trimmedLine = line.trim();
  if (trimmedLine.length === 0) {
    return line;
  }

  let parsedEntry: unknown;
  try {
    parsedEntry = JSON.parse(trimmedLine);
  } catch {
    return line;
  }

  if (isRecordLike(parsedEntry) && parsedEntry.type === "session") {
    // A fork inherits conversation history, not the source runtime identity.
    // Pi forwards this ID as provider session-id and x-client-request-id, so
    // copying it lets concurrently running branches share request identity.
    return JSON.stringify({ ...parsedEntry, id: randomUUID() });
  }

  if (shouldDropSessionHistoryLineForFork(parsedEntry, omittedCustomTypes)) {
    const entryLink = parseSessionEntryLink(parsedEntry);
    if (entryLink?.id) {
      const survivingParentId = resolveForkParentId(entryLink.parentId, droppedEntryParentIdMap);
      droppedEntryParentIdMap.set(entryLink.id, survivingParentId ?? null);
    }
    return undefined;
  }

  const rewrittenEntry = rewriteForkParentIdForRetainedEntry(parsedEntry, droppedEntryParentIdMap);
  return rewrittenEntry ? JSON.stringify(rewrittenEntry) : line;
}

function shouldDropSessionHistoryLineForFork(parsedEntry: unknown, omittedCustomTypes: ReadonlySet<string>): boolean {
  if (
    isRecordLike(parsedEntry) &&
    parsedEntry.type === "custom" &&
    typeof parsedEntry.customType === "string" &&
    omittedCustomTypes.has(parsedEntry.customType)
  ) {
    return true;
  }

  return isForkExcludedCodexParentCardEntry(parsedEntry);
}

function isForkExcludedCodexParentCardEntry(parsedEntry: unknown): boolean {
  if (
    !isRecordLike(parsedEntry) ||
    parsedEntry.type !== "custom" ||
    parsedEntry.customType !== CONVERSATION_ENTRY_TYPE
  ) {
    return false;
  }

  const data = parsedEntry.data;
  if (!isRecordLike(data) || data.type !== "conversation_message" || data.role !== "system") {
    return false;
  }

  const externalThreadContext = data.externalThreadContext;
  return (
    isRecordLike(externalThreadContext) &&
    externalThreadContext.type === "codex_app_server" &&
    externalThreadContext.excludeFromModelContext === true
  );
}

function rewriteForkParentIdForRetainedEntry(
  parsedEntry: unknown,
  droppedEntryParentIdMap: ReadonlyMap<string, string | null>
): Record<string, unknown> | undefined {
  const entryLink = parseSessionEntryLink(parsedEntry);
  if (!entryLink || entryLink.parentId === undefined) {
    return undefined;
  }

  const resolvedParentId = resolveForkParentId(entryLink.parentId, droppedEntryParentIdMap);
  if (resolvedParentId === entryLink.parentId) {
    return undefined;
  }

  return {
    ...entryLink.entry,
    parentId: resolvedParentId,
  };
}

function parseSessionEntryLink(parsedEntry: unknown):
  | { entry: Record<string, unknown>; id?: string; parentId?: string | null }
  | undefined {
  if (!isRecordLike(parsedEntry)) {
    return undefined;
  }

  const id =
    typeof parsedEntry.id === "string" && parsedEntry.id.trim().length > 0 ? parsedEntry.id : undefined;
  const parentId =
    parsedEntry.parentId === null
      ? null
      : typeof parsedEntry.parentId === "string" && parsedEntry.parentId.trim().length > 0
        ? parsedEntry.parentId
        : undefined;

  if (id === undefined && parentId === undefined) {
    return undefined;
  }

  return { entry: parsedEntry, id, parentId };
}

function resolveForkParentId(
  parentId: string | null | undefined,
  droppedEntryParentIdMap: ReadonlyMap<string, string | null>
): string | null | undefined {
  if (parentId === undefined || parentId === null) {
    return parentId;
  }

  let resolvedParentId: string | null = parentId;
  const visitedParentIds = new Set<string>();

  while (resolvedParentId !== null && droppedEntryParentIdMap.has(resolvedParentId)) {
    if (visitedParentIds.has(resolvedParentId)) {
      break;
    }

    visitedParentIds.add(resolvedParentId);
    resolvedParentId = droppedEntryParentIdMap.get(resolvedParentId) ?? null;
  }

  return resolvedParentId;
}

function isForkTargetConversationEntryLine(line: string, fromMessageId: string): boolean {
  const conversationEntry = parseConversationMessageEntryLine(line);
  if (!conversationEntry) {
    return false;
  }

  return conversationEntry.id === fromMessageId;
}

export async function appendImmediateCustomEntryViaTimeline(
  options: ImmediateCustomEntryTimelineOptions
): Promise<ImmediateCustomEntryTimelineResult> {
  const sessionFile = resolve(options.sessionFile);
  const now = options.now ?? (() => new Date().toISOString());

  await mkdir(dirname(sessionFile), { recursive: true });

  const inspection = inspectSessionFileForAppend(sessionFile);
  const entryId = generateSessionEntryId();
  const entryLine = JSON.stringify({
    type: "custom",
    customType: options.customType,
    data: options.data,
    id: entryId,
    parentId: inspection.parentId,
    timestamp: now()
  });

  const payload = inspection.headerCreated
    ? `${buildSessionHeaderLine(options.cwd, now)}${entryLine}\n`
    : `${inspection.needsLeadingNewline ? "\n" : ""}${entryLine}\n`;

  const fileHandle = await openFile(sessionFile, "a");
  try {
    await fileHandle.appendFile(payload, "utf8");
  } finally {
    await fileHandle.close();
  }

  return {
    sessionFile,
    entryId,
    parentId: inspection.parentId,
    headerCreated: inspection.headerCreated
  };
}

interface SessionFileAppendInspection {
  headerCreated: boolean;
  parentId: string | null;
  needsLeadingNewline: boolean;
}

export function inspectSessionFileForAppend(sessionFile: string): SessionFileAppendInspection {
  const fileStats = getSessionFileStats(sessionFile);
  if (!fileStats.exists || fileStats.size === 0) {
    return {
      headerCreated: true,
      parentId: null,
      needsLeadingNewline: false
    };
  }

  if (!hasValidImmediateAppendSessionHeader(sessionFile, fileStats.size)) {
    throw new Error(`Cannot append immediate custom entry: invalid session header in ${sessionFile}`);
  }

  const tailInfo = readLastLineInfo(sessionFile, fileStats.size);
  const parsedLastLine = tailInfo.lastLine ? parseJsonLine(tailInfo.lastLine, sessionFile) : undefined;

  return {
    headerCreated: false,
    parentId: extractParentId(parsedLastLine),
    needsLeadingNewline: !tailInfo.endsWithNewline
  };
}

function buildSessionHeaderLine(cwd: string, now: () => string): string {
  return `${JSON.stringify({
    type: "session",
    version: SESSION_HEADER_VERSION,
    id: randomUUID(),
    timestamp: now(),
    cwd
  })}\n`;
}

function generateSessionEntryId(): string {
  return randomUUID().slice(0, 8);
}

function assignConversationMessageIdIfMissing(event: ConversationEntryEvent, preferredId: string): void {
  if (event.type !== "conversation_message") {
    return;
  }

  if (typeof event.id === "string" && event.id.trim().length > 0) {
    return;
  }

  event.id = preferredId;
}

export function extractSessionEntryId(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null || !("id" in entry)) {
    return undefined;
  }

  const entryId = (entry as { id?: unknown }).id;
  if (typeof entryId !== "string" || entryId.trim().length === 0) {
    return undefined;
  }

  return entryId;
}

export function hasValidSessionHeader(sessionFile: string): boolean {
  if (!existsSync(sessionFile)) {
    return false;
  }

  let fileDescriptor: number | undefined;

  try {
    fileDescriptor = openSync(sessionFile, "r");
    const buffer = Buffer.alloc(FIRST_LINE_CHUNK_BYTES);
    const bytesRead = readSync(fileDescriptor, buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) {
      return false;
    }

    const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n")[0]?.trim();
    if (!firstLine) {
      return false;
    }

    const header = JSON.parse(firstLine) as { type?: string; id?: unknown };
    return header.type === "session" && typeof header.id === "string" && header.id.trim().length > 0;
  } catch {
    return false;
  } finally {
    if (fileDescriptor !== undefined) {
      closeSync(fileDescriptor);
    }
  }
}

function hasValidImmediateAppendSessionHeader(sessionFile: string, fileSize: number): boolean {
  if (!existsSync(sessionFile) || fileSize <= 0) {
    return false;
  }

  const firstLine = readFirstLine(sessionFile, fileSize);
  if (!firstLine) {
    return false;
  }

  try {
    const parsed = JSON.parse(firstLine) as { type?: unknown; id?: unknown; cwd?: unknown };
    return (
      parsed.type === "session" &&
      typeof parsed.id === "string" &&
      parsed.id.trim().length > 0 &&
      typeof parsed.cwd === "string"
    );
  } catch {
    return false;
  }
}

function getSessionFileStats(sessionFile: string): { exists: boolean; size: number } {
  try {
    const stats = statSync(sessionFile);
    return { exists: true, size: stats.size };
  } catch (error) {
    if (isEnoentError(error)) {
      return { exists: false, size: 0 };
    }

    throw error;
  }
}

function isMissingOrEmptySessionFile(sessionFile: string): boolean {
  try {
    return statSync(sessionFile).size === 0;
  } catch (error) {
    if (isEnoentError(error)) {
      return true;
    }

    throw error;
  }
}

function readFirstLine(sessionFile: string, fileSize: number): string | null {
  let fileDescriptor: number | undefined;

  try {
    fileDescriptor = openSync(sessionFile, "r");
    let readOffset = 0;
    let collected = "";

    while (readOffset < fileSize) {
      const nextChunkSize = Math.min(FIRST_LINE_CHUNK_BYTES, fileSize - readOffset);
      const buffer = Buffer.alloc(nextChunkSize);
      const bytesRead = readSync(fileDescriptor, buffer, 0, nextChunkSize, readOffset);
      if (bytesRead <= 0) {
        break;
      }

      collected += buffer.toString("utf8", 0, bytesRead);
      const newlineIndex = collected.indexOf("\n");
      if (newlineIndex >= 0) {
        return collected.slice(0, newlineIndex).replace(/\r$/u, "").trim();
      }

      readOffset += bytesRead;
    }

    return collected.replace(/\r$/u, "").trim() || null;
  } finally {
    if (fileDescriptor !== undefined) {
      closeSync(fileDescriptor);
    }
  }
}

function readLastLineInfo(
  sessionFile: string,
  fileSize: number,
  maxReadBytes = fileSize,
): { lastLine: string | null; endsWithNewline: boolean } {
  let fileDescriptor: number | undefined;

  try {
    fileDescriptor = openSync(sessionFile, "r");
    const lastByteBuffer = Buffer.alloc(1);
    const lastByteRead = readSync(fileDescriptor, lastByteBuffer, 0, 1, fileSize - 1);
    const endsWithNewline = lastByteRead > 0 && lastByteBuffer.toString("utf8", 0, lastByteRead) === "\n";

    let readLength = Math.min(fileSize, TAIL_CHUNK_BYTES);
    while (readLength > 0) {
      const readOffset = Math.max(0, fileSize - readLength);
      const buffer = Buffer.alloc(readLength);
      const bytesRead = readSync(fileDescriptor, buffer, 0, readLength, readOffset);
      if (bytesRead <= 0) {
        return { lastLine: null, endsWithNewline };
      }

      const text = buffer.toString("utf8", 0, bytesRead);
      const trimmed = text.replace(/[\r\n]+$/u, "");
      if (!trimmed) {
        return { lastLine: null, endsWithNewline };
      }

      const lastNewlineIndex = trimmed.lastIndexOf("\n");
      if (lastNewlineIndex >= 0) {
        return {
          lastLine: trimmed.slice(lastNewlineIndex + 1).replace(/\r$/u, ""),
          endsWithNewline
        };
      }

      if (readOffset === 0) {
        return {
          lastLine: trimmed.replace(/\r$/u, ""),
          endsWithNewline
        };
      }

      const readLimit = Math.min(fileSize, maxReadBytes);
      if (readLength >= readLimit) {
        return { lastLine: null, endsWithNewline };
      }

      readLength = Math.min(readLimit, readLength * 2);
    }

    return { lastLine: null, endsWithNewline };
  } finally {
    if (fileDescriptor !== undefined) {
      closeSync(fileDescriptor);
    }
  }
}

function parseJsonLine(line: string, sessionFile: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Session line is not a JSON object");
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Cannot append immediate custom entry: invalid trailing session line in ${sessionFile}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function extractParentId(parsedLastLine: Record<string, unknown> | undefined): string | null {
  if (!parsedLastLine || parsedLastLine.type === "session") {
    return null;
  }

  const entryId = parsedLastLine.id;
  return typeof entryId === "string" && entryId.trim().length > 0 ? entryId : null;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
