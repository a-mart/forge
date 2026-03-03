import { resolve } from "node:path";
import { getProfileScheduleFilePath, getProfileSchedulesDir } from "../swarm/data-paths.js";
import { normalizeManagerId } from "../utils/normalize.js";

const LEGACY_SCHEDULES_DIR_NAME = "schedules";
export { normalizeManagerId };

export function getSchedulesDirectoryPath(dataDir: string, managerId: string): string {
  const normalizedManagerId = normalizeManagerId(managerId);
  return getProfileSchedulesDir(dataDir, normalizedManagerId);
}

export function getScheduleFilePath(dataDir: string, managerId: string): string {
  const normalizedManagerId = normalizeManagerId(managerId);
  return getProfileScheduleFilePath(dataDir, normalizedManagerId);
}

export function getLegacyScheduleFilePath(dataDir: string, managerId: string): string {
  return resolve(dataDir, LEGACY_SCHEDULES_DIR_NAME, `${normalizeManagerId(managerId)}.json`);
}
