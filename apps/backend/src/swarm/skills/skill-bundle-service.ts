import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { arch as currentArch, release as currentOsRelease } from "node:os";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import type { SkillBundleFileEntry, SkillBundleIssue, SkillBundleManifestV1 } from "@forge/protocol";
import {
  DEFAULT_SKILL_BUNDLE_MAX_FILE_BYTES,
  DEFAULT_SKILL_BUNDLE_MAX_FILES,
  DEFAULT_SKILL_BUNDLE_MAX_TOTAL_BYTES,
  SHAREABLE_SKILL_SOURCE_KINDS,
  SKILL_BUNDLE_FORMAT,
  SKILL_BUNDLE_SKILL_FILE_NAME,
  SKILL_BUNDLE_VERSION
} from "./skill-bundle-constants.js";
import { compareBundleFiles, computeSkillBundleContentSha256, sha256Hex } from "./skill-bundle-canonical.js";
import { SkillBundleError } from "./skill-bundle-errors.js";
import {
  assertValidSkillHandle,
  compareCodePoint,
  errorToMessage,
  isPathWithinRoot,
  isSensitiveSkillEntryName,
  normalizeSkillBundleFilePath,
  toBundleRelativePath
} from "./skill-bundle-paths.js";
import { analyzeFrontmatter, buildPortabilityMetadata } from "./skill-bundle-portability.js";
import {
  SkillBundleValidationError,
  validateSkillBundleManifest,
  type SkillBundleValidationResult
} from "./skill-bundle-validation.js";
import { parseSkillFrontmatter } from "./skill-frontmatter.js";
import type { SkillMetadata, SkillMetadataService } from "./skill-metadata-service.js";

export {
  DEFAULT_SKILL_BUNDLE_MAX_FILE_BYTES,
  DEFAULT_SKILL_BUNDLE_MAX_FILES,
  DEFAULT_SKILL_BUNDLE_MAX_TOTAL_BYTES,
  SKILL_BUNDLE_FORMAT,
  SKILL_BUNDLE_VERSION
} from "./skill-bundle-constants.js";
export { computeSkillBundleContentSha256 } from "./skill-bundle-canonical.js";
export { SkillBundleError } from "./skill-bundle-errors.js";
export { normalizeSkillBundleFilePath } from "./skill-bundle-paths.js";
export { SkillBundleValidationError, validateSkillBundleManifest } from "./skill-bundle-validation.js";
export type { SkillBundleValidationResult } from "./skill-bundle-validation.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const EXCLUDED_ENTRY_NAMES = new Set([
  ".DS_Store",
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".cache",
  ".pytest_cache",
  "__pycache__",
  "target"
]);

interface SkillBundleServiceDependencies {
  skillMetadataService: Pick<SkillMetadataService, "resolveSkillById">;
  now?: () => Date;
  platform?: string;
  arch?: string;
  osRelease?: string;
  forgeVersion?: string;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
}

export interface SkillBundlePackageResult {
  bundle: SkillBundleManifestV1;
  warnings: SkillBundleIssue[];
}

interface CollectedSkillFile {
  absolutePath: string;
  relativePath: string;
  stats: {
    mode: number;
    size: number;
  };
}

interface EncodedSkillFile {
  entry: SkillBundleFileEntry;
  rawBytes: Buffer;
  textContent?: string;
}

export class SkillBundleService {
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxFiles: number;

  constructor(private readonly deps: SkillBundleServiceDependencies) {
    this.maxFileBytes = deps.maxFileBytes ?? DEFAULT_SKILL_BUNDLE_MAX_FILE_BYTES;
    this.maxTotalBytes = deps.maxTotalBytes ?? DEFAULT_SKILL_BUNDLE_MAX_TOTAL_BYTES;
    this.maxFiles = deps.maxFiles ?? DEFAULT_SKILL_BUNDLE_MAX_FILES;
  }

