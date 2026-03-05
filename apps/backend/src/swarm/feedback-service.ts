import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { FEEDBACK_REASON_CODES, type FeedbackEvent, type FeedbackState } from "@middleman/protocol";
import { getProfilesDir, getSessionFeedbackPath, getSessionsDir } from "./data-paths.js";
import { readSessionMeta, writeSessionMeta } from "./session-manifest.js";

export interface FeedbackListOptions {
  since?: string;
  scope?: string;
  value?: string;
}

export interface FeedbackAcrossSessionsOptions extends FeedbackListOptions {
  profileId?: string;
}

export class FeedbackService {
  constructor(private readonly dataDir: string) {}

  async submitFeedback(event: Omit<FeedbackEvent, "id" | "createdAt">): Promise<FeedbackEvent> {
    const normalized = normalizeSubmitFeedbackInput(event);

    const submitted: FeedbackEvent = {
      ...normalized,
      id: randomUUID(),
      createdAt: new Date().toISOString()
    };

    const feedbackPath = getSessionFeedbackPath(this.dataDir, submitted.profileId, submitted.sessionId);
    await mkdir(dirname(feedbackPath), { recursive: true });
    await appendFile(feedbackPath, `${JSON.stringify(submitted)}\n`, "utf8");

    await this.updateSessionFeedbackMeta(submitted.profileId, submitted.sessionId, submitted.createdAt);

    return submitted;
  }

  async listFeedback(profileId: string, sessionId: string, opts: FeedbackListOptions = {}): Promise<FeedbackEvent[]> {
    const normalizedProfileId = requireNonEmptyString(profileId, "profileId");
    const normalizedSessionId = requireNonEmptyString(sessionId, "sessionId");

    const since = normalizeOptionalString(opts.since);
    const scope = normalizeOptionalString(opts.scope);
    const value = normalizeOptionalString(opts.value);

    const feedbackPath = getSessionFeedbackPath(this.dataDir, normalizedProfileId, normalizedSessionId);
    const events = await readFeedbackEventsFile(feedbackPath);

    return events.filter((event) => {
      if (since && event.createdAt < since) {
        return false;
      }

      if (scope && event.scope !== scope) {
        return false;
      }

      if (value && event.value !== value) {
        return false;
      }

      return true;
    });
  }

  async queryFeedbackAcrossSessions(opts: FeedbackAcrossSessionsOptions = {}): Promise<FeedbackEvent[]> {
    const profileId = normalizeOptionalString(opts.profileId);
    const profileIds = profileId ? [profileId] : await listDirectoryNames(getProfilesDir(this.dataDir));

    const events: FeedbackEvent[] = [];
    for (const currentProfileId of profileIds) {
      const sessionIds = await listDirectoryNames(getSessionsDir(this.dataDir, currentProfileId));
      for (const sessionId of sessionIds) {
        const sessionEvents = await this.listFeedback(currentProfileId, sessionId, {
          since: opts.since,
          scope: opts.scope,
          value: opts.value
        });
        events.push(...sessionEvents);
      }
    }

    events.sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt.localeCompare(right.createdAt);
      }

      return left.id.localeCompare(right.id);
    });

    return events;
  }

  async getLatestStates(profileId: string, sessionId: string): Promise<FeedbackState[]> {
    const events = await this.listFeedback(profileId, sessionId);
    const latestEventsByTarget = new Map<string, FeedbackEvent>();

    for (const event of events) {
      const key = `${event.actor}:${event.scope}:${event.targetId}`;
      latestEventsByTarget.set(key, event);
    }

    const states = Array.from(latestEventsByTarget.values()).map((event) => ({
      targetId: event.targetId,
      scope: event.scope,
      value: event.value === "clear" ? null : event.value,
      latestEventId: event.id,
      latestAt: event.createdAt
    } satisfies FeedbackState));

    states.sort((left, right) => {
      if (left.scope !== right.scope) {
        return left.scope.localeCompare(right.scope);
      }

      return left.targetId.localeCompare(right.targetId);
    });

    return states;
  }

  async getFeedbackFileSize(profileId: string, sessionId: string): Promise<number> {
    const normalizedProfileId = requireNonEmptyString(profileId, "profileId");
    const normalizedSessionId = requireNonEmptyString(sessionId, "sessionId");
    const feedbackPath = getSessionFeedbackPath(this.dataDir, normalizedProfileId, normalizedSessionId);

    try {
      const feedbackStats = await stat(feedbackPath);
      return feedbackStats.size;
    } catch (error) {
      if (isEnoentError(error)) {
        return 0;
      }

      throw error;
    }
  }

  private async updateSessionFeedbackMeta(profileId: string, sessionId: string, lastFeedbackAt: string): Promise<void> {
    const meta = await readSessionMeta(this.dataDir, profileId, sessionId);
    if (!meta) {
      return;
    }

    const feedbackFileSize = await this.getFeedbackFileSize(profileId, sessionId);
    meta.feedbackFileSize = String(feedbackFileSize);
    meta.lastFeedbackAt = lastFeedbackAt;
    meta.updatedAt = new Date().toISOString();

    await writeSessionMeta(this.dataDir, meta);
  }
}

