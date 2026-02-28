import type { SwarmManager } from "../../swarm/swarm-manager.js";
import type {
  ConversationAttachment,
  MessageSourceContext
} from "../../swarm/types.js";
import { normalizeManagerId } from "../../utils/normalize.js";
import { stripBotMention } from "./slack-heuristics.js";
import { SlackWebApiClient } from "./slack-client.js";
import type {
  SlackAppMentionEvent,
  SlackEventsApiBody,
  SlackFileDescriptor,
  SlackIntegrationConfig,
  SlackMessageEvent,
  SlackSocketEnvelope
} from "./slack-types.js";

const IGNORED_MESSAGE_SUBTYPES = new Set([
  "message_changed",
  "message_deleted",
  "thread_broadcast",
  "reply_broadcast",
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name"
]);

const DEDUPE_TTL_MS = 30 * 60 * 1000;

export class SlackInboundRouter {
  private readonly swarmManager: SwarmManager;
  private readonly managerId: string;
  private readonly integrationProfileId: string;
  private readonly slackClient: SlackWebApiClient;
  private readonly getConfig: () => SlackIntegrationConfig;
  private readonly getBotUserId: () => string | undefined;
  private readonly onError?: (message: string, error?: unknown) => void;
  private readonly seenEventKeys = new Map<string, number>();

  constructor(options: {
    swarmManager: SwarmManager;
    managerId: string;
    integrationProfileId: string;
    slackClient: SlackWebApiClient;
    getConfig: () => SlackIntegrationConfig;
    getBotUserId: () => string | undefined;
    onError?: (message: string, error?: unknown) => void;
  }) {
    this.swarmManager = options.swarmManager;
    this.managerId = normalizeManagerId(options.managerId);
    this.integrationProfileId = options.integrationProfileId.trim();
    this.slackClient = options.slackClient;
    this.getConfig = options.getConfig;
    this.getBotUserId = options.getBotUserId;
    this.onError = options.onError;
  }

  async handleEnvelope(envelope: SlackSocketEnvelope): Promise<void> {
    if (envelope.type !== "events_api") {
      return;
    }

    const body = asEventsApiBody(envelope.body);
    if (!body.event) {
      return;
    }

    const dedupeKey = buildDedupeKey(body);
    if (dedupeKey && this.isDuplicate(dedupeKey)) {
      return;
    }

    if (isSlackMessageEvent(body.event)) {
      await this.handleMessageEvent(body.event, body);
      return;
    }

    if (isSlackAppMentionEvent(body.event)) {
      await this.handleAppMentionEvent(body.event, body);
      return;
    }
  }

  private async handleMessageEvent(event: SlackMessageEvent, body: SlackEventsApiBody): Promise<void> {
    const botUserId = this.getBotUserId();
    if (this.shouldIgnoreMessageEvent(event, botUserId)) {
      return;
    }

    const config = this.getConfig();
    const channelType = resolveChannelType(event.channel_type, event.channel);
    if (channelType === "dm") {
      if (!config.listen.dm) {
        return;
      }
    } else {
      if (!this.isChannelAllowed(event.channel, channelType, config)) {
        return;
      }
    }

    await this.forwardToSwarm({
      eventType: "message",
      body,
      channel: event.channel,
      channelType,
      userId: event.user,
      text: event.text,
      ts: event.ts,
      threadTs: event.thread_ts,
      files: event.files,
      stripMention: false
    });
  }

  private async handleAppMentionEvent(event: SlackAppMentionEvent, body: SlackEventsApiBody): Promise<void> {
    const botUserId = this.getBotUserId();
    if (this.shouldIgnoreMentionEvent(event, botUserId)) {
      return;
    }

    const config = this.getConfig();
    const channelType = resolveChannelType(undefined, event.channel);

    if (channelType !== "dm") {
      if (!this.isChannelAllowed(event.channel, channelType, config)) {
        return;
      }
    }

    await this.forwardToSwarm({
      eventType: "app_mention",
      body,
      channel: event.channel,
      channelType,
      userId: event.user,
      text: event.text,
      ts: event.ts,
      threadTs: event.thread_ts,
      files: event.files,
      stripMention: true
    });
  }

