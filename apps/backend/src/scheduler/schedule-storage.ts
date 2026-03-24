import { resolve } from "node:path";
import { getProfileScheduleFilePath, getProfileSchedulesDir } from "../swarm/data-paths.js";
import { normalizeManagerId } from "../utils/normalize.js";

const LEGACY_SCHEDULES_DIR_NAME = "schedules";
export { normalizeManagerId };

// Schedule storage is profile-scoped. Callers must resolve any non-root session
// managerId to its owning profileId before using these helpers.
export function getSchedulesDirectoryPath(dataDir: string, profileId: string): string {
  const normalizedProfileId = normalizeManagerId(profileId);
  return getProfileSchedulesDir(dataDir, normalizedProfileId);
}

export function getScheduleFilePath(dataDir: string, profileId: string): string {
  const normalizedProfileId = normalizeManagerId(profileId);
  return getProfileScheduleFilePath(dataDir, normalizedProfileId);
}

export function getLegacyScheduleFilePath(dataDir: string, managerId: string): string {
  return resolve(dataDir, LEGACY_SCHEDULES_DIR_NAME, `${normalizeManagerId(managerId)}.json`);
}
