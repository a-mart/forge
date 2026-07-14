import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CodexPluginArtifactFilePort {
  ensureDirectory(path: string): Promise<void>;
  writeUniqueArtifact(input: {
    directory: string;
    baseName: string;
    extension: string;
    body: string;
  }): Promise<string>;
  writeManifest(path: string, body: string): Promise<void>;
}

export function createCodexPluginArtifactFilePort(): CodexPluginArtifactFilePort {
  return {
    ensureDirectory: async (path) => mkdir(path, { recursive: true }).then(() => undefined),
    writeUniqueArtifact: async ({ directory, baseName, extension, body }) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
        const candidate = join(directory, `${baseName}${suffix}.${extension}`);
        try {
          await writeFile(candidate, body, { encoding: "utf8", flag: "wx" });
          return candidate;
        } catch (error) {
          if (isNodeErrorCode(error, "EEXIST")) continue;
          throw error;
        }
      }
      throw new Error("Unable to allocate a unique Codex plugin artifact file name.");
    },
    writeManifest: async (path, body) => writeFile(path, body, "utf8").then(() => undefined),
  };
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}
