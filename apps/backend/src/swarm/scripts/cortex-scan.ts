import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface ScanResult {
  profileId: string;
  sessionId: string;
  delta: number;
  sessionFileSize: number;
  reviewedBytes: number;
  reviewedAt: string | null;
}

export async function runCortexScan(dataDir: string): Promise<string> {
  const sessionsNeedingReview: ScanResult[] = [];
  const unchangedSessions: ScanResult[] = [];

  const profilesDir = join(resolve(dataDir), "profiles");
  let profileEntries: Array<{ name: string; isDirectory: () => boolean }> = [];

  try {
    profileEntries = await readdir(profilesDir, { withFileTypes: true });
  } catch {
    return [
      "Sessions with new content since last review:",
      "  (none)",
      "",
      "Sessions unchanged:",
      "  (none)",
      "",
      "Summary: 0 sessions need review, 0 up to date"
    ].join("\n");
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
      const sessionFileSizeRaw = parsed?.stats?.sessionFileSize;
      const sessionFileSize = typeof sessionFileSizeRaw === "string" ? Number.parseInt(sessionFileSizeRaw, 10) : NaN;
      if (!Number.isFinite(sessionFileSize)) {
        continue;
      }

      const reviewedBytes =
        typeof parsed?.cortexReviewedBytes === "number" && Number.isFinite(parsed.cortexReviewedBytes)
          ? parsed.cortexReviewedBytes
          : 0;
      const reviewedAt = typeof parsed?.cortexReviewedAt === "string" ? parsed.cortexReviewedAt : null;
      const delta = sessionFileSize - reviewedBytes;

      const result: ScanResult = {
        profileId,
        sessionId,
        delta,
        sessionFileSize,
        reviewedBytes,
        reviewedAt
      };

      if (delta === 0) {
        unchangedSessions.push(result);
      } else {
        sessionsNeedingReview.push(result);
      }
    }
  }

  sessionsNeedingReview.sort((left, right) => right.delta - left.delta);
  unchangedSessions.sort((left, right) => `${left.profileId}/${left.sessionId}`.localeCompare(`${right.profileId}/${right.sessionId}`));

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
    `Summary: ${sessionsNeedingReview.length} sessions need review, ${unchangedSessions.length} up to date`
  ].join("\n");
}

function formatNeedsReviewLine(result: ScanResult): string {
  const reviewedLabel = result.reviewedAt ? `last reviewed: ${result.reviewedAt.slice(0, 10)}` : "never reviewed";

  if (result.delta < 0) {
    return `  ${result.profileId}/${result.sessionId}: needs re-review (compacted: reviewed ${result.reviewedBytes.toLocaleString()} > current ${result.sessionFileSize.toLocaleString()}; ${reviewedLabel})`;
  }

  return `  ${result.profileId}/${result.sessionId}: ${result.delta.toLocaleString()} new bytes (${reviewedLabel})`;
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