  private async forwardToSwarm(input: {
    eventType: "message" | "app_mention";
    body: SlackEventsApiBody;
    channel: string;
    channelType: MessageSourceContext["channelType"];
    userId?: string;
    text?: string;
    ts?: string;
    threadTs?: string;
    files?: SlackFileDescriptor[];
    stripMention: boolean;
  }): Promise<void> {
    const config = this.getConfig();
    const botUserId = this.getBotUserId();
    const normalizedText = input.stripMention
      ? stripBotMention(input.text ?? "", botUserId)
      : (input.text ?? "").trim();
    const attachments = await this.extractAttachments(input.files, config);

    if (!normalizedText && attachments.length === 0) {
      return;
    }

    const shouldStartThread =
      input.channelType !== "dm" && !input.threadTs && Boolean(input.ts) && config.response.respondInThread;

    const sourceContext: MessageSourceContext = {
      channel: "slack",
      channelId: input.channel,
      userId: normalizeOptionalString(input.userId),
      threadTs: normalizeOptionalString(input.threadTs) ?? (shouldStartThread ? input.ts : undefined),
      integrationProfileId: this.integrationProfileId,
      channelType: input.channelType,
      teamId: normalizeOptionalString(input.body.team_id)
    };

    try {
      await this.swarmManager.handleUserMessage(normalizedText, {
        targetAgentId: this.managerId,
        attachments,
        sourceContext
      });
    } catch (error) {
      this.onError?.("Failed to route Slack message to swarm manager", error);
    }
  }

  private shouldIgnoreMessageEvent(event: SlackMessageEvent, botUserId?: string): boolean {
    if (event.bot_id) {
      return true;
    }

    if (botUserId && event.user === botUserId) {
      return true;
    }

    if (event.subtype && IGNORED_MESSAGE_SUBTYPES.has(event.subtype)) {
      return true;
    }

    if (event.subtype && event.subtype !== "file_share") {
      return true;
    }

    return false;
  }

  private shouldIgnoreMentionEvent(event: SlackAppMentionEvent, botUserId?: string): boolean {
    if (event.subtype && IGNORED_MESSAGE_SUBTYPES.has(event.subtype)) {
      return true;
    }

    if (botUserId && event.user === botUserId) {
      return true;
    }

    return false;
  }

  private isChannelAllowed(
    channelId: string,
    channelType: MessageSourceContext["channelType"],
    config: SlackIntegrationConfig
  ): boolean {
    if (!channelId) {
      return false;
    }

    const isPrivateChannel = channelType === "group" || channelType === "mpim";
    if (isPrivateChannel && !config.listen.includePrivateChannels) {
      return false;
    }

    const channelIds = config.listen.channelIds;
    if (channelIds.length === 0) {
      return true;
    }

    return channelIds.includes(channelId);
  }

  private async extractAttachments(
    files: SlackFileDescriptor[] | undefined,
    config: SlackIntegrationConfig
  ): Promise<ConversationAttachment[]> {
    if (!files || files.length === 0) {
      return [];
    }

    const attachments: ConversationAttachment[] = [];

    for (const file of files) {
      try {
        const attachment = await this.mapFileToAttachment(file, config);
        if (attachment) {
          attachments.push(attachment);
        }
      } catch (error) {
        this.onError?.("Failed to ingest Slack attachment", error);
      }
    }

    return attachments;
  }

