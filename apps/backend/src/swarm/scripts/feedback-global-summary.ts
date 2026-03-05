import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface ScriptArgs {
  dataDir: string;
  json: boolean;
}

interface FeedbackEvent {
  [key: string]: unknown;
}

interface SessionNeedsFeedbackReview {
  profileId: string;
  sessionId: string;
  feedbackDeltaBytes: number;
  timestampDrift: boolean;
  lastFeedbackAt: string | null;
  feedbackReviewedAt: string | null;
  metaFeedbackSize: number;
}

interface StaleMetaEntry {
  profileId: string;
  sessionId: string;
  metaFeedbackSize: number;
  feedbackReviewedBytes: number;
  feedbackDeltaBytes: number;
  lastFeedbackAt: string | null;
  feedbackReviewedAt: string | null;
}

function parseArgs(argv: string[]): ScriptArgs {
  const args: ScriptArgs = {
    dataDir: process.env.SWARM_DATA_DIR || "/Users/adam/.middleman",
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

async function safeReadJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

async function readFeedbackEvents(path: string): Promise<{
  exists: boolean;
  events: FeedbackEvent[];
  invalidLines: number;
  sizeBytes: number;
}> {
  try {
    const raw = await readFile(path, "utf8");
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
      exists: true,
      events,
      invalidLines,
      sizeBytes: Buffer.byteLength(raw, "utf8")
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { exists: false, events: [], invalidLines: 0, sizeBytes: 0 };
    }
    throw error;
  }
}

function increment(map: Map<string, number>, key: string, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = resolve(args.dataDir);
  const profilesDir = join(dataDir, "profiles");

  let profileEntries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    profileEntries = await readdir(profilesDir, { withFileTypes: true });
  } catch {
    if (args.json) {
      console.log(JSON.stringify({ dataDir, error: "profiles dir not found" }, null, 2));
    } else {
      console.log("No profiles dir.");
    }
    return;
  }

  const byProfileSessions = new Map<string, number>();
  const byProfileEntries = new Map<string, number>();
  const reasonCounts = new Map<string, number>();
  const reasonByValue = new Map<string, number>();
  const valueCounts = new Map<string, number>();
  const scopeCounts = new Map<string, number>();

  const staleMeta: StaleMetaEntry[] = [];
  const sessionsNeedingFeedbackReview: SessionNeedsFeedbackReview[] = [];

  let totalSessions = 0;
  let sessionsWithFeedbackFile = 0;
  let totalFeedbackEntries = 0;
  let totalInvalidLines = 0;

  for (const profileEntry of profileEntries) {
    if (!profileEntry.isDirectory()) {
      continue;
    }

    const profileId = profileEntry.name;
    if (profileId === "cortex") {
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

      totalSessions += 1;
      increment(byProfileSessions, profileId, 1);

      const sessionId = sessionEntry.name;
      const sessionDir = join(sessionsDir, sessionId);
      const meta = await safeReadJson(join(sessionDir, "meta.json"));

      const metaFeedbackSize = parseNumberLike(meta?.feedbackFileSize, 0);
      const feedbackReviewedBytes = parseNumberLike(meta?.cortexReviewedFeedbackBytes, 0);
      const feedbackDeltaBytes = metaFeedbackSize - feedbackReviewedBytes;
      const lastFeedbackAt = typeof meta?.lastFeedbackAt === "string" ? meta.lastFeedbackAt : null;
      const feedbackReviewedAt =
        typeof meta?.cortexReviewedFeedbackAt === "string" ? meta.cortexReviewedFeedbackAt : null;
      const timestampDrift = (() => {
        const last = parseIso(lastFeedbackAt);
        const reviewed = parseIso(feedbackReviewedAt);
        return last !== null && (reviewed === null || last > reviewed);
      })();

      if (feedbackDeltaBytes !== 0 || timestampDrift) {
        sessionsNeedingFeedbackReview.push({
          profileId,
          sessionId,
          feedbackDeltaBytes,
          timestampDrift,
          lastFeedbackAt,
          feedbackReviewedAt,
          metaFeedbackSize
        });
      }

      const feedbackPath = join(sessionDir, "feedback.jsonl");
      const feedback = await readFeedbackEvents(feedbackPath);
      if (feedback.exists) {
        sessionsWithFeedbackFile += 1;
      }

      if (!feedback.exists && metaFeedbackSize > 0) {
        staleMeta.push({
          profileId,
          sessionId,
          metaFeedbackSize,
          feedbackReviewedBytes,
          feedbackDeltaBytes,
          lastFeedbackAt,
          feedbackReviewedAt
        });
      }

      totalFeedbackEntries += feedback.events.length;
      totalInvalidLines += feedback.invalidLines;
      increment(byProfileEntries, profileId, feedback.events.length);

      for (const event of feedback.events) {
        const value = typeof event.value === "string" ? event.value : "unknown";
        const scope = typeof event.scope === "string" ? event.scope : "unknown";
        increment(valueCounts, value);
        increment(scopeCounts, scope);

        const reasonCodes = Array.isArray(event.reasonCodes) ? event.reasonCodes : [];
        for (const codeRaw of reasonCodes) {
          if (typeof codeRaw !== "string" || !codeRaw.trim()) {
            continue;
          }

          const code = codeRaw.trim();
          increment(reasonCounts, code);
          increment(reasonByValue, `${value}:${code}`);
        }
      }
    }
  }

  sessionsNeedingFeedbackReview.sort((left, right) => {
    const leftScore = Math.abs(left.feedbackDeltaBytes) + (left.timestampDrift ? 1000 : 0);
    const rightScore = Math.abs(right.feedbackDeltaBytes) + (right.timestampDrift ? 1000 : 0);
    return rightScore - leftScore;
  });

  const report = {
    generatedAt: new Date().toISOString(),
    dataDir,
    totals: {
      sessionsScanned: totalSessions,
      sessionsWithFeedbackFile,
      totalFeedbackEntries,
      totalInvalidLines,
      sessionsNeedingFeedbackReview: sessionsNeedingFeedbackReview.length,
      staleMetaCount: staleMeta.length
    },
    distributions: {
      byProfileSessions: Object.fromEntries([...byProfileSessions.entries()].sort()),
      byProfileEntries: Object.fromEntries([...byProfileEntries.entries()].sort()),
      valueCounts: Object.fromEntries([...valueCounts.entries()].sort()),
      scopeCounts: Object.fromEntries([...scopeCounts.entries()].sort()),
      reasonCounts: Object.fromEntries(
        [...reasonCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      ),
      reasonByValue: Object.fromEntries(
        [...reasonByValue.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      )
    },
    sessionsNeedingFeedbackReview,
    staleMeta
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("# Feedback Global Summary");
  console.log(`Generated: ${report.generatedAt}`);
  console.log("");
  console.log("## Totals");
  for (const [key, value] of Object.entries(report.totals)) {
    console.log(`- ${key}: ${value}`);
  }

  console.log("");
  console.log("## Distributions");
  console.log(`- valueCounts: ${JSON.stringify(report.distributions.valueCounts)}`);
  console.log(`- scopeCounts: ${JSON.stringify(report.distributions.scopeCounts)}`);
  const topReasons = Object.entries(report.distributions.reasonCounts).slice(0, 10);
  console.log(
    `- topReasons: ${
      topReasons.length > 0 ? topReasons.map(([reason, count]) => `${reason}:${count}`).join(", ") : "(none)"
    }`
  );

  console.log("");
  console.log("## Sessions needing feedback review");
  if (report.sessionsNeedingFeedbackReview.length === 0) {
    console.log("- none");
  } else {
    for (const row of report.sessionsNeedingFeedbackReview.slice(0, 20)) {
      const basis: string[] = [];
      if (row.feedbackDeltaBytes !== 0) {
        basis.push(`delta=${row.feedbackDeltaBytes}`);
      }
      if (row.timestampDrift) {
        basis.push("timestamp-drift");
      }
      console.log(
        `- ${row.profileId}/${row.sessionId} [${basis.join(" + ")}] metaSize=${row.metaFeedbackSize} last=${row.lastFeedbackAt ?? "(none)"} reviewed=${row.feedbackReviewedAt ?? "(none)"}`
      );
    }
  }

  console.log("");
  console.log("## Stale meta (feedbackFileSize > 0 but feedback.jsonl missing)");
  if (report.staleMeta.length === 0) {
    console.log("- none");
  } else {
    for (const row of report.staleMeta.slice(0, 20)) {
      console.log(
        `- ${row.profileId}/${row.sessionId} meta=${row.metaFeedbackSize} reviewedBytes=${row.feedbackReviewedBytes} delta=${row.feedbackDeltaBytes} last=${row.lastFeedbackAt ?? "(none)"}`
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
