import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizePathSegment } from "../data-paths.js";

export function getSharedSpecialistsDir(dataDir: string): string {
  return join(dataDir, "shared", "specialists");
}

export function getProfileSpecialistsDir(dataDir: string, profileId: string): string {
  return join(dataDir, "profiles", sanitizePathSegment(profileId), "specialists");
}

export function getBuiltinSpecialistsDir(): string {
  return fileURLToPath(new URL("./builtins", import.meta.url));
}
