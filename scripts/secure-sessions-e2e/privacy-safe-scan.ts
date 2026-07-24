import { Buffer } from "node:buffer";
import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

export interface PrivacySafeScanEntry {
  readonly path: string;
  readonly matchCount: number;
}

export interface PrivacySafeScanReport {
  readonly scannedFileCount: number;
  readonly totalMatches: number;
  /**
   * Deliberately contains only caller-supplied paths and aggregate counts.
   * It never includes matching bytes, snippets, offsets, or needle labels.
   */
  readonly matches: readonly PrivacySafeScanEntry[];
}

export interface NamedBytes {
  readonly path: string;
  readonly bytes: Uint8Array;
}

function countMatches(haystack: Uint8Array, needles: readonly Uint8Array[]): number {
  const ownedHaystack = Buffer.from(haystack);
  let count = 0;
  try {
    for (const needleValue of needles) {
      const needle = Buffer.from(needleValue);
      try {
        if (needle.byteLength === 0) {
          continue;
        }
        let offset = 0;
        while (offset <= ownedHaystack.byteLength - needle.byteLength) {
          const found = ownedHaystack.indexOf(needle, offset);
          if (found < 0) {
            break;
          }
          count += 1;
          offset = found + needle.byteLength;
        }
      } finally {
        needle.fill(0);
      }
    }
    return count;
  } finally {
    ownedHaystack.fill(0);
  }
}

export function scanNamedBytes(
  entries: readonly NamedBytes[],
  needles: readonly Uint8Array[],
): PrivacySafeScanReport {
  const matches: PrivacySafeScanEntry[] = [];
  let totalMatches = 0;

  for (const entry of entries) {
    const matchCount = countMatches(entry.bytes, needles);
    totalMatches += matchCount;
    if (matchCount > 0) {
      matches.push({ path: entry.path, matchCount });
    }
  }

  return {
    scannedFileCount: entries.length,
    totalMatches,
    matches,
  };
}

async function collectFiles(root: string, current: string, files: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = resolve(current, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      continue;
    }
    if (metadata.isDirectory()) {
      await collectFiles(root, path, files);
      continue;
    }
    if (metadata.isFile()) {
      files.push(relative(root, path) || entry.name);
    }
  }
}

export async function scanDirectory(
  root: string,
  needles: readonly Uint8Array[],
): Promise<PrivacySafeScanReport> {
  const canonicalRoot = resolve(root);
  const files: string[] = [];
  await collectFiles(canonicalRoot, canonicalRoot, files);
  const entries: NamedBytes[] = [];
  for (const path of files) {
    entries.push({
      path,
      bytes: await readFile(resolve(canonicalRoot, path)),
    });
  }
  try {
    return scanNamedBytes(entries, needles);
  } finally {
    for (const entry of entries) {
      entry.bytes.fill(0);
    }
  }
}

export function canaryNeedles(canary: Uint8Array): Buffer[] {
  const raw = Buffer.from(canary);
  const text = raw.toString("utf8");
  const base64 = raw.toString("base64");
  const base64Url = raw.toString("base64url");
  const candidates = [
    Buffer.from(raw),
    Buffer.from(base64),
    Buffer.from(base64.replace(/=+$/u, "")),
    Buffer.from(base64Url),
    Buffer.from(
      base64Url.padEnd(Math.ceil(base64Url.length / 4) * 4, "="),
    ),
    Buffer.from(raw.toString("hex")),
    Buffer.from(raw.toString("hex").toUpperCase()),
    Buffer.from(encodeURIComponent(text)),
    Buffer.from(JSON.stringify(text).slice(1, -1)),
  ];

  const unique: Buffer[] = [];
  for (const candidate of candidates) {
    if (!unique.some((existing) => existing.equals(candidate))) {
      unique.push(candidate);
    } else {
      candidate.fill(0);
    }
  }
  raw.fill(0);
  return unique;
}
