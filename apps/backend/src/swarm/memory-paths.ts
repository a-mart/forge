import {
  getLegacyAgentMemoryPath,
  getLegacyMemoryDirPath
} from "./data-paths.js";

/** @deprecated Use data-paths.ts helpers instead. */
export function getMemoryDirPath(dataDir: string): string {
  return getLegacyMemoryDirPath(dataDir);
}

/** @deprecated Use resolveMemoryFilePath() in data-paths.ts instead. */
export function getAgentMemoryPath(dataDir: string, agentId: string): string {
  return getLegacyAgentMemoryPath(dataDir, agentId);
}