  async packageSkill(skillId: string): Promise<SkillBundlePackageResult> {
    const skill = await this.deps.skillMetadataService.resolveSkillById(skillId);
    if (!skill) {
      throw new SkillBundleError("unknown_skill", "Unknown skill.");
    }

    this.assertShareableSource(skill);
    this.assertShareableHandle(skill.directoryName);
    await this.assertDirectorySkillRoot(skill.rootPath);

    const notices: SkillBundleIssue[] = [];
    const collectedFiles = await this.collectSkillFiles(skill.rootPath, notices);
    const encodedFiles = await this.encodeSkillFiles(collectedFiles);
    const skillFile = encodedFiles.find((file) => file.entry.path === SKILL_BUNDLE_SKILL_FILE_NAME);
    if (!skillFile) {
      throw new SkillBundleError("missing_skill_file", "Skill bundle must include SKILL.md.");
    }
    if (skillFile.textContent === undefined) {
      throw new SkillBundleError("invalid_skill_file", "SKILL.md must be UTF-8 text.", { path: SKILL_BUNDLE_SKILL_FILE_NAME });
    }

    const parsedFrontmatter = parseSkillFrontmatter(skillFile.textContent);
    const files = encodedFiles.map((file) => file.entry).sort(compareBundleFiles);
    const bundle = this.buildBundle({
      skill,
      skillMarkdown: skillFile.textContent,
      parsedName: parsedFrontmatter.name,
      parsedDescription: parsedFrontmatter.description,
      files,
      byteCount: files.reduce((sum, file) => sum + file.size, 0),
      portability: buildPortabilityMetadata(encodedFiles, skill.env.map((entry) => entry.name))
    });

    bundle.contentSha256 = computeSkillBundleContentSha256(bundle);
    const validation = this.validateBundle(bundle);
    if (!validation.valid) {
      throw new SkillBundleValidationError(validation.errors);
    }

    return {
      bundle,
      warnings: [...notices, ...validation.warnings]
    };
  }

  validateBundle(bundle: unknown): SkillBundleValidationResult {
    return validateSkillBundleManifest(bundle, {
      maxFileBytes: this.maxFileBytes,
      maxTotalBytes: this.maxTotalBytes,
      maxFiles: this.maxFiles
    });
  }

  assertValidBundle(bundle: unknown): SkillBundleManifestV1 {
    const result = this.validateBundle(bundle);
    if (!result.valid) {
      throw new SkillBundleValidationError(result.errors);
    }

    return bundle as SkillBundleManifestV1;
  }

  private assertShareableSource(skill: SkillMetadata): void {
    if (!SHAREABLE_SKILL_SOURCE_KINDS.has(skill.sourceKind)) {
      throw new SkillBundleError(
        "unshareable_skill_source",
        "Only user-created global and project skills can be shared in V1."
      );
    }
  }

  private assertShareableHandle(handle: string): void {
    try {
      assertValidSkillHandle(handle);
    } catch (error) {
      throw new SkillBundleError("invalid_skill_handle", errorToMessage(error), { cause: error });
    }
  }

  private async assertDirectorySkillRoot(skillRoot: string): Promise<void> {
    const rootStats = await lstat(skillRoot);
    if (rootStats.isSymbolicLink()) {
      throw new SkillBundleError("invalid_skill_root", "Skill root must not be a symlink.");
    }
    if (!rootStats.isDirectory()) {
      throw new SkillBundleError("invalid_skill_root", "Skill root must be a directory.");
    }
  }

  private buildBundle(options: {
    skill: SkillMetadata;
    skillMarkdown: string;
    parsedName?: string;
    parsedDescription?: string;
    files: SkillBundleFileEntry[];
    byteCount: number;
    portability: SkillBundleManifestV1["portability"];
  }): SkillBundleManifestV1 {
    const { skill, skillMarkdown, parsedName, parsedDescription, files, byteCount, portability } = options;

    return {
      format: SKILL_BUNDLE_FORMAT,
      bundleVersion: SKILL_BUNDLE_VERSION,
      createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
      contentSha256: "",
      origin: {
        ...(this.deps.forgeVersion ? { forgeVersion: this.deps.forgeVersion } : {}),
        platform: this.deps.platform ?? process.platform,
        arch: this.deps.arch ?? currentArch(),
        osRelease: this.deps.osRelease ?? currentOsRelease(),
        skillSourceKind: skill.sourceKind,
        ...(skill.profileId ? { profileId: skill.profileId } : {})
      },
      skill: {
        handle: skill.directoryName,
        name: (parsedName ?? skill.skillName ?? skill.directoryName).trim(),
        ...(parsedDescription ?? skill.description ? { description: parsedDescription ?? skill.description } : {}),
        env: skill.env.map((entry) => ({ ...entry })),
        frontmatter: analyzeFrontmatter(skillMarkdown)
      },
      portability,
      files,
      totals: {
        fileCount: files.length,
        byteCount
      }
    };
  }

