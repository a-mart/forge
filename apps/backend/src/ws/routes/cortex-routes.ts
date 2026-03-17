import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CortexReviewControlAction, CortexReviewRunAxis, CortexReviewRunScope } from "@forge/protocol";
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
import { scanCortexReviewStatus } from "../../swarm/scripts/cortex-scan.js";
import { readSessionMeta, writeSessionMeta } from "../../swarm/session-manifest.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { applyCorsHeaders, parseJsonBody, sendJson } from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const CORTEX_SCAN_ENDPOINT_PATH = "/api/cortex/scan";
const CORTEX_SCAN_METHODS = "GET, OPTIONS";
const CORTEX_REVIEW_RUNS_ENDPOINT_PATH = "/api/cortex/review-runs";
const CORTEX_REVIEW_RUNS_METHODS = "GET, POST, OPTIONS";
const CORTEX_REVIEW_CONTROLS_ENDPOINT_PATH = "/api/cortex/review-controls";
const CORTEX_REVIEW_CONTROLS_METHODS = "POST, OPTIONS";

export function createCortexRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return [
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
          const [profileMemory, profileKnowledge, profileReference, profileMergeAudit, cortexReviewLog, cortexReviewLock, cortexReviewRuns, cortexPromotionManifests] = await Promise.all([
            buildProfileMemoryInfoMap(dataDir, profileIds),
            buildProfileKnowledgeInfoMap(dataDir, profileIds),
            buildProfileReferenceInfoMap(dataDir, profileIds),
            buildProfileMergeAuditInfoMap(dataDir, profileIds),
            buildFileInfo(getCortexReviewLogPath(dataDir)),
            buildFileInfo(getCortexReviewLockPath(dataDir)),
            buildFileInfo(getCortexReviewRunsPath(dataDir)),
            buildDirectoryInfo(getCortexPromotionManifestsDir(dataDir))
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
            }
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to scan Cortex review status.";
          sendJson(response, 500, { error: message });
        }
      }
    }
  ];
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