  private async mapFileToAttachment(
    file: SlackFileDescriptor,
    config: SlackIntegrationConfig
  ): Promise<ConversationAttachment | null> {
    const resolved = await this.resolveFileDescriptor(file);

    if (resolved.is_external) {
      return null;
    }

    const fileSize = typeof resolved.size === "number" ? resolved.size : undefined;
    if (fileSize !== undefined && fileSize > config.attachments.maxFileBytes) {
      return null;
    }

    const mimeType = normalizeOptionalString(resolved.mimetype) ?? "application/octet-stream";
    const fileName = normalizeOptionalString(resolved.name);
    const isImage = mimeType.startsWith("image/");
    const isText = isTextMimeType(mimeType);

    if (isImage && !config.attachments.allowImages) {
      return null;
    }

    if (isText && !config.attachments.allowText) {
      return null;
    }

    if (!isImage && !isText && !config.attachments.allowBinary) {
      return null;
    }

    if (!resolved.url_private && !resolved.url_private_download) {
      return null;
    }

    const downloaded = await this.slackClient.downloadFile(resolved);
    if (downloaded.size > config.attachments.maxFileBytes) {
      return null;
    }

    if (isImage) {
      return {
        mimeType,
        data: downloaded.buffer.toString("base64"),
        fileName
      };
    }

    if (isText) {
      const text = downloaded.buffer.toString("utf8");
      if (!text.trim()) {
        return null;
      }

      return {
        type: "text",
        mimeType,
        text,
        fileName
      };
    }

    return {
      type: "binary",
      mimeType,
      data: downloaded.buffer.toString("base64"),
      fileName
    };
  }

  private async resolveFileDescriptor(file: SlackFileDescriptor): Promise<SlackFileDescriptor> {
    const hasDownloadUrl = Boolean(file.url_private || file.url_private_download);
    if (hasDownloadUrl || !file.id) {
      return file;
    }

    const fetched = await this.slackClient.getFileInfo(file.id);
    if (!fetched) {
      return file;
    }

    return {
      ...file,
      ...fetched
    };
  }

  private isDuplicate(key: string): boolean {
    this.pruneSeenKeys();

    if (this.seenEventKeys.has(key)) {
      return true;
    }

    this.seenEventKeys.set(key, Date.now());
    return false;
  }

  private pruneSeenKeys(): void {
    const now = Date.now();

    for (const [key, seenAt] of this.seenEventKeys.entries()) {
      if (now - seenAt > DEDUPE_TTL_MS) {
        this.seenEventKeys.delete(key);
      }
    }
  }
}

function asEventsApiBody(value: unknown): SlackEventsApiBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const maybe = value as SlackEventsApiBody;
  if (!maybe.event || typeof maybe.event !== "object") {
    return {
      team_id: normalizeOptionalString(maybe.team_id),
      event_id: normalizeOptionalString(maybe.event_id),
      event_time: typeof maybe.event_time === "number" ? maybe.event_time : undefined
    };
  }

  const eventType = (maybe.event as { type?: unknown }).type;

  if (eventType === "message") {
    return {
      team_id: normalizeOptionalString(maybe.team_id),
      event_id: normalizeOptionalString(maybe.event_id),
      event_time: typeof maybe.event_time === "number" ? maybe.event_time : undefined,
      event: normalizeMessageEvent(maybe.event)
    };
  }

  if (eventType === "app_mention") {
    return {
      team_id: normalizeOptionalString(maybe.team_id),
      event_id: normalizeOptionalString(maybe.event_id),
      event_time: typeof maybe.event_time === "number" ? maybe.event_time : undefined,
      event: normalizeAppMentionEvent(maybe.event)
    };
  }

  return {
    team_id: normalizeOptionalString(maybe.team_id),
    event_id: normalizeOptionalString(maybe.event_id),
    event_time: typeof maybe.event_time === "number" ? maybe.event_time : undefined,
    event: { type: typeof eventType === "string" ? eventType : "unknown" }
  };
}