  private async collectSkillFiles(skillRoot: string, notices: SkillBundleIssue[]): Promise<CollectedSkillFile[]> {
    const resolvedRoot = resolve(skillRoot);
    const realRoot = await realpath(resolvedRoot);
    const collected: CollectedSkillFile[] = [];
    let totalBytes = 0;

    const visitDirectory = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => compareCodePoint(left.name, right.name));

      for (const entry of entries) {
        const absolutePath = resolve(directory, entry.name);
        const relativePath = toBundleRelativePath(resolvedRoot, absolutePath);
        const pathForNotice = relativePath || entry.name;

        if (isSensitiveSkillEntryName(entry.name)) {
          throw new SkillBundleError("sensitive_file", `Sensitive file is not shareable: ${pathForNotice}`, {
            path: pathForNotice
          });
        }

        if (EXCLUDED_ENTRY_NAMES.has(entry.name)) {
          notices.push({
            severity: "info",
            code: "excluded_entry",
            path: pathForNotice,
            message: `Excluded generated/vendor/cache entry from skill bundle: ${pathForNotice}`
          });
          continue;
        }

        const stats = await lstat(absolutePath);
        if (stats.isSymbolicLink()) {
          throw new SkillBundleError("unsupported_symlink", `Symlinks are not supported in skill bundles: ${pathForNotice}`, {
            path: pathForNotice
          });
        }

        const realEntryPath = await realpath(absolutePath);
        if (!isPathWithinRoot(realEntryPath, realRoot)) {
          throw new SkillBundleError("invalid_skill_path", `Path is outside skill root: ${pathForNotice}`, {
            path: pathForNotice
          });
        }

        if (stats.isDirectory()) {
          await visitDirectory(absolutePath);
          continue;
        }

        if (!stats.isFile()) {
          notices.push({
            severity: "info",
            code: "excluded_special_file",
            path: pathForNotice,
            message: `Excluded non-regular file from skill bundle: ${pathForNotice}`
          });
          continue;
        }

        totalBytes = this.assertWithinSizeLimits(pathForNotice, stats.size, totalBytes, collected.length);
        let normalizedRelativePath: string;
        try {
          normalizedRelativePath = normalizeSkillBundleFilePath(relativePath);
        } catch (error) {
          throw new SkillBundleError("invalid_skill_path", errorToMessage(error), {
            path: pathForNotice,
            cause: error
          });
        }

        collected.push({
          absolutePath,
          relativePath: normalizedRelativePath,
          stats: {
            mode: stats.mode,
            size: stats.size
          }
        });
      }
    };

    await visitDirectory(resolvedRoot);
    collected.sort((left, right) => compareCodePoint(left.relativePath, right.relativePath));
    return collected;
  }

  private assertWithinSizeLimits(pathForNotice: string, fileSize: number, currentTotalBytes: number, currentFileCount: number): number {
    if (fileSize > this.maxFileBytes) {
      throw new SkillBundleError("oversized_file", `File too large for skill bundle: ${pathForNotice} (${fileSize} bytes).`, {
        path: pathForNotice
      });
    }

    const totalBytes = currentTotalBytes + fileSize;
    if (totalBytes > this.maxTotalBytes) {
      throw new SkillBundleError("oversized_bundle", `Skill bundle exceeds ${this.maxTotalBytes} byte limit.`);
    }

    if (currentFileCount + 1 > this.maxFiles) {
      throw new SkillBundleError("too_many_files", `Skill bundle exceeds ${this.maxFiles} file limit.`);
    }

    return totalBytes;
  }

  private async encodeSkillFiles(files: CollectedSkillFile[]): Promise<EncodedSkillFile[]> {
    const encoded: EncodedSkillFile[] = [];

    for (const file of files) {
      const rawBytes = await readFile(file.absolutePath);
      const textContent = decodeUtf8Text(rawBytes);
      const isExecutable = (file.stats.mode & 0o111) !== 0;
      const entry: SkillBundleFileEntry = {
        path: file.relativePath,
        size: rawBytes.byteLength,
        sha256: sha256Hex(rawBytes),
        encoding: textContent === undefined ? "base64" : "utf8",
        ...(isExecutable ? { executable: true } : {}),
        content: textContent === undefined ? rawBytes.toString("base64") : textContent
      };

      encoded.push({ entry, rawBytes, ...(textContent !== undefined ? { textContent } : {}) });
    }

    return encoded;
  }
}

function decodeUtf8Text(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) {
    return undefined;
  }

  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    return undefined;
  }
}
