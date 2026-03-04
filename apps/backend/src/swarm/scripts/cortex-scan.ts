import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface ScanSession {
  profileId: string;
  sessionId: string;
  deltaBytes: number;
  totalBytes: number;
  reviewedBytes: number;
  reviewedAt: string | null;
  status: "never-reviewed" | "needs-review" | "up-to-date";
}

export interface ScanResult {
  sessions: ScanSession[];
  summary: {
    needsReview: number;
    upToDate: number;
    totalBytes: number;
    reviewedBytes: number;
  };
}

export async function scanCortexReviewStatus(dataDir: string): Promise<ScanResult> {
  const sessions: ScanSession[] = [];

  const profilesDir = join(resolve(dataDir), "profiles");
  let profileEntries: Array<{ name: string; isDirectory: () => boolean }> = [];

  try {
    profileEntries = await readdir(profilesDir, { withFileTypes: true });
  } catch {
    return {
      sessions,
      summary: {
        needsReview: 0,
        upToDate: 0,
        totalBytes: 0,
        reviewedBytes: 0
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

      const metaPath = join(sessionsDir, sessionEntry.name, "meta.json");
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
      const totalBytes = parseSessionTotalBytes(parsed?.stats?.sessionFileSize);
      if (!Number.isFinite(totalBytes)) {
        continue;
      }

      const reviewedBytes =
        typeof parsed?.cortexReviewedBytes === "number" && Number.isFinite(parsed.cortexReviewedBytes)
          ? parsed.cortexReviewedBytes
          : 0;
      const reviewedAt = typeof parsed?.cortexReviewedAt === "string" ? parsed.cortexReviewedAt : null;
      const deltaBytes = totalBytes - reviewedBytes;

      const status: ScanSession["status"] =
        deltaBytes === 0 ? "up-to-date" : reviewedAt === null ? "never-reviewed" : "needs-review";

      sessions.push({
        profileId,
        sessionId,
        deltaBytes,
        totalBytes,
        reviewedBytes,
        reviewedAt,
        status
      });
    }
  }

  sessions.sort((left, right) => {
    const leftNeedsReview = left.status === "up-to-date" ? 1 : 0;
    const rightNeedsReview = right.status === "up-to-date" ? 1 : 0;

    if (leftNeedsReview !== rightNeedsReview) {
      return leftNeedsReview - rightNeedsReview;
    }

    if (left.status !== "up-to-date" && right.status !== "up-to-date") {
      const deltaDifference = right.deltaBytes - left.deltaBytes;
      if (deltaDifference !== 0) {
        return deltaDifference;
      }
    }

    return `${left.profileId}/${left.sessionId}`.localeCompare(`${right.profileId}/${right.sessionId}`);
  });

  const summary = sessions.reduce(
    (accumulator, session) => {
      if (session.status === "up-to-date") {
        accumulator.upToDate += 1;
      } else {
        accumulator.needsReview += 1;
      }

      accumulator.totalBytes += session.totalBytes;
      accumulator.reviewedBytes += session.reviewedBytes;
      return accumulator;
    },
    {
      needsReview: 0,
      upToDate: 0,
      totalBytes: 0,
      reviewedBytes: 0
    }
  );

  return {
    sessions,
    summary
  };
}

export async function runCortexScan(dataDir: string): Promise<string> {
  const scanResult = await scanCortexReviewStatus(dataDir);
  const sessionsNeedingReview = scanResult.sessions.filter((result) => result.status !== "up-to-date");
  const unchangedSessions = scanResult.sessions.filter((result) => result.status === "up-to-date");

  const needsReviewLines =
    sessionsNeedingReview.length > 0
      ? sessionsNeedingReview.map((result) => formatNeedsReviewLine(result))
      : ["  (none)"];
  const unchangedLines =
    unchangedSessions.length > 0
      ? unchangedSessions.map((result) => `  ${result.profileId}/${result.sessionId}: no new content`)
      : ["  (none)"];

  return [
    "Sessions with new content since last review:",
    ...needsReviewLines,
    "",
    "Sessions unchanged:",
    ...unchangedLines,
    "",
    `Summary: ${scanResult.summary.needsReview} sessions need review, ${scanResult.summary.upToDate} up to date`
  ].join("\n");
}

function formatNeedsReviewLine(result: ScanSession): string {
  const reviewedLabel = result.reviewedAt ? `last reviewed: ${result.reviewedAt.slice(0, 10)}` : "never reviewed";

  if (result.deltaBytes < 0) {
    return `  ${result.profileId}/${result.sessionId}: needs re-review (compacted: reviewed ${result.reviewedBytes.toLocaleString()} > current ${result.totalBytes.toLocaleString()}; ${reviewedLabel})`;
  }

  return `  ${result.profileId}/${result.sessionId}: ${result.deltaBytes.toLocaleString()} new bytes (${reviewedLabel})`;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
