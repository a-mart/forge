import { randomUUID } from "node:crypto";
import { mkdir, open as openFile } from "node:fs/promises";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SESSION_HEADER_VERSION = 3;
const FIRST_LINE_CHUNK_BYTES = 512;
const TAIL_CHUNK_BYTES = 8192;

export interface ImmediateCustomEntryWriteOptions {
  sessionFile: string;
  cwd: string;
  customType: string;
  data?: unknown;
  now?: () => string;
}

export interface ImmediateCustomEntryWriteResult {
  sessionFile: string;
  entryId: string;
  parentId: string | null;
  headerCreated: boolean;
}

export async function appendImmediateCustomEntry(
  options: ImmediateCustomEntryWriteOptions
): Promise<ImmediateCustomEntryWriteResult> {
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

function inspectSessionFileForAppend(sessionFile: string): SessionFileAppendInspection {
  const fileStats = getSessionFileStats(sessionFile);
  if (!fileStats.exists || fileStats.size === 0) {
    return {
      headerCreated: true,
      parentId: null,
      needsLeadingNewline: false
    };
  }

  if (!hasValidSessionHeader(sessionFile, fileStats.size)) {
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

function hasValidSessionHeader(sessionFile: string, fileSize: number): boolean {
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

function readLastLineInfo(sessionFile: string, fileSize: number): { lastLine: string | null; endsWithNewline: boolean } {
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

      if (readLength >= fileSize) {
        throw new Error(`Cannot determine last session line for ${sessionFile}`);
      }

      readLength = Math.min(fileSize, readLength * 2);
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

function extractParentId(entry: Record<string, unknown> | undefined): string | null {
  if (!entry || entry.type === "session") {
    return null;
  }

  return typeof entry.id === "string" && entry.id.trim().length > 0 ? entry.id : null;
}

function generateSessionEntryId(): string {
  return randomUUID().slice(0, 8);
}

function isEnoentError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
