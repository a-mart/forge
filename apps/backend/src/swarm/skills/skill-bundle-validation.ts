import { TextDecoder } from "node:util";
import type {
  SkillBundleDependencyManager,
  SkillBundleFileEntry,
  SkillBundleIssue,
  SkillBundleManifestV1,
  SkillBundleScriptKind,
  SkillSourceKind
} from "@forge/protocol";
import {
  DEFAULT_SKILL_BUNDLE_MAX_FILE_BYTES,
  DEFAULT_SKILL_BUNDLE_MAX_FILES,
  DEFAULT_SKILL_BUNDLE_MAX_TOTAL_BYTES,
  SHAREABLE_SKILL_SOURCE_KINDS,
  SKILL_BUNDLE_FORMAT,
  SKILL_BUNDLE_SKILL_FILE_NAME,
  SKILL_BUNDLE_VERSION
} from "./skill-bundle-constants.js";
import { computeSkillBundleContentSha256, sha256Hex } from "./skill-bundle-canonical.js";
import { SkillBundleError } from "./skill-bundle-errors.js";
import { analyzeFrontmatter, buildPortabilityMetadata } from "./skill-bundle-portability.js";
import { parseSkillFrontmatter } from "./skill-frontmatter.js";
import { assertValidSkillHandle, errorToMessage, normalizeSkillBundleFilePath } from "./skill-bundle-paths.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface SkillBundleValidationResult {
  valid: boolean;
  errors: SkillBundleIssue[];
  warnings: SkillBundleIssue[];
  contentSha256?: string;
}

interface ManifestFileValidation {
  file?: SkillBundleFileEntry;
  rawBytes?: Buffer;
}

export class SkillBundleValidationError extends SkillBundleError {
  readonly issues: SkillBundleIssue[];

  constructor(issues: SkillBundleIssue[]) {
    super("invalid_skill_bundle", issues.map((issue) => issue.message).join("; ") || "Invalid skill bundle.");
    this.name = "SkillBundleValidationError";
    this.issues = issues;
  }
}

