import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isEnoentError } from "../../utils/fs-errors.js";
import { MAX_LINE_BYTES } from "./content-policy.js";
import {
  MAX_GENERATION_SCAN_BYTES,
  MAX_JSONL_CHUNK_BYTES,
  type JsonlCompleteLine,
  type JsonlScanResult,
} from "./types.js";

export interface SourceFileStat {
  size: number;
  mtimeMs: number;
  ino: string;
}

export interface JsonlLineRead extends JsonlCompleteLine {
  oversized: boolean;
}

export function readSourceStat(path: string): SourceFileStat | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      return undefined;
    }
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ino: String(stat.ino),
    };
  } catch (error) {
    if (isEnoentError(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Append-safe replacement identity: inode + header + first body line. Appends do not change it. */
export function readPrefixTailHash(path: string, prefixBytes: number): string {
  const hash = createHash("sha256");
  if (prefixBytes <= 0) {
    return hash.digest("base64url");
  }
  const descriptor = openSync(path, "r");
  try {
    const length = Math.min(256, prefixBytes);
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(descriptor, buffer, 0, length, prefixBytes - length);
    hash.update(buffer.subarray(0, bytesRead));
    return hash.digest("base64url");
  } finally {
    closeSync(descriptor);
  }
}

export function readSourceGeneration(path: string, stat: SourceFileStat): string {
  const hash = createHash("sha256");
  hash.update(stat.ino);
  hash.update("\n");
  if (stat.size <= 0) {
    return hash.digest("base64url");
  }
  const descriptor = openSync(path, "r");
  try {
    const length = Math.min(MAX_GENERATION_SCAN_BYTES, stat.size);
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(descriptor, buffer, 0, length, 0);
    const readable = buffer.subarray(0, bytesRead);
    const firstNewline = readable.indexOf(0x0a);
    if (firstNewline < 0) {
      hash.update(readable);
      return hash.digest("base64url");
    }
    hash.update(readable.subarray(0, firstNewline));
    hash.update("\n");
    const rest = readable.subarray(firstNewline + 1);
    const secondNewline = rest.indexOf(0x0a);
    if (secondNewline < 0) {
      hash.update(rest);
      return hash.digest("base64url");
    }
    const body = rest.subarray(0, secondNewline);
    hash.update(body.length > MAX_LINE_BYTES ? body.subarray(0, MAX_LINE_BYTES) : body);
    return hash.digest("base64url");
  } finally {
    closeSync(descriptor);
  }
}

export function* iterateCompleteLines(
  path: string,
  startOffset: number,
  endOffset: number,
  maxBytes: number,
  options?: { resumeSkippingOversized?: boolean },
): Generator<JsonlCompleteLine, Omit<JsonlScanResult, "lines">> {
  const descriptor = openSync(path, "r");
  let offset = Math.max(0, startOffset);
  let scannedBytes = 0;
  let remainder = Buffer.alloc(0);
  let incomplete = false;
  let skippingOversized = Boolean(options?.resumeSkippingOversized);
  let skippedOversized = skippingOversized;
  try {
    while (offset < endOffset) {
      const remainingBudget = maxBytes - scannedBytes;
      const probeExactCap = !skippingOversized && remainingBudget <= 0 && remainder.length === MAX_LINE_BYTES;
      if (remainingBudget <= 0 && !probeExactCap) {
        break;
      }
      const toRead = Math.min(
        MAX_JSONL_CHUNK_BYTES,
        endOffset - offset,
        probeExactCap ? 1 : remainingBudget,
      );
      if (toRead <= 0) {
        break;
      }
      const chunk = Buffer.allocUnsafe(toRead);
      const bytesRead = readSync(descriptor, chunk, 0, toRead, offset);
      if (bytesRead <= 0) {
        break;
      }
      scannedBytes += bytesRead;
      offset += bytesRead;
      const data = bytesRead === toRead ? chunk : chunk.subarray(0, bytesRead);

      if (skippingOversized) {
        const newline = data.indexOf(0x0a);
        if (newline < 0) {
          incomplete = true;
          continue;
        }
        skippingOversized = false;
        remainder = data.subarray(newline + 1);
      } else {
        remainder = remainder.length > 0 ? Buffer.concat([remainder, data]) : data;
      }

      let start = 0;
      while (start < remainder.length) {
        const newline = remainder.indexOf(0x0a, start);
        if (newline < 0) {
          break;
        }
        const lineBytes = remainder.subarray(start, newline);
        const byteOffset = offset - (remainder.length - start);
        if (lineBytes.length > MAX_LINE_BYTES) {
          skippedOversized = true;
          incomplete = true;
        } else if (lineBytes.length > 0) {
          yield {
            byteOffset,
            nextOffset: byteOffset + lineBytes.length + 1,
            line: lineBytes.toString("utf8"),
          };
        }
        start = newline + 1;
      }
      remainder = remainder.subarray(start);

      if (remainder.length > MAX_LINE_BYTES) {
        skippedOversized = true;
        incomplete = true;
        skippingOversized = true;
        remainder = Buffer.alloc(0);
      }
    }
  } finally {
    closeSync(descriptor);
  }
  if (remainder.length > 0 || skippingOversized || offset < endOffset) {
    incomplete = true;
  }
  const consumedRemainder = skippingOversized ? 0 : remainder.length;
  return {
    nextOffset: offset - consumedRemainder,
    incomplete,
    scannedBytes,
    skippedOversized,
    skippingOversized,
  };
}

export function readCompleteLines(
  path: string,
  startOffset: number,
  endOffset: number,
  maxBytes: number,
  options?: { resumeSkippingOversized?: boolean },
): JsonlScanResult {
  const lines: JsonlCompleteLine[] = [];
  const iterator = iterateCompleteLines(path, startOffset, endOffset, maxBytes, options);
  let result = iterator.next();
  while (!result.done) {
    lines.push(result.value);
    result = iterator.next();
  }
  return { lines, ...result.value };
}

export function readLineAt(path: string, byteOffset: number): JsonlLineRead | undefined {
  const stat = readSourceStat(path);
  if (!stat || byteOffset < 0 || byteOffset >= stat.size) {
    return undefined;
  }
  const descriptor = openSync(path, "r");
  try {
    if (byteOffset > 0) {
      const previous = Buffer.alloc(1);
      if (readSync(descriptor, previous, 0, 1, byteOffset - 1) !== 1 || previous[0] !== 10) return undefined;
    }
    let offset = byteOffset;
    let collected = Buffer.alloc(0);
    while (offset < stat.size && collected.length <= MAX_LINE_BYTES) {
      const toRead = Math.min(MAX_JSONL_CHUNK_BYTES, stat.size - offset, MAX_LINE_BYTES + 1 - collected.length);
      const chunk = Buffer.allocUnsafe(toRead);
      const bytesRead = readSync(descriptor, chunk, 0, toRead, offset);
      if (bytesRead <= 0) {
        break;
      }
      offset += bytesRead;
      const data = bytesRead === toRead ? chunk : chunk.subarray(0, bytesRead);
      const newline = data.indexOf(0x0a);
      if (newline >= 0) {
        const lineBytes = Buffer.concat([collected, data.subarray(0, newline)]);
        if (lineBytes.length > MAX_LINE_BYTES) {
          return { byteOffset, nextOffset: offset - (data.length - newline) + 1, line: "", oversized: true };
        }
        return {
          byteOffset,
          nextOffset: byteOffset + lineBytes.length + 1,
          line: lineBytes.toString("utf8"),
          oversized: false,
        };
      }
      collected = Buffer.concat([collected, data]);
    }
    if (collected.length > MAX_LINE_BYTES) {
      return { byteOffset, nextOffset: offset, line: "", oversized: true };
    }
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}
