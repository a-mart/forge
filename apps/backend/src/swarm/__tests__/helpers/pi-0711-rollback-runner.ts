import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");

const FROZEN_PI_0711_SESSION_MANAGER_CANDIDATES = [
  process.env.FORGE_PI_0711_SESSION_MANAGER_JS,
  resolve(
    repoRoot,
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
  // Vitest often runs with cwd=apps/backend; keep cwd-relative fallback for local overrides.
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
  const errors: string[] = [];
  for (const candidate of FROZEN_PI_0711_SESSION_MANAGER_CANDIDATES) {
    attempted.push(candidate);
    try {
      await access(candidate);
    } catch {
      errors.push(`${candidate}: missing`);
      continue;
    }
    try {
      await assertFrozenPi0711Identity(candidate);
      return await import(pathToFileURL(candidate).href) as FrozenPi0711SessionModule;
    } catch (error) {
      // Identity or import failures are hard errors for a present runner — do not silently skip.
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${candidate}: ${message}`);
      throw new Error(
        `Frozen Pi 0.71.1 rollback runner failed identity/import checks. ${message}. Attempted: ${attempted.join(", ")}`,
      );
    }
  }

  throw new Error(
    `Frozen Pi 0.71.1 rollback runner is required for this gate. Provision it with ./scripts/pi-upgrade/provision-pi-0711-rollback-runner.sh or set FORGE_PI_0711_SESSION_MANAGER_JS. Attempted: ${attempted.join(", ")}${errors.length ? `; details: ${errors.join("; ")}` : ""}`,
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
