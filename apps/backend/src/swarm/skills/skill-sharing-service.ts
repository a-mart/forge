import { randomUUID } from "node:crypto";
import { mkdir, rm, lstat, writeFile, chmod } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import type {
  SkillBundleFileEntry,
  SkillBundleIssue,
  SkillBundleManifestV1,
  SkillBundlePreviewFileEntry,
  SkillBundlePreviewManifestV1,
  SkillImportConflictState,
  SkillImportConflictStrategy,
  SkillImportPreviewResponse,
  SkillImportRelatedConflict,
  SkillImportRequest,
  SkillImportResultResponse,
  SkillImportTarget,
  SkillShareResponse
} from "@forge/protocol";
import { getProfilePiSkillsDir, sanitizePathSegment } from "../data-paths.js";
import type { SwarmConfig } from "../types.js";
import { renameWithRetry } from "../retry-rename.js";
import { assertValidSkillHandle, isPathWithinRoot, normalizeSkillBundleFilePath } from "./skill-bundle-paths.js";
import { SkillBundleService, SkillBundleValidationError } from "./skill-bundle-service.js";
import {
  isRequiredSkillDirectoryName,
  type SkillMetadata,
  type SkillMetadataService
} from "./skill-metadata-service.js";

const DEFAULT_SKILL_SHARE_BASE_URL = "https://share.forge.dev";
const SKILL_SHARE_BASE_URL_ENV = "FORGE_SKILL_SHARE_BASE_URL";
const LEGACY_SKILL_SHARE_BASE_URL_ENV = "MIDDLEMAN_SKILL_SHARE_BASE_URL";
const SKILL_SHARE_DISABLED_ENV = "FORGE_SKILL_SHARE_DISABLED";
const LEGACY_SKILL_SHARE_DISABLED_ENV = "MIDDLEMAN_SKILL_SHARE_DISABLED";
const SHARE_UPLOAD_RESPONSE_MAX_BYTES = 1024 * 1024;
const SHARE_DOWNLOAD_MAX_BYTES = 35 * 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_REDIRECT_LIMIT = 2;

export interface SkillSharingServiceOptions {
  config: SwarmConfig;
  skillMetadataService: SkillMetadataService;
  now?: () => Date;
  fetchFn?: typeof fetch;
  shareBaseUrl?: string;
  disabled?: boolean;
  fetchTimeoutMs?: number;
  redirectLimit?: number;
  validateProfileTarget?: (profileId: string) => boolean;
}

export interface PreviewSkillImportUrlOptions {
  url: string;
  target?: SkillImportTarget;
}

export interface PreviewSkillImportBundleOptions {
  bundle: unknown;
  target?: SkillImportTarget;
}

export type ImportSkillOptions = Omit<SkillImportRequest, "source"> & {
  source: {
    url?: string;
    bundle?: unknown;
  };
  conflictStrategy?: SkillImportConflictStrategy;
};

interface ResolvedShareConfig {
  baseUrl: URL;
  disabled: boolean;
}

interface FetchResult {
  status: number;
  headers: Headers;
  bodyText: string;
}

export class SkillSharingError extends Error {
  readonly retryAfter?: string;

  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly details?: unknown,
    retryAfter?: string
  ) {
    super(message);
    this.name = "SkillSharingError";
    this.retryAfter = normalizeRetryAfterValue(retryAfter);
  }
}

export class SkillSharingService {
  private readonly bundleService: SkillBundleService;
  private readonly fetchFn: typeof fetch;
  private readonly shareConfig: ResolvedShareConfig;
  private readonly fetchTimeoutMs: number;
  private readonly redirectLimit: number;

  constructor(private readonly options: SkillSharingServiceOptions) {
    this.bundleService = new SkillBundleService({
      skillMetadataService: options.skillMetadataService,
      now: options.now
    });
    this.fetchFn = options.fetchFn ?? fetch;
    this.shareConfig = resolveShareConfig(options);
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.redirectLimit = options.redirectLimit ?? DEFAULT_REDIRECT_LIMIT;
  }

