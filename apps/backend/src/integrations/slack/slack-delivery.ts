import type { ServerEvent } from "@middleman/protocol";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { normalizeManagerId } from "../../utils/normalize.js";
import { SlackWebApiClient } from "./slack-client.js";
import { markdownToSlackMrkdwn } from "./slack-mrkdwn.js";
import type { SlackIntegrationConfig } from "./slack-types.js";

const SLACK_MESSAGE_LIMIT = 4096;

export class SlackDeliveryBridge {
  private readonly swarmManager: SwarmManager;
  private readonly managerId: string;
  private readonly getConfig: () => SlackIntegrationConfig;
  private readonly getProfileId: () => string;
  private readonly getSlackClient: () => SlackWebApiClient | null;
  private readonly onError?: (message: string, error?: unknown) => void;

  private readonly onConversationMessage = (event: ServerEvent): void => {
    if (event.type !== "conversation_message") {
      return;
    }

    void this.forwardConversationMessage(event);
  };

  constructor(options: {
    swarmManager: SwarmManager;
    managerId: string;
    getConfig: () => SlackIntegrationConfig;
    getProfileId: () => string;
    getSlackClient: () => SlackWebApiClient | null;
    onError?: (message: string, error?: unknown) => void;
  }) {
    this.swarmManager = options.swarmManager;
    this.managerId = normalizeManagerId(options.managerId);
    this.getConfig = options.getConfig;
    this.getProfileId = options.getProfileId;
    this.getSlackClient = options.getSlackClient;
    this.onError = options.onError;
  }

  start(): void {
    this.swarmManager.on("conversation_message", this.onConversationMessage);
  }

  stop(): void {
    this.swarmManager.off("conversation_message", this.onConversationMessage);
  }

  private async forwardConversationMessage(event: Extract<ServerEvent, { type: "conversation_message" }>): Promise<void> {
    if (!event.sourceContext || event.sourceContext.channel !== "slack") {
      return;
    }

    if (event.source === "user_input") {
      return;
    }

    const config = this.getConfig();
    if (!config.enabled) {
      return;
    }

    if (event.agentId !== this.managerId) {
      return;
    }

    const eventProfileId = normalizeOptionalString(event.sourceContext.integrationProfileId);
    const profileId = normalizeOptionalString(this.getProfileId());
    if (eventProfileId && profileId && eventProfileId !== profileId) {
      return;
    }

    const slackClient = this.getSlackClient();
    if (!slackClient) {
      return;
    }

    const text = markdownToSlackMrkdwn(event.text);
    if (!text) {
      return;
    }

    const channelId =
      normalizeOptionalString(event.sourceContext.channelId) ??
      (event.sourceContext.userId
        ? await this.resolveDmChannel(slackClient, event.sourceContext.userId)
        : undefined);

    if (!channelId) {
      return;
    }

    const chunks = chunkSlackMessage(text, SLACK_MESSAGE_LIMIT);
    const shouldAutoThread = config.response.respondInThread && !channelId.startsWith("D");
    let threadTs = normalizeOptionalString(event.sourceContext.threadTs);

    for (const chunk of chunks) {
      try {
        const result = await slackClient.postMessage({
          channel: channelId,
          text: chunk,
          threadTs,
          replyBroadcast: threadTs ? config.response.replyBroadcast : false
        });

        if (!threadTs && shouldAutoThread && result.ts) {
          threadTs = result.ts;
        }
      } catch (error) {
        this.onError?.("Failed to deliver Slack message", error);
        return;
      }
    }
  }

  private async resolveDmChannel(slackClient: SlackWebApiClient, userId: string): Promise<string | undefined> {
    const normalizedUserId = normalizeOptionalString(userId);
    if (!normalizedUserId) {
      return undefined;
    }

    try {
      return await slackClient.openDirectMessage(normalizedUserId);
    } catch (error) {
      this.onError?.("Failed to open Slack DM conversation", error);
      return undefined;
    }
  }
}

function chunkSlackMessage(text: string, maxLength: number): string[] {
  const normalized = text.trim();
  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength);
    const newlineIndex = candidate.lastIndexOf("\n");
    const spaceIndex = candidate.lastIndexOf(" ");
    const splitIndex = Math.max(newlineIndex, spaceIndex);
    const chunkLength = splitIndex > maxLength * 0.6 ? splitIndex : maxLength;

    const chunk = remaining.slice(0, chunkLength).trim();
    if (chunk.length === 0) {
      break;
    }

    chunks.push(chunk);
    remaining = remaining.slice(chunkLength).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
