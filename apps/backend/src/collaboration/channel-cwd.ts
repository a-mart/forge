import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getSessionDir } from "../swarm/data-paths.js";
import { COLLABORATION_PROFILE_ID } from "./constants.js";

const COLLABORATION_CHANNEL_SESSION_ID_PREFIX = "collab-channel-";
const COLLABORATION_CHANNEL_WORKSPACE_DIRNAME = "workspace";

export function createCollaborationChannelSessionAgentId(): string {
  return `${COLLABORATION_CHANNEL_SESSION_ID_PREFIX}${randomUUID()}`;
}

export function getCollaborationChannelWorkingDir(dataDir: string, sessionAgentId: string): string {
  return join(
    getSessionDir(dataDir, COLLABORATION_PROFILE_ID, sessionAgentId),
    COLLABORATION_CHANNEL_WORKSPACE_DIRNAME,
  );
}

export async function ensureCollaborationChannelWorkingDir(
  dataDir: string,
  sessionAgentId: string,
): Promise<string> {
  const cwd = getCollaborationChannelWorkingDir(dataDir, sessionAgentId);
  await mkdir(cwd, { recursive: true });
  return cwd;
}
