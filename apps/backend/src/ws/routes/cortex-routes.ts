import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  CortexDocumentEntry,
  CortexFileReviewHistoryEntry,
  CortexFileReviewHistoryResult,
  CortexReviewControlAction,
  CortexReviewRunAxis,
  CortexReviewRunScope,
  OnboardingState,
  OnboardingTechnicalLevel
} from "@forge/protocol";
import { ONBOARDING_TECHNICAL_LEVEL_VALUES } from "@forge/protocol";
import {
  getCommonKnowledgePath,
  getCortexNotesPath,
  getCortexPromotionManifestsDir,
  getCortexReviewLockPath,
  getCortexReviewLogPath,
  getCortexReviewRunsPath,
  getProfileKnowledgeDir,
  getProfileKnowledgePath,
  getProfileMemoryPath,
  getProfileMergeAuditLogPath,
  getProfileReferencePath
} from "../../swarm/data-paths.js";
import { getOnboardingSnapshot, renderOnboardingCommonKnowledge, saveOnboardingPreferences, skipOnboarding } from "../../swarm/onboarding-state.js";
import { readStoredCortexReviewRuns } from "../../swarm/cortex-review-runs.js";
import { scanCortexReviewStatus } from "../../swarm/scripts/cortex-scan.js";
import {
  readCortexReviewLogEntries
} from "../../swarm/scripts/cortex-review-state.js";
import { readSessionMeta, writeSessionMeta } from "../../swarm/session-manifest.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { enumerateExistingTrackedPaths, resolveTrackedVersionedPathReference } from "../../versioning/versioned-paths.js";
import { applyCorsHeaders, parseJsonBody, sendJson } from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const CORTEX_SCAN_ENDPOINT_PATH = "/api/cortex/scan";
const CORTEX_SCAN_METHODS = "GET, OPTIONS";
const CORTEX_REVIEW_RUNS_ENDPOINT_PATH = "/api/cortex/review-runs";
const CORTEX_REVIEW_RUNS_METHODS = "GET, POST, OPTIONS";
const CORTEX_REVIEW_CONTROLS_ENDPOINT_PATH = "/api/cortex/review-controls";
const CORTEX_REVIEW_CONTROLS_METHODS = "POST, OPTIONS";
const CORTEX_FILE_REVIEW_HISTORY_ENDPOINT_PATH = "/api/cortex/file-review-history";
const CORTEX_FILE_REVIEW_HISTORY_METHODS = "GET, OPTIONS";
const ONBOARDING_STATE_ENDPOINT_PATH = "/api/onboarding/state";
const ONBOARDING_STATE_METHODS = "GET, OPTIONS";
const ONBOARDING_PREFERENCES_ENDPOINT_PATH = "/api/onboarding/preferences";
const ONBOARDING_PREFERENCES_METHODS = "POST, OPTIONS";
const ONBOARDING_PREFERRED_NAME_MAX_LENGTH = 200;
const ONBOARDING_ADDITIONAL_PREFERENCES_MAX_LENGTH = 2000;

