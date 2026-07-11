import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const FROZEN_PI_0711_SESSION_MANAGER_CANDIDATES = [
  process.env.FORGE_PI_0711_SESSION_MANAGER_JS,
  "/Users/adam/repos/middleman/node_modules/.pnpm/@mariozechner+pi-coding-agent@0.71.1_patch_hash=7427f9d78ef9bd9c35deb412e4bb9ea5c8656e4_487622cc8e59301a83d1d565cf188f09/node_modules/@mariozechner/pi-coding-agent/dist/core/session-manager.js",
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

export async function loadFrozenPi0711SessionModule(): Promise<FrozenPi0711SessionModule | undefined> {
  for (const candidate of FROZEN_PI_0711_SESSION_MANAGER_CANDIDATES) {
    try {
      await access(candidate);
      return await import(pathToFileURL(candidate).href) as FrozenPi0711SessionModule;
    } catch {
      // Try the next configured frozen runner location. The old runtime is intentionally not a dependency.
    }
  }

  return undefined;
}
