import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { getProjectForgeReferenceDir } from "./data-paths.js";

export interface RepositoryReferenceDocInventory {
  rootDir: string;
  files: string[];
  truncated: boolean;
}

export async function listRepositoryReferenceDocs(
  forgeDir: string,
  options: { maxFiles?: number } = {}
): Promise<RepositoryReferenceDocInventory> {
  const rootDir = getProjectForgeReferenceDir(forgeDir);
  const maxFiles = options.maxFiles ?? 100;
  const files: string[] = [];
  await collectMarkdownFiles(rootDir, rootDir, files);
  files.sort((left, right) => left.localeCompare(right));
  return { rootDir, files: files.slice(0, maxFiles), truncated: files.length > maxFiles };
}

async function collectMarkdownFiles(rootDir: string, currentDir: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(currentDir, entry.name);
    const stats = await lstat(path).catch(() => null);
    if (!stats || stats.isSymbolicLink()) {
      continue;
    }
    if (stats.isDirectory()) {
      await collectMarkdownFiles(rootDir, path, files);
      continue;
    }
    if (!stats.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }
    files.push(relative(rootDir, path));
  }
}