async function readFeedbackEventsFile(path: string): Promise<FeedbackEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoentError(error)) {
      return [];
    }

    throw error;
  }

  const events: FeedbackEvent[] = [];
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const event = coerceFeedbackEvent(parsed);
    if (event) {
      events.push(event);
    }
  }

  return events;
}

function normalizeSubmitFeedbackInput(event: Omit<FeedbackEvent, "id" | "createdAt">): Omit<FeedbackEvent, "id" | "createdAt"> {
  const profileId = requireNonEmptyString(event.profileId, "profileId");
  const sessionId = requireNonEmptyString(event.sessionId, "sessionId");
  const targetId = requireNonEmptyString(event.targetId, "targetId");
  const scope = requireFeedbackScope(event.scope, "scope");
  const value = requireFeedbackValue(event.value, "value");
  const channel = requireFeedbackChannel(event.channel, "channel");

  if (scope === "session" && targetId !== sessionId) {
    throw new Error("targetId must match sessionId when scope is session.");
  }

  if (event.actor !== "user") {
    throw new Error("actor must be user.");
  }

  const comment = typeof event.comment === "string" ? event.comment : "";

  return {
    profileId,
    sessionId,
    scope,
    targetId,
    value,
    reasonCodes: normalizeReasonCodes(event.reasonCodes),
    comment,
    channel,
    actor: "user"
  };
}

function coerceFeedbackEvent(value: unknown): FeedbackEvent | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = normalizeOptionalString(value.id);
  const createdAt = normalizeOptionalString(value.createdAt);
  const profileId = normalizeOptionalString(value.profileId);
  const sessionId = normalizeOptionalString(value.sessionId);
  const targetId = normalizeOptionalString(value.targetId);
  const scope = normalizeOptionalString(value.scope);
  const feedbackValue = normalizeOptionalString(value.value);
  const channel = normalizeOptionalString(value.channel);
  const actor = normalizeOptionalString(value.actor);

  if (!id || !createdAt || !profileId || !sessionId || !targetId || !scope || !feedbackValue || !channel || !actor) {
    return undefined;
  }

  if (!isFeedbackScope(scope) || !isFeedbackValue(feedbackValue) || !isFeedbackChannel(channel) || actor !== "user") {
    return undefined;
  }

  if (scope === "session" && targetId !== sessionId) {
    return undefined;
  }

  const reasonCodes = normalizeReasonCodesMaybe(value.reasonCodes);
  if (!reasonCodes) {
    return undefined;
  }

  const comment = typeof value.comment === "string" ? value.comment : "";

  return {
    id,
    createdAt,
    profileId,
    sessionId,
    scope,
    targetId,
    value: feedbackValue,
    reasonCodes,
    comment,
    channel,
    actor: "user"
  };
}

async function listDirectoryNames(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isEnoentError(error)) {
      return [];
    }

    throw error;
  }
}

function normalizeReasonCodes(value: unknown): string[] {
  const reasonCodes = normalizeReasonCodesMaybe(value);
  if (!reasonCodes) {
    throw new Error("reasonCodes must be an array of known reason code strings.");
  }

  return reasonCodes;
}

function normalizeReasonCodesMaybe(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") {
      return undefined;
    }

    const code = item.trim();
    if (!FEEDBACK_REASON_CODES.includes(code as (typeof FEEDBACK_REASON_CODES)[number])) {
      return undefined;
    }

    if (seen.has(code)) {
      continue;
    }

    seen.add(code);
    normalized.push(code);
  }

  return normalized;
}

function requireFeedbackScope(value: unknown, fieldName: string): FeedbackEvent["scope"] {
  if (!isFeedbackScope(value)) {
    throw new Error(`${fieldName} must be one of: message, session.`);
  }

  return value;
}

function requireFeedbackValue(value: unknown, fieldName: string): FeedbackEvent["value"] {
  if (!isFeedbackValue(value)) {
    throw new Error(`${fieldName} must be one of: up, down, clear.`);
  }

  return value;
}

function requireFeedbackChannel(value: unknown, fieldName: string): FeedbackEvent["channel"] {
  if (!isFeedbackChannel(value)) {
    throw new Error(`${fieldName} must be one of: web, telegram, slack.`);
  }

  return value;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }

  return normalized;
}

function isFeedbackScope(value: unknown): value is FeedbackEvent["scope"] {
  return value === "message" || value === "session";
}

function isFeedbackValue(value: unknown): value is FeedbackEvent["value"] {
  return value === "up" || value === "down" || value === "clear";
}

function isFeedbackChannel(value: unknown): value is FeedbackEvent["channel"] {
  return value === "web" || value === "telegram" || value === "slack";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
