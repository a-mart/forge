import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface ScanSession {
  profileId: string;
  sessionId: string;
  deltaBytes: number;
  totalBytes: number;
  reviewedBytes: number;
  reviewedAt: string | null;
  reviewExcluded: boolean;
  reviewExcludedAt: string | null;
  memoryDeltaBytes: number;
  memoryTotalBytes: number;
  memoryReviewedBytes: number;
  memoryReviewedAt: string | null;
  feedbackDeltaBytes: number;
  feedbackTotalBytes: number;
  feedbackReviewedBytes: number;
  feedbackReviewedAt: string | null;
  lastFeedbackAt: string | null;
  feedbackTimestampDrift: boolean;
  status: "never-reviewed" | "needs-review" | "up-to-date";
}

export interface ScanResult {
  sessions: ScanSession[];
  summary: {
    needsReview: number;
    upToDate: number;
    excluded: number;
    totalBytes: number;
    reviewedBytes: number;
    transcriptTotalBytes: number;
    transcriptReviewedBytes: number;
    memoryTotalBytes: number;
    memoryReviewedBytes: number;
    feedbackTotalBytes: number;
    feedbackReviewedBytes: number;
    attentionBytes: number;
    sessionsWithTranscriptDrift: number;
    sessionsWithMemoryDrift: number;
    sessionsWithFeedbackDrift: number;
  };
}

