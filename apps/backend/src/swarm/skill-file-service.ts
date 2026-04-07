import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, win32 } from "node:path";
import { isPathWithinRoots } from "./cwd-policy.js";
import type { SkillMetadata } from "./skill-metadata-service.js";

const BINARY_SNIFF_BYTES = 8 * 1024;
const MAX_FILE_CONTENT_BYTES = 2 * 1024 * 1024;
const FILTERED_ENTRY_NAMES = new Set([".DS_Store", "node_modules", ".git"]);

export interface SkillFileEntry {
  name: string;
  path: string;
  absolutePath: string;
  type: "file" | "directory";
  size?: number;
  extension?: string;
}

export interface SkillFileListResult {
  skillId: string;
  rootPath: string;
  path: string;
  entries: SkillFileEntry[];
}

export interface SkillFileContentResult {
  path: string;
  absolutePath: string;
  content: string | null;
  binary: boolean;
  size: number;
  lines?: number;
}

export class SkillFileService {
  async listDirectory(skill: SkillMetadata, relativePath: string): Promise<SkillFileListResult> {
    const normalizedRelativePath = normalizeRelativeSkillPath(relativePath, { allowEmpty: true });
    const resolvedPath = await this.resolvePathWithinSkillRoot(skill.rootPath, normalizedRelativePath);

    let directoryStats;
    try {
      directoryStats = await stat(resolvedPath);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        throw new Error("Directory not found.");
      }

      if (isErrorCode(error, "EACCES") || isErrorCode(error, "EPERM")) {
        throw new Error("Directory is not readable.");
      }

      throw error;
    }

    if (!directoryStats.isDirectory()) {
      throw new Error("Requested path must be a directory.");
    }

    let dirEntries;
    try {
      dirEntries = await readdir(resolvedPath, { withFileTypes: true });
    } catch (error) {
      if (isErrorCode(error, "EACCES") || isErrorCode(error, "EPERM")) {
        throw new Error("Directory is not readable.");
      }

      throw error;
    }

    const entries = (
      await Promise.all(
        dirEntries.map(async (entry) => this.toDirectoryEntry({
          entry,
          parentDir: resolvedPath,
          skillRoot: skill.rootPath
        }))
      )
    ).filter((entry): entry is SkillFileEntry => entry !== null);

