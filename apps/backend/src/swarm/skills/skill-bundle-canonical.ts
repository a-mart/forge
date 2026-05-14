import { createHash } from "node:crypto";
import type { SkillBundleFileEntry, SkillBundleManifestV1, SkillBundleOsIndicator } from "@forge/protocol";
import { compareCodePoint } from "./skill-bundle-paths.js";

export function computeSkillBundleContentSha256(bundle: SkillBundleManifestV1): string {
  const canonical = canonicalizeBundleForHash(bundle);
  return sha256Hex(Buffer.from(stableJsonStringify(canonical), "utf8"));
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function compareBundleFiles(left: SkillBundleFileEntry, right: SkillBundleFileEntry): number {
  return compareCodePoint(left.path, right.path);
}

export function compareOsIndicators(left: SkillBundleOsIndicator, right: SkillBundleOsIndicator): number {
  return compareCodePoint(`${left.path}\0${left.token}`, `${right.path}\0${right.token}`);
}

function canonicalizeBundleForHash(bundle: SkillBundleManifestV1): unknown {
  return {
    format: bundle.format,
    bundleVersion: bundle.bundleVersion,
    origin: {
      ...(bundle.origin.forgeVersion ? { forgeVersion: bundle.origin.forgeVersion } : {}),
      platform: bundle.origin.platform,
      arch: bundle.origin.arch,
      ...(bundle.origin.osRelease ? { osRelease: bundle.origin.osRelease } : {}),
      skillSourceKind: bundle.origin.skillSourceKind,
      ...(bundle.origin.profileId ? { profileId: bundle.origin.profileId } : {})
    },
    skill: {
      handle: bundle.skill.handle,
      name: bundle.skill.name,
      ...(bundle.skill.description ? { description: bundle.skill.description } : {}),
      env: bundle.skill.env.map((entry) => ({
        name: entry.name,
        ...(entry.description ? { description: entry.description } : {}),
        required: entry.required,
        ...(entry.helpUrl ? { helpUrl: entry.helpUrl } : {})
      })),
      frontmatter: {
        knownForgeKeys: [...bundle.skill.frontmatter.knownForgeKeys].sort(compareCodePoint),
        knownPiKeys: [...bundle.skill.frontmatter.knownPiKeys].sort(compareCodePoint),
        unsupportedKeys: [...bundle.skill.frontmatter.unsupportedKeys].sort(compareCodePoint),
        warnings: [...bundle.skill.frontmatter.warnings]
      }
    },
    portability: {
      osIndicators: [...bundle.portability.osIndicators].sort(compareOsIndicators).map((entry) => ({
        path: entry.path,
        token: entry.token,
        severity: entry.severity
      })),
      scripts: [...bundle.portability.scripts].sort((left, right) => compareCodePoint(left.path, right.path)).map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        ...(entry.shebang ? { shebang: entry.shebang } : {}),
        executable: entry.executable === true,
        warnings: [...entry.warnings]
      })),
      dependencies: [...bundle.portability.dependencies].sort((left, right) => compareCodePoint(left.path, right.path)).map((entry) => ({
        path: entry.path,
        manager: entry.manager,
        summary: entry.summary,
        warnings: [...entry.warnings]
      }))
    },
    files: [...bundle.files].sort(compareBundleFiles).map((entry) => ({
      path: entry.path,
      size: entry.size,
      sha256: entry.sha256,
      encoding: entry.encoding,
      executable: entry.executable === true,
      content: entry.content
    })),
    totals: {
      fileCount: bundle.totals.fileCount,
      byteCount: bundle.totals.byteCount
    }
  };
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareCodePoint);

  return `{${entries.map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`).join(",")}}`;
}