export async function scanCortexReviewStatus(dataDir: string): Promise<ScanResult> {
  const sessions: ScanSession[] = [];

  const resolvedDataDir = resolve(dataDir);
  const profilesDir = join(resolvedDataDir, "profiles");
  let profileEntries: Array<{ name: string; isDirectory: () => boolean }> = [];

  try {
    profileEntries = await readdir(profilesDir, { withFileTypes: true });
  } catch {
    return {
      sessions,
      summary: {
        needsReview: 0,
        upToDate: 0,
        excluded: 0,
        totalBytes: 0,
        reviewedBytes: 0,
        transcriptTotalBytes: 0,
        transcriptReviewedBytes: 0,
        memoryTotalBytes: 0,
        memoryReviewedBytes: 0,
        feedbackTotalBytes: 0,
        feedbackReviewedBytes: 0,
        attentionBytes: 0,
        sessionsWithTranscriptDrift: 0,
        sessionsWithMemoryDrift: 0,
        sessionsWithFeedbackDrift: 0
      }
    };
  }

  for (const profileEntry of profileEntries) {
    if (!profileEntry.isDirectory()) {
      continue;
    }

    const sessionsDir = join(profilesDir, profileEntry.name, "sessions");

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

      const sessionDir = join(sessionsDir, sessionEntry.name);
      const metaPath = join(sessionDir, "meta.json");
      let rawMeta: string;
      try {
        rawMeta = await readFile(metaPath, "utf8");
      } catch {
        continue;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(rawMeta);
      } catch {
        continue;
      }

      const profileId = typeof parsed?.profileId === "string" ? parsed.profileId : profileEntry.name;
      if (profileId === "cortex") {
        continue;
      }

      const sessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId : sessionEntry.name;

      const [actualSessionBytes, actualMemoryBytes, actualFeedbackBytes] = await Promise.all([
        readExistingFileSize(join(sessionDir, "session.jsonl")),
        readExistingFileSize(join(sessionDir, "memory.md")),
        readExistingFileSize(join(sessionDir, "feedback.jsonl"))
      ]);
      const totalBytes = actualSessionBytes ?? parseSessionTotalBytes(parsed?.stats?.sessionFileSize);
      if (!Number.isFinite(totalBytes)) {
        continue;
      }

      const reviewedBytes =
        typeof parsed?.cortexReviewedBytes === "number" && Number.isFinite(parsed.cortexReviewedBytes)
          ? parsed.cortexReviewedBytes
          : 0;
      const reviewedAt = typeof parsed?.cortexReviewedAt === "string" ? parsed.cortexReviewedAt : null;
      const deltaBytes = totalBytes - reviewedBytes;

      const memoryTotalBytesRaw = actualMemoryBytes ?? parseSessionTotalBytes(parsed?.stats?.memoryFileSize);
      const memoryTotalBytes = Number.isFinite(memoryTotalBytesRaw) ? memoryTotalBytesRaw : 0;
      const memoryReviewedBytes =
        typeof parsed?.cortexReviewedMemoryBytes === "number" && Number.isFinite(parsed.cortexReviewedMemoryBytes)
          ? parsed.cortexReviewedMemoryBytes
          : memoryTotalBytes;
      const memoryReviewedAt =
        typeof parsed?.cortexReviewedMemoryAt === "string" ? parsed.cortexReviewedMemoryAt : null;
      const memoryDeltaBytes = memoryTotalBytes - memoryReviewedBytes;

      const feedbackTotalBytesRaw = actualFeedbackBytes ?? parseSessionTotalBytes(parsed?.feedbackFileSize);
      const feedbackTotalBytes = Number.isFinite(feedbackTotalBytesRaw) ? feedbackTotalBytesRaw : 0;
      const feedbackReviewedBytes =
        typeof parsed?.cortexReviewedFeedbackBytes === "number" && Number.isFinite(parsed.cortexReviewedFeedbackBytes)
          ? parsed.cortexReviewedFeedbackBytes
          : 0;
      const feedbackReviewedAt =
        typeof parsed?.cortexReviewedFeedbackAt === "string" ? parsed.cortexReviewedFeedbackAt : null;
      const lastFeedbackAt = typeof parsed?.lastFeedbackAt === "string" ? parsed.lastFeedbackAt : null;
      const feedbackDeltaBytes = feedbackTotalBytes - feedbackReviewedBytes;
      const feedbackTimestampDrift = hasFeedbackTimestampDrift(lastFeedbackAt, feedbackReviewedAt);
      const hasPriorReview = reviewedAt !== null || memoryReviewedAt !== null || feedbackReviewedAt !== null;
      const reviewExcludedAt =
        typeof parsed?.cortexReviewExcludedAt === "string" ? parsed.cortexReviewExcludedAt : null;
      const reviewExcluded = reviewExcludedAt !== null;

      const status: ScanSession["status"] =
        deltaBytes === 0 && memoryDeltaBytes === 0 && feedbackDeltaBytes === 0 && !feedbackTimestampDrift
          ? "up-to-date"
          : !hasPriorReview
            ? "never-reviewed"
            : "needs-review";

      sessions.push({
        profileId,
        sessionId,
        deltaBytes,
        totalBytes,
        reviewedBytes,
        reviewedAt,
        reviewExcluded,
        reviewExcludedAt: reviewExcluded ? reviewExcludedAt : null,
        memoryDeltaBytes,
        memoryTotalBytes,
        memoryReviewedBytes,
        memoryReviewedAt,
        feedbackDeltaBytes,
        feedbackTotalBytes,
        feedbackReviewedBytes,
        feedbackReviewedAt,
        lastFeedbackAt,
        feedbackTimestampDrift,
        status
      });
    }
  }

  sessions.sort((left, right) => {
    const leftRank = getSessionSortRank(left);
    const rightRank = getSessionSortRank(right);

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    if (leftRank === 0 && rightRank === 0) {
      const leftCombinedDelta = getAttentionDeltaBytes(left);
      const rightCombinedDelta = getAttentionDeltaBytes(right);
      const deltaDifference = rightCombinedDelta - leftCombinedDelta;
      if (deltaDifference !== 0) {
        return deltaDifference;
      }
    }

    return `${left.profileId}/${left.sessionId}`.localeCompare(`${right.profileId}/${right.sessionId}`);
  });

  const summary = sessions.reduce(
    (accumulator, session) => {
      if (session.reviewExcluded) {
        accumulator.excluded += 1;
        return accumulator;
      }

      if (session.status === "up-to-date") {
        accumulator.upToDate += 1;
      } else {
        accumulator.needsReview += 1;
      }

      accumulator.totalBytes += session.totalBytes;
      accumulator.reviewedBytes += session.reviewedBytes;
      accumulator.transcriptTotalBytes += session.totalBytes;
      accumulator.transcriptReviewedBytes += clampReviewedBytes(session.reviewedBytes, session.totalBytes);
      accumulator.memoryTotalBytes += session.memoryTotalBytes;
      accumulator.memoryReviewedBytes += clampReviewedBytes(session.memoryReviewedBytes, session.memoryTotalBytes);
      accumulator.feedbackTotalBytes += session.feedbackTotalBytes;
      accumulator.feedbackReviewedBytes += clampReviewedBytes(session.feedbackReviewedBytes, session.feedbackTotalBytes);
      accumulator.attentionBytes += getAttentionDeltaBytes(session);

      if (session.deltaBytes !== 0) {
        accumulator.sessionsWithTranscriptDrift += 1;
      }
      if (session.memoryDeltaBytes !== 0) {
        accumulator.sessionsWithMemoryDrift += 1;
      }
      if (session.feedbackDeltaBytes !== 0 || session.feedbackTimestampDrift) {
        accumulator.sessionsWithFeedbackDrift += 1;
      }

      return accumulator;
    },
    {
      needsReview: 0,
      upToDate: 0,
      excluded: 0,
      totalBytes: 0,
      reviewedBytes: 0,
      transcriptTotalBytes: 0,
      transcriptReviewedBytes: 0,
      memoryTotalBytes: 0,
      memoryReviewedBytes: 0,
      feedbackTotalBytes: 0,
      feedbackReviewedBytes: 0,
      attentionBytes: 0,
      sessionsWithTranscriptDrift: 0,
      sessionsWithMemoryDrift: 0,
      sessionsWithFeedbackDrift: 0
    }
  );

  return {
    sessions,
    summary
  };
}