export function validateSkillBundleManifest(
  candidate: unknown,
  options: {
    maxFileBytes?: number;
    maxTotalBytes?: number;
    maxFiles?: number;
  } = {}
): SkillBundleValidationResult {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_SKILL_BUNDLE_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_SKILL_BUNDLE_MAX_TOTAL_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_SKILL_BUNDLE_MAX_FILES;
  const errors: SkillBundleIssue[] = [];
  const warnings: SkillBundleIssue[] = [];

  if (!isRecord(candidate)) {
    return {
      valid: false,
      errors: [issue("error", "invalid_bundle", "Skill bundle must be a JSON object.")],
      warnings
    };
  }

  rejectUnknownKeys(
    candidate,
    ["format", "bundleVersion", "createdAt", "contentSha256", "origin", "skill", "portability", "files", "totals"],
    errors,
    "Skill bundle"
  );

  if (candidate.format !== SKILL_BUNDLE_FORMAT) {
    errors.push(issue("error", "invalid_format", "Unsupported skill bundle format."));
  }
  if (candidate.bundleVersion !== SKILL_BUNDLE_VERSION) {
    errors.push(issue("error", "invalid_bundle_version", "Unsupported skill bundle version."));
  }
  if (typeof candidate.createdAt !== "string" || Number.isNaN(Date.parse(candidate.createdAt))) {
    errors.push(issue("error", "invalid_created_at", "Skill bundle createdAt must be an ISO timestamp."));
  }
  if (typeof candidate.contentSha256 !== "string" || !SHA256_PATTERN.test(candidate.contentSha256)) {
    errors.push(issue("error", "invalid_content_hash", "Skill bundle contentSha256 must be a sha256 hex digest."));
  }

  validateOrigin(candidate.origin, errors);
  validateSkillSummary(candidate.skill, errors, warnings);
  validatePortability(candidate.portability, errors);

  const fileValidation = validateBundleFiles(candidate.files, { maxFileBytes, maxTotalBytes, maxFiles }, errors);
  validateTotals(candidate.totals, fileValidation, errors, maxTotalBytes);
  validateDerivedMetadata(candidate, fileValidation, errors);

  let contentSha256: string | undefined;
  if (errors.length === 0) {
    contentSha256 = computeSkillBundleContentSha256(candidate as unknown as SkillBundleManifestV1);
    if (contentSha256 !== candidate.contentSha256) {
      errors.push(issue("error", "content_hash_mismatch", "Skill bundle contentSha256 does not match bundle contents."));
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    ...(contentSha256 ? { contentSha256 } : {})
  };
}

function validateOrigin(origin: unknown, errors: SkillBundleIssue[]): void {
  if (!isRecord(origin)) {
    errors.push(issue("error", "invalid_origin", "Skill bundle origin must be an object."));
    return;
  }

  rejectUnknownKeys(origin, ["forgeVersion", "platform", "arch", "osRelease", "skillSourceKind", "profileId"], errors, "Skill bundle origin");

  if (origin.forgeVersion !== undefined && typeof origin.forgeVersion !== "string") {
    errors.push(issue("error", "invalid_origin_forge_version", "Skill bundle origin forgeVersion must be a string."));
  }
  if (typeof origin.platform !== "string" || origin.platform.trim().length === 0) {
    errors.push(issue("error", "invalid_origin_platform", "Skill bundle origin platform is required."));
  }
  if (typeof origin.arch !== "string" || origin.arch.trim().length === 0) {
    errors.push(issue("error", "invalid_origin_arch", "Skill bundle origin arch is required."));
  }
  if (origin.osRelease !== undefined && typeof origin.osRelease !== "string") {
    errors.push(issue("error", "invalid_origin_os_release", "Skill bundle origin osRelease must be a string."));
  }
  if (!isValidSkillSourceKind(origin.skillSourceKind)) {
    errors.push(issue("error", "invalid_origin_source", "Skill bundle origin skillSourceKind is invalid."));
  }
  if (origin.skillSourceKind !== undefined && !SHAREABLE_SKILL_SOURCE_KINDS.has(origin.skillSourceKind as SkillSourceKind)) {
    errors.push(issue("error", "unshareable_origin_source", "Skill bundle origin must be a user-created global or project skill."));
  }
  if (origin.skillSourceKind === "profile" && (typeof origin.profileId !== "string" || origin.profileId.trim().length === 0)) {
    errors.push(issue("error", "invalid_origin_profile", "Profile skill bundles must include origin.profileId."));
  }
  if (origin.skillSourceKind !== "profile" && origin.profileId !== undefined) {
    errors.push(issue("error", "invalid_origin_profile", "Only profile skill bundles may include origin.profileId."));
  }
}

function validateSkillSummary(skill: unknown, errors: SkillBundleIssue[], warnings: SkillBundleIssue[]): void {
  if (!isRecord(skill)) {
    errors.push(issue("error", "invalid_skill", "Skill bundle skill summary must be an object."));
    return;
  }

  rejectUnknownKeys(skill, ["handle", "name", "description", "env", "frontmatter"], errors, "Skill bundle skill summary");

  try {
    assertValidSkillHandle(skill.handle);
  } catch (error) {
    errors.push(issue("error", "invalid_skill_handle", errorToMessage(error)));
  }

  if (typeof skill.name !== "string" || skill.name.trim().length === 0) {
    errors.push(issue("error", "invalid_skill_name", "Skill bundle skill name is required."));
  }
  if (skill.description !== undefined && typeof skill.description !== "string") {
    errors.push(issue("error", "invalid_skill_description", "Skill bundle skill description must be a string."));
  }

  validateSkillEnv(skill.env, errors);
  validateFrontmatterSummary(skill.frontmatter, errors, warnings);
}

function validateSkillEnv(envValue: unknown, errors: SkillBundleIssue[]): void {
  if (!Array.isArray(envValue)) {
    errors.push(issue("error", "invalid_skill_env", "Skill bundle env declarations must be an array."));
    return;
  }

  const seenEnv = new Set<string>();
  for (const [index, env] of envValue.entries()) {
    if (!isRecord(env)) {
      errors.push(issue("error", "invalid_skill_env", `Skill env declaration ${index + 1} must be an object.`));
      continue;
    }

    rejectUnknownKeys(env, ["name", "description", "required", "helpUrl"], errors, `Skill env declaration ${index + 1}`);

    if (typeof env.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env.name)) {
      errors.push(issue("error", "invalid_skill_env_name", `Skill env declaration ${index + 1} has an invalid name.`));
    } else if (seenEnv.has(env.name)) {
      errors.push(issue("error", "duplicate_skill_env_name", `Duplicate skill env declaration: ${env.name}.`));
    } else {
      seenEnv.add(env.name);
    }

    if (env.description !== undefined && typeof env.description !== "string") {
      errors.push(issue("error", "invalid_skill_env_description", `Skill env declaration ${index + 1} description must be a string.`));
    }
    if (typeof env.required !== "boolean") {
      errors.push(issue("error", "invalid_skill_env_required", `Skill env declaration ${index + 1} required must be a boolean.`));
    }
    if (env.helpUrl !== undefined && typeof env.helpUrl !== "string") {
      errors.push(issue("error", "invalid_skill_env_help", `Skill env declaration ${index + 1} helpUrl must be a string.`));
    }
  }
}