    entries.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "directory" ? -1 : 1;
      }

      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });

    return {
      skillId: skill.skillId,
      rootPath: skill.rootPath,
      path: normalizedRelativePath,
      entries
    };
  }

  async getFileContent(skill: SkillMetadata, relativePath: string): Promise<SkillFileContentResult> {
    const normalizedRelativePath = normalizeRelativeSkillPath(relativePath, { allowEmpty: false });
    const resolvedPath = await this.resolvePathWithinSkillRoot(skill.rootPath, normalizedRelativePath);

    let fileStats;
    try {
      fileStats = await stat(resolvedPath);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        throw new Error("File not found.");
      }

      if (isErrorCode(error, "EACCES") || isErrorCode(error, "EPERM")) {
        throw new Error("File is not readable.");
      }

      throw error;
    }

    if (!fileStats.isFile()) {
      throw new Error("Requested path must point to a file.");
    }

    if (fileStats.size > MAX_FILE_CONTENT_BYTES) {
      throw new Error(`File too large (${fileStats.size} bytes). Exceeds ${MAX_FILE_CONTENT_BYTES} byte limit.`);
    }

    const contentBuffer = await readFile(resolvedPath);
    const sample = contentBuffer.subarray(0, Math.min(contentBuffer.length, BINARY_SNIFF_BYTES));
    if (sample.includes(0)) {
      return {
        path: normalizedRelativePath,
        absolutePath: resolvedPath,
        content: null,
        binary: true,
        size: contentBuffer.byteLength
      };
    }

    const content = contentBuffer.toString("utf8");
    return {
      path: normalizedRelativePath,
      absolutePath: resolvedPath,
      content,
      binary: false,
      size: contentBuffer.byteLength,
      lines: content.length === 0 ? 0 : content.split(/\r?\n/).length
    };
  }

  private async resolvePathWithinSkillRoot(skillRoot: string, relativePath: string): Promise<string> {
    const requested = relativePath.length > 0 ? relativePath : ".";
    const resolvedPath = resolve(skillRoot, requested);
    const isWithin = await isPathWithinRoots(resolvedPath, [skillRoot]);
    if (!isWithin) {
      throw new Error("Path is outside skill root.");
    }

    return resolvedPath;
  }

  private async toDirectoryEntry(options: {
    entry: { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean };
    parentDir: string;
    skillRoot: string;
  }): Promise<SkillFileEntry | null> {
    const { entry, parentDir, skillRoot } = options;
    const name = entry.name;

    if (FILTERED_ENTRY_NAMES.has(name)) {
      return null;
    }

    const absolutePath = resolve(parentDir, name);

    if (entry.isSymbolicLink()) {
      return this.resolveSymlinkEntry(absolutePath, skillRoot);
    }

    if (entry.isDirectory()) {
      return {
        name,
        path: toRelativeSkillPath(skillRoot, absolutePath),
        absolutePath,
        type: "directory"
      };
    }

    if (entry.isFile()) {
      try {
        const fileStats = await stat(absolutePath);
        if (!fileStats.isFile()) {
          return null;
        }

        return {
          name,
          path: toRelativeSkillPath(skillRoot, absolutePath),
          absolutePath,
          type: "file",
          size: fileStats.size,
          extension: toFileExtension(name)
        };
      } catch (error) {
        if (isErrorCode(error, "EACCES") || isErrorCode(error, "EPERM") || isErrorCode(error, "ENOENT")) {
          return null;
        }

        throw error;
      }
    }

    return null;
  }

  private async resolveSymlinkEntry(absolutePath: string, skillRoot: string): Promise<SkillFileEntry | null> {
    let targetStats;
    try {
      targetStats = await stat(absolutePath);
    } catch (error) {
      if (isErrorCode(error, "ENOENT") || isErrorCode(error, "EACCES") || isErrorCode(error, "EPERM")) {
        return null;
      }

      throw error;
    }

    let resolvedTarget;
    try {
      resolvedTarget = await realpath(absolutePath);
    } catch {
      return null;
    }

    const isWithin = await isPathWithinRoots(resolvedTarget, [skillRoot]);
    if (!isWithin) {
      return null;
    }

    const name = basename(absolutePath);
    if (targetStats.isDirectory()) {
      return {
        name,
        path: toRelativeSkillPath(skillRoot, absolutePath),
        absolutePath,
        type: "directory"
      };
    }

    if (!targetStats.isFile()) {
      return null;
    }

    return {
      name,
      path: toRelativeSkillPath(skillRoot, absolutePath),
      absolutePath,
      type: "file",
      size: targetStats.size,
      extension: toFileExtension(name)
    };
  }
}

function normalizeRelativeSkillPath(
  pathValue: string,
  options: { allowEmpty: boolean }
): string {
  const trimmed = pathValue.trim();
  if (!trimmed || trimmed === ".") {
    if (options.allowEmpty) {
      return "";
    }

    throw new Error("path must be a non-empty relative path.");
  }

  if (isAbsolute(trimmed) || win32.isAbsolute(trimmed) || /^\/+[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new Error("path must be a relative path.");
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    if (options.allowEmpty) {
      return "";
    }

    throw new Error("path must be a non-empty relative path.");
  }

  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Path traversal is not allowed.");
  }

  return segments.join("/");
}

function toRelativeSkillPath(skillRoot: string, absolutePath: string): string {
  return relative(skillRoot, absolutePath).replace(/\\/g, "/");
}

function toFileExtension(name: string): string | undefined {
  const extension = extname(name);
  if (!extension || extension.length <= 1) {
    return undefined;
  }

  return extension.slice(1).toLowerCase();
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}
