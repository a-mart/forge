import { resolve } from "node:path";
import { normalizeManagerId } from "../utils/normalize.js";

const SCHEDULES_DIR_NAME = "schedules";
export { normalizeManagerId };

export function getSchedulesDirectoryPath(dataDir: string): string {
  return resolve(dataDir, SCHEDULES_DIR_NAME);
}

export function getScheduleFilePath(dataDir: string, managerId: string): string {
  return resolve(getSchedulesDirectoryPath(dataDir), `${normalizeManagerId(managerId)}.json`);
}
