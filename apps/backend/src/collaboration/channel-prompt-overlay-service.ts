import { rm } from "node:fs/promises";
import { readPromptFile, writePromptFile } from "../swarm/storage/asset-root-storage.js";
import { getSessionContextPromptPath } from "../swarm/storage/data-paths.js";
import type { CollaborationDbHelpers } from "./collab-db-helpers.js";
import { CollaborationChannelServiceError } from "./channel-service.js";
import { COLLABORATION_PROFILE_ID } from "./constants.js";

export class ChannelPromptOverlayService {
  constructor(
    private readonly dbHelpers: Pick<CollaborationDbHelpers, "getChannel">,
    private readonly dataDir: string,
  ) {}

  async getPromptOverlay(channelId: string): Promise<string | null> {
    const record = this.requireChannel(channelId);
    const promptOverlay = (await readPromptFile(this.getPromptPath(record.backingSessionAgentId)))?.trim() ?? "";
    return promptOverlay || null;
  }

  async setPromptOverlay(channelId: string, content: string | null): Promise<void> {
    const record = this.requireChannel(channelId);
    const promptPath = this.getPromptPath(record.backingSessionAgentId);
    const normalizedContent = content?.trim() ?? "";

    if (!normalizedContent) {
      await rm(promptPath, { force: true });
      return;
    }

    await writePromptFile(promptPath, normalizedContent);
  }

  private requireChannel(channelId: string) {
    const normalizedChannelId = channelId.trim();
    if (!normalizedChannelId) {
      throw new Error("channelId must be a non-empty string");
    }

    const record = this.dbHelpers.getChannel(normalizedChannelId);
    if (!record) {
      throw new CollaborationChannelServiceError(
        "not_found",
        `Unknown collaboration channel: ${normalizedChannelId}`,
      );
    }

    return record;
  }

  private getPromptPath(backingSessionAgentId: string): string {
    return getSessionContextPromptPath(
      this.dataDir,
      COLLABORATION_PROFILE_ID,
      backingSessionAgentId,
    );
  }
}