export function createCortexRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return [
    {
      methods: ONBOARDING_STATE_METHODS,
      matches: (pathname) => pathname === ONBOARDING_STATE_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, ONBOARDING_STATE_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "GET") {
          applyCorsHeaders(request, response, ONBOARDING_STATE_METHODS);
          response.setHeader("Allow", ONBOARDING_STATE_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, ONBOARDING_STATE_METHODS);

        try {
          const snapshot = await getOnboardingSnapshot(swarmManager.getConfig().paths.dataDir);
          sendJson(response, 200, { state: buildOnboardingStateResponse(snapshot) });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to load onboarding state.";
          sendJson(response, 500, { error: message });
        }
      }
    },
    {
      methods: ONBOARDING_PREFERENCES_METHODS,
      matches: (pathname) => pathname === ONBOARDING_PREFERENCES_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, ONBOARDING_PREFERENCES_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "POST") {
          applyCorsHeaders(request, response, ONBOARDING_PREFERENCES_METHODS);
          response.setHeader("Allow", ONBOARDING_PREFERENCES_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, ONBOARDING_PREFERENCES_METHODS);

        try {
          const payload = await parseJsonBody(request, 8 * 1024);
          const mutation = parseOnboardingPreferencesPayload(payload);
          if (!mutation) {
            sendJson(response, 400, {
              error:
                'Request body must include either { status: "skipped" } or completed onboarding preferences with preferredName and technicalLevel.'
            });
            return;
          }

          const dataDir = swarmManager.getConfig().paths.dataDir;
          const snapshot = 'status' in mutation
            ? await skipOnboarding(dataDir)
            : await saveOnboardingPreferences(dataDir, mutation);
          await renderOnboardingCommonKnowledge(dataDir, snapshot);
          sendJson(response, 200, { state: buildOnboardingStateResponse(snapshot) });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to save onboarding preferences.";
          if (
            message.includes("Request body must be valid JSON") ||
            message.includes("preferredName") ||
            message.includes("technicalLevel") ||
            message.includes("additionalPreferences")
          ) {
            sendJson(response, 400, { error: message });
            return;
          }
          if (message.includes("Request body exceeds")) {
            sendJson(response, 413, { error: message });
            return;
          }
          sendJson(response, 500, { error: message });
        }
      }
    },
    {
      methods: CORTEX_REVIEW_RUNS_METHODS,
      matches: (pathname) => pathname === CORTEX_REVIEW_RUNS_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, CORTEX_REVIEW_RUNS_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        applyCorsHeaders(request, response, CORTEX_REVIEW_RUNS_METHODS);

        if (request.method === "GET") {
          try {
            const runs = await swarmManager.listCortexReviewRuns();
            sendJson(response, 200, { runs });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unable to load Cortex review runs.";
            sendJson(response, 500, { error: message });
          }
          return;
        }

        if (request.method === "POST") {
          try {
            const payload = await parseJsonBody(request, 16 * 1024);
            const scope = parseReviewRunScopePayload(payload);
            if (!scope) {
              sendJson(response, 400, { error: "Request body must include a valid review scope." });
              return;
            }

            const run = await swarmManager.startCortexReviewRun({
              scope,
              trigger: "manual",
              sourceContext: { channel: "web" }
            });
            if (!run) {
              throw new Error("Manual Cortex review run unexpectedly coalesced.");
            }
            sendJson(response, 202, { run });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unable to start Cortex review run.";
            if (message.includes("Request body must be valid JSON")) {
              sendJson(response, 400, { error: message });
              return;
            }
            if (message.includes("Request body exceeds")) {
              sendJson(response, 413, { error: message });
              return;
            }
            sendJson(response, 500, { error: message });
          }
          return;
        }

        response.setHeader("Allow", CORTEX_REVIEW_RUNS_METHODS);
        sendJson(response, 405, { error: "Method Not Allowed" });
      }
    },
    {
      methods: CORTEX_REVIEW_CONTROLS_METHODS,
      matches: (pathname) => pathname === CORTEX_REVIEW_CONTROLS_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, CORTEX_REVIEW_CONTROLS_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "POST") {
          applyCorsHeaders(request, response, CORTEX_REVIEW_CONTROLS_METHODS);
          response.setHeader("Allow", CORTEX_REVIEW_CONTROLS_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, CORTEX_REVIEW_CONTROLS_METHODS);

        try {
          const payload = await parseJsonBody(request, 8 * 1024);
          const control = parseReviewControlPayload(payload);
          if (!control) {
            sendJson(response, 400, { error: "Request body must include profileId, sessionId, and a valid review control action." });
            return;
          }

          const dataDir = swarmManager.getConfig().paths.dataDir;
          const meta = await readSessionMeta(dataDir, control.profileId, control.sessionId);
          if (!meta) {
            sendJson(response, 404, { error: "Session meta not found." });
            return;
          }

          const scan = await scanCortexReviewStatus(dataDir);
          const session = scan.sessions.find(
            (candidate) => candidate.profileId === control.profileId && candidate.sessionId === control.sessionId
          );
          if (!session) {
            sendJson(response, 404, { error: "Session review state not found." });
            return;
          }

          if (control.action === "exclude") {
            if (session.reviewExcluded) {
              sendJson(response, 409, { error: "Session is already excluded from Cortex review." });
              return;
            }
            if (session.status === "up-to-date") {
              sendJson(response, 409, { error: "Only review-actionable sessions can be excluded from Cortex review." });
              return;
            }
          }

          if (control.action === "resume" && !session.reviewExcluded) {
            sendJson(response, 409, { error: "Session is not excluded from Cortex review." });
            return;
          }

          const now = new Date().toISOString();
          await writeSessionMeta(swarmManager.getConfig().paths.dataDir, {
            ...meta,
            updatedAt: now,
            cortexReviewExcludedAt: control.action === "exclude" ? now : null
          });

          sendJson(response, 200, { ok: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to update Cortex review controls.";
          if (message.includes("Request body must be valid JSON")) {
            sendJson(response, 400, { error: message });
            return;
          }
          if (message.includes("Request body exceeds")) {
            sendJson(response, 413, { error: message });
            return;
          }
          sendJson(response, 500, { error: message });
        }
      }
    },
    {
      methods: CORTEX_FILE_REVIEW_HISTORY_METHODS,
      matches: (pathname) => pathname === CORTEX_FILE_REVIEW_HISTORY_ENDPOINT_PATH,
      handle: async (request, response, requestUrl) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, CORTEX_FILE_REVIEW_HISTORY_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "GET") {
          applyCorsHeaders(request, response, CORTEX_FILE_REVIEW_HISTORY_METHODS);
          response.setHeader("Allow", CORTEX_FILE_REVIEW_HISTORY_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, CORTEX_FILE_REVIEW_HISTORY_METHODS);

        try {
          const dataDir = swarmManager.getConfig().paths.dataDir;
          const path = requireNonEmptyQuery(requestUrl.searchParams, "path");
          const limit = parseIntegerQuery(requestUrl.searchParams.get("limit"), 10, 1, 100, "limit");
          const trackedPath = resolveTrackedVersionedPathReference(dataDir, path);
          if (!trackedPath) {
            sendJson(response, 400, { error: "path must resolve to a tracked versioning file." });
            return;
          }

          const payload = await buildCortexFileReviewHistoryResult(dataDir, trackedPath.gitPath, limit);
          sendJson(response, 200, payload as unknown as Record<string, unknown>);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to load Cortex file review history.";
          if (message.includes("must be") || message.includes("tracked versioning file")) {
            sendJson(response, 400, { error: message });
            return;
          }
          sendJson(response, 500, { error: message });
        }
      }
    },
    {
      methods: CORTEX_SCAN_METHODS,
      matches: (pathname) => pathname === CORTEX_SCAN_ENDPOINT_PATH,
      handle: async (request, response) => {
        if (request.method === "OPTIONS") {
          applyCorsHeaders(request, response, CORTEX_SCAN_METHODS);
          response.statusCode = 204;
          response.end();
          return;
        }

        if (request.method !== "GET") {
          applyCorsHeaders(request, response, CORTEX_SCAN_METHODS);
          response.setHeader("Allow", CORTEX_SCAN_METHODS);
          sendJson(response, 405, { error: "Method Not Allowed" });
          return;
        }

        applyCorsHeaders(request, response, CORTEX_SCAN_METHODS);

        try {
          const config = swarmManager.getConfig();
          const dataDir = config.paths.dataDir;
          const scan = await scanCortexReviewStatus(dataDir);
          const profileIds = Array.from(
            new Set([
              ...scan.sessions.map((session) => session.profileId),
              ...swarmManager
                .listProfiles()
                .map((profile) => profile.profileId)
                .filter((profileId) => profileId !== "cortex")
            ])
          ).sort((a, b) => a.localeCompare(b));
          const [profileMemory, profileKnowledge, profileReference, profileMergeAudit, cortexReviewLog, cortexReviewLock, cortexReviewRuns, cortexPromotionManifests, documents] = await Promise.all([
            buildProfileMemoryInfoMap(dataDir, profileIds),
            buildProfileKnowledgeInfoMap(dataDir, profileIds),
            buildProfileReferenceInfoMap(dataDir, profileIds),
            buildProfileMergeAuditInfoMap(dataDir, profileIds),
            buildFileInfo(getCortexReviewLogPath(dataDir)),
            buildFileInfo(getCortexReviewLockPath(dataDir)),
            buildFileInfo(getCortexReviewRunsPath(dataDir)),
            buildDirectoryInfo(getCortexPromotionManifestsDir(dataDir)),
            buildCortexDocuments(dataDir, profileIds)
          ]);

          sendJson(response, 200, {
            scan,
            files: {
              commonKnowledge: getCommonKnowledgePath(dataDir),
              cortexNotes: getCortexNotesPath(dataDir),
              cortexReviewLog,
              cortexReviewLock,
              cortexReviewRuns,
              cortexPromotionManifests,
              profileMemory,
              profileKnowledge,
              profileReference,
              profileMergeAudit
            },
            documents
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to scan Cortex review status.";
          sendJson(response, 500, { error: message });
        }
      }
    }
  ];
}

