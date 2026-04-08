import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getSharedDir, sanitizePathSegment } from "../../data-paths.js";

export function getSharedSpecialistsDir(dataDir: string): string {
  return join(getSharedDir(dataDir), "specialists");
}

export function getProfileSpecialistsDir(dataDir: string, profileId: string): string {
  return join(dataDir, "profiles", sanitizePathSegment(profileId), "specialists");
}

const BUILTIN_SPECIALISTS_RELATIVE_DIR = join("apps", "backend", "src", "swarm", "specialists", "builtins");

export function getBuiltinSpecialistsDir(): string {
  const resourcesDir = process.env.FORGE_RESOURCES_DIR?.trim();
  if (resourcesDir) {
    return resolve(resourcesDir, BUILTIN_SPECIALISTS_RELATIVE_DIR);
  }

  return fileURLToPath(new URL("./builtins", import.meta.url));
}
