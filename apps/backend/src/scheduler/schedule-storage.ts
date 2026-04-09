import { getProfileScheduleFilePath } from "../swarm/data-paths.js";
import { normalizeManagerId } from "../utils/normalize.js";

export function getScheduleFilePath(dataDir: string, profileId: string): string {
  const normalizedProfileId = normalizeManagerId(profileId);
  return getProfileScheduleFilePath(dataDir, normalizedProfileId);
}

