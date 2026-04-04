import { join } from "node:path";
import { getSessionDir, getSharedDir, getWorkersDir, sanitizePathSegment } from "./data-paths.js";

export function claudeConfigDir(forgeDataDir: string): string {
  return join(getSharedDir(forgeDataDir), "claude-sdk");
}

export function claudeSessionDir(forgeDataDir: string, profileId: string, sessionId: string): string {
  return join(getSessionDir(forgeDataDir, profileId, sessionId), "claude");
}

export function claudeWorkerDir(
  forgeDataDir: string,
  profileId: string,
  sessionId: string,
  workerId: string
): string {
  return join(getWorkersDir(forgeDataDir, profileId, sessionId), sanitizePathSegment(workerId), "claude");
}