function buildOnboardingStateResponse(snapshot: OnboardingState) {
  return {
    status: snapshot.status,
    completedAt: snapshot.completedAt,
    skippedAt: snapshot.skippedAt,
    preferences: snapshot.preferences
  };
}

async function buildCortexFileReviewHistoryResult(
  dataDir: string,
  gitPath: string,
  limit: number
): Promise<CortexFileReviewHistoryResult> {
  const [logEntries, storedRuns] = await Promise.all([
    readCortexReviewLogEntries(dataDir),
    readStoredCortexReviewRuns(dataDir)
  ]);
  const storedRunById = new Map(storedRuns.map((run) => [run.runId, run]));

  const matchingRuns = await Promise.all(
    logEntries
      .filter((entry) => entry.changedFiles.some((candidate) => normalizeTrackedGitPath(candidate) === gitPath))
      .sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt))
      .map(async (entry) => buildCortexFileReviewHistoryEntry(dataDir, entry, storedRunById.get(entry.reviewId ?? "")))
  );

  return {
    file: gitPath,
    runs: matchingRuns.slice(0, limit),
    latestRun: matchingRuns[0] ?? null
  };
}

async function buildCortexFileReviewHistoryEntry(
  dataDir: string,
  entry: Awaited<ReturnType<typeof readCortexReviewLogEntries>>[number],
  storedRun: Awaited<ReturnType<typeof readStoredCortexReviewRuns>>[number] | undefined
): Promise<CortexFileReviewHistoryEntry> {
  const manifestPath = entry.reviewId ? join(getCortexPromotionManifestsDir(dataDir), `${entry.reviewId}.md`) : undefined;
  const manifestExists = manifestPath ? await pathExists(manifestPath) : false;

  return {
    reviewId: entry.reviewId,
    recordedAt: entry.recordedAt,
    status: entry.status,
    changedFiles: entry.changedFiles.map(normalizeTrackedGitPath),
    notes: entry.notes ?? [],
    blockers: entry.blockers ?? [],
    watermarksAdvanced: entry.watermarksAdvanced,
    trigger: storedRun?.trigger,
    scope: storedRun?.scope,
    scopeLabel: storedRun?.scopeLabel,
    sessionAgentId: storedRun?.sessionAgentId,
    scheduleName: storedRun?.scheduleName ?? null,
    manifestPath,
    manifestExists
  };
}

