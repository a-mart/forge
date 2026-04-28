import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isCollaborationServerRuntimeTarget } from "../../runtime-target.js";
import type { SwarmConfig } from "../../swarm/types.js";

export async function getCollaborationAuthSecret(config: SwarmConfig): Promise<string> {
  if (!isCollaborationServerRuntimeTarget(config.runtimeTarget)) {
    throw new Error("Collaboration auth secret requested while collaboration server runtime is disabled");
  }

  const envSecret = normalizeSecret(config.collaborationAuthSecret);
  if (envSecret) {
    return envSecret;
  }

  const secretPath = config.paths.collaborationAuthSecretPath;
  if (!secretPath) {
    throw new Error("Missing collaboration auth secret path in config");
  }

  const persistedSecret = await readPersistedSecret(secretPath);
  if (persistedSecret) {
    return persistedSecret;
  }

  const generatedSecret = randomBytes(32).toString("hex");
  await mkdir(dirname(secretPath), { recursive: true });
  await writeFile(secretPath, `${generatedSecret}\n`, "utf8");
  return generatedSecret;
}

async function readPersistedSecret(secretPath: string): Promise<string | null> {
  try {
    return normalizeSecret(await readFile(secretPath, "utf8"));
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      return null;
    }

    throw error;
  }
}

function normalizeSecret(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}
