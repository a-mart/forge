import { resolve } from "node:path";
import { SHARED_INTEGRATION_MANAGER_ID } from "@forge/protocol";
import { getSharedIntegrationsDir } from "../swarm/data-paths.js";

export { SHARED_INTEGRATION_MANAGER_ID };

const LEGACY_INTEGRATIONS_DIR_NAME = "integrations";
const LEGACY_INTEGRATIONS_SHARED_DIR_NAME = "shared";

export function isSharedIntegrationManagerId(managerId: string): boolean {
  return managerId.trim() === SHARED_INTEGRATION_MANAGER_ID;
}

export function getSharedIntegrationConfigPath(dataDir: string, fileName: string): string {
  return resolve(getSharedIntegrationsDir(dataDir), fileName);
}

export function getLegacySharedIntegrationConfigPath(dataDir: string, fileName: string): string {
  return resolve(dataDir, LEGACY_INTEGRATIONS_DIR_NAME, LEGACY_INTEGRATIONS_SHARED_DIR_NAME, fileName);
}
