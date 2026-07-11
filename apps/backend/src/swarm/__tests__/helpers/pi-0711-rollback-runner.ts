import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FROZEN_PI_0711_SESSION_MANAGER_CANDIDATES = [
  process.env.FORGE_PI_0711_SESSION_MANAGER_JS,
  resolve(
    process.cwd(),
    "..",
    "..",
    ".forge",
    "pi-upgrade-runners",
    "0.71.1",
    "node_modules",
    "@mariozechner",
    "pi-coding-agent",
    "dist",
    "core",
    "session-manager.js",
  ),
].filter((value): value is string => typeof value === "string" && value.length > 0);

export interface FrozenPi0711SessionModule {
  CURRENT_SESSION_VERSION: number;
  SessionManager: {
    open(sessionFile: string, cwd?: string): {
      getSessionId(): string;
      getEntries(): Array<{ type: string; id: string; parentId: string | null; [key: string]: unknown }>;
      getLeafId(): string | null;
      buildSessionContext(): { messages: Array<{ role: string; [key: string]: unknown }>; thinkingLevel: string; model: unknown };
      appendMessage(message: { role: "user" | "assistant"; content: Array<{ type: "text"; text: string }>; [key: string]: unknown }): string;
    };
  };
  buildSessionContext(
    entries: Array<{ type: string; id: string; parentId: string | null; [key: string]: unknown }>,
    leafId?: string | null,
  ): { messages: Array<{ role: string; [key: string]: unknown }>; thinkingLevel: string; model: unknown };
}

export async function loadFrozenPi0711SessionModule(): Promise<FrozenPi0711SessionModule> {
  const attempted: string[] = [];
  for (const candidate of FROZEN_PI_0711_SESSION_MANAGER_CANDIDATES) {
    attempted.push(candidate);
    try {
      await access(candidate);
      await assertFrozenPi0711Identity(candidate);
      return await import(pathToFileURL(candidate).href) as FrozenPi0711SessionModule;
    } catch {
      // Try the next configured frozen runner location. The old runtime is intentionally not a shipped dependency.
    }
  }

  throw new Error(
    `Frozen Pi 0.71.1 rollback runner is required for this gate. Provision it outside shipped deps at .forge/pi-upgrade-runners/0.71.1 or set FORGE_PI_0711_SESSION_MANAGER_JS. Attempted: ${attempted.join(", ")}`,
  );
}

async function assertFrozenPi0711Identity(sessionManagerJs: string): Promise<void> {
  let current = dirname(resolve(sessionManagerJs));
  while (true) {
    const packageJson = resolve(current, "package.json");
    try {
      const manifest = JSON.parse(await readFile(packageJson, "utf8")) as { name?: string; version?: string };
      if (manifest.name === "@mariozechner/pi-coding-agent") {
        if (manifest.version !== "0.71.1") {
          throw new Error(`Frozen Pi rollback runner must be @mariozechner/pi-coding-agent@0.71.1, got ${manifest.version}`);
        }
        return;
      }
    } catch {
      // Continue walking upward until package root is found.
    }
    const parent = resolve(current, "..");
    if (parent === current) {
      throw new Error(`Unable to verify frozen Pi 0.71.1 package identity from ${sessionManagerJs}`);
    }
    current = parent;
  }
}