  async shareSkill(skillId: string): Promise<SkillShareResponse> {
    this.assertShareServiceEnabled("Skill sharing is disabled.");
    const packaged = await this.bundleService.packageSkill(skillId);
    const uploadResponse = await this.uploadBundle(packaged.bundle);
    return {
      ...uploadResponse,
      warnings: dedupeIssues([...packaged.warnings, ...uploadResponse.warnings])
    };
  }

  async previewImportFromUrl(options: PreviewSkillImportUrlOptions): Promise<SkillImportPreviewResponse> {
    const target = normalizeImportTarget(options.target, this.options.validateProfileTarget);
    const bundle = await this.fetchBundleFromShareUrl(options.url);
    return this.previewImportBundle({ bundle, target });
  }

  async previewImportBundle(options: PreviewSkillImportBundleOptions): Promise<SkillImportPreviewResponse> {
    const bundle = this.bundleService.assertValidBundle(options.bundle);
    const target = normalizeImportTarget(options.target, this.options.validateProfileTarget);
    const warnings = this.buildImportWarnings(bundle);
    return {
      bundle: toPreviewBundle(bundle),
      target,
      conflict: await this.resolveConflictState(bundle, target),
      warnings
    };
  }

  async importSkill(options: ImportSkillOptions): Promise<SkillImportResultResponse> {
    const source = normalizeImportSource(options.source);
    const conflictStrategy = normalizeConflictStrategy(options.conflictStrategy);
    const bundle = source.url
      ? await this.fetchBundleFromShareUrl(source.url)
      : this.bundleService.assertValidBundle(source.bundle);
    const target = normalizeImportTarget(options.target, this.options.validateProfileTarget);
    const preview = await this.previewImportBundle({ bundle, target });

    if (preview.conflict.isBlocking) {
      throw new SkillSharingError(
        "skill_import_required_builtin_conflict",
        "Import would shadow a required built-in skill.",
        409,
        preview.conflict
      );
    }
    if (preview.conflict.exists && conflictStrategy !== "replace") {
      throw new SkillSharingError("skill_import_conflict", "Skill already exists in the selected target.", 409, preview.conflict);
    }
    if (preview.conflict.exists && options.confirmReplace !== true) {
      throw new SkillSharingError("skill_import_replace_not_confirmed", "Replacing a skill requires explicit confirmation.", 409, preview.conflict);
    }

    const rootPath = await this.installBundle(bundle, target, {
      replace: preview.conflict.conflictType === "target_path" && conflictStrategy === "replace"
    });
    await this.options.skillMetadataService.reloadSkillMetadata();
    const importedSkill = await this.findImportedSkill(bundle, target, rootPath);

    return {
      bundle: preview.bundle,
      target,
      rootPath,
      ...(importedSkill ? { skillId: importedSkill.skillId } : {}),
      replaced: preview.conflict.exists,
      warnings: preview.warnings
    };
  }

