import { lstat, opendir } from "node:fs/promises";
import { join, relative } from "node:path";
import { getProjectForgeReferenceDir } from "./data-paths.js";

export interface RepositoryReferenceDocInventory {
  rootDir: string;
  files: string[];
  truncated: boolean;
}

interface ReferenceDocTraversalState {
  files: string[];
  entriesScanned: number;
  truncated: boolean;
}

export async function listRepositoryReferenceDocs(
  forgeDir: string,
  options: { maxFiles?: number; maxEntries?: number } = {}
): Promise<RepositoryReferenceDocInventory> {
  const rootDir = getProjectForgeReferenceDir(forgeDir);
  const maxFiles = Math.max(0, options.maxFiles ?? 100);
  const maxEntries = Math.max(0, options.maxEntries ?? 1000);
  const state: ReferenceDocTraversalState = { files: [], entriesScanned: 0, truncated: false };
  await collectMarkdownFiles(rootDir, rootDir, state, { maxFiles, maxEntries });
  state.files.sort((left, right) => left.localeCompare(right));
  return { rootDir, files: state.files.slice(0, maxFiles), truncated: state.truncated || state.files.length > maxFiles };
}

async function collectMarkdownFiles(
  rootDir: string,
  currentDir: string,
  state: ReferenceDocTraversalState,
  limits: { maxFiles: number; maxEntries: number }
): Promise<void> {
  if (state.files.length > limits.maxFiles || state.entriesScanned >= limits.maxEntries) {
    state.truncated = true;
    return;
  }

  let directory;
  try {
    directory = await opendir(currentDir);
  } catch {
    return;
  }

  const entries = [];
  try {
    for await (const entry of directory) {
      if (state.entriesScanned >= limits.maxEntries) {
        state.truncated = true;
        break;
      }
      state.entriesScanned += 1;
      entries.push(entry);
      if (state.files.length > limits.maxFiles) {
        state.truncated = true;
        break;
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (state.files.length > limits.maxFiles || state.entriesScanned > limits.maxEntries) {
      state.truncated = true;
      return;
    }
    const path = join(currentDir, entry.name);
    const stats = await lstat(path).catch(() => null);
    if (!stats || stats.isSymbolicLink()) {
      continue;
    }
    if (stats.isDirectory()) {
      await collectMarkdownFiles(rootDir, path, state, limits);
      continue;
    }
    if (!stats.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }
    state.files.push(relative(rootDir, path));
  }
}
