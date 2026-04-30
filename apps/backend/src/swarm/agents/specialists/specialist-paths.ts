import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getSharedDir, sanitizePathSegment } from "../../data-paths.js";

export function getSharedSpecialistsDir(dataDir: string): string {
  return join(getSharedDir(dataDir), "specialists");
}

export function getProfileSpecialistsDir(dataDir: string, profileId: string): string {
  return join(dataDir, "profiles", sanitizePathSegment(profileId), "specialists");
}

const BUILTIN_SPECIALISTS_RELATIVE_DIR = join("apps", "backend", "src", "swarm", "specialists", "builtins");

function firstExistingDirectory(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

export function getBuiltinSpecialistsDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const cwd = process.cwd();
  const resourcesDir = process.env.FORGE_RESOURCES_DIR?.trim();
  const candidates = [
    // Prefer the active checkout/worktree when running from repo root or apps/backend.
    resolve(cwd, BUILTIN_SPECIALISTS_RELATIVE_DIR),
    resolve(cwd, "src", "swarm", "specialists", "builtins"),
  ];

  if (resourcesDir) {
    candidates.push(
      // Electron/Docker staged source assets from the repository/resource root.
      resolve(resourcesDir, BUILTIN_SPECIALISTS_RELATIVE_DIR),
      // Compatibility for packages that stage the backend app root directly.
      resolve(resourcesDir, "src", "swarm", "specialists", "builtins"),
      resolve(resourcesDir, "dist", "swarm", "specialists", "builtins"),
      // Compatibility for older agents-module staging.
      resolve(resourcesDir, "src", "swarm", "agents", "specialists", "builtins"),
      resolve(resourcesDir, "dist", "swarm", "agents", "specialists", "builtins"),
    );
  }

  candidates.push(
    // Old agents-module location. Keep before source-relative fallbacks so staged shims keep working.
    join(moduleDir, "builtins"),
    // Canonical source/dist module location after specialist code moved under agents/.
    resolve(moduleDir, "..", "..", "specialists", "builtins"),
    // Docker/dist fallback: compiled module is under apps/backend/dist, while builtin
    // markdown assets are still shipped from apps/backend/src.
    resolve(moduleDir, "..", "..", "..", "..", "src", "swarm", "specialists", "builtins"),
  );

  return firstExistingDirectory(candidates) ?? candidates[1];
}