  private async uploadBundle(bundle: SkillBundleManifestV1): Promise<SkillShareResponse> {
    const endpoint = new URL("/api/v1/skill-shares", this.shareConfig.baseUrl);
    const response = await this.fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ bundle }),
      redirect: "manual"
    });
    const bodyText = await readResponseTextWithLimit(response, SHARE_UPLOAD_RESPONSE_MAX_BYTES);

    if (!response.ok) {
      throw shareServiceStatusError(response.status, bodyText, "upload", response.headers);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new SkillSharingError("invalid_share_response", "Skill share service returned invalid JSON.", 502);
    }

    if (!isSkillShareResponse(parsed)) {
      throw new SkillSharingError("invalid_share_response", "Skill share service response was missing required fields.", 502);
    }

    return this.validateSkillShareResponse(parsed);
  }

  private validateSkillShareResponse(response: SkillShareResponse): SkillShareResponse {
    let shareUrl: string;
    try {
      shareUrl = this.assertAllowedShareUrl(response.shareUrl).toString();
    } catch {
      throw new SkillSharingError("invalid_share_response", "Skill share service returned an untrusted share URL.", 502);
    }

    let parsedImportUrl: URL;
    try {
      parsedImportUrl = new URL(response.importUrl);
    } catch {
      throw new SkillSharingError("invalid_share_response", "Skill share service returned an invalid Forge import URL.", 502);
    }

    if (parsedImportUrl.protocol !== "forge:" || parsedImportUrl.hostname !== "skill-import") {
      throw new SkillSharingError("invalid_share_response", "Skill share service returned an unexpected Forge import URL.", 502);
    }

    const embeddedShareUrl = parsedImportUrl.searchParams.get("url");
    if (!embeddedShareUrl) {
      throw new SkillSharingError("invalid_share_response", "Skill share service import URL did not include a share URL.", 502);
    }

    let normalizedEmbeddedShareUrl: string;
    try {
      normalizedEmbeddedShareUrl = this.assertAllowedShareUrl(embeddedShareUrl).toString();
    } catch {
      throw new SkillSharingError("invalid_share_response", "Skill share service import URL included an untrusted share URL.", 502);
    }
    if (normalizedEmbeddedShareUrl !== shareUrl) {
      throw new SkillSharingError("invalid_share_response", "Skill share service import URL did not match the share URL.", 502);
    }

    return {
      ...response,
      shareUrl,
      importUrl: `forge://skill-import?url=${encodeURIComponent(shareUrl)}`
    };
  }

  private async fetchBundleFromShareUrl(url: string): Promise<SkillBundleManifestV1> {
    this.assertShareServiceEnabled("Skill share URL import is disabled.");
    const requestUrl = this.assertAllowedShareUrl(url);
    const response = await this.fetchShareUrlWithRedirects(requestUrl);
    if (response.status < 200 || response.status >= 300) {
      throw shareServiceStatusError(response.status, response.bodyText, "download", response.headers);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch {
      throw new SkillSharingError("invalid_share_bundle", "Skill share response was not valid bundle JSON.", 502);
    }

    try {
      return this.bundleService.assertValidBundle(parsed);
    } catch (error) {
      if (error instanceof SkillBundleValidationError) {
        throw new SkillSharingError("invalid_share_bundle", "Skill share bundle failed validation.", 400, error.issues);
      }
      throw error;
    }
  }

  private async fetchShareUrlWithRedirects(initialUrl: URL): Promise<FetchResult> {
    let currentUrl = initialUrl;
    for (let redirectCount = 0; redirectCount <= this.redirectLimit; redirectCount += 1) {
      const response = await this.fetchWithTimeout(currentUrl, {
        method: "GET",
        headers: { "Accept": "application/json" },
        redirect: "manual"
      });

      if (isRedirectStatus(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          throw new SkillSharingError("invalid_share_redirect", "Skill share redirect did not include a location.", 502);
        }
        if (redirectCount >= this.redirectLimit) {
          throw new SkillSharingError("share_redirect_limit", "Skill share redirect limit exceeded.", 502);
        }
        currentUrl = this.assertAllowedShareUrl(new URL(location, currentUrl).toString());
        continue;
      }

      return {
        status: response.status,
        headers: response.headers,
        bodyText: await readResponseTextWithLimit(response, SHARE_DOWNLOAD_MAX_BYTES)
      };
    }

    throw new SkillSharingError("share_redirect_limit", "Skill share redirect limit exceeded.", 502);
  }

  private async fetchWithTimeout(url: URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new SkillSharingError("share_fetch_timeout", "Skill share service request timed out.", 504);
      }
      throw new SkillSharingError("share_fetch_failed", "Unable to reach skill share service.", 502, errorToDetails(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertAllowedShareUrl(rawUrl: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new SkillSharingError("invalid_share_url", "Skill share URL is invalid.", 400);
    }

    if (!isAllowedProtocol(parsed, this.shareConfig.baseUrl)) {
      throw new SkillSharingError("invalid_share_url", "Skill share URL must use the configured share service origin.", 400);
    }
    if (parsed.host !== this.shareConfig.baseUrl.host) {
      throw new SkillSharingError("untrusted_share_url", "Skill share URL host is not trusted.", 403);
    }
    if (!isAllowedSharePath(parsed.pathname)) {
      throw new SkillSharingError("invalid_share_url", "Skill share URL path is not a Forge skill share link.", 400);
    }

    parsed.hash = "";
    return parsed;
  }

  private assertShareServiceEnabled(message: string): void {
    if (this.shareConfig.disabled) {
      throw new SkillSharingError("skill_share_disabled", message, 503);
    }
  }

  private buildImportWarnings(bundle: SkillBundleManifestV1): SkillBundleIssue[] {
    const validation = this.bundleService.validateBundle(bundle);
    const warnings: SkillBundleIssue[] = [...validation.warnings];

    if (bundle.origin.platform && bundle.origin.platform !== process.platform) {
      warnings.push({
        severity: "warning",
        code: "origin_platform_mismatch",
        message: `Skill was exported from ${bundle.origin.platform}; this device is ${process.platform}.`
      });
    }

    for (const script of bundle.portability.scripts) {
      warnings.push({
        severity: "warning",
        code: "script_file",
        path: script.path,
        message: `Skill includes a ${script.kind} script: ${script.path}`
      });
      for (const warning of script.warnings) {
        warnings.push({ severity: "warning", code: "script_warning", path: script.path, message: warning });
      }
    }

    for (const dependency of bundle.portability.dependencies) {
      warnings.push({
        severity: "info",
        code: "dependency_manifest",
        path: dependency.path,
        message: dependency.summary
      });
      for (const warning of dependency.warnings) {
        warnings.push({ severity: "warning", code: "dependency_warning", path: dependency.path, message: warning });
      }
    }

    for (const indicator of bundle.portability.osIndicators) {
      warnings.push({
        severity: indicator.severity,
        code: "os_indicator",
        path: indicator.path,
        message: `Found portability indicator ${indicator.token} in ${indicator.path}.`
      });
    }

    for (const env of bundle.skill.env) {
      warnings.push({
        severity: env.required ? "warning" : "info",
        code: env.required ? "required_env" : "optional_env",
        message: `${env.required ? "Required" : "Optional"} environment variable must be configured by the recipient: ${env.name}`
      });
    }

    return dedupeIssues(warnings);
  }

  private async resolveConflictState(
    bundle: SkillBundleManifestV1,
    target: SkillImportTarget
  ): Promise<SkillImportConflictState> {
    const targetRoot = this.resolveTargetRoot(bundle.skill.handle, target);
    const [effectiveSkill, targetExists] = await Promise.all([
      this.findEffectiveSkillByHandle(bundle.skill.handle, target),
      pathExists(targetRoot)
    ]);

    const effectiveConflict = effectiveSkill
      ? this.buildEffectiveConflict(effectiveSkill, targetRoot)
      : undefined;
    const effectiveMatchesTarget = effectiveSkill
      ? resolve(effectiveSkill.rootPath) === resolve(targetRoot)
      : false;

    if (targetExists && !effectiveMatchesTarget) {
      return {
        exists: true,
        existingSourceKind: target.scope === "global" ? "machine-local" : "profile",
        existingRootPath: targetRoot,
        existingDirectoryName: bundle.skill.handle,
        conflictType: "target_path",
        ...(effectiveConflict ? { relatedConflicts: [effectiveConflict] } : {}),
        ...(effectiveConflict?.isBlocking ? { isRequiredBuiltin: effectiveConflict.isRequiredBuiltin, isBlocking: true } : {})
      };
    }

    if (effectiveSkill && effectiveConflict) {
      return {
        exists: true,
        existingSourceKind: effectiveSkill.sourceKind,
        existingSkillId: effectiveSkill.skillId,
        existingRootPath: effectiveSkill.rootPath,
        existingDirectoryName: effectiveSkill.directoryName,
        conflictType: effectiveMatchesTarget ? "target_path" : "effective_skill",
        ...(effectiveConflict.isRequiredBuiltin ? { isRequiredBuiltin: true, isBlocking: true } : {})
      };
    }

    return { exists: false };
  }

  private buildEffectiveConflict(effectiveSkill: SkillMetadata, targetRoot: string): SkillImportRelatedConflict {
    const isTargetPath = resolve(effectiveSkill.rootPath) === resolve(targetRoot);
    const isRequiredBuiltin = (effectiveSkill.sourceKind === "builtin" || effectiveSkill.sourceKind === "repo")
      && isRequiredSkillDirectoryName(effectiveSkill.directoryName);
    return {
      sourceKind: effectiveSkill.sourceKind,
      skillId: effectiveSkill.skillId,
      rootPath: effectiveSkill.rootPath,
      directoryName: effectiveSkill.directoryName,
      conflictType: isTargetPath ? "target_path" : "effective_skill",
      ...(isRequiredBuiltin ? { isRequiredBuiltin: true, isBlocking: true } : {})
    };
  }

  private async findEffectiveSkillByHandle(
    handle: string,
    target: SkillImportTarget
  ): Promise<SkillMetadata | undefined> {
    await this.options.skillMetadataService.reloadSkillMetadata();
    const normalizedHandle = normalizeSkillHandle(handle);
    if (target.scope === "profile" && target.profileId) {
      const profileMatch = (await this.options.skillMetadataService.getProfileSkillMetadata(target.profileId))
        .find((skill) => normalizeSkillHandle(skill.directoryName) === normalizedHandle);
      if (profileMatch) {
        return profileMatch;
      }
    }

    return this.options.skillMetadataService.getSkillMetadata()
      .find((skill) => normalizeSkillHandle(skill.directoryName) === normalizedHandle);
  }

  private async installBundle(
    bundle: SkillBundleManifestV1,
    target: SkillImportTarget,
    options: { replace: boolean }
  ): Promise<string> {
    const targetRoot = this.resolveTargetRoot(bundle.skill.handle, target);
    const parentDir = dirname(targetRoot);
    await mkdir(parentDir, { recursive: true });
    const tempRoot = join(parentDir, `.${bundle.skill.handle}.forge-import-${randomUUID()}.tmp`);
    const backupRoot = join(parentDir, `.${bundle.skill.handle}.forge-import-${randomUUID()}.bak`);

    try {
      await this.writeBundleToDirectory(bundle, tempRoot);
      const targetExists = await pathExists(targetRoot);
      if (!targetExists) {
        await renameWithRetry(tempRoot, targetRoot);
        return targetRoot;
      }

      if (!options.replace) {
        throw new SkillSharingError("skill_import_conflict", "Skill already exists in the selected target.", 409);
      }

      await renameWithRetry(targetRoot, backupRoot);
      try {
        await renameWithRetry(tempRoot, targetRoot);
        await rm(backupRoot, { recursive: true, force: true });
        return targetRoot;
      } catch (error) {
        await rm(targetRoot, { recursive: true, force: true }).catch(() => undefined);
        await renameWithRetry(backupRoot, targetRoot).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async writeBundleToDirectory(bundle: SkillBundleManifestV1, targetRoot: string): Promise<void> {
    await mkdir(targetRoot, { recursive: true });
    const resolvedRoot = resolve(targetRoot);

    for (const file of bundle.files) {
      const normalizedPath = normalizeSkillBundleFilePath(file.path);
      const targetPath = resolve(resolvedRoot, normalizedPath);
      if (!isPathWithinRoot(targetPath, resolvedRoot)) {
        throw new SkillSharingError("invalid_bundle_path", `Bundle path is outside skill root: ${file.path}`, 400);
      }
      await mkdir(dirname(targetPath), { recursive: true });
      const content = decodeBundleFileContent(file);
      await writeFile(targetPath, content);
      if (process.platform !== "win32" && file.executable) {
        await chmod(targetPath, 0o755);
      }
    }
  }

  private resolveTargetRoot(handle: string, target: SkillImportTarget): string {
    assertValidSkillHandle(handle);
    const safeHandle = sanitizePathSegment(handle);
    if (target.scope === "global") {
      return resolve(this.options.config.paths.dataDir, "skills", safeHandle);
    }
    if (!target.profileId) {
      throw new SkillSharingError("invalid_import_target", "Profile imports require profileId.", 400);
    }
    return resolve(getProfilePiSkillsDir(this.options.config.paths.dataDir, target.profileId), safeHandle);
  }

  private async findImportedSkill(
    bundle: SkillBundleManifestV1,
    target: SkillImportTarget,
    rootPath: string
  ): Promise<SkillMetadata | undefined> {
    const normalizedRoot = resolve(rootPath);
    const metadata = target.scope === "profile" && target.profileId
      ? await this.options.skillMetadataService.getProfileSkillMetadata(target.profileId)
      : this.options.skillMetadataService.getSkillMetadata();
    return metadata.find((skill) => skill.directoryName === bundle.skill.handle && resolve(skill.rootPath) === normalizedRoot);
  }
}

function resolveShareConfig(options: SkillSharingServiceOptions): ResolvedShareConfig {
  const disabled = options.disabled ?? readBooleanEnv(SKILL_SHARE_DISABLED_ENV, LEGACY_SKILL_SHARE_DISABLED_ENV);
  const rawBaseUrl = options.shareBaseUrl
    ?? process.env[SKILL_SHARE_BASE_URL_ENV]
    ?? process.env[LEGACY_SKILL_SHARE_BASE_URL_ENV]
    ?? DEFAULT_SKILL_SHARE_BASE_URL;
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new SkillSharingError("invalid_share_config", "Configured skill share base URL is invalid.", 503);
  }
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "");
  baseUrl.search = "";
  baseUrl.hash = "";
  if (baseUrl.protocol !== "https:" && !isLocalhost(baseUrl.hostname)) {
    throw new SkillSharingError("invalid_share_config", "Skill share base URL must use https unless it is localhost.", 503);
  }
  return { baseUrl, disabled };
}

function readBooleanEnv(primaryName: string, legacyName: string): boolean {
  const value = process.env[primaryName] ?? process.env[legacyName];
  return value === "1" || value?.toLowerCase() === "true";
}

function normalizeImportSource(source: ImportSkillOptions["source"] | unknown): { url?: string; bundle?: unknown } {
  if (!isRecord(source)) {
    throw new SkillSharingError("invalid_import_source", "Import source must be an object.", 400);
  }

  const rawUrl = source.url;
  const rawBundle = source.bundle;
  const hasUrl = Object.hasOwn(source, "url") && rawUrl !== undefined;
  const hasBundle = Object.hasOwn(source, "bundle") && rawBundle !== undefined;
  if (hasUrl) {
    if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
      throw new SkillSharingError("invalid_import_source", "source.url must be a non-empty string.", 400);
    }
  }
  if ((hasUrl ? 1 : 0) + (hasBundle ? 1 : 0) !== 1) {
    throw new SkillSharingError("invalid_import_source", "Import source must include exactly one url or bundle.", 400);
  }

  return hasUrl && typeof rawUrl === "string" ? { url: rawUrl.trim() } : { bundle: rawBundle };
}

function normalizeConflictStrategy(strategy: unknown): SkillImportConflictStrategy {
  if (strategy === undefined) {
    return "reject";
  }
  if (strategy === "reject" || strategy === "replace") {
    return strategy;
  }
  throw new SkillSharingError("invalid_conflict_strategy", "conflictStrategy must be reject or replace.", 400);
}

function normalizeImportTarget(
  target: SkillImportTarget | undefined,
  validateProfileTarget?: (profileId: string) => boolean
): SkillImportTarget {
  if (!target) {
    return { scope: "global" };
  }
  if (target.scope !== "global" && target.scope !== "profile") {
    throw new SkillSharingError("invalid_import_target", "Import target scope must be global or profile.", 400);
  }
  if (target.scope === "profile") {
    if (typeof target.profileId !== "string" || target.profileId.trim().length === 0) {
      throw new SkillSharingError("invalid_import_target", "Profile imports require profileId.", 400);
    }
    const profileId = target.profileId.trim();
    if (validateProfileTarget && !validateProfileTarget(profileId)) {
      throw new SkillSharingError("unknown_profile", `Unknown profile: ${profileId}`, 404);
    }
    return { scope: "profile", profileId };
  }
  return { scope: "global" };
}

function toPreviewBundle(bundle: SkillBundleManifestV1): SkillBundlePreviewManifestV1 {
  const files: SkillBundlePreviewFileEntry[] = bundle.files.map(({ content: _content, ...file }) => ({ ...file }));
  return {
    ...bundle,
    files
  };
}

function decodeBundleFileContent(file: SkillBundleFileEntry): Buffer | string {
  if (file.encoding === "base64") {
    return Buffer.from(file.content, "base64");
  }
  return file.content;
}

function isSkillShareResponse(value: unknown): value is SkillShareResponse {
  if (!isRecord(value)) return false;
  return (
    typeof value.shareUrl === "string" &&
    typeof value.importUrl === "string" &&
    typeof value.expiresAt === "string" &&
    typeof value.contentSha256 === "string" &&
    Array.isArray(value.warnings)
  );
}

async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) {
    return "";
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new SkillSharingError("share_response_too_large", `Skill share response exceeds ${maxBytes} bytes.`, 413);
      }
      chunks.push(value);
    }
  }

  return Buffer.concat(chunks).toString("utf8");
}

