import { join } from "node:path";
import { PINNED_MESSAGES_FILE_NAME } from "./message-pins.js";
import {
  getSessionDir,
  getSessionFeedbackPath,
  getSessionFilePath,
  getSessionMemoryPath,
  getSessionMetaPath,
  getWorkerSessionFilePath,
  getWorkersDir
} from "../data-paths.js";

export interface SessionWorkspace {
  readonly dataDir: string;
  readonly profileId: string;
  readonly sessionAgentId: string;
  readonly sessionDir: string;
  readonly sessionFilePath: string;
  readonly memoryPath: string;
  readonly metaPath: string;
  readonly feedbackPath: string;
  readonly workersDir: string;
  readonly pinnedMessagesPath: string;
  workerSessionFilePath(workerId: string): string;
}

/**
 * Session-scoped filesystem view for ordinary chat/session sidecars.
 *
 * Terminal paths are intentionally excluded. Current terminal persistence is
 * profile/root-session scoped and should be reached via ProfileWorkspace.
 */
export function createSessionWorkspace(dataDir: string, profileId: string, sessionAgentId: string): SessionWorkspace {
  const sessionDir = getSessionDir(dataDir, profileId, sessionAgentId);

  return {
    dataDir,
    profileId,
    sessionAgentId,
    sessionDir,
    sessionFilePath: getSessionFilePath(dataDir, profileId, sessionAgentId),
    memoryPath: getSessionMemoryPath(dataDir, profileId, sessionAgentId),
    metaPath: getSessionMetaPath(dataDir, profileId, sessionAgentId),
    feedbackPath: getSessionFeedbackPath(dataDir, profileId, sessionAgentId),
    workersDir: getWorkersDir(dataDir, profileId, sessionAgentId),
    pinnedMessagesPath: join(sessionDir, PINNED_MESSAGES_FILE_NAME),
    workerSessionFilePath(workerId: string): string {
      return getWorkerSessionFilePath(dataDir, profileId, sessionAgentId, workerId);
    }
  };
}