function validateFrontmatterSummary(frontmatter: unknown, errors: SkillBundleIssue[], warnings: SkillBundleIssue[]): void {
  if (!isRecord(frontmatter)) {
    errors.push(issue("error", "invalid_frontmatter", "Skill bundle frontmatter summary must be an object."));
    return;
  }

  rejectUnknownKeys(frontmatter, ["knownForgeKeys", "knownPiKeys", "unsupportedKeys", "warnings"], errors, "Skill bundle frontmatter summary");

  for (const key of ["knownForgeKeys", "knownPiKeys", "unsupportedKeys", "warnings"] as const) {
    if (!Array.isArray(frontmatter[key]) || !frontmatter[key].every((value) => typeof value === "string")) {
      errors.push(issue("error", "invalid_frontmatter", `Skill bundle frontmatter ${key} must be a string array.`));
    }
  }
  if (Array.isArray(frontmatter.warnings)) {
    for (const warning of frontmatter.warnings) {
      if (typeof warning === "string" && warning.trim().length > 0) {
        warnings.push(issue("warning", "frontmatter_warning", warning));
      }
    }
  }
}

function validatePortability(portability: unknown, errors: SkillBundleIssue[]): void {
  if (!isRecord(portability)) {
    errors.push(issue("error", "invalid_portability", "Skill bundle portability metadata must be an object."));
    return;
  }

  rejectUnknownKeys(portability, ["osIndicators", "scripts", "dependencies"], errors, "Skill bundle portability metadata");

  validateOsIndicators(portability.osIndicators, errors);
  validateScripts(portability.scripts, errors);
  validateDependencies(portability.dependencies, errors);
}

function validateOsIndicators(osIndicators: unknown, errors: SkillBundleIssue[]): void {
  if (!Array.isArray(osIndicators)) {
    errors.push(issue("error", "invalid_os_indicators", "Skill bundle osIndicators must be an array."));
    return;
  }

  for (const [index, indicator] of osIndicators.entries()) {
    if (!isRecord(indicator)) {
      errors.push(issue("error", "invalid_os_indicator", `OS indicator ${index + 1} must be an object.`));
      continue;
    }
    rejectUnknownKeys(indicator, ["path", "token", "severity"], errors, `OS indicator ${index + 1}`);
    validateOptionalBundlePath(indicator.path, errors, `OS indicator ${index + 1}`);
    if (typeof indicator.token !== "string" || indicator.token.trim().length === 0) {
      errors.push(issue("error", "invalid_os_indicator", `OS indicator ${index + 1} token is required.`));
    }
    if (indicator.severity !== "info" && indicator.severity !== "warning") {
      errors.push(issue("error", "invalid_os_indicator", `OS indicator ${index + 1} severity is invalid.`));
    }
  }
}