function normalizeMessageEvent(value: unknown): SlackMessageEvent {
  const maybe = value as Partial<SlackMessageEvent>;

  return {
    type: "message",
    user: normalizeOptionalString(maybe.user),
    text: normalizeOptionalString(maybe.text),
    channel: normalizeOptionalString(maybe.channel) ?? "",
    ts: normalizeOptionalString(maybe.ts) ?? "",
    thread_ts: normalizeOptionalString(maybe.thread_ts),
    channel_type: normalizeChannelTypeRaw(maybe.channel_type),
    subtype: normalizeOptionalString(maybe.subtype),
    bot_id: normalizeOptionalString(maybe.bot_id),
    files: normalizeFiles(maybe.files)
  };
}

function normalizeAppMentionEvent(value: unknown): SlackAppMentionEvent {
  const maybe = value as Partial<SlackAppMentionEvent>;

  return {
    type: "app_mention",
    user: normalizeOptionalString(maybe.user),
    text: normalizeOptionalString(maybe.text),
    channel: normalizeOptionalString(maybe.channel) ?? "",
    ts: normalizeOptionalString(maybe.ts) ?? "",
    thread_ts: normalizeOptionalString(maybe.thread_ts),
    subtype: normalizeOptionalString(maybe.subtype),
    files: normalizeFiles(maybe.files)
  };
}

function normalizeFiles(value: unknown): SlackFileDescriptor[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const files: SlackFileDescriptor[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const maybe = item as Partial<SlackFileDescriptor>;
    files.push({
      id: normalizeOptionalString(maybe.id),
      name: normalizeOptionalString(maybe.name),
      mimetype: normalizeOptionalString(maybe.mimetype),
      size: typeof maybe.size === "number" ? maybe.size : undefined,
      url_private: normalizeOptionalString(maybe.url_private),
      url_private_download: normalizeOptionalString(maybe.url_private_download),
      is_external: maybe.is_external === true
    });
  }

  return files.length > 0 ? files : undefined;
}

function isSlackMessageEvent(event: SlackEventsApiBody["event"]): event is SlackMessageEvent {
  return Boolean(
    event &&
      event.type === "message" &&
      typeof event.channel === "string" &&
      event.channel.trim().length > 0 &&
      typeof event.ts === "string" &&
      event.ts.trim().length > 0
  );
}

function isSlackAppMentionEvent(event: SlackEventsApiBody["event"]): event is SlackAppMentionEvent {
  return Boolean(
    event &&
      event.type === "app_mention" &&
      typeof event.channel === "string" &&
      event.channel.trim().length > 0 &&
      typeof event.ts === "string" &&
      event.ts.trim().length > 0
  );
}

function buildDedupeKey(body: SlackEventsApiBody): string | undefined {
  if (body.event_id) {
    return body.event_id;
  }

  if (!body.event) {
    return undefined;
  }

  if (body.event.type === "message") {
    return `${body.event.type}:${body.event.channel}:${body.event.ts}`;
  }

  if (body.event.type === "app_mention") {
    return `${body.event.type}:${body.event.channel}:${body.event.ts}`;
  }

  return undefined;
}

function resolveChannelType(
  channelType: SlackMessageEvent["channel_type"] | undefined,
  channelId: string
): MessageSourceContext["channelType"] {
  if (channelType === "im") {
    return "dm";
  }

  if (channelType === "channel") {
    return "channel";
  }

  if (channelType === "group") {
    return "group";
  }

  if (channelType === "mpim") {
    return "mpim";
  }

  if (channelId.startsWith("D")) {
    return "dm";
  }

  if (channelId.startsWith("G")) {
    return "group";
  }

  if (channelId.startsWith("C")) {
    return "channel";
  }

  return undefined;
}

function normalizeChannelTypeRaw(value: unknown): SlackMessageEvent["channel_type"] | undefined {
  if (value !== "im" && value !== "channel" && value !== "group" && value !== "mpim") {
    return undefined;
  }

  return value;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isTextMimeType(mimeType: string): boolean {
  if (mimeType.startsWith("text/")) {
    return true;
  }

  return (
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/yaml" ||
    mimeType === "application/x-yaml" ||
    mimeType === "application/javascript"
  );
}