function requireNonEmptyQuery(searchParams: URLSearchParams, key: string): string {
  const value = searchParams.get(key);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }

  return value.trim();
}

function parseIntegerQuery(
  rawValue: string | null,
  fallback: number,
  min: number,
  max: number,
  fieldName: string
): number {
  if (rawValue === null || rawValue.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${fieldName} must be an integer between ${min} and ${max}.`);
  }

  return parsed;
}

function normalizeTrackedGitPath(value: string): string {
  return value.replace(/\\/g, "/").trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isEnoentError(error)) {
      return false;
    }
    throw error;
  }
}

function parseOnboardingPreferencesPayload(
  payload: unknown
):
  | { status: "skipped" }
  | { preferredName: string; technicalLevel: OnboardingTechnicalLevel; additionalPreferences?: string | null }
  | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const status = typeof (payload as { status?: unknown }).status === "string"
    ? (payload as { status: string }).status.trim()
    : "";
  if (status === "skipped") {
    return { status: "skipped" };
  }

  const preferredName = typeof (payload as { preferredName?: unknown }).preferredName === "string"
    ? (payload as { preferredName: string }).preferredName.trim()
    : "";
  if (preferredName.length > ONBOARDING_PREFERRED_NAME_MAX_LENGTH) {
    throw new Error(`preferredName must be ${ONBOARDING_PREFERRED_NAME_MAX_LENGTH} characters or fewer.`);
  }

  const technicalLevel = typeof (payload as { technicalLevel?: unknown }).technicalLevel === "string"
    ? ((payload as { technicalLevel: string }).technicalLevel.trim() as OnboardingTechnicalLevel)
    : null;
  const additionalPreferencesValue = (payload as { additionalPreferences?: unknown }).additionalPreferences;
  const additionalPreferences = typeof additionalPreferencesValue === "string" && additionalPreferencesValue.trim().length > 0
    ? additionalPreferencesValue.trim()
    : null;

  if (additionalPreferences && additionalPreferences.length > ONBOARDING_ADDITIONAL_PREFERENCES_MAX_LENGTH) {
    throw new Error(
      `additionalPreferences must be ${ONBOARDING_ADDITIONAL_PREFERENCES_MAX_LENGTH} characters or fewer.`
    );
  }

  if (!preferredName || !technicalLevel || !ONBOARDING_TECHNICAL_LEVEL_VALUES.includes(technicalLevel)) {
    return null;
  }

  return {
    preferredName,
    technicalLevel,
    additionalPreferences
  };
}

function parseReviewRunScopePayload(payload: unknown): CortexReviewRunScope | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const scope = (payload as { scope?: unknown }).scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    return null;
  }

  const mode = typeof (scope as { mode?: unknown }).mode === "string" ? (scope as { mode: string }).mode : null;
  if (mode === "all") {
    return { mode: "all" };
  }

  if (mode !== "session") {
    return null;
  }

  const profileId = typeof (scope as { profileId?: unknown }).profileId === "string"
    ? (scope as { profileId: string }).profileId.trim()
    : "";
  const sessionId = typeof (scope as { sessionId?: unknown }).sessionId === "string"
    ? (scope as { sessionId: string }).sessionId.trim()
    : "";

  if (!profileId || !sessionId) {
    return null;
  }

  const rawAxes: unknown[] = Array.isArray((scope as { axes?: unknown[] }).axes)
    ? [...((scope as { axes?: unknown[] }).axes ?? [])]
    : [];
  const axes = rawAxes.filter((value): value is CortexReviewRunAxis => value === "transcript" || value === "memory" || value === "feedback");

  return axes.length > 0
    ? { mode: "session", profileId, sessionId, axes }
    : { mode: "session", profileId, sessionId };
}

function parseReviewControlPayload(
  payload: unknown
): { profileId: string; sessionId: string; action: CortexReviewControlAction } | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const profileId = typeof (payload as { profileId?: unknown }).profileId === "string"
    ? (payload as { profileId: string }).profileId.trim()
    : "";
  const sessionId = typeof (payload as { sessionId?: unknown }).sessionId === "string"
    ? (payload as { sessionId: string }).sessionId.trim()
    : "";
  const action = typeof (payload as { action?: unknown }).action === "string"
    ? ((payload as { action: string }).action.trim() as CortexReviewControlAction)
    : null;

  if (!profileId || !sessionId || (action !== "exclude" && action !== "resume")) {
    return null;
  }

  return { profileId, sessionId, action };
}

interface FileSystemPathInfo {
  path: string;
  exists: boolean;
  sizeBytes: number;
}

interface DirectoryPathInfo {
  path: string;
  exists: boolean;
  fileCount: number;
}

interface ProfileKnowledgeFileInfo extends FileSystemPathInfo {}

interface ProfileReferenceFileInfo extends FileSystemPathInfo {}

async function buildProfileMemoryInfoMap(
  dataDir: string,
  profileIds: string[]
): Promise<Record<string, ProfileKnowledgeFileInfo>> {
  const profileMemory: Record<string, ProfileKnowledgeFileInfo> = {};

  await Promise.all(
    profileIds.map(async (profileId) => {
      const path = getProfileMemoryPath(dataDir, profileId);
      let sizeBytes = 0;

      try {
        const fileStats = await stat(path);
        sizeBytes = fileStats.size;
      } catch (error) {
        if (!isEnoentError(error)) {
          throw error;
        }
      }

      profileMemory[profileId] = {
        path,
        exists: sizeBytes > 0,
        sizeBytes
      };
    })
  );

  return profileMemory;
}

async function buildProfileKnowledgeInfoMap(
  dataDir: string,
  profileIds: string[]
): Promise<Record<string, ProfileKnowledgeFileInfo>> {
  const profileKnowledgeDir = getProfileKnowledgeDir(dataDir);
  const existingProfileKnowledgeSizes = new Map<string, number>();

  try {
    const entries = await readdir(profileKnowledgeDir, { withFileTypes: true });

    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile() || !entry.name.endsWith(".md")) {
          return;
        }

        const profileId = entry.name.slice(0, -3);
        if (!profileIds.includes(profileId)) {
          return;
        }

        try {
          const fileStats = await stat(join(profileKnowledgeDir, entry.name));
          existingProfileKnowledgeSizes.set(profileId, fileStats.size);
        } catch {
          // Skip files that disappear or become unreadable while scanning.
        }
      })
    );
  } catch (error) {
    if (!isEnoentError(error)) {
      throw error;
    }
  }

  const profileKnowledge: Record<string, ProfileKnowledgeFileInfo> = {};
  for (const profileId of profileIds) {
    const sizeBytes = existingProfileKnowledgeSizes.get(profileId);
    profileKnowledge[profileId] = {
      path: getProfileKnowledgePath(dataDir, profileId),
      exists: sizeBytes !== undefined,
      sizeBytes: sizeBytes ?? 0
    };
  }

  return profileKnowledge;
}

async function buildProfileReferenceInfoMap(
  dataDir: string,
  profileIds: string[]
): Promise<Record<string, ProfileReferenceFileInfo>> {
  const profileReference: Record<string, ProfileReferenceFileInfo> = {};

  await Promise.all(
    profileIds.map(async (profileId) => {
      const info = await buildFileInfo(getProfileReferencePath(dataDir, profileId, "index.md"));
      profileReference[profileId] = info;
    })
  );

  return profileReference;
}

async function buildProfileMergeAuditInfoMap(
  dataDir: string,
  profileIds: string[]
): Promise<Record<string, ProfileKnowledgeFileInfo>> {
  const profileMergeAudit: Record<string, ProfileKnowledgeFileInfo> = {};

  await Promise.all(
    profileIds.map(async (profileId) => {
      const path = getProfileMergeAuditLogPath(dataDir, profileId);
      let exists = false;
      let sizeBytes = 0;

      try {
        const fileStats = await stat(path);
        exists = true;
        sizeBytes = fileStats.size;
      } catch (error) {
        if (!isEnoentError(error)) {
          throw error;
        }
      }

      profileMergeAudit[profileId] = {
        path,
        exists,
        sizeBytes
      };
    })
  );

  return profileMergeAudit;
}

async function buildCortexDocuments(
  dataDir: string,
  profileIds: string[]
): Promise<CortexDocumentEntry[]> {
  const documents: CortexDocumentEntry[] = [];
  const seenIds = new Set<string>();

  const addDocument = async (descriptor: {
    gitPath: string;
    label: string;
    description: string;
    group: CortexDocumentEntry["group"];
    editable: boolean;
  }): Promise<void> => {
    if (seenIds.has(descriptor.gitPath)) {
      return;
    }

    const absolutePath = resolve(dataDir, descriptor.gitPath);
    const fileInfo = await buildFileInfo(absolutePath);
    const tracked = resolveTrackedVersionedPathReference(dataDir, descriptor.gitPath);
    if (!tracked) {
      return;
    }

    documents.push({
      id: descriptor.gitPath,
      label: descriptor.label,
      description: descriptor.description,
      group: descriptor.group,
      surface: tracked.surface,
      absolutePath,
      gitPath: descriptor.gitPath,
      profileId: tracked.profileId,
      exists: fileInfo.exists,
      sizeBytes: fileInfo.sizeBytes,
      editable: descriptor.editable
    });
    seenIds.add(descriptor.gitPath);
  };

  await addDocument({
    gitPath: "shared/knowledge/common.md",
    label: "Common Knowledge",
    description: "Shared knowledge base across all profiles",
    group: "commonKnowledge",
    editable: true
  });
  await addDocument({
    gitPath: "shared/knowledge/.cortex-notes.md",
    label: "Cortex Notes",
    description: "Working notes and tentative observations",
    group: "notes",
    editable: true
  });

  for (const profileId of profileIds) {
    await addDocument({
      gitPath: `profiles/${profileId}/memory.md`,
      label: `Profile Memory: ${profileId}`,
      description: `Injected profile summary memory for ${profileId}`,
      group: "profileMemory",
      editable: true
    });
  }

  const trackedPaths = await enumerateExistingTrackedPaths(dataDir);
  for (const gitPath of trackedPaths) {
    if (
      gitPath === "shared/knowledge/common.md" ||
      gitPath === "shared/knowledge/.cortex-notes.md" ||
      gitPath === "shared/knowledge/.cortex-worker-prompts.md" ||
      /^shared\/knowledge\/profiles\/[^/]+\.md$/u.test(gitPath) ||
      /^profiles\/[^/]+\/memory\.md$/u.test(gitPath)
    ) {
      continue;
    }

    const tracked = resolveTrackedVersionedPathReference(dataDir, gitPath);
    if (!tracked || !tracked.profileId) {
      continue;
    }

    if (tracked.surface === "reference") {
      const fileName = gitPath.split("/").at(-1) ?? gitPath;
      await addDocument({
        gitPath,
        label: `${tracked.profileId} / ${fileName}`,
        description: `Reference doc for ${tracked.profileId}`,
        group: "referenceDocs",
        editable: true
      });
      continue;
    }

    if (tracked.surface === "prompt" && tracked.promptCategory && tracked.promptId) {
      await addDocument({
        gitPath,
        label: `${tracked.profileId} / ${tracked.promptCategory} / ${tracked.promptId}`,
        description: `Prompt override for ${tracked.profileId}`,
        group: "promptOverrides",
        editable: true
      });
    }
  }

  const groupOrder: CortexDocumentEntry["group"][] = [
    "commonKnowledge",
    "profileMemory",
    "referenceDocs",
    "promptOverrides",
    "notes"
  ];

  return documents.sort((left, right) => {
    const groupDelta = groupOrder.indexOf(left.group) - groupOrder.indexOf(right.group);
    if (groupDelta !== 0) {
      return groupDelta;
    }
    return left.label.localeCompare(right.label);
  });
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

async function buildFileInfo(path: string): Promise<FileSystemPathInfo> {
  let exists = false;
  let sizeBytes = 0;

  try {
    const fileStats = await stat(path);
    exists = fileStats.isFile();
    sizeBytes = exists ? fileStats.size : 0;
  } catch (error) {
    if (!isEnoentError(error)) {
      throw error;
    }
  }

  return { path, exists, sizeBytes };
}

async function buildDirectoryInfo(path: string): Promise<DirectoryPathInfo> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return {
      path,
      exists: true,
      fileCount: entries.filter((entry) => entry.isFile()).length
    };
  } catch (error) {
    if (!isEnoentError(error)) {
      throw error;
    }
  }

  return { path, exists: false, fileCount: 0 };
}