function validateScripts(scripts: unknown, errors: SkillBundleIssue[]): void {
  if (!Array.isArray(scripts)) {
    errors.push(issue("error", "invalid_scripts", "Skill bundle scripts must be an array."));
    return;
  }

  for (const [index, script] of scripts.entries()) {
    if (!isRecord(script)) {
      errors.push(issue("error", "invalid_script", `Script ${index + 1} must be an object.`));
      continue;
    }
    rejectUnknownKeys(script, ["path", "kind", "shebang", "executable", "warnings"], errors, `Script ${index + 1}`);
    validateOptionalBundlePath(script.path, errors, `Script ${index + 1}`);
    if (!isValidScriptKind(script.kind)) {
      errors.push(issue("error", "invalid_script", `Script ${index + 1} kind is invalid.`));
    }
    if (script.shebang !== undefined && typeof script.shebang !== "string") {
      errors.push(issue("error", "invalid_script", `Script ${index + 1} shebang must be a string.`));
    }
    if (script.executable !== undefined && typeof script.executable !== "boolean") {
      errors.push(issue("error", "invalid_script", `Script ${index + 1} executable must be a boolean.`));
    }
    if (!Array.isArray(script.warnings) || !script.warnings.every((value) => typeof value === "string")) {
      errors.push(issue("error", "invalid_script", `Script ${index + 1} warnings must be a string array.`));
    }
  }
}

function validateDependencies(dependencies: unknown, errors: SkillBundleIssue[]): void {
  if (!Array.isArray(dependencies)) {
    errors.push(issue("error", "invalid_dependencies", "Skill bundle dependencies must be an array."));
    return;
  }

  for (const [index, dependency] of dependencies.entries()) {
    if (!isRecord(dependency)) {
      errors.push(issue("error", "invalid_dependency", `Dependency ${index + 1} must be an object.`));
      continue;
    }
    rejectUnknownKeys(dependency, ["path", "manager", "summary", "warnings"], errors, `Dependency ${index + 1}`);
    validateOptionalBundlePath(dependency.path, errors, `Dependency ${index + 1}`);
    if (!isValidDependencyManager(dependency.manager)) {
      errors.push(issue("error", "invalid_dependency", `Dependency ${index + 1} manager is invalid.`));
    }
    if (typeof dependency.summary !== "string" || dependency.summary.trim().length === 0) {
      errors.push(issue("error", "invalid_dependency", `Dependency ${index + 1} summary is required.`));
    }
    if (!Array.isArray(dependency.warnings) || !dependency.warnings.every((value) => typeof value === "string")) {
      errors.push(issue("error", "invalid_dependency", `Dependency ${index + 1} warnings must be a string array.`));
    }
  }
}