function shareServiceStatusError(
  status: number,
  bodyText: string,
  operation: "upload" | "download",
  headers?: Headers
): SkillSharingError {
  const message = parseErrorMessage(bodyText) ?? `Skill share service ${operation} failed.`;
  const retryAfter = normalizeRetryAfterValue(headers?.get("retry-after") ?? undefined);
  if (status === 400) return new SkillSharingError("share_bad_request", message, 400, undefined, retryAfter);
  if (status === 404) return new SkillSharingError("share_not_found", message, 404, undefined, retryAfter);
  if (status === 410) return new SkillSharingError("share_expired", message, 410, undefined, retryAfter);
  if (status === 413) return new SkillSharingError("share_too_large", message, 413, undefined, retryAfter);
  if (status === 429) return new SkillSharingError("share_rate_limited", message, 429, undefined, retryAfter);
  if (status === 503) return new SkillSharingError("share_unavailable", message, 503, undefined, retryAfter);
  if (status === 504) return new SkillSharingError("share_timeout", message, 504, undefined, retryAfter);
  if (status === 507) return new SkillSharingError("share_budget_exceeded", message, 507, undefined, retryAfter);
  return new SkillSharingError("share_upstream_error", message, status >= 500 ? 502 : status, undefined, retryAfter);
}

function parseErrorMessage(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (isRecord(parsed) && typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      return parsed.error;
    }
  } catch {
    // ignore non-JSON error bodies
  }
  return undefined;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isAllowedSharePath(pathname: string): boolean {
  return /^\/s\/[^/]+$/.test(pathname) || /^\/api\/v1\/skill-shares\/[^/]+$/.test(pathname);
}

function isAllowedProtocol(url: URL, baseUrl: URL): boolean {
  if (url.protocol === baseUrl.protocol) {
    return true;
  }
  return url.protocol === "http:" && baseUrl.protocol === "http:" && isLocalhost(url.hostname) && isLocalhost(baseUrl.hostname);
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function dedupeIssues(issues: SkillBundleIssue[]): SkillBundleIssue[] {
  const seen = new Set<string>();
  const deduped: SkillBundleIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.severity}\0${issue.code}\0${issue.path ?? ""}\0${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(issue);
  }
  return deduped;
}

function errorToDetails(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return undefined;
}

function normalizeSkillHandle(handle: string): string {
  return handle.trim().toLowerCase();
}

function normalizeRetryAfterValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 128) {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }
  if (Number.isFinite(Date.parse(trimmed))) {
    return trimmed;
  }
  return undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
