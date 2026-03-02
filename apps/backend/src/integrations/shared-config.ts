import { resolve } from "node:path";

export const SHARED_INTEGRATION_MANAGER_ID = "__shared__";

const INTEGRATIONS_DIR_NAME = "integrations";
const INTEGRATIONS_SHARED_DIR_NAME = "shared";

export function isSharedIntegrationManagerId(managerId: string): boolean {
  return managerId.trim() === SHARED_INTEGRATION_MANAGER_ID;
}

export function getSharedIntegrationConfigPath(dataDir: string, fileName: string): string {
  return resolve(dataDir, INTEGRATIONS_DIR_NAME, INTEGRATIONS_SHARED_DIR_NAME, fileName);
}
