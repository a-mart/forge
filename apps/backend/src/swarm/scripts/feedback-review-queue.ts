import { homedir } from "node:os";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface ScriptArgs {
  dataDir: string;
  profileId?: string;
  sessionId?: string;
  json: boolean;
}

interface FeedbackNeedInfo {
  feedbackNeedsReview: boolean;
  feedbackTotalBytes: number;
  feedbackReviewedBytes: number;
  feedbackDeltaBytes: number;
  timestampDrift: boolean;
  lastFeedbackAt: string | null;
  feedbackReviewedAt: string | null;
}

interface FeedbackEvent {
  [key: string]: unknown;
}

interface FeedbackSummary {
  counts: {
    total: number;
    byValue: { up: number; down: number; comment: number; other: number };
    byScope: { message: number; session: number; other: number };
    withCommentText: number;
  };
  topReasons: {
    down: Array<[string, number]>;
    up: Array<[string, number]>;
    comment: Array<[string, number]>;
  };
}

interface QueueItem extends FeedbackNeedInfo {
  profileId: string;
  sessionId: string;
  sessionDir: string;
  feedbackPath: string;
  invalidLines: number;
  metaFeedbackSize: number;
  actualFeedbackSize: number;
  summary: FeedbackSummary;
  priorityScore?: number;
}

function parseArgs(argv: string[]): ScriptArgs {
  const args: ScriptArgs = {
    dataDir: process.env.SWARM_DATA_DIR || join(homedir(), ".forge"),
    profileId: undefined,
    sessionId: undefined,
    json: false
  };

  const positional = [...argv];
  if (positional[0] && !positional[0].startsWith("-")) {
    args.dataDir = positional.shift() as string;
  }

  for (let index = 0; index < positional.length; index += 1) {
    const arg = positional[index];
    if (arg === "--data-dir") {
      args.dataDir = positional[index + 1] ?? args.dataDir;
      index += 1;
    } else if (arg === "--profile") {
      args.profileId = positional[index + 1];
      index += 1;
    } else if (arg === "--session") {
      args.sessionId = positional[index + 1];
      index += 1;
    } else if (arg === "--json") {
      args.json = true;
    }
  }

  return args;
}

function parseNumberLike(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function parseIso(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function computeFeedbackNeedsReview(meta: Record<string, unknown> | null): FeedbackNeedInfo {
  const feedbackTotalBytes = parseNumberLike(meta?.feedbackFileSize, 0);
  const feedbackReviewedBytes = parseNumberLike(meta?.cortexReviewedFeedbackBytes, 0);
  const feedbackDeltaBytes = feedbackTotalBytes - feedbackReviewedBytes;

  const lastFeedbackAt = typeof meta?.lastFeedbackAt === "string" ? meta.lastFeedbackAt : null;
  const feedbackReviewedAt =
    typeof meta?.cortexReviewedFeedbackAt === "string" ? meta.cortexReviewedFeedbackAt : null;

  const lastFeedbackAtMs = parseIso(lastFeedbackAt);
  const feedbackReviewedAtMs = parseIso(feedbackReviewedAt);

  const timestampDrift =
    lastFeedbackAtMs !== null && (feedbackReviewedAtMs === null || lastFeedbackAtMs > feedbackReviewedAtMs);

  const feedbackNeedsReview = feedbackDeltaBytes !== 0 || timestampDrift;

  return {
    feedbackNeedsReview,
    feedbackTotalBytes,
    feedbackReviewedBytes,
    feedbackDeltaBytes,
    timestampDrift,
    lastFeedbackAt,
    feedbackReviewedAt
  };
}

async function readFeedbackEvents(feedbackPath: string): Promise<{
  events: FeedbackEvent[];
  invalidLines: number;
  sizeBytes: number;
}> {
  let raw: string;
  try {
    raw = await readFile(feedbackPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { events: [], invalidLines: 0, sizeBytes: 0 };
    }
    throw error;
  }

  const lines = raw.split(/\r?\n/);
  const events: FeedbackEvent[] = [];
  let invalidLines = 0;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        events.push(parsed as FeedbackEvent);
      } else {
        invalidLines += 1;
      }
    } catch {
      invalidLines += 1;
    }
  }

  return {
    events,
    invalidLines,
    sizeBytes: Buffer.byteLength(raw, "utf8")
  };
}

