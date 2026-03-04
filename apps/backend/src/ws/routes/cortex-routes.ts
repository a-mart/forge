import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  getCommonKnowledgePath,
  getCortexNotesPath,
  getProfileKnowledgeDir,
  getProfileKnowledgePath
} from "../../swarm/data-paths.js";
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
          const profileIds = Array.from(new Set(scan.sessions.map((session) => session.profileId))).sort((a, b) =>
            a.localeCompare(b)
          );
          const profileKnowledge = await buildProfileKnowledgeInfoMap(dataDir, profileIds);

          sendJson(response, 200, {
            scan,
            files: {
              commonKnowledge: getCommonKnowledgePath(dataDir),
              cortexNotes: getCortexNotesPath(dataDir),
              profileKnowledge
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

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