function validateBundleFiles(
  files: unknown,
  limits: { maxFileBytes: number; maxTotalBytes: number; maxFiles: number },
  errors: SkillBundleIssue[]
): ManifestFileValidation[] {
  if (!Array.isArray(files)) {
    errors.push(issue("error", "invalid_files", "Skill bundle files must be an array."));
    return [];
  }

  if (files.length === 0) {
    errors.push(issue("error", "empty_files", "Skill bundle must include at least one file."));
  }
  if (files.length > limits.maxFiles) {
    errors.push(issue("error", "too_many_files", `Skill bundle exceeds ${limits.maxFiles} file limit.`));
  }

  const seenPaths = new Set<string>();
  const seenCaseInsensitivePaths = new Map<string, string>();
  const validatedFiles: ManifestFileValidation[] = [];
  let byteCount = 0;
  let hasSkillFile = false;

  for (const [index, value] of files.entries()) {
    if (!isRecord(value)) {
      errors.push(issue("error", "invalid_file", `Bundle file ${index + 1} must be an object.`));
      validatedFiles.push({});
      continue;
    }

    rejectUnknownKeys(value, ["path", "size", "sha256", "encoding", "executable", "content"], errors, `Bundle file ${index + 1}`);

    const pathValue = value.path;
    let normalizedPath: string | undefined;
    if (typeof pathValue !== "string") {
      errors.push(issue("error", "invalid_file_path", `Bundle file ${index + 1} path is required.`));
    } else {
      normalizedPath = validateBundleFilePath(pathValue, seenPaths, seenCaseInsensitivePaths, errors);
      if (normalizedPath === SKILL_BUNDLE_SKILL_FILE_NAME) {
        hasSkillFile = true;
      }
    }

    validateBundleFileShape(value, index, normalizedPath, limits.maxFileBytes, errors);
    if (typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0) {
      byteCount += value.size;
    }

    const decoded = typeof value.content === "string" ? decodeManifestFileContent(value.encoding, value.content) : undefined;
    if (!decoded) {
      if (typeof value.content === "string") {
        errors.push(issue("error", "invalid_file_content", `Bundle file ${pathValue ?? index + 1} content is not valid ${String(value.encoding)}.`, normalizedPath));
      }
      validatedFiles.push({});
      continue;
    }

    validateDecodedBundleFile(value, decoded, index, normalizedPath, errors);
    validatedFiles.push({
      file: value as unknown as SkillBundleFileEntry,
      rawBytes: decoded
    });
  }

  if (!hasSkillFile) {
    errors.push(issue("error", "missing_skill_file", "Skill bundle must include SKILL.md."));
  }
  if (byteCount > limits.maxTotalBytes) {
    errors.push(issue("error", "bundle_too_large", `Skill bundle exceeds ${limits.maxTotalBytes} byte limit.`));
  }

  return validatedFiles;
}

function validateBundleFilePath(
  pathValue: string,
  seenPaths: Set<string>,
  seenCaseInsensitivePaths: Map<string, string>,
  errors: SkillBundleIssue[]
): string | undefined {
  try {
    const normalizedPath = normalizeSkillBundleFilePath(pathValue);
    if (normalizedPath !== pathValue) {
      errors.push(issue("error", "invalid_file_path", `Bundle file ${pathValue} path is not normalized.`, pathValue));
    }
    if (seenPaths.has(normalizedPath)) {
      errors.push(issue("error", "duplicate_file_path", `Duplicate bundle file path: ${normalizedPath}.`, normalizedPath));
    }

    const caseInsensitivePath = normalizedPath.toLocaleLowerCase("en-US");
    const existingCaseInsensitivePath = seenCaseInsensitivePaths.get(caseInsensitivePath);
    if (existingCaseInsensitivePath && existingCaseInsensitivePath !== normalizedPath) {
      errors.push(issue(
        "error",
        "duplicate_file_path_case_insensitive",
        `Bundle file path ${normalizedPath} collides case-insensitively with ${existingCaseInsensitivePath}.`,
        normalizedPath
      ));
    }

    seenPaths.add(normalizedPath);
    seenCaseInsensitivePaths.set(caseInsensitivePath, normalizedPath);
    return normalizedPath;
  } catch (error) {
    errors.push(issue("error", "invalid_file_path", errorToMessage(error), pathValue));
    return undefined;
  }
}

