import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | null = null;

/**
 * Best-effort application version for informational surfaces (handshakes,
 * diagnostics). Walks up from this module looking for the nearest
 * `package.json` that carries a `version` field (the workspace root in this
 * repo — package manifests for the apps are versionless). Never throws.
 */
export function getForgeAppVersion(): string {
  if (cachedVersion !== null) {
    return cachedVersion;
  }

  cachedVersion = resolveVersionFromPackageJson() ?? "unknown";
  return cachedVersion;
}

function resolveVersionFromPackageJson(): string | null {
  try {
    let current = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = join(current, "package.json");
      const version = readVersionField(candidate);
      if (version) {
        return version;
      }

      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  } catch {
    // fall through
  }

  return null;
}

function readVersionField(packageJsonPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim().length > 0 ? parsed.version : null;
  } catch {
    return null;
  }
}
