import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const UP_ONLY = new Set(["great_outcome"]);
const DOWN_ONLY = new Set(["over_engineered", "poor_outcome"]);

interface ScriptArgs {
  dataDir: string;
  profileId?: string;
  sessionId?: string;
  json: boolean;
}

interface FeedbackNeedsReview {
  feedbackNeedsReview: boolean;
  feedbackDeltaBytes: number;
  feedbackTotalBytes: number;
  feedbackReviewedBytes: number;
  lastFeedbackAt: string | null;
  feedbackReviewedAt: string | null;
  timestampDrift: boolean;
}

interface FeedbackEvent {
  [key: string]: unknown;
}

interface TargetDigest {
  scope: string;
  targetId: string;
  votesUp: number;
  votesDown: number;
  comments: number;
  commentTexts: string[];
  reasons: string[];
  latestAt: string | null;
}

interface AnalysisResult {
  counts: {
    total: number;
    withCommentText: number;
    byValue: Record<string, number>;
    byScope: Record<string, number>;
    byChannel: Record<string, number>;
  };
  reasons: {
    total: Record<string, number>;
    byValue: Record<string, number>;
  };
  targets: TargetDigest[];
  anomalies: Array<Record<string, unknown>>;
}

function parseArgs(argv: string[]): ScriptArgs {
  const args: ScriptArgs = {
    dataDir: process.env.SWARM_DATA_DIR || "/Users/adam/.middleman",
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

  if (!args.profileId || !args.sessionId) {
    throw new Error(
      "Usage: node feedback-session-digest.js <data-dir> --profile <id> --session <id> [--json] [--data-dir <dir>]"
    );
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

function needsReview(meta: Record<string, unknown> | null): FeedbackNeedsReview {
  const feedbackTotalBytes = parseNumberLike(meta?.feedbackFileSize, 0);
  const feedbackReviewedBytes = parseNumberLike(meta?.cortexReviewedFeedbackBytes, 0);
  const feedbackDeltaBytes = feedbackTotalBytes - feedbackReviewedBytes;

  const lastFeedbackAt = typeof meta?.lastFeedbackAt === "string" ? meta.lastFeedbackAt : null;
  const feedbackReviewedAt =
    typeof meta?.cortexReviewedFeedbackAt === "string" ? meta.cortexReviewedFeedbackAt : null;

  const lastFeedbackMs = parseIso(lastFeedbackAt);
  const reviewedFeedbackMs = parseIso(feedbackReviewedAt);
  const timestampDrift = lastFeedbackMs !== null && (reviewedFeedbackMs === null || lastFeedbackMs > reviewedFeedbackMs);

  return {
    feedbackNeedsReview: feedbackDeltaBytes !== 0 || timestampDrift,
    feedbackDeltaBytes,
    feedbackTotalBytes,
    feedbackReviewedBytes,
    lastFeedbackAt,
    feedbackReviewedAt,
    timestampDrift
  };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid JSON object in ${path}`);
  }
  return parsed as Record<string, unknown>;
}

async function readFeedback(path: string): Promise<{ events: FeedbackEvent[]; invalidLines: number; raw: string }> {
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { events: [], invalidLines: 0, raw: "" };
    }
    throw error;
  }

  const events: FeedbackEvent[] = [];
  let invalidLines = 0;

  for (const line of raw.split(/\r?\n/)) {
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

  return { events, invalidLines, raw };
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function analyze(events: FeedbackEvent[], sessionId: string): AnalysisResult {
  const byValue = new Map<string, number>();
  const byScope = new Map<string, number>();
  const byReason = new Map<string, number>();
  const byReasonAndValue = new Map<string, number>();
  const byChannel = new Map<string, number>();

  const targetSummary = new Map<
    string,
    {
      scope: string;
      targetId: string;
      votesUp: number;
      votesDown: number;
      comments: number;
      commentTexts: string[];
      reasons: Set<string>;
      latestAt: string | null;
    }
  >();

  const anomalies: Array<Record<string, unknown>> = [];
  let withCommentText = 0;

  for (const event of events) {
    const value = typeof event.value === "string" ? event.value : "unknown";
    const scope = typeof event.scope === "string" ? event.scope : "unknown";
    const targetId = typeof event.targetId === "string" ? event.targetId : "unknown";
    const channel = typeof event.channel === "string" ? event.channel : "unknown";

    increment(byValue, value);
    increment(byScope, scope);
    increment(byChannel, channel);

    const comment = typeof event.comment === "string" ? event.comment.trim() : "";
    if (comment.length > 0) {
      withCommentText += 1;
    }

    const reasonCodes = Array.isArray(event.reasonCodes)
      ? event.reasonCodes.filter((code): code is string => typeof code === "string")
      : [];

    for (const reasonCode of reasonCodes) {
      increment(byReason, reasonCode);
      increment(byReasonAndValue, `${value}:${reasonCode}`);

      if (value === "up" && DOWN_ONLY.has(reasonCode)) {
        anomalies.push({ type: "direction_mismatch", value, reasonCode, targetId, scope, id: event.id });
      }
      if (value === "down" && UP_ONLY.has(reasonCode)) {
        anomalies.push({ type: "direction_mismatch", value, reasonCode, targetId, scope, id: event.id });
      }
    }

    if (scope === "session" && targetId !== sessionId) {
      anomalies.push({
        type: "session_target_mismatch",
        id: event.id,
        targetId,
        sessionId
      });
    }

    const targetKey = `${scope}:${targetId}`;
    if (!targetSummary.has(targetKey)) {
      targetSummary.set(targetKey, {
        scope,
        targetId,
        votesUp: 0,
        votesDown: 0,
        comments: 0,
        commentTexts: [],
        reasons: new Set<string>(),
        latestAt: null
      });
    }

    const target = targetSummary.get(targetKey);
    if (!target) {
      continue;
    }

    if (value === "up") {
      target.votesUp += 1;
    } else if (value === "down") {
      target.votesDown += 1;
    } else if (value === "comment") {
      target.comments += 1;
    }

    for (const code of reasonCodes) {
      target.reasons.add(code);
    }

    if (comment && target.commentTexts.length < 2) {
      target.commentTexts.push(comment.slice(0, 180));
    }

    if (typeof event.createdAt === "string") {
      if (!target.latestAt || event.createdAt > target.latestAt) {
        target.latestAt = event.createdAt;
      }
    }
  }

  const targets = [...targetSummary.values()]
    .map((target) => ({
      ...target,
      reasons: [...target.reasons].sort()
    }))
    .sort((left, right) => {
      if (left.votesDown !== right.votesDown) {
        return right.votesDown - left.votesDown;
      }
      if (left.comments !== right.comments) {
        return right.comments - left.comments;
      }
      return `${left.scope}:${left.targetId}`.localeCompare(`${right.scope}:${right.targetId}`);
    });

  return {
    counts: {
      total: events.length,
      withCommentText,
      byValue: Object.fromEntries([...byValue.entries()].sort(([left], [right]) => left.localeCompare(right))),
      byScope: Object.fromEntries([...byScope.entries()].sort(([left], [right]) => left.localeCompare(right))),
      byChannel: Object.fromEntries([...byChannel.entries()].sort(([left], [right]) => left.localeCompare(right)))
    },
    reasons: {
      total: Object.fromEntries(
        [...byReason.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      ),
      byValue: Object.fromEntries(
        [...byReasonAndValue.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      )
    },
    targets,
    anomalies
  };
}

function renderMarkdown(report: {
  profileId: string;
  sessionId: string;
  generatedAt: string;
  watermarks: FeedbackNeedsReview;
  fileStats: {
    metaFeedbackFileSize: number;
    actualFeedbackFileSize: number;
    invalidLines: number;
    sha256: string;
  };
  analysis: AnalysisResult;
}): string {
  const lines: string[] = [];
  lines.push(`# Feedback Session Digest: ${report.profileId}/${report.sessionId}`);
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Watermark status");
  lines.push(`- feedbackNeedsReview: **${report.watermarks.feedbackNeedsReview}**`);
  lines.push(`- feedbackDeltaBytes: ${report.watermarks.feedbackDeltaBytes}`);
  lines.push(`- timestampDrift: ${report.watermarks.timestampDrift}`);
  lines.push(`- lastFeedbackAt: ${report.watermarks.lastFeedbackAt ?? "(none)"}`);
  lines.push(`- feedbackReviewedAt: ${report.watermarks.feedbackReviewedAt ?? "(none)"}`);
  lines.push("");
  lines.push("## File stats");
  lines.push(`- feedbackFileSize(meta): ${report.fileStats.metaFeedbackFileSize}`);
  lines.push(`- feedbackFileSize(actual): ${report.fileStats.actualFeedbackFileSize}`);
  lines.push(`- feedbackSHA256: ${report.fileStats.sha256}`);
  lines.push(`- invalidLinesSkipped: ${report.fileStats.invalidLines}`);
  lines.push("");
  lines.push("## Counts");
  lines.push(`- total entries: ${report.analysis.counts.total}`);
  lines.push(`- entries with comment text: ${report.analysis.counts.withCommentText}`);
  lines.push(`- by value: ${JSON.stringify(report.analysis.counts.byValue)}`);
  lines.push(`- by scope: ${JSON.stringify(report.analysis.counts.byScope)}`);
  lines.push(`- by channel: ${JSON.stringify(report.analysis.counts.byChannel)}`);
  lines.push("");
  lines.push("## Top reasons");

  const topReasons = Object.entries(report.analysis.reasons.total).slice(0, 8);
  if (topReasons.length === 0) {
    lines.push("- (none)");
  } else {
    for (const [reason, count] of topReasons) {
      lines.push(`- ${reason}: ${count}`);
    }
  }

  lines.push("");
  lines.push("## Top targets");
  if (report.analysis.targets.length === 0) {
    lines.push("- (none)");
  } else {
    for (const target of report.analysis.targets.slice(0, 10)) {
      lines.push(
        `- ${target.scope}:${target.targetId} | down=${target.votesDown} up=${target.votesUp} comments=${target.comments} | reasons=${target.reasons.join(", ") || "-"}${target.latestAt ? ` | latest=${target.latestAt}` : ""}`
      );
    }
  }

  lines.push("");
  lines.push("## Anomalies");
  if (report.analysis.anomalies.length === 0) {
    lines.push("- none");
  } else {
    for (const anomaly of report.analysis.anomalies.slice(0, 20)) {
      lines.push(`- ${JSON.stringify(anomaly)}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = resolve(args.dataDir);
  const sessionDir = join(dataDir, "profiles", args.profileId as string, "sessions", args.sessionId as string);
  const metaPath = join(sessionDir, "meta.json");
  const feedbackPath = join(sessionDir, "feedback.jsonl");

  const meta = await readJson(metaPath);
  const watermarks = needsReview(meta);

  const feedback = await readFeedback(feedbackPath);
  const sha256 = createHash("sha256").update(feedback.raw, "utf8").digest("hex");

  let actualFeedbackFileSize = 0;
  try {
    actualFeedbackFileSize = (await stat(feedbackPath)).size;
  } catch {
    actualFeedbackFileSize = 0;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dataDir,
    profileId: args.profileId as string,
    sessionId: args.sessionId as string,
    watermarks,
    fileStats: {
      metaFeedbackFileSize: parseNumberLike(meta.feedbackFileSize, 0),
      actualFeedbackFileSize,
      invalidLines: feedback.invalidLines,
      sha256
    },
    analysis: analyze(feedback.events, args.sessionId as string)
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(renderMarkdown(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