function validateBundleFileShape(
  value: Record<string, unknown>,
  index: number,
  normalizedPath: string | undefined,
  maxFileBytes: number,
  errors: SkillBundleIssue[]
): void {
  const pathLabel = typeof value.path === "string" ? value.path : index + 1;
  if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0) {
    errors.push(issue("error", "invalid_file_size", `Bundle file ${pathLabel} size is invalid.`, normalizedPath));
  } else if (value.size > maxFileBytes) {
    errors.push(issue("error", "file_too_large", `Bundle file ${pathLabel} exceeds ${maxFileBytes} byte limit.`, normalizedPath));
  }

  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
    errors.push(issue("error", "invalid_file_hash", `Bundle file ${pathLabel} sha256 is invalid.`, normalizedPath));
  }
  if (value.encoding !== "utf8" && value.encoding !== "base64") {
    errors.push(issue("error", "invalid_file_encoding", `Bundle file ${pathLabel} encoding is invalid.`, normalizedPath));
  }
  if (value.executable !== undefined && typeof value.executable !== "boolean") {
    errors.push(issue("error", "invalid_file_executable", `Bundle file ${pathLabel} executable must be a boolean.`, normalizedPath));
  }
  if (typeof value.content !== "string") {
    errors.push(issue("error", "invalid_file_content", `Bundle file ${pathLabel} content must be a string.`, normalizedPath));
  }
}

function validateDecodedBundleFile(
  value: Record<string, unknown>,
  decoded: Buffer,
  index: number,
  normalizedPath: string | undefined,
  errors: SkillBundleIssue[]
): void {
  const pathLabel = typeof value.path === "string" ? value.path : index + 1;
  if (typeof value.size === "number" && decoded.byteLength !== value.size) {
    errors.push(issue("error", "file_size_mismatch", `Bundle file ${pathLabel} size does not match decoded content.`, normalizedPath));
  }
  if (typeof value.sha256 === "string" && SHA256_PATTERN.test(value.sha256) && sha256Hex(decoded) !== value.sha256) {
    errors.push(issue("error", "file_hash_mismatch", `Bundle file ${pathLabel} sha256 does not match decoded content.`, normalizedPath));
  }
}

function validateTotals(
  totals: unknown,
  files: ManifestFileValidation[],
  errors: SkillBundleIssue[],
  maxTotalBytes: number
): void {
  if (!isRecord(totals)) {
    errors.push(issue("error", "invalid_totals", "Skill bundle totals must be an object."));
    return;
  }

  rejectUnknownKeys(totals, ["fileCount", "byteCount"], errors, "Skill bundle totals");

  const fileCount = files.filter((file) => file.file !== undefined).length;
  const byteCount = files.reduce((sum, file) => sum + (file.rawBytes?.byteLength ?? 0), 0);

  if (totals.fileCount !== fileCount) {
    errors.push(issue("error", "file_count_mismatch", "Skill bundle totals.fileCount does not match files."));
  }
  if (totals.byteCount !== byteCount) {
    errors.push(issue("error", "byte_count_mismatch", "Skill bundle totals.byteCount does not match files."));
  }
  if (typeof totals.byteCount === "number" && totals.byteCount > maxTotalBytes) {
    errors.push(issue("error", "bundle_too_large", `Skill bundle totals exceed ${maxTotalBytes} byte limit.`));
  }
}

