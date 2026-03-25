import { homedir } from "node:os";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

interface ScriptArgs {
  dataDir: string;
  profileId?: string;
  sessionId?: string;
  targets: string[];
  window: number;
  json: boolean;
}

interface SessionEntry {
  lineNumber: number;
  type: string;
  role?: string;
  id?: string;
  timestamp?: string;
  text: string;
}

interface ContextHit {
  target: string;
  hitLine: number;
  context: SessionEntry[];
}

function parseArgs(argv: string[]): ScriptArgs {
  const args: ScriptArgs = {
    dataDir: process.env.SWARM_DATA_DIR || join(homedir(), ".forge"),
    profileId: undefined,
    sessionId: undefined,
    targets: [],
    window: 2,
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
    } else if (arg === "--target") {
      const target = positional[index + 1];
      if (target) {
        args.targets.push(target);
      }
      index += 1;
    } else if (arg === "--window") {
      const windowSize = Number.parseInt(positional[index + 1] ?? "", 10);
      if (Number.isFinite(windowSize)) {
        args.window = windowSize;
      }
      index += 1;
    } else if (arg === "--json") {
      args.json = true;
    }
  }

  if (!args.profileId || !args.sessionId || args.targets.length === 0) {
    throw new Error(
      "Usage: node feedback-target-context.js <data-dir> --profile <id> --session <id> --target <id> [--target <id> ...] [--window <n>] [--json] [--data-dir <dir>]"
    );
  }

  if (!Number.isFinite(args.window) || args.window < 0) {
    args.window = 2;
  }

  return args;
}

function safeText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }

        if (entry && typeof entry === "object") {
          const text = (entry as Record<string, unknown>).text;
          if (typeof text === "string") {
            return text;
          }

          const content = (entry as Record<string, unknown>).content;
          if (typeof content === "string") {
            return content;
          }
        }

        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function extractEntry(raw: Record<string, unknown>, lineNumber: number): SessionEntry {
  const type = typeof raw.type === "string" ? raw.type : "unknown";
  const role = typeof raw.role === "string" ? raw.role : undefined;
  const timestamp = typeof raw.timestamp === "string" ? raw.timestamp : undefined;
  const id = typeof raw.id === "string" ? raw.id : undefined;

  const text =
    [safeText(raw.content), safeText(raw.text), safeText(raw.message)].find((value) => value.trim().length > 0) || "";

  return {
    lineNumber,
    type,
    role,
    id,
    timestamp,
    text: text.slice(0, 1200)
  };
}

function isConversationSignal(entry: SessionEntry | undefined): boolean {
  if (!entry) {
    return false;
  }

  return (
    entry.type === "user_message" ||
    entry.type === "assistant_chunk" ||
    entry.type === "worker_message" ||
    entry.type === "conversation_message" ||
    entry.role === "user" ||
    entry.role === "assistant"
  );
}

async function loadEntries(sessionPath: string): Promise<SessionEntry[]> {
  const entries: SessionEntry[] = [];
  const stream = createReadStream(sessionPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber += 1;

    if (!line.trim()) {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") {
        continue;
      }

      entries.push(extractEntry(parsed as Record<string, unknown>, lineNumber));
    } catch {
      // skip invalid lines
    }
  }

  return entries;
}

function collectContexts(entries: SessionEntry[], targets: string[], windowSize: number): ContextHit[] {
  const targetSet = new Set(targets);
  const hits: ContextHit[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    const isTarget = (entry.id && targetSet.has(entry.id)) || (entry.timestamp && targetSet.has(entry.timestamp));
    if (!isTarget) {
      continue;
    }

    const context: SessionEntry[] = [];

    let backIndex = index - 1;
    while (backIndex >= 0 && context.length < windowSize) {
      if (isConversationSignal(entries[backIndex])) {
        context.unshift(entries[backIndex] as SessionEntry);
      }
      backIndex -= 1;
    }

    context.push(entry);

    let forwardIndex = index + 1;
    let forwardCount = 0;
    while (forwardIndex < entries.length && forwardCount < windowSize) {
      if (isConversationSignal(entries[forwardIndex])) {
        context.push(entries[forwardIndex] as SessionEntry);
        forwardCount += 1;
      }
      forwardIndex += 1;
    }

    hits.push({
      target: entry.id ?? entry.timestamp ?? "unknown",
      hitLine: entry.lineNumber,
      context
    });
  }

  return hits;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sessionPath = join(
    resolve(args.dataDir),
    "profiles",
    args.profileId as string,
    "sessions",
    args.sessionId as string,
    "session.jsonl"
  );

  await access(sessionPath);

  const entries = await loadEntries(sessionPath);
  const contexts = collectContexts(entries, args.targets, args.window);

  const report = {
    generatedAt: new Date().toISOString(),
    profileId: args.profileId,
    sessionId: args.sessionId,
    sessionPath,
    targets: args.targets,
    window: args.window,
    totalParsedEntries: entries.length,
    matchedTargets: contexts.length,
    contexts
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`# Feedback Target Context: ${args.profileId}/${args.sessionId}`);
  console.log(`targets: ${args.targets.join(", ")}`);
  console.log(`matchedTargets: ${contexts.length}`);
  console.log("");

  if (contexts.length === 0) {
    console.log("- no matching target ids found in session.jsonl (by id or timestamp)");
    return;
  }

  for (const hit of contexts) {
    console.log(`## Target: ${hit.target} (line ${hit.hitLine})`);

    for (const row of hit.context) {
      const marker = row.lineNumber === hit.hitLine ? ">>" : "  ";
      const roleOrType = row.role ? row.role : row.type;
      const identifier = row.id ?? row.timestamp ?? "-";
      const preview = row.text.replace(/\s+/g, " ").trim().slice(0, 220);
      console.log(`${marker} [${row.lineNumber}] ${roleOrType} | ${identifier} | ${preview}`);
    }

    console.log("");
  }
}

if (process.env.FORGE_BUNDLED_BACKEND !== "1" && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