function summarizeEvents(events: FeedbackEvent[]): FeedbackSummary {
  const counts = {
    total: events.length,
    byValue: { up: 0, down: 0, comment: 0, other: 0 },
    byScope: { message: 0, session: 0, other: 0 },
    withCommentText: 0
  };

  const reasonDown = new Map<string, number>();
  const reasonUp = new Map<string, number>();
  const reasonComment = new Map<string, number>();

  for (const event of events) {
    const value = event.value;
    const scope = event.scope;

    if (value === "up" || value === "down" || value === "comment") {
      counts.byValue[value] += 1;
    } else {
      counts.byValue.other += 1;
    }

    if (scope === "message" || scope === "session") {
      counts.byScope[scope] += 1;
    } else {
      counts.byScope.other += 1;
    }

    const comment = typeof event.comment === "string" ? event.comment.trim() : "";
    if (comment.length > 0) {
      counts.withCommentText += 1;
    }

    const reasonCodes = Array.isArray(event.reasonCodes) ? event.reasonCodes : [];
    for (const codeRaw of reasonCodes) {
      if (typeof codeRaw !== "string" || !codeRaw.trim()) {
        continue;
      }

      const code = codeRaw.trim();
      const target = value === "down" ? reasonDown : value === "up" ? reasonUp : reasonComment;
      target.set(code, (target.get(code) ?? 0) + 1);
    }
  }

  return {
    counts,
    topReasons: {
      down: [...reasonDown.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5),
      up: [...reasonUp.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5),
      comment: [...reasonComment.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5)
    }
  };
}

function scoreQueueItem(item: QueueItem): number {
  let score = 0;
  score += Math.abs(item.feedbackDeltaBytes);
  if (item.feedbackDeltaBytes < 0) {
    score += 200;
  }
  if (item.timestampDrift) {
    score += 250;
  }
  if (!item.feedbackReviewedAt && item.lastFeedbackAt) {
    score += 500;
  }
  score += item.summary.counts.byValue.down * 30;
  score += item.summary.counts.withCommentText * 10;
  return score;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = resolve(args.dataDir);
  const profilesDir = join(dataDir, "profiles");

  const queue: QueueItem[] = [];

  let profileEntries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    profileEntries = await readdir(profilesDir, { withFileTypes: true });
  } catch {
    if (args.json) {
      console.log(JSON.stringify({ dataDir, queue: [], error: "profiles dir not found" }, null, 2));
      return;
    }

    console.log("No profiles directory found.");
    return;
  }

  for (const profileEntry of profileEntries) {
    if (!profileEntry.isDirectory()) {
      continue;
    }

    const profileId = profileEntry.name;
    if (profileId === "cortex") {
      continue;
    }
    if (args.profileId && profileId !== args.profileId) {
      continue;
    }

    const sessionsDir = join(profilesDir, profileId, "sessions");

    let sessionEntries: Array<{ name: string; isDirectory: () => boolean }> = [];
    try {
      sessionEntries = await readdir(sessionsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) {
        continue;
      }

      const sessionId = sessionEntry.name;
      if (args.sessionId && sessionId !== args.sessionId) {
        continue;
      }

      const sessionDir = join(sessionsDir, sessionId);
      const metaPath = join(sessionDir, "meta.json");

      let meta: Record<string, unknown> | null = null;
      try {
        const raw = await readFile(metaPath, "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          meta = parsed as Record<string, unknown>;
        }
      } catch {
        continue;
      }

      const info = computeFeedbackNeedsReview(meta);
      if (!info.feedbackNeedsReview) {
        continue;
      }

      const feedbackPath = join(sessionDir, "feedback.jsonl");
      const { events, invalidLines, sizeBytes } = await readFeedbackEvents(feedbackPath);
      const summary = summarizeEvents(events);

      let actualSizeFromStat = 0;
      try {
        const result = await stat(feedbackPath);
        actualSizeFromStat = result.size;
      } catch {
        actualSizeFromStat = 0;
      }

      queue.push({
        profileId,
        sessionId,
        sessionDir,
        feedbackPath,
        ...info,
        invalidLines,
        metaFeedbackSize: parseNumberLike(meta?.feedbackFileSize, 0),
        actualFeedbackSize: actualSizeFromStat || sizeBytes,
        summary
      });
    }
  }

  for (const item of queue) {
    item.priorityScore = scoreQueueItem(item);
  }

  queue.sort((left, right) => (right.priorityScore ?? 0) - (left.priorityScore ?? 0));

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          dataDir,
          generatedAt: new Date().toISOString(),
          queue
        },
        null,
        2
      )
    );
    return;
  }

  if (queue.length === 0) {
    console.log("Feedback queue is empty (no sessions need feedback re-review).");
    return;
  }

  console.log("Feedback review queue (programmatic):");
  for (const [index, item] of queue.entries()) {
    const down = item.summary.counts.byValue.down;
    const comments = item.summary.counts.withCommentText;
    const reasonsDown = item.summary.topReasons.down.map(([code, count]) => `${code}:${count}`).join(", ") || "-";
    const basis: string[] = [];
    if (item.feedbackDeltaBytes !== 0) {
      basis.push(`delta=${item.feedbackDeltaBytes}`);
    }
    if (item.timestampDrift) {
      basis.push("timestamp-drift");
    }

    console.log(
      `${String(index + 1).padStart(2, " ")}. ${item.profileId}/${item.sessionId} ` +
        `[score=${item.priorityScore ?? 0}] [${basis.join(" + ")}] ` +
        `entries=${item.summary.counts.total} down=${down} comments=${comments} topDown=${reasonsDown}`
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