export async function runCortexScan(dataDir: string): Promise<string> {
  const scanResult = await scanCortexReviewStatus(dataDir);
  const sessionsNeedingReview = scanResult.sessions.filter((result) => !result.reviewExcluded && result.status !== "up-to-date");
  const excludedSessions = scanResult.sessions.filter((result) => result.reviewExcluded);
  const unchangedSessions = scanResult.sessions.filter((result) => !result.reviewExcluded && result.status === "up-to-date");

  const needsReviewLines =
    sessionsNeedingReview.length > 0
      ? sessionsNeedingReview.map((result) => formatNeedsReviewLine(result))
      : ["  (none)"];
  const excludedLines =
    excludedSessions.length > 0
      ? excludedSessions.map((result) => formatExcludedLine(result))
      : ["  (none)"];
  const unchangedLines =
    unchangedSessions.length > 0
      ? unchangedSessions.map((result) => `  ${result.profileId}/${result.sessionId}: up to date`)
      : ["  (none)"];

  const transcriptCoverage =
    scanResult.summary.transcriptTotalBytes > 0
      ? Math.min(
          100,
          Math.round((scanResult.summary.transcriptReviewedBytes / scanResult.summary.transcriptTotalBytes) * 100)
        )
      : 0;

  return [
    "Sessions needing attention:",
    ...needsReviewLines,
    "",
    "Sessions excluded from review:",
    ...excludedLines,
    "",
    "Sessions up to date:",
    ...unchangedLines,
    "",
    `Summary: ${scanResult.summary.needsReview} sessions need review, ${scanResult.summary.upToDate} up to date, ${scanResult.summary.excluded} excluded | signals — transcript: ${scanResult.summary.sessionsWithTranscriptDrift}, memory: ${scanResult.summary.sessionsWithMemoryDrift}, feedback: ${scanResult.summary.sessionsWithFeedbackDrift} | transcript coverage: ${transcriptCoverage}%`
  ].join("\n");
}