function validateDerivedMetadata(
  candidate: Record<string, unknown>,
  files: ManifestFileValidation[],
  errors: SkillBundleIssue[]
): void {
  if (!isRecord(candidate.skill) || !isRecord(candidate.portability)) {
    return;
  }

  const usableFiles = files.filter((file): file is Required<ManifestFileValidation> => file.file !== undefined && file.rawBytes !== undefined);
  if (usableFiles.length !== files.length) {
    return;
  }

  const decodedFiles = usableFiles.map((file) => ({
    file: file.file,
    rawBytes: file.rawBytes,
    textContent: decodeUtf8Text(file.rawBytes)
  }));

  for (const decoded of decodedFiles) {
    const expectedEncoding = decoded.textContent === undefined ? "base64" : "utf8";
    if (decoded.file.encoding !== expectedEncoding) {
      errors.push(issue(
        "error",
        "file_encoding_mismatch",
        `Bundle file ${decoded.file.path} encoding does not match canonical encoding for decoded content.`,
        decoded.file.path
      ));
    }
  }

  const skillFile = decodedFiles.find((file) => file.file.path === SKILL_BUNDLE_SKILL_FILE_NAME);
  if (!skillFile) {
    return;
  }
  if (skillFile.textContent === undefined || skillFile.file.encoding !== "utf8") {
    errors.push(issue("error", "invalid_skill_file", "SKILL.md must be UTF-8 text.", SKILL_BUNDLE_SKILL_FILE_NAME));
    return;
  }

  const handle = typeof candidate.skill.handle === "string" ? candidate.skill.handle : "";
  const parsedFrontmatter = parseSkillFrontmatter(skillFile.textContent);
  const expectedSkill = {
    handle,
    name: (parsedFrontmatter.name ?? handle).trim(),
    ...(parsedFrontmatter.description ? { description: parsedFrontmatter.description } : {}),
    env: parsedFrontmatter.env.map((entry) => ({ ...entry })),
    frontmatter: analyzeFrontmatter(skillFile.textContent)
  };
  assertJsonEqual(candidate.skill, expectedSkill, "skill_metadata_mismatch", "Skill bundle skill metadata does not match SKILL.md contents.", errors);

  const expectedPortability = buildPortabilityMetadata(
    decodedFiles.map((file) => ({
      entry: file.file,
      ...(file.textContent !== undefined ? { textContent: file.textContent } : {})
    })),
    parsedFrontmatter.env.map((entry) => entry.name)
  );
  assertJsonEqual(
    candidate.portability,
    expectedPortability,
    "portability_metadata_mismatch",
    "Skill bundle portability metadata does not match decoded file contents.",
    errors
  );
}

function assertJsonEqual(
  actual: unknown,
  expected: unknown,
  code: string,
  message: string,
  errors: SkillBundleIssue[]
): void {
  if (stableJsonStringify(actual) !== stableJsonStringify(expected)) {
    errors.push(issue("error", code, message));
  }
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((left, right) => left.localeCompare(right));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`).join(",")}}`;
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

function decodeManifestFileContent(encoding: unknown, content: string): Buffer | undefined {
  if (encoding === "utf8") {
    if (content.includes("\0")) {
      return undefined;
    }
    return Buffer.from(content, "utf8");
  }

  if (encoding !== "base64" || !/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length % 4 !== 0) {
    return undefined;
  }

  return Buffer.from(content, "base64");
}

function validateOptionalBundlePath(value: unknown, errors: SkillBundleIssue[], label: string): void {
  if (typeof value !== "string") {
    errors.push(issue("error", "invalid_portability_path", `${label} path is required.`));
    return;
  }

  try {
    normalizeSkillBundleFilePath(value);
  } catch (error) {
    errors.push(issue("error", "invalid_portability_path", `${label} path is invalid: ${errorToMessage(error)}`, value));
  }
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  errors: SkillBundleIssue[],
  label: string
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      errors.push(issue("error", "unknown_field", `${label} contains unsupported field: ${key}.`));
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidSkillSourceKind(value: unknown): value is SkillSourceKind {
  return value === "builtin" || value === "repo" || value === "machine-local" || value === "profile";
}

function isValidScriptKind(value: unknown): value is SkillBundleScriptKind {
  return value === "shell" || value === "powershell" || value === "batch" || value === "node" || value === "python" || value === "ruby" || value === "go" || value === "rust" || value === "other";
}

function isValidDependencyManager(value: unknown): value is SkillBundleDependencyManager {
  return value === "npm" || value === "pnpm" || value === "yarn" || value === "pip" || value === "uv" || value === "poetry" || value === "cargo" || value === "go" || value === "other";
}

function issue(severity: SkillBundleIssue["severity"], code: string, message: string, path?: string): SkillBundleIssue {
  return {
    severity,
    code,
    message,
    ...(path ? { path } : {})
  };
}
