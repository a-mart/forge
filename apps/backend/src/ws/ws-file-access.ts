import { readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname } from "node:path";
import { isPathWithinRoots, normalizeAllowlistRoots, resolveDirectoryPath } from "../swarm/cwd-policy.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { resolveReadFileContentType } from "./http-utils.js";

export const MAX_READ_FILE_CONTENT_BYTES = 2 * 1024 * 1024;

export interface FileAccessContext {
  rootDir: string;
  allowedRoots: string[];
}

export interface ApiProxyReadFileResult {
  status: number;
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
}

export function normalizeFileAccessPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (!trimmed) {
    return "";
  }

  if (/^\/+[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed.replace(/^\/+/, "");
  }

  return trimmed;
}

export function resolveReadFileAccessContext(
  swarmManager: SwarmManager,
  agentId?: string,
  options?: { includeCwdAllowlistRootsForAgent?: boolean },
): FileAccessContext {
  const config = swarmManager.getConfig();
  const normalizedAgentId = agentId?.trim();
  const includeCwdAllowlistRootsForAgent = options?.includeCwdAllowlistRootsForAgent ?? true;

  if (!normalizedAgentId) {
    return {
      rootDir: config.paths.rootDir,
      allowedRoots: normalizeAllowlistRoots([
        ...config.cwdAllowlistRoots,
        config.paths.rootDir,
        config.paths.dataDir,
        config.paths.uploadsDir
      ])
    };
  }

  const descriptor = swarmManager.getAgent(normalizedAgentId);
  if (!descriptor) {
    throw new Error(`Unknown agent: ${normalizedAgentId}`);
  }

  const contextualRoots = [descriptor.cwd];
  if (descriptor.role === "worker") {
    const owner = swarmManager.getAgent(descriptor.managerId);
    if (owner?.role === "manager") {
      contextualRoots.push(owner.cwd);
    }
  }

  return {
    rootDir: descriptor.cwd,
    allowedRoots: normalizeAllowlistRoots([
      ...contextualRoots,
      ...(includeCwdAllowlistRootsForAgent ? config.cwdAllowlistRoots : []),
      config.paths.dataDir,
      config.paths.uploadsDir
    ])
  };
}

export function resolveLegacyWriteFileAccessContext(swarmManager: SwarmManager): FileAccessContext {
  const config = swarmManager.getConfig();
  return {
    rootDir: config.paths.rootDir,
    allowedRoots: normalizeAllowlistRoots([
      ...config.cwdAllowlistRoots,
      config.paths.rootDir,
      config.paths.dataDir,
      config.paths.uploadsDir,
      homedir(),
      tmpdir(),
    ])
  };
}

export async function resolvePathWithinRoots(
  requestedPath: string,
  rootDir: string,
  allowedRoots: string[],
): Promise<string> {
  const normalizedRequestedPath = resolveDirectoryPath(requestedPath, rootDir);

  if (await isPathWithinRoots(normalizedRequestedPath, allowedRoots)) {
    return normalizedRequestedPath;
  }

  let existingAncestor = normalizedRequestedPath;
  while (true) {
    try {
      await stat(existingAncestor);
      break;
    } catch {
      const parentPath = dirname(existingAncestor);
      if (parentPath === existingAncestor) {
        break;
      }

      existingAncestor = parentPath;
    }
  }

  if (!(await isPathWithinRoots(existingAncestor, allowedRoots))) {
    throw new Error("Path is outside allowed roots.");
  }

  return normalizedRequestedPath;
}

export function resolveReadFilePath(
  requestedPath: string,
  swarmManager: SwarmManager,
  agentId?: string,
  options?: { includeCwdAllowlistRootsForAgent?: boolean },
): Promise<string> {
  const requestedPathContext = resolveReadFileAccessContext(swarmManager, agentId, options);
  const normalizedRequestedPath = normalizeFileAccessPath(requestedPath);
  return resolvePathWithinRoots(
    normalizedRequestedPath,
    requestedPathContext.rootDir,
    requestedPathContext.allowedRoots,
  );
}

export function resolveLegacyWriteFilePath(requestedPath: string, swarmManager: SwarmManager): Promise<string> {
  const accessContext = resolveLegacyWriteFileAccessContext(swarmManager);
  const normalizedRequestedPath = normalizeFileAccessPath(requestedPath);
  return resolvePathWithinRoots(normalizedRequestedPath, accessContext.rootDir, accessContext.allowedRoots);
}

export async function readApiProxyFile(options: {
  requestedPath: string;
  swarmManager: SwarmManager;
  agentId?: string;
}): Promise<ApiProxyReadFileResult> {
  const { requestedPath, swarmManager, agentId } = options;
  const resolvedPath = await resolveReadFilePath(requestedPath, swarmManager, agentId);

  let fileStats;
  try {
    fileStats = await stat(resolvedPath);
  } catch {
    return {
      status: 404,
      payload: { error: "File not found." }
    };
  }

  if (!fileStats.isFile()) {
    return {
      status: 400,
      payload: { error: "Requested path must point to a file." }
    };
  }

  if (fileStats.size > MAX_READ_FILE_CONTENT_BYTES) {
    return {
      status: 413,
      payload: {
        error: `File is too large. Maximum supported size is ${MAX_READ_FILE_CONTENT_BYTES} bytes.`
      }
    };
  }

  const fileContents = await readFile(resolvedPath);
  const contentType = resolveReadFileContentType(resolvedPath);
  const binary = isLikelyBinary(fileContents) || contentType.startsWith("image/");

  if (binary) {
    return {
      status: 200,
      payload: {
        path: resolvedPath,
        binary: true,
        encoding: "base64",
        contentType,
        content: fileContents.toString("base64")
      },
      headers: {
        "x-read-file-content-type": contentType,
        "x-read-file-content-encoding": "base64"
      }
    };
  }

  return {
    status: 200,
    payload: {
      path: resolvedPath,
      content: fileContents.toString("utf8"),
      contentType
    },
    headers: {
      "x-read-file-content-type": contentType
    }
  };
}

export function isLikelyBinary(content: Buffer): boolean {
  if (content.length === 0) {
    return false;
  }

  const sample = content.subarray(0, 4000);
  let suspiciousChars = 0;

  for (const code of sample) {
    const isAllowedControl = code === 9 || code === 10 || code === 13;
    if (!isAllowedControl && (code < 32 || code === 255)) {
      suspiciousChars += 1;
    }
  }

  return suspiciousChars > 0 && suspiciousChars / sample.length > 0.12;
}
