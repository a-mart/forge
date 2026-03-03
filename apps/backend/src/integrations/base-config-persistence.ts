import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getProfileIntegrationsDir } from "../swarm/data-paths.js";
import { normalizeManagerId } from "../utils/normalize.js";

const LEGACY_INTEGRATIONS_DIR_NAME = "integrations";
const LEGACY_INTEGRATIONS_MANAGERS_DIR_NAME = "managers";

export class BaseConfigPersistence<TConfig> {
  private readonly integrationName: string;
  private readonly fileName: string;
  private readonly createDefaultConfig: (managerId: string) => TConfig;
  private readonly parseConfig: (value: unknown) => TConfig;

  constructor(options: {
    integrationName: string;
    fileName: string;
    createDefaultConfig: (managerId: string) => TConfig;
    parseConfig: (value: unknown) => TConfig;
  }) {
    this.integrationName = options.integrationName;
    this.fileName = options.fileName;
    this.createDefaultConfig = options.createDefaultConfig;
    this.parseConfig = options.parseConfig;
  }

  getPath(dataDir: string, managerId: string): string {
    const normalizedManagerId = normalizeManagerId(managerId);
    return resolve(getProfileIntegrationsDir(dataDir, normalizedManagerId), this.fileName);
  }

  private getLegacyPath(dataDir: string, managerId: string): string {
    const normalizedManagerId = normalizeManagerId(managerId);
    return resolve(
      dataDir,
      LEGACY_INTEGRATIONS_DIR_NAME,
      LEGACY_INTEGRATIONS_MANAGERS_DIR_NAME,
      normalizedManagerId,
      this.fileName
    );
  }

  async load(options: { dataDir: string; managerId: string }): Promise<TConfig> {
    const defaults = this.createDefaultConfig(options.managerId);
    const normalizedManagerId = normalizeManagerId(options.managerId);
    const configPath = this.getPath(options.dataDir, normalizedManagerId);
    const legacyConfigPath = this.getLegacyPath(options.dataDir, normalizedManagerId);
    const candidatePaths = legacyConfigPath === configPath ? [configPath] : [configPath, legacyConfigPath];

    for (const candidatePath of candidatePaths) {
      try {
        const raw = await readFile(candidatePath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        return this.parseConfig(parsed);
      } catch (error) {
        if (isEnoentError(error)) {
          continue;
        }

        if (isSyntaxError(error)) {
          throw new Error(`Invalid ${this.integrationName} config JSON at ${candidatePath}`);
        }

        if (error instanceof Error) {
          throw new Error(`Invalid ${this.integrationName} config at ${candidatePath}: ${error.message}`);
        }

        throw error;
      }
    }

    return defaults;
  }

  async save(options: { dataDir: string; managerId: string; config: TConfig }): Promise<void> {
    const configPath = this.getPath(options.dataDir, options.managerId);
    const tmpPath = `${configPath}.tmp`;

    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(tmpPath, `${JSON.stringify(options.config, null, 2)}\n`, "utf8");
    await rename(tmpPath, configPath);
  }
}

export function buildIntegrationProfileId(provider: string, managerId: string): string {
  const normalizedManagerId = normalizeManagerId(managerId);
  return `${provider}:${normalizedManagerId}`;
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function isSyntaxError(error: unknown): boolean {
  return error instanceof SyntaxError;
}
