import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { AgentDescriptor } from "../../types.js";

export function normalizeDescriptorPaths(descriptor: AgentDescriptor, dataDir: string): AgentDescriptor {
  const normalizedDataDir = resolve(dataDir);
  const legacyDataDirCandidates = resolveLegacyDataDirCandidatesForCurrentDataDir(normalizedDataDir);
  if (legacyDataDirCandidates.length === 0) {
    return descriptor;
  }

  const normalizedSessionFile = resolve(descriptor.sessionFile);

  for (const legacyDataDir of legacyDataDirCandidates) {
    if (!isPathWithinDirectory(normalizedSessionFile, legacyDataDir)) {
      continue;
    }

    const relativeSessionPath = normalizedSessionFile.slice(legacyDataDir.length).replace(/^[/\\]+/, "");
    if (!relativeSessionPath) {
      continue;
    }

    if (relativeSessionPath === ".." || relativeSessionPath.startsWith(`..${sep}`)) {
      continue;
    }

    const rewrittenSessionFile = resolve(normalizedDataDir, relativeSessionPath);
    if (rewrittenSessionFile === descriptor.sessionFile) {
      return descriptor;
    }

    return {
      ...descriptor,
      sessionFile: rewrittenSessionFile
    };
  }

  return descriptor;
}

export function resolveLegacyDataDirCandidatesForCurrentDataDir(dataDir: string): string[] {
  const normalized = dataDir.toLowerCase();
  const candidates: string[] = [];

  if (normalized.endsWith(`${sep}.forge`)) {
    candidates.push(`${dataDir.slice(0, -".forge".length)}.middleman`);
  }

  if (normalized.endsWith(`${sep}forge`)) {
    candidates.push(`${dataDir.slice(0, -"forge".length)}middleman`);

    if (process.platform === "win32") {
      candidates.push(resolve(homedir(), ".middleman"));
    }
  }

  return [...new Set(candidates.map((candidate) => resolve(candidate)))];
}

function isPathWithinDirectory(pathValue: string, directoryPath: string): boolean {
  return pathValue === directoryPath || pathValue.startsWith(`${directoryPath}${sep}`);
}