function formatNeedsReviewLine(result: ScanSession): string {
  const reviewedLabel = result.reviewedAt ? `last reviewed: ${result.reviewedAt.slice(0, 10)}` : "never reviewed";
  const memoryReviewedLabel = result.memoryReviewedAt
    ? `memory reviewed: ${result.memoryReviewedAt.slice(0, 10)}`
    : "memory watermark pending";

  if (result.memoryDeltaBytes === 0 && result.feedbackDeltaBytes === 0 && !result.feedbackTimestampDrift) {
    if (result.deltaBytes < 0) {
      return `  ${result.profileId}/${result.sessionId}: needs re-review (compacted: reviewed ${result.reviewedBytes.toLocaleString()} > current ${result.totalBytes.toLocaleString()}; ${reviewedLabel})`;
    }

    if (result.deltaBytes > 0) {
      return `  ${result.profileId}/${result.sessionId}: ${result.deltaBytes.toLocaleString()} new bytes (${reviewedLabel})`;
    }
  }

  const parts: string[] = [];

  if (result.deltaBytes < 0) {
    parts.push(
      `session compacted (reviewed ${result.reviewedBytes.toLocaleString()} > current ${result.totalBytes.toLocaleString()})`
    );
  } else if (result.deltaBytes > 0) {
    parts.push(`${result.deltaBytes.toLocaleString()} new bytes`);
  }

  if (result.memoryDeltaBytes < 0) {
    parts.push(
      `memory compacted (reviewed ${result.memoryReviewedBytes.toLocaleString()} > current ${result.memoryTotalBytes.toLocaleString()})`
    );
  } else if (result.memoryDeltaBytes > 0) {
    parts.push(`${result.memoryDeltaBytes.toLocaleString()} new memory bytes`);
  }

  if (result.feedbackDeltaBytes < 0) {
    parts.push(
      `feedback compacted (reviewed ${result.feedbackReviewedBytes.toLocaleString()} > current ${result.feedbackTotalBytes.toLocaleString()})`
    );
  } else if (result.feedbackDeltaBytes > 0) {
    parts.push(`${result.feedbackDeltaBytes.toLocaleString()} new feedback bytes`);
  } else if (result.feedbackTimestampDrift) {
    parts.push("feedback updated since last feedback review");
  }

  const feedbackReviewedLabel = result.feedbackReviewedAt
    ? `feedback reviewed: ${result.feedbackReviewedAt.slice(0, 10)}`
    : result.lastFeedbackAt
      ? "feedback never reviewed"
      : "no feedback review watermark";

  return `  ${result.profileId}/${result.sessionId}: ${parts.join(", ")} (${reviewedLabel}; ${memoryReviewedLabel}; ${feedbackReviewedLabel})`;
}

function formatExcludedLine(result: ScanSession): string {
  const excludedLabel = result.reviewExcludedAt ? `excluded: ${result.reviewExcludedAt.slice(0, 10)}` : "excluded";
  const reviewLabel = result.reviewedAt ? `last reviewed: ${result.reviewedAt.slice(0, 10)}` : "never reviewed";
  return `  ${result.profileId}/${result.sessionId}: excluded from automatic review (${excludedLabel}; ${reviewLabel})`;
}

function getSessionSortRank(result: ScanSession): number {
  if (result.reviewExcluded) {
    return 1;
  }

  return result.status === "up-to-date" ? 2 : 0;
}

function getAttentionDeltaBytes(result: ScanSession): number {
  return (
    Math.max(result.deltaBytes, 0) +
    Math.max(result.memoryDeltaBytes, 0) +
    Math.max(result.feedbackDeltaBytes, 0)
  );
}

function clampReviewedBytes(reviewedBytes: number, totalBytes: number): number {
  return Math.max(0, Math.min(reviewedBytes, totalBytes));
}

function hasFeedbackTimestampDrift(lastFeedbackAt: string | null, feedbackReviewedAt: string | null): boolean {
  if (!lastFeedbackAt) {
    return false;
  }

  const lastFeedbackTime = parseIsoTimestamp(lastFeedbackAt);
  if (lastFeedbackTime === null) {
    return true;
  }

  if (!feedbackReviewedAt) {
    return true;
  }

  const feedbackReviewedTime = parseIsoTimestamp(feedbackReviewedAt);
  if (feedbackReviewedTime === null) {
    return true;
  }

  return lastFeedbackTime > feedbackReviewedTime;
}

function parseIsoTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

function parseSessionTotalBytes(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return Number.NaN;
}

async function readExistingFileSize(filePath: string): Promise<number | null> {
  try {
    const stats = await stat(filePath);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const [dataDir] = process.argv.slice(2);
  if (!dataDir) {
    console.error("Usage: node cortex-scan.js <data-dir>");
    process.exitCode = 1;
    return;
  }

  const output = await runCortexScan(dataDir);
  console.log(output);
}

if (process.env.FORGE_BUNDLED_BACKEND !== "1" && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
