import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  getCommonKnowledgePath,
  getCortexNotesPath,
  getProfileKnowledgeDir,
  getProfileKnowledgePath,
  getProfileMemoryPath,
  getProfileMergeAuditLogPath,
  getProfileReferencePath
} from "../../swarm/data-paths.js";
import { ensureProfileReferenceIndex, migrateLegacyProfileKnowledgeToReferenceDoc } from "../../swarm/reference-docs.js";
import { scanCortexReviewStatus } from "../../swarm/scripts/cortex-scan.js";
import type { SwarmManager } from "../../swarm/swarm-manager.js";
import { applyCorsHeaders, sendJson } from "../http-utils.js";
import type { HttpRoute } from "./http-route.js";

const CORTEX_SCAN_ENDPOINT_PATH = "/api/cortex/scan";
const CORTEX_SCAN_METHODS = "GET, OPTIONS";

export function createCortexRoutes(options: { swarmManager: SwarmManager }): HttpRoute[] {
  const { swarmManager } = options;

  return [
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
          const [profileMemory, profileKnowledge, profileReference, profileMergeAudit] = await Promise.all([
            buildProfileMemoryInfoMap(dataDir, profileIds),
            buildProfileKnowledgeInfoMap(dataDir, profileIds),
            buildProfileReferenceInfoMap(dataDir, profileIds),
            buildProfileMergeAuditInfoMap(dataDir, profileIds)
          ]);

          sendJson(response, 200, {
            scan,
            files: {
              commonKnowledge: getCommonKnowledgePath(dataDir),
              cortexNotes: getCortexNotesPath(dataDir),
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

interface ProfileKnowledgeFileInfo {
  path: string;
  exists: boolean;
  sizeBytes: number;
}

interface ProfileReferenceFileInfo {
  path: string;
  exists: boolean;
  sizeBytes: number;
}

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
      const indexPath = getProfileReferencePath(dataDir, profileId, "index.md");
      let sizeBytes = 0;

      try {
        await migrateLegacyProfileKnowledgeToReferenceDoc(dataDir, profileId);
      } catch {
        // Degrade gracefully: a broken legacy knowledge file for one profile should not fail the full scan route.
      }

      try {
        const ensured = await ensureProfileReferenceIndex(dataDir, profileId);
        const fileStats = await stat(ensured.path);
        sizeBytes = fileStats.size;
      } catch {
        sizeBytes = 0;
      }

      profileReference[profileId] = {
        path: indexPath,
        exists: sizeBytes > 0,
        sizeBytes
      };
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
